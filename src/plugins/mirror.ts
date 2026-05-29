// Plugin mirror — destructive primary → other-agent sync.
//
// Reads the primary agent's installed plugins, diffs against the other plugin
// agent, and applies installs (and, with --remove-stale, removes) via each
// adapter's native CLI. Always shows a diff and prompts for confirmation OR
// honors --yes. The native-CLI cohort is the two bundle agents (Claude, Codex);
// both implement installPlugin + removePlugin.
//
// Cursor is a third plugin target, but write-only: it has no plugin-list CLI, so
// we can't read its state, diff it, or remove from it. Instead it receives the
// primary's plugins by source repo via `npx plugins add <repo> --target cursor`
// — additive only. Source repos come from the primary's marketplace→repo map,
// which only Claude exposes, so cursor push is supported from a Claude primary.

import { pluginAdapters } from "./index.ts";
import { isSafeRepoSlug, run } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallResult,
  PluginRecord,
  PluginRemoveResult,
} from "./types.ts";
import { addSkillRepos, type SkillAddResult } from "../skills.ts";
import type { AgentId } from "../types.ts";

const CURSOR_PLUGINS_TIMEOUT_MS = 180_000;

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
  // Skills added to this target as a fallback for plugins it couldn't install
  // natively (skills-only bundles). Populated on apply only. Today only Codex.
  skillsFallback?: SkillAddResult[];
};

export type CursorPushResult = { repo: string; status: "installed" | "failed"; message?: string };

// Cursor's write-only plugin push. `supported` is false when the primary can't
// supply github source repos (only Claude can). `repos` is the deduped set of
// owner/repo slugs behind the primary's installed plugins; on apply each is
// installed via `npx plugins add <repo> --target cursor`.
export type CursorPush = {
  supported: boolean;
  reason?: string;
  repos: string[];
  results: CursorPushResult[];
};

export type MirrorReport = {
  from: AgentId;
  fromRead: PluginAdapterRead;
  targets: MirrorTarget[];
  cursor: CursorPush;
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
  // The primary's marketplace name → owner/repo. Used by --provision (so a Codex
  // target can register a marketplace it lacks) and by the cursor push (which is
  // entirely repo-based). Fetched once; only Claude implements it. Needed for the
  // preview too, so fetch whenever available rather than only on apply/provision.
  let sources: Map<string, string> | null | undefined;
  if (primary.marketplaceSources) {
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
      // Skills-fallback: any skipped install that handed back a source repo is a
      // bundle this target can't load as a plugin (a skills-only bundle on Codex).
      // Add its skills loosely so the content still reaches the agent — additive,
      // and safe from duplication since there's no plugin here to collide with.
      const fallbackRepos = installs
        .map((i) => i.skillsFallbackRepo)
        .filter((r): r is string => !!r);
      if (fallbackRepos.length) {
        target.skillsFallback = await addSkillRepos(fallbackRepos, [a.id]);
      }
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

  const cursor = await pushToCursor(fromRead, sources, opts.apply);

  return { from: opts.from, fromRead, targets, cursor, applied: opts.apply };
}

// Install the primary's plugins onto Cursor by source repo. Cursor has no
// plugin-list CLI, so this is additive and unconditional — we can't diff against
// cursor's current state. Repos are deduped (a multi-plugin marketplace installs
// once) and slug-validated (an adversarial marketplace entry can't smuggle a flag
// into the `npx plugins` invocation).
async function pushToCursor(
  fromRead: PluginAdapterRead,
  sources: Map<string, string> | null | undefined,
  apply: boolean,
): Promise<CursorPush> {
  if (fromRead.error) {
    return { supported: false, reason: `primary unreadable: ${fromRead.error}`, repos: [], results: [] };
  }
  if (sources === undefined) {
    return {
      supported: false,
      reason: "primary can't supply github source repos for `npx plugins` — run `syncthis mirror claude` to populate cursor",
      repos: [],
      results: [],
    };
  }
  if (sources === null) {
    return {
      supported: false,
      reason: "couldn't read the primary's marketplaces (`claude plugin marketplace list` failed) — cursor not updated",
      repos: [],
      results: [],
    };
  }
  const repos = [
    ...new Set(
      fromRead.plugins
        .map((p) => (p.marketplace ? sources.get(p.marketplace) : undefined))
        .filter((r): r is string => !!r && isSafeRepoSlug(r)),
    ),
  ].sort();

  if (!apply) return { supported: true, repos, results: [] };

  const results: CursorPushResult[] = [];
  for (const repo of repos) {
    const res = await run("npx", ["plugins", "add", repo, "--target", "cursor", "-y"], {
      timeoutMs: CURSOR_PLUGINS_TIMEOUT_MS,
    });
    if (res.notFound) {
      results.push({ repo, status: "failed", message: "`npx plugins` not found on PATH" });
      continue;
    }
    if (res.timedOut) {
      results.push({ repo, status: "failed", message: `timed out after ${CURSOR_PLUGINS_TIMEOUT_MS / 1000}s` });
      continue;
    }
    if (!res.ok) {
      results.push({ repo, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` });
      continue;
    }
    results.push({ repo, status: "installed" });
  }
  return { supported: true, repos, results };
}

export function mirrorHasChanges(report: MirrorReport): boolean {
  return (
    report.targets.some((t) => t.diff && (t.diff.add.length > 0 || t.diff.remove.length > 0)) ||
    report.cursor.repos.length > 0
  );
}
