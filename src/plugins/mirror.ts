// Plugin mirror — destructive primary → all sync (Phase 2 of plan-cross-agent-sync.md).
//
// Reads the user-designated primary agent's installed plugins, computes a diff
// against every other agent that supports the same plugin kind, and applies
// installs / removes via the adapter's native primitives. Always shows a diff
// and prompts for confirmation OR honors --yes (sacred §10).
//
// Mismatched kinds (bundle vs npm) are intentionally never crossed — Codex
// bundles don't translate to OpenCode npm modules.

import { pluginAdapters } from "./index.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallResult,
  PluginRecord,
  PluginRemoveResult,
} from "./types.ts";
import type { AgentId } from "../types.ts";

export type MirrorDiff = {
  // Plugins present in primary but missing from target → install
  add: PluginRecord[];
  // Plugins present in target but not primary → remove
  remove: PluginRecord[];
};

export type MirrorTarget = {
  to: AgentId;
  toRead: PluginAdapterRead;
  // null when the target's plugin kind differs from primary's (unmirrorable).
  diff: MirrorDiff | null;
  unsupportedReason?: string;
  installs?: PluginInstallResult[];
  removes?: PluginRemoveResult[];
};

export type MirrorReport = {
  from: AgentId;
  fromRead: PluginAdapterRead;
  targets: MirrorTarget[];
  applied: boolean;
};

export type MirrorRunOpts = {
  from: AgentId;
  apply: boolean;
  // When true, also remove plugins from targets that aren't in primary.
  // Default false — additive by default, destructive only when asked.
  removeStale?: boolean;
};

function adapterFor(id: AgentId): PluginAdapter | undefined {
  return pluginAdapters.find((a) => a.id === id);
}

function keyOf(p: PluginRecord): string {
  return p.marketplace ? `${p.name}@${p.marketplace}` : p.name;
}

function indexByKey(plugins: PluginRecord[]): Map<string, PluginRecord> {
  const m = new Map<string, PluginRecord>();
  for (const p of plugins) m.set(keyOf(p), p);
  return m;
}

export async function runMirror(opts: MirrorRunOpts): Promise<MirrorReport> {
  const primary = adapterFor(opts.from);
  if (!primary) {
    throw new Error(
      `mirror: ${opts.from} has no plugin adapter. plugin-capable agents: ${pluginAdapters.map((a) => a.id).join(", ")}`,
    );
  }
  const fromRead = await primary.read();

  // P1 SAFETY: an errored primary read returns `{ error, plugins: [] }`. With
  // --remove-stale set, an empty fromIdx would mark *every* plugin in every
  // target as stale and queue them all for deletion. The interactive diff
  // catches this for a human; non-interactive `--yes` does not. Refuse the
  // dangerous case before computing any removes (sacred rule #1: no implicit
  // deletion).
  if (opts.removeStale && fromRead.error) {
    throw new Error(
      `mirror: refusing --remove-stale because primary ${opts.from} is unreadable: ${fromRead.error}. Re-run without --remove-stale, or fix the primary first.`,
    );
  }
  if (opts.removeStale && fromRead.plugins.length === 0) {
    throw new Error(
      `mirror: refusing --remove-stale because primary ${opts.from} reports zero plugins — that would wipe every other agent. If you really want to clear all plugins, use \`syncthis plugin rm --all\` explicitly.`,
    );
  }
  const targets: MirrorTarget[] = [];

  for (const a of pluginAdapters) {
    if (a.id === primary.id) continue;
    const toRead = await a.read();

    if (a.pluginKind !== primary.pluginKind) {
      targets.push({
        to: a.id,
        toRead,
        diff: null,
        unsupportedReason: `kind mismatch: primary is ${primary.pluginKind}, target is ${a.pluginKind} (npm plugins do not translate to bundle plugins)`,
      });
      continue;
    }

    if (toRead.error) {
      targets.push({ to: a.id, toRead, diff: null, unsupportedReason: `cannot read target: ${toRead.error}` });
      continue;
    }

    const fromIdx = indexByKey(fromRead.plugins);
    const toIdx = indexByKey(toRead.plugins);

    const add: PluginRecord[] = [];
    for (const [k, p] of fromIdx) if (!toIdx.has(k)) add.push(p);

    const remove: PluginRecord[] = [];
    if (opts.removeStale) {
      for (const [k, p] of toIdx) if (!fromIdx.has(k)) remove.push(p);
    }

    const target: MirrorTarget = { to: a.id, toRead, diff: { add, remove } };

    if (opts.apply) {
      if (!a.installPlugin) {
        target.unsupportedReason = `${a.id} has no install primitive (mirror cannot push plugins to it)`;
      } else {
        const installs: PluginInstallResult[] = [];
        for (const p of add) {
          installs.push(await a.installPlugin(p.name, { dryRun: false, marketplace: p.marketplace }));
        }
        target.installs = installs;
      }
      if (opts.removeStale && a.removePlugin) {
        const removes: PluginRemoveResult[] = [];
        for (const p of remove) {
          removes.push(await a.removePlugin(keyOf(p), { dryRun: false, prune: true }));
        }
        target.removes = removes;
      }
    }

    targets.push(target);
  }

  return { from: opts.from, fromRead, targets, applied: opts.apply };
}

export function mirrorHasChanges(report: MirrorReport): boolean {
  return report.targets.some((t) => t.diff && (t.diff.add.length > 0 || t.diff.remove.length > 0));
}
