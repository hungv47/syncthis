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
  // Mirror layer. installPlugin pushes primary's plugins onto a target;
  // removePlugin backs the `--remove-stale` path. Both are required: only agents
  // with a native install CLI are in the cohort, so every member can do both.
  installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult>;
  removePlugin(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult>;
}
