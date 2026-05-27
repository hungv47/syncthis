import type { AgentId } from "../types.ts";

// A plugin name as understood by the agent.
// For Claude/Codex: bare name plus optional @marketplace (e.g. "vercel-plugin@plugins-cli").
// For Cursor: directory name under ~/.cursor/plugins/<scope>/ (may include owner prefix).
// For OpenCode: npm package specifier ("@scope/pkg" or "pkg").
export type PluginKind = "bundle" | "npm";

export type PluginRecord = {
  name: string;
  marketplace?: string;
  version?: string;
  enabled?: boolean;
  scope?: string;
  path?: string;
  kind: PluginKind;
};

export type MarketplaceSourceType = "git" | "local" | "github" | "unknown";

export type MarketplaceRecord = {
  name: string;
  source: string;
  sourceType: MarketplaceSourceType;
};

export type PluginAdapterRead = {
  agent: AgentId;
  configPath: string;
  exists: boolean;
  supportsPlugins: boolean;
  supportsMarketplaces: boolean;
  pluginKind: PluginKind;
  plugins: PluginRecord[];
  marketplaces: MarketplaceRecord[];
  error?: string;
};

export type PluginRemoveOpts = {
  dryRun: boolean;
  prune?: boolean;
  // When true, also rm -rf the on-disk cache directory(ies) that the agent
  // leaves behind after a registration-only uninstall. Off by default.
  purge?: boolean;
};

export type RemoveStatus = "removed" | "absent" | "skipped" | "failed";

export type PluginRemoveResult = {
  agent: AgentId;
  target: string;
  status: RemoveStatus;
  message?: string;
};

export interface PluginAdapter {
  id: AgentId;
  pluginKind: PluginKind;
  supportsMarketplaces: boolean;
  configPath(): string;
  read(): Promise<PluginAdapterRead>;
  removePlugin?(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult>;
  removeMarketplace?(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult>;
}
