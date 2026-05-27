import { expandHome, readJson, writeJson } from "../io.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginRecord,
  PluginRemoveOpts,
  PluginRemoveResult,
} from "./types.ts";

const CONFIG_PATH = "~/.config/opencode/opencode.json";

function resolvedConfigPath(): string {
  return expandHome(CONFIG_PATH);
}

type OpencodeConfig = {
  plugin?: string[];
  [key: string]: unknown;
};

export const opencodePluginAdapter: PluginAdapter = {
  id: "opencode",
  // OpenCode plugins are npm modules, not GitHub bundles. Cross-format
  // mirroring with Claude/Codex/Cursor is intentionally not supported.
  pluginKind: "npm",
  supportsMarketplaces: false,
  configPath: resolvedConfigPath,
  async read(): Promise<PluginAdapterRead> {
    const configPath = resolvedConfigPath();
    const base: PluginAdapterRead = {
      agent: "opencode",
      configPath,
      exists: false,
      supportsPlugins: true,
      supportsMarketplaces: false,
      pluginKind: "npm",
      plugins: [],
      marketplaces: [],
    };

    const config = await readJson<OpencodeConfig>(configPath);
    if (config === null) return base;

    const list = Array.isArray(config.plugin) ? config.plugin : [];
    const plugins: PluginRecord[] = list
      .filter((p): p is string => typeof p === "string")
      .map((name) => ({ name, kind: "npm" }));

    return { ...base, exists: true, plugins };
  },

  async removePlugin(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult> {
    const configPath = resolvedConfigPath();
    const config = await readJson<OpencodeConfig>(configPath);
    if (config === null) return { agent: "opencode", target: name, status: "absent", message: "no config" };
    const current = Array.isArray(config.plugin) ? config.plugin : [];
    if (!current.includes(name)) return { agent: "opencode", target: name, status: "absent" };
    if (opts.dryRun) return { agent: "opencode", target: name, status: "removed", message: "dry-run" };
    try {
      const next = { ...config, plugin: current.filter((p) => p !== name) };
      await writeJson(configPath, next, { backup: true });
      return { agent: "opencode", target: name, status: "removed" };
    } catch (err) {
      return { agent: "opencode", target: name, status: "failed", message: (err as Error).message };
    }
  },
};
