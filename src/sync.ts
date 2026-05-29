import { spawn } from "node:child_process";
import { adapters } from "./adapters/index.ts";
import { addSkillsFromPlugins, skillCohort, type PluginSkillsReport } from "./skills.ts";
import type { Adapter, AdapterRead, AdapterWriteResult, AgentId, McpServer } from "./types.ts";

const SKILLS_UPDATE_TIMEOUT_MS = 120_000;

type SyncOptions = {
  dryRun?: boolean;
  skipSkills?: boolean;
  onPluginSkillProgress?: (repo: string, i: number, total: number) => void;
};

export type DirectionalDiff = {
  add: string[];
  overwrite: string[];
  remove: string[];
};

export type DirectionalReport = {
  from: AgentId;
  to: AgentId;
  fromRead: AdapterRead;
  toRead: AdapterRead;
  diff: DirectionalDiff;
  applied: boolean;
  write?: AdapterWriteResult;
};

export type FanOutTarget = {
  to: AgentId;
  toRead: AdapterRead;
  diff: DirectionalDiff;
  write?: AdapterWriteResult;
};

export type FanOutReport = {
  from: AgentId;
  fromRead: AdapterRead;
  targets: FanOutTarget[];
  applied: boolean;
};

export type RemoveReport = {
  name: string;
  applied: boolean;
  writes: AdapterWriteResult[];
};

export type Conflict = {
  name: string;
  versions: { agent: AgentId; server: McpServer }[];
};

export type SyncReport = {
  reads: AdapterRead[];
  union: Record<string, McpServer>;
  conflicts: Conflict[];
  writes: AdapterWriteResult[];
  pluginSkills?: PluginSkillsReport;
  skills?: { ran: boolean; ok: boolean; message?: string };
};

function canonical(s: McpServer): string {
  return JSON.stringify(sortKeys(canonicalShape(s)));
}

