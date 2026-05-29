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

export type PluginRemoveOpts = {
  dryRun: boolean;
  prune?: boolean;
};

export type RemoveStatus = "removed" | "absent" | "skipped" | "failed";

export type PluginRemoveResult = {
  agent: AgentId;
  target: string;
  status: RemoveStatus;
  message?: string;
};

export type PluginInstallOpts = {
  dryRun: boolean;
  marketplace?: string;
  // When true, a target may register a missing marketplace before installing
  // (e.g. Codex shells `npx plugins add <sourceRepo> --target codex`). Off by
  // default — additive native installs only, no out-of-band provisioning.
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
  // Mirror layer. installPlugin pushes primary's plugins onto a target;
  // removePlugin backs the `--remove-stale` path. Both are required: only agents
  // with a native install CLI are in the cohort, so every member can do both.
  installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult>;
  removePlugin(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult>;
}
