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
};

export type InstallStatus = "installed" | "present" | "skipped" | "failed";

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
  // Mirror layer: push the primary's plugins onto a target. Additive only — there
  // is intentionally no removePlugin. syncthis never uninstalls a plugin (a mirror
  // can only add), so a sync mistake can't wipe an agent's plugins.
  installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult>;
}