// Canonical identity used for conflict/equality detection (computeUnion + diffServers).
//
// Two things are deliberately collapsed so the detector doesn't fire on differences
// that aren't real:
//   1. Empty containers — adapters disagree on round-tripping `args: []`/`env: {}`
//      (OpenCode drops them, canonical-schema adapters keep them). Omit when empty.
//   2. URL transport subtype (http / sse / streamable-http). Several agents
//      (windsurf, copilot, hermes, opencode) have no field for it and ALWAYS read a
//      URL server back as "http". If transport were part of the identity, the first
//      sync would write an sse server to those agents, they'd report it back as http,
//      and the SECOND sync would see sse-vs-http for the same name and raise a
//      conflict the user can never resolve (re-running just recreates it). The URL is
//      the server's identity; transport is not faithfully syncable, so it's excluded.
//      The propagated union value still keeps its original `type` (see computeUnion),
//      so transport-capable agents retain whatever the source agent had.
function canonicalShape(s: McpServer): Record<string, unknown> {
  if ("url" in s) {
    const out: Record<string, unknown> = { kind: "url", url: s.url };
    if (s.headers && Object.keys(s.headers).length > 0) out.headers = s.headers;
    return out;
  }
  const out: Record<string, unknown> = { kind: "stdio", command: s.command };
  if (s.args && s.args.length > 0) out.args = s.args;
  if (s.env && Object.keys(s.env).length > 0) out.env = s.env;
  if (s.cwd) out.cwd = s.cwd;
  return out;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function computeUnion(reads: AdapterRead[]): {
  union: Record<string, McpServer>;
  conflicts: Conflict[];
} {
  const versions = new Map<string, { agent: AgentId; server: McpServer }[]>();
  for (const r of reads) {
    for (const [name, server] of Object.entries(r.servers)) {
      const list = versions.get(name) ?? [];
      list.push({ agent: r.agent, server });
      versions.set(name, list);
    }
  }
  const union: Record<string, McpServer> = {};
  const conflicts: Conflict[] = [];
  for (const [name, vs] of versions) {
    const distinct = new Set(vs.map((v) => canonical(v.server)));
    if (distinct.size === 1) {
      union[name] = vs[0]!.server;
    } else {
      conflicts.push({ name, versions: vs });
    }
  }
  return { union, conflicts };
}

export async function runSync(opts: SyncOptions = {}): Promise<SyncReport> {
  const dryRun = opts.dryRun ?? false;
  const reads = await Promise.all(adapters.map((a) => a.read()));
  const { union, conflicts } = computeUnion(reads);
  const conflictNames = new Set(conflicts.map((c) => c.name));
  const readsByAgent = new Map(reads.map((r) => [r.agent, r]));

  const writes = await Promise.all(
    adapters.map((a) => {
      const read = readsByAgent.get(a.id)!;
      const own = read.servers;
      const final: Record<string, McpServer> = { ...union };
      for (const name of conflictNames) {
        if (own[name]) final[name] = own[name];
      }
      if (!read.error && Object.keys(final).length === 0 && Object.keys(own).length === 0) {
        return {
          agent: a.id,
          path: read.path,
          status: "skipped",
          message: "nothing to sync",
        } satisfies AdapterWriteResult;
      }
      return a.write(final, { dryRun });
    }),
  );

  const report: SyncReport = { reads, union, conflicts, writes };

  if (opts.skipSkills) {
    report.pluginSkills = { ran: false, dryRun, agents: skillCohort(), sources: [], results: [], message: "skipped (--no-skills)" };
    report.skills = { ran: false, ok: true, message: "skipped (--no-skills)" };
    return report;
  }

  // Surface plugin-bundled skills to the non-plugin agents BEFORE refreshing, so
  // a freshly added skill is picked up by the same run. On dry-run this only
  // resolves + reports the source repos (no `npx skills add` invoked).
  report.pluginSkills = await addSkillsFromPlugins({ dryRun, onProgress: opts.onPluginSkillProgress });
  report.skills = dryRun ? { ran: false, ok: true, message: "skipped (dry-run)" } : await runSkillsUpdate();

  return report;
}

export function findAdapter(id: AgentId): Adapter | undefined {
  return adapters.find((a) => a.id === id);
}

export function listAgentIds(): AgentId[] {
  return adapters.map((a) => a.id);
}

export function diffServers(
  from: Record<string, McpServer>,
  to: Record<string, McpServer>,
): DirectionalDiff {
  const add: string[] = [];
  const overwrite: string[] = [];
  const remove: string[] = [];
  for (const [name, server] of Object.entries(from)) {
    if (!(name in to)) add.push(name);
    else if (canonical(server) !== canonical(to[name]!)) overwrite.push(name);
  }
  for (const name of Object.keys(to)) {
    if (!(name in from)) remove.push(name);
  }
  return { add: add.sort(), overwrite: overwrite.sort(), remove: remove.sort() };
}

type DirectionalOptions = {
  from: AgentId;
  to: AgentId;
  dryRun?: boolean;
  apply: boolean;
};

export async function runDirectional(opts: DirectionalOptions): Promise<DirectionalReport> {
  const fromAdapter = findAdapter(opts.from);
  const toAdapter = findAdapter(opts.to);
  if (!fromAdapter) throw new Error(`syncthis: unknown agent: ${opts.from}`);
  if (!toAdapter) throw new Error(`syncthis: unknown agent: ${opts.to}`);
  if (opts.from === opts.to) throw new Error(`syncthis: from and to must differ`);

  const [fromRead, toRead] = await Promise.all([fromAdapter.read(), toAdapter.read()]);
  if (fromRead.error) throw new Error(`syncthis: cannot read source ${opts.from}: ${fromRead.error}`);
  if (toRead.error) throw new Error(`syncthis: cannot read destination ${opts.to}: ${toRead.error}`);
  const diff = diffServers(fromRead.servers, toRead.servers);

  if (!opts.apply || opts.dryRun) {
    return { from: opts.from, to: opts.to, fromRead, toRead, diff, applied: false };
  }

  const write = await toAdapter.write(fromRead.servers, { dryRun: false });
  return { from: opts.from, to: opts.to, fromRead, toRead, diff, applied: true, write };
}

export async function runFanOut(opts: { from: AgentId; dryRun?: boolean; apply: boolean }): Promise<FanOutReport> {
  const fromAdapter = findAdapter(opts.from);
  if (!fromAdapter) throw new Error(`syncthis: unknown agent: ${opts.from}`);

  const fromRead = await fromAdapter.read();
  if (fromRead.error) throw new Error(`syncthis: cannot read source ${opts.from}: ${fromRead.error}`);

  const targets = await Promise.all(
    adapters
      .filter((a) => a.id !== opts.from)
      .map(async (adapter): Promise<FanOutTarget> => {
        const toRead = await adapter.read();
        if (toRead.error) {
          return {
            to: adapter.id,
            toRead,
            diff: { add: [], overwrite: [], remove: [] },
            write: opts.apply && !opts.dryRun
              ? { agent: adapter.id, path: toRead.path, status: "failed", message: toRead.error }
              : undefined,
          };
        }

        const diff = diffServers(fromRead.servers, toRead.servers);
        const hasChange = diff.add.length > 0 || diff.overwrite.length > 0 || diff.remove.length > 0;
        if (!opts.apply || !hasChange) return { to: adapter.id, toRead, diff };
        const write = await adapter.write(fromRead.servers, { dryRun: !!opts.dryRun });
        return { to: adapter.id, toRead, diff, write };
      }),
  );

  return { from: opts.from, fromRead, targets, applied: opts.apply && !opts.dryRun };
}

export async function runRemove(opts: { name: string; dryRun?: boolean; apply: boolean }): Promise<RemoveReport> {
  const name = opts.name.trim();
  if (!name) throw new Error("syncthis: server name is required");

  const reads = await Promise.all(adapters.map((a) => a.read()));
  const readsByAgent = new Map(reads.map((r) => [r.agent, r]));
  const writes = await Promise.all(
    adapters.map(async (adapter): Promise<AdapterWriteResult> => {
      const read = readsByAgent.get(adapter.id)!;
      if (read.error) {
        return { agent: adapter.id, path: read.path, status: "failed", message: read.error };
      }
      if (!read.servers[name]) {
        return { agent: adapter.id, path: read.path, status: "skipped", message: "not present" };
      }
      if (adapter.removeServer) {
        if (!opts.apply) return adapter.removeServer(name, { dryRun: true });
        return adapter.removeServer(name, { dryRun: !!opts.dryRun });
      }
      const next = { ...read.servers };
      delete next[name];
      if (!opts.apply) {
        return { agent: adapter.id, path: read.path, status: "synced", message: "dry-run" };
      }
      return adapter.write(next, { dryRun: !!opts.dryRun });
    }),
  );

  return { name, applied: opts.apply && !opts.dryRun, writes };
}

export async function runSkillsOnly(): Promise<NonNullable<SyncReport["skills"]>> {
  return runSkillsUpdate();
}

function runSkillsUpdate(): Promise<NonNullable<SyncReport["skills"]>> {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;
    // stdout is inherited so the user sees skills' own progress; stderr is captured
    // so a failure tail can be surfaced.
    const child = spawn("npx", ["-y", "skills", "update", "-y"], { stdio: ["ignore", "inherit", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SKILLS_UPDATE_TIMEOUT_MS);
    // 'error' (spawn failure) and 'close' can both fire — settle exactly once.
    const finish = (r: NonNullable<SyncReport["skills"]>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (err: Error) => finish({ ran: true, ok: false, message: `npx skills failed: ${err.message}` }));
    child.on("close", (code) => {
      if (timedOut) return finish({ ran: true, ok: false, message: `npx skills timed out after ${SKILLS_UPDATE_TIMEOUT_MS / 1000}s` });
      if (code === 0) return finish({ ran: true, ok: true });
      finish({ ran: true, ok: false, message: `npx skills exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}` });
    });
  });
}
