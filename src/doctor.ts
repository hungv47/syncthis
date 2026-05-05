import { adapters } from "./adapters/index.ts";
import { computeUnion, type Conflict } from "./sync.ts";
import type { AdapterRead, AgentId } from "./types.ts";

export type DoctorReport = {
  reads: AdapterRead[];
  unionNames: string[];
  conflicts: Conflict[];
  coverage: { name: string; present: AgentId[]; missing: AgentId[] }[];
};

export async function runDoctor(): Promise<DoctorReport> {
  const reads = await Promise.all(adapters.map((a) => a.read()));
  const { union, conflicts } = computeUnion(reads);
  const allAgents = adapters.map((a) => a.id);

  const allNames = new Set<string>();
  for (const r of reads) for (const n of Object.keys(r.servers)) allNames.add(n);

  const coverage = [...allNames].sort().map((name) => {
    const present: AgentId[] = [];
    const missing: AgentId[] = [];
    for (const r of reads) {
      if (r.servers[name]) present.push(r.agent);
      else missing.push(r.agent);
    }
    return { name, present, missing };
  });

  return {
    reads,
    unionNames: Object.keys(union).sort(),
    conflicts,
    coverage,
  };
}

export type { Conflict };
export const _agents = adapters.map((a) => a.id);
