import { pluginAdapters } from "./plugins/index.ts";
import type {
  MarketplaceRecord,
  PluginAdapterRead,
  PluginKind,
  PluginRecord,
} from "./plugins/types.ts";
import type { AgentId } from "./types.ts";

export type PluginCoverageRow = {
  name: string;
  kind: PluginKind;
  present: AgentId[];
  missing: AgentId[];
};

export type MarketplaceCoverageRow = {
  name: string;
  present: AgentId[];
  missing: AgentId[];
};

export type MarketplaceConflict = {
  name: string;
  versions: { agent: AgentId; source: string }[];
};

export type PluginDoctorReport = {
  reads: PluginAdapterRead[];
  pluginCoverage: {
    bundle: PluginCoverageRow[];
    npm: PluginCoverageRow[];
  };
  marketplaceCoverage: MarketplaceCoverageRow[];
  marketplaceConflicts: MarketplaceConflict[];
};

function keyForPlugin(p: PluginRecord): string {
  // Within a kind, plugin name (without marketplace suffix) is the identity.
  return p.name;
}

function keyForMarketplace(m: MarketplaceRecord): string {
  return m.name;
}

export async function runPluginDoctor(): Promise<PluginDoctorReport> {
  const reads = await Promise.all(pluginAdapters.map((a) => a.read()));

  // Cohorts: which agents can hold each kind of plugin?
  const bundleAgents: AgentId[] = reads.filter((r) => r.pluginKind === "bundle").map((r) => r.agent);
  const npmAgents: AgentId[] = reads.filter((r) => r.pluginKind === "npm").map((r) => r.agent);
  const marketplaceAgents: AgentId[] = reads.filter((r) => r.supportsMarketplaces).map((r) => r.agent);

  const bundleNames = new Set<string>();
  const npmNames = new Set<string>();
  const marketplaceNames = new Set<string>();

  for (const r of reads) {
    if (r.error) continue;
    for (const p of r.plugins) {
      if (p.kind === "bundle") bundleNames.add(keyForPlugin(p));
      else npmNames.add(keyForPlugin(p));
    }
    for (const m of r.marketplaces) marketplaceNames.add(keyForMarketplace(m));
  }

  const bundleCoverage = buildPluginCoverage(reads, bundleAgents, bundleNames, "bundle");
  const npmCoverage = buildPluginCoverage(reads, npmAgents, npmNames, "npm");

  const marketplaceCoverage: MarketplaceCoverageRow[] = [...marketplaceNames].sort().map((name) => {
    const present: AgentId[] = [];
    const missing: AgentId[] = [];
    for (const r of reads) {
      if (!r.supportsMarketplaces) continue;
      if (r.error) continue;
      if (r.marketplaces.some((m) => m.name === name)) present.push(r.agent);
      else missing.push(r.agent);
    }
    return { name, present, missing };
  });

  const marketplaceConflicts: MarketplaceConflict[] = [];
  for (const name of marketplaceNames) {
    const versions: { agent: AgentId; source: string }[] = [];
    for (const r of reads) {
      const m = r.marketplaces.find((x) => x.name === name);
      if (m) versions.push({ agent: r.agent, source: m.source });
    }
    if (versions.length > 1) {
      const distinct = new Set(versions.map((v) => v.source));
      if (distinct.size > 1) marketplaceConflicts.push({ name, versions });
    }
  }
  marketplaceConflicts.sort((a, b) => a.name.localeCompare(b.name));

  // Suppress unused-variable warning for marketplaceAgents (kept for future Phase 3 ordering).
  void marketplaceAgents;

  return {
    reads,
    pluginCoverage: { bundle: bundleCoverage, npm: npmCoverage },
    marketplaceCoverage,
    marketplaceConflicts,
  };
}

function buildPluginCoverage(
  reads: PluginAdapterRead[],
  cohort: AgentId[],
  names: Set<string>,
  kind: PluginKind,
): PluginCoverageRow[] {
  return [...names].sort().map((name) => {
    const present: AgentId[] = [];
    const missing: AgentId[] = [];
    for (const r of reads) {
      if (!cohort.includes(r.agent)) continue;
      if (r.error) continue;
      const has = r.plugins.some((p) => p.kind === kind && keyForPlugin(p) === name);
      if (has) present.push(r.agent);
      else missing.push(r.agent);
    }
    return { name, kind, present, missing };
  });
}

export async function listPlugins(): Promise<PluginAdapterRead[]> {
  return await Promise.all(pluginAdapters.map((a) => a.read()));
}
