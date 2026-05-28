// Plugin mirror — destructive primary → other-agent sync.
//
// Reads the primary agent's installed plugins, diffs against the other plugin
// agent, and applies installs (and, with --remove-stale, removes) via each
// adapter's native CLI. Always shows a diff and prompts for confirmation OR
// honors --yes. The cohort is the two bundle agents with an install CLI
// (Claude, Codex); both implement installPlugin + removePlugin.

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
  // null when the target's config could not be read (see unsupportedReason).
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
  // When true, a target may register a missing marketplace before installing
  // (Codex shells `npx plugins add <repo> --target codex`). Off by default.
  provision?: boolean;
};

function adapterFor(id: AgentId): PluginAdapter | undefined {
  return pluginAdapters.find((a) => a.id === id);
}

// Cross-agent identity is the BARE plugin name, not name@marketplace. The
// marketplace tag is agent-local: the same upstream plugin is "forsvn-skills@
// forsvn-skills" in Claude but "forsvn-skills@plugins-cli" in Codex. Keying on
// the tag would treat every such plugin as missing and queue a spurious re-add.
function indexByName(plugins: PluginRecord[]): Map<string, PluginRecord> {
  const m = new Map<string, PluginRecord>();
  for (const p of plugins) m.set(p.name, p);
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
      `mirror: refusing --remove-stale because primary ${opts.from} reports zero plugins — that would uninstall every plugin from the other agent. If you really want to clear them, uninstall directly with that agent's CLI (\`claude plugin uninstall\` / \`codex plugin remove\`).`,
    );
  }
  // For --provision: the primary's marketplace name → owner/repo, so a target
  // can register a marketplace it lacks before installing. Fetched once.
  let sources: Map<string, string> | undefined;
  if (opts.provision && opts.apply && primary.marketplaceSources) {
    sources = await primary.marketplaceSources();
  }

  const targets: MirrorTarget[] = [];

  for (const a of pluginAdapters) {
    if (a.id === primary.id) continue;
    const toRead = await a.read();

    if (toRead.error) {
      targets.push({ to: a.id, toRead, diff: null, unsupportedReason: `cannot read target: ${toRead.error}` });
      continue;
    }

    const fromIdx = indexByName(fromRead.plugins);
    const toIdx = indexByName(toRead.plugins);

    const add: PluginRecord[] = [];
    for (const [name, p] of fromIdx) if (!toIdx.has(name)) add.push(p);

    const remove: PluginRecord[] = [];
    if (opts.removeStale) {
      for (const [name, p] of toIdx) if (!fromIdx.has(name)) remove.push(p);
    }

    const target: MirrorTarget = { to: a.id, toRead, diff: { add, remove } };

    if (opts.apply) {
      // Install by bare name and let the target resolve its own marketplace —
      // the primary's marketplace tag won't exist on the target. removePlugin
      // re-resolves the target's own tag from its config.
      const installs: PluginInstallResult[] = [];
      for (const p of add) {
        installs.push(
          await a.installPlugin(p.name, {
            dryRun: false,
            provision: opts.provision,
            sourceRepo: p.marketplace ? sources?.get(p.marketplace) : undefined,
          }),
        );
      }
      target.installs = installs;
      if (opts.removeStale) {
        const removes: PluginRemoveResult[] = [];
        for (const p of remove) {
          removes.push(await a.removePlugin(p.name, { dryRun: false, prune: true }));
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
