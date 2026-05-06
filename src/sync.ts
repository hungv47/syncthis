import { spawn } from "bun";
import { adapters } from "./adapters/index.ts";
import type { Adapter, AdapterRead, AdapterWriteResult, AgentId, McpServer } from "./types.ts";

type SyncOptions = {
  dryRun?: boolean;
  skipSkills?: boolean;
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

export type Conflict = {
  name: string;
  versions: { agent: AgentId; server: McpServer }[];
};

export type SyncReport = {
  reads: AdapterRead[];
  union: Record<string, McpServer>;
  conflicts: Conflict[];
  writes: AdapterWriteResult[];
  skills?: { ran: boolean; ok: boolean; message?: string };
};

function canonical(s: McpServer): string {
  return JSON.stringify(sortKeys(normalizeServer(s)));
}

// Adapters differ in how they preserve empty containers — OpenCode drops `args: []` on round-trip
// while canonical-schema adapters keep it. Normalize both shapes to the same canonical form so the
// conflict detector doesn't fire on cosmetic differences.
function normalizeServer(s: McpServer): McpServer {
  if ("url" in s) {
    const out: Extract<McpServer, { url: string }> = { type: s.type ?? "http", url: s.url };
    if (s.headers && Object.keys(s.headers).length > 0) out.headers = s.headers;
    return out;
  }
  const out: Extract<McpServer, { command: string }> = { type: s.type ?? "stdio", command: s.command };
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

  const writes = await Promise.all(
    adapters.map((a) => {
      const own = reads.find((r) => r.agent === a.id)!.servers;
      const final: Record<string, McpServer> = { ...union };
      for (const name of conflictNames) {
        if (own[name]) final[name] = own[name];
      }
      return a.write(final, { dryRun });
    }),
  );

  const report: SyncReport = { reads, union, conflicts, writes };

  const skipReason = opts.skipSkills ? "skipped (--no-skills)" : dryRun ? "skipped (dry-run)" : null;
  report.skills = skipReason
    ? { ran: false, ok: true, message: skipReason }
    : await runSkillsUpdate();

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
  const diff = diffServers(fromRead.servers, toRead.servers);

  if (!opts.apply || opts.dryRun) {
    return { from: opts.from, to: opts.to, fromRead, toRead, diff, applied: false };
  }

  const write = await toAdapter.write(fromRead.servers, { dryRun: false });
  return { from: opts.from, to: opts.to, fromRead, toRead, diff, applied: true, write };
}

export async function runSkillsOnly(): Promise<NonNullable<SyncReport["skills"]>> {
  return runSkillsUpdate();
}

async function runSkillsUpdate(): Promise<NonNullable<SyncReport["skills"]>> {
  try {
    const proc = spawn(["npx", "-y", "skills", "update", "-y"], {
      stdout: "inherit",
      stderr: "pipe",
      stdin: "ignore",
    });
    const code = await proc.exited;
    if (code === 0) return { ran: true, ok: true };
    const err = await new Response(proc.stderr).text();
    return { ran: true, ok: false, message: `npx skills exited ${code}: ${err.trim().split("\n").pop() ?? ""}` };
  } catch (err) {
    return { ran: true, ok: false, message: `npx skills failed: ${String(err)}` };
  }
}
