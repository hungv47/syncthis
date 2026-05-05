import { spawn } from "bun";
import { adapters } from "./adapters/index.ts";
import { syncSkills, type SkillSyncReport } from "./skills.ts";
import type { AdapterRead, AdapterWriteResult, AgentId, McpServer } from "./types.ts";

type SyncOptions = {
  dryRun?: boolean;
  skipSkills?: boolean;
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
  skillPropagation?: SkillSyncReport;
};

function canonical(s: McpServer): string {
  return JSON.stringify(sortKeys(s));
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

  if (!opts.skipSkills) {
    report.skillPropagation = await syncSkills({ dryRun });
  }

  return report;
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
