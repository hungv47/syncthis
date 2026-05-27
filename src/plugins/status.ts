// Plugin status matrix — joins discovery output across all agents into one
// plugin × agent × stage matrix. Pure data; rendering lives in bin/syncthis.ts.

import { pluginAdapters } from "./index.ts";
import { discoverPluginsForAgent, type LifecycleReport } from "./discovery.ts";
import type { PluginAdapterRead } from "./types.ts";
import type { AgentId } from "../types.ts";

export type StatusCell = {
  agent: AgentId;
  installed: boolean;
  report?: LifecycleReport;
  // Set when the agent's config is unreadable / errored.
  error?: string;
};

export type StatusRow = {
  name: string;
  // Composite source key (Codex name@source). Suppressed in default display.
  marketplace?: string;
  cells: StatusCell[];
};

export type StatusReport = {
  reads: PluginAdapterRead[];
  rows: StatusRow[];
};

export async function buildStatusReport(): Promise<StatusReport> {
  const reads = await Promise.all(pluginAdapters.map((a) => a.read()));
  const lifecycles = await Promise.all(reads.map(discoverPluginsForAgent));

  // Collect plugin names installed in any agent. Use bare name as the row key —
  // marketplace shown via --detailed, not as a row dimension (§7 decision #3).
  const names = new Set<string>();
  for (const lf of lifecycles) for (const r of lf) names.add(r.name);

  const rows: StatusRow[] = [];
  for (const name of [...names].sort()) {
    const cells: StatusCell[] = [];
    let marketplaceForRow: string | undefined;
    for (let i = 0; i < reads.length; i++) {
      const read = reads[i]!;
      if (read.error) {
        cells.push({ agent: read.agent, installed: false, error: read.error });
        continue;
      }
      const match = lifecycles[i]!.find((r) => r.name === name);
      if (!match) {
        cells.push({ agent: read.agent, installed: false });
        continue;
      }
      cells.push({ agent: read.agent, installed: true, report: match });
      if (match.marketplace && !marketplaceForRow) marketplaceForRow = match.marketplace;
    }
    rows.push({ name, marketplace: marketplaceForRow, cells });
  }

  return { reads, rows };
}

// Cell glyph for status output. Public so tests can assert it.
export function cellGlyph(cell: StatusCell): "absent" | "error" | "surfaced" | "silent" | "disabled" {
  if (cell.error) return "error";
  if (!cell.installed) return "absent";
  const r = cell.report!;
  if (r.enabled === false) return "disabled";
  if (r.surfaced) return "surfaced";
  return "silent";
}

export function hasSilentFailures(report: StatusReport): boolean {
  // "disabled" is an intentional user state, not a failure. cmdStatus and
  // doStatus both treat it as informational and don't suggest `syncthis fix`
  // for it — this helper must match that semantics so any caller wiring it
  // into a CI gate doesn't get false positives from intentionally-disabled plugins.
  return report.rows.some((row) => row.cells.some((c) => cellGlyph(c) === "silent"));
}
