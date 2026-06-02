import type { AgentId } from "../types.ts";

// A plugin name as understood by the agent.
// For Claude/Codex: bare name plus optional @marketplace (e.g. "vercel-plugin@plugins-cli").
export type PluginRecord = {
  name: string;
  marketplace?: string;
  version?: string;
  enabled?: boolean;
  scope?: string;
  path?: string;
  // owner/repo source of this plugin's marketplace (when known). Used by the
  // provision path to register the marketplace on a target that lacks it.
  sourceRepo?: string;
};

export type PluginAdapterRead = {
  agent: AgentId;
  configPath: string;
  exists: boolean;
  plugins: PluginRecord[];
  error?: string;
};

export type PluginInstallOpts = {
  dryRun: boolean;
  marketplace?: string;
  // When true, a target may register a missing marketplace before installing
  // (e.g. Codex shells `npx plugins add <sourceRepo> --target codex`). The mirror
  // sets this on by default now (matched by a `--no-provision` opt-out) — making a
  // plugin's content actually reachable on the target is the point of a mirror.
  provision?: boolean;
  // owner/repo to provision from, when the plugin's marketplace isn't registered
  // on the target. Supplied by the mirror from the primary's marketplace list.
  sourceRepo?: string;
  // Absolute path to the SOURCE agent's local marketplace clone for this plugin
  // (e.g. ~/.claude/plugins/marketplaces/<mkt>). When present, the target installs
  // by registering this clone via `<target> plugin marketplace add <path>` and
  // installing `<name>@<marketplace>` from it — network-free, and the preferred path
  // over `npx plugins` provisioning. `sourceRepo` stays the fallback when no clone
  // exists. See src/plugins/marketplace.ts.
  sourceClonePath?: string;
};

export type PluginUninstallOpts = {
  dryRun: boolean;
  // Disambiguate when the same plugin name is installed from more than one
  // marketplace on the target. Optional — the adapter resolves it from the
  // installed snapshot when there's only one.
  marketplace?: string;
  // Claude only: pass `--keep-data` so the plugin's persistent data dir survives
  // the uninstall. Off by default (a plain uninstall removes data too).
  keepData?: boolean;
};

export type InstallStatus = "installed" | "present" | "skipped" | "failed";

// "absent" = the plugin wasn't installed on this agent, so nothing was removed (not
// a failure). "skipped" = couldn't act unambiguously (e.g. installed under several
// marketplaces — needs <name>@<marketplace>).
export type UninstallStatus = "uninstalled" | "absent" | "skipped" | "failed";

export type PluginUninstallResult = {
  agent: AgentId;
  target: string;
  status: UninstallStatus;
  message?: string;
};

export type PluginInstallResult = {
  agent: AgentId;
  target: string;
  status: InstallStatus;
  message?: string;
  // Set on a `skipped` result when the plugin can't be installed natively here but
  // its skills can still be added loosely: the owner/repo to hand to `npx skills
  // add`. Today only Codex sets it — for a bundle whose plugin its loader never
  // exposes (skills-only), or an alias whose plugin.json name Codex rejects. The
  // mirror collects these and runs the skills fallback — but only for repos that
  // didn't already land as a real plugin on the target (no flat/namespaced dup).
  skillsFallbackRepo?: string;
  // Set on a `skipped` result when this Claude-side plugin name couldn't be added
  // under that name, but provisioning its source repo DID install the bundle on the
  // target under its canonical name (e.g. Claude's `github.com-foo-bar` → Codex's
  // `bar`), or a sibling alias of the same bundle already installed. Names the
  // covering plugin(s). No skills fallback — the content is already present.
  coveredBy?: string;
};

export interface PluginAdapter {
  id: AgentId;
  configPath(): string;
  read(): Promise<PluginAdapterRead>;
  // Optional: map of marketplace name → owner/repo for this agent's registered
  // marketplaces. The mirror uses the primary's map to tell a target where to
  // provision a plugin whose marketplace it lacks. Only agents that can report
  // marketplace sources implement it (currently Claude).
  // Returns null when the lookup failed (so callers can distinguish "couldn't read"
  // from "read fine, no github marketplaces" — an empty map).
  marketplaceSources?(): Promise<Map<string, string> | null>;
  // Mirror layer: push the primary's plugins onto a target. Additive only — a mirror
  // (and union sync) can only add, never remove, so a sync mistake can't wipe an
  // agent's plugins.
  installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult>;
  // Guarded removal: uninstall a single plugin from this agent. NEVER reached by
  // sync or mirror — only by the explicit `syncthis plugin rm` command, behind the
  // same rails as MCP `rm` (explicit scope, diff, TTY-confirm or --yes, --dry-run).
  uninstallPlugin(name: string, opts: PluginUninstallOpts): Promise<PluginUninstallResult>;
}
