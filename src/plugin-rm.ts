import { pluginAdapters } from "./plugins/index.ts";
import type { PluginRemoveResult } from "./plugins/types.ts";
import type { AgentId } from "./types.ts";

export type RemoveScope = { all: true } | { agents: AgentId[] };

export type RemoveRunOpts = {
  name: string;
  scope: RemoveScope;
  apply: boolean;
  prune?: boolean;
  purge?: boolean;
};

export type RemoveReport = {
  name: string;
  kind: "plugin" | "marketplace";
  results: PluginRemoveResult[];
};

export type BulkRemoveReport = {
  marketplace: string;
  resolvedNames: string[];
  perPlugin: RemoveReport[];
};

function selectAdapters(scope: RemoveScope) {
  if ("all" in scope) return pluginAdapters;
  const wanted = new Set<AgentId>(scope.agents);
  return pluginAdapters.filter((a) => wanted.has(a.id));
}

async function runWithCapability(
  capability: "removePlugin" | "removeMarketplace",
  capabilityCheck: (adapter: (typeof pluginAdapters)[number]) => boolean,
  opts: RemoveRunOpts,
): Promise<PluginRemoveResult[]> {
  const targets = selectAdapters(opts.scope);
  const removeOpts = { dryRun: !opts.apply, prune: opts.prune, purge: opts.purge };

  const work = targets.map(async (adapter): Promise<PluginRemoveResult> => {
    const fn = adapter[capability];
    if (!fn) {
      return {
        agent: adapter.id,
        target: opts.name,
        status: "skipped",
        message: capabilityCheck(adapter) ? "not implemented" : "not applicable",
      };
    }
    if (!capabilityCheck(adapter)) {
      return {
        agent: adapter.id,
        target: opts.name,
        status: "skipped",
        message: "not applicable",
      };
    }
    try {
      return await fn.call(adapter, opts.name, removeOpts);
    } catch (err) {
      return {
        agent: adapter.id,
        target: opts.name,
        status: "failed",
        message: (err as Error).message,
      };
    }
  });
  return await Promise.all(work);
}

export async function runPluginRemove(opts: RemoveRunOpts): Promise<RemoveReport> {
  const results = await runWithCapability("removePlugin", () => true, opts);
  return { name: opts.name, kind: "plugin", results };
}

export async function runMarketplaceRemove(opts: RemoveRunOpts): Promise<RemoveReport> {
  const results = await runWithCapability(
    "removeMarketplace",
    (adapter) => adapter.supportsMarketplaces,
    opts,
  );
  return { name: opts.name, kind: "marketplace", results };
}

export function hasChanges(report: RemoveReport): boolean {
  return report.results.some((r) => r.status === "removed");
}

export function bulkHasChanges(report: BulkRemoveReport): boolean {
  return report.perPlugin.some(hasChanges);
}

// Enumerate every plugin name installed in any in-scope agent that came from
// the given marketplace. Used by `syncthis plugin rm --marketplace <name>` to
// expand one filter into the actual list of plugins to remove.
export async function resolvePluginNamesByMarketplace(
  marketplace: string,
  scope: RemoveScope,
): Promise<string[]> {
  const targets = selectAdapters(scope);
  const reads = await Promise.all(targets.map((a) => a.read()));
  const names = new Set<string>();
  for (const r of reads) {
    if (r.error) continue;
    for (const p of r.plugins) {
      if (p.marketplace === marketplace) names.add(p.name);
    }
  }
  return [...names].sort();
}

export async function runPluginRemoveByMarketplace(
  marketplace: string,
  baseOpts: Omit<RemoveRunOpts, "name">,
): Promise<BulkRemoveReport> {
  const resolvedNames = await resolvePluginNamesByMarketplace(marketplace, baseOpts.scope);
  const perPlugin: RemoveReport[] = [];
  for (const name of resolvedNames) {
    perPlugin.push(await runPluginRemove({ ...baseOpts, name }));
  }
  return { marketplace, resolvedNames, perPlugin };
}
