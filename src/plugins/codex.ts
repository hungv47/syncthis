import * as TOML from "smol-toml";
import { expandHome, readText } from "../io.ts";
import { assertSafeIdentifier, parsePluginId, run } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallOpts,
  PluginInstallResult,
  PluginRecord,
  PluginRemoveOpts,
  PluginRemoveResult,
} from "./types.ts";

const CONFIG_PATH = "~/.codex/config.toml";

function resolvedConfigPath(): string {
  return expandHome(CONFIG_PATH);
}

export const codexPluginAdapter: PluginAdapter = {
  id: "codex",
  configPath: resolvedConfigPath,
  async read(): Promise<PluginAdapterRead> {
    const configPath = resolvedConfigPath();
    const base: PluginAdapterRead = {
      agent: "codex",
      configPath,
      exists: false,
      plugins: [],
    };

    const text = await readText(configPath);
    if (text === null) return base;

    let parsed: Record<string, unknown>;
    try {
      parsed = text.trim() ? (TOML.parse(text) as Record<string, unknown>) : {};
    } catch (err) {
      return { ...base, exists: true, error: `parse failed: ${(err as Error).message}` };
    }

    const plugins: PluginRecord[] = [];
    const pluginsTable = parsed.plugins;
    if (pluginsTable && typeof pluginsTable === "object" && !Array.isArray(pluginsTable)) {
      for (const [id, value] of Object.entries(pluginsTable as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const { name, marketplace } = parsePluginId(id);
        const v = value as Record<string, unknown>;
        plugins.push({
          name,
          marketplace,
          enabled: typeof v.enabled === "boolean" ? v.enabled : undefined,
        });
      }
    }

    return { ...base, exists: true, plugins };
  },

  async installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult> {
    try {
      assertSafeIdentifier(name, "plugin name");
      if (opts.marketplace) assertSafeIdentifier(opts.marketplace, "marketplace name");
    } catch (err) {
      return { agent: "codex", target: name, status: "failed", message: (err as Error).message };
    }
    const target = opts.marketplace ? `${name}@${opts.marketplace}` : name;
    const read = await this.read();
    if (!read.error) {
      const found = read.plugins.find((p) => p.name === name && (!opts.marketplace || p.marketplace === opts.marketplace));
      if (found) return { agent: "codex", target, status: "present" };
    }
    if (opts.dryRun) return { agent: "codex", target, status: "installed", message: "dry-run" };
    const res = await run("codex", ["plugin", "add", "--", target]);
    if (res.notFound) return { agent: "codex", target, status: "failed", message: "codex CLI not found" };
    if (!res.ok) return { agent: "codex", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    return { agent: "codex", target, status: "installed" };
  },

  async removePlugin(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult> {
    const read = await this.read();
    if (read.error) return { agent: "codex", target: name, status: "failed", message: read.error };
    const { name: bare, marketplace: explicitMkt } = parsePluginId(name);
    try {
      assertSafeIdentifier(bare, "plugin name");
      if (explicitMkt) assertSafeIdentifier(explicitMkt, "marketplace name");
    } catch (err) {
      return { agent: "codex", target: name, status: "failed", message: (err as Error).message };
    }
    const matches = read.plugins.filter((p) => p.name === bare && (!explicitMkt || p.marketplace === explicitMkt));
    if (matches.length === 0) return { agent: "codex", target: name, status: "absent" };
    if (matches.length > 1) {
      return {
        agent: "codex",
        target: name,
        status: "failed",
        message: `ambiguous — installed under multiple marketplaces: ${matches.map((m) => m.marketplace).join(", ")}. Pass <name>@<marketplace> to disambiguate.`,
      };
    }
    const match = matches[0]!;
    const target = match.marketplace ? `${match.name}@${match.marketplace}` : match.name;
    if (opts.dryRun) return { agent: "codex", target, status: "removed", message: "dry-run" };
    const res = await run("codex", ["plugin", "remove", "--", target]);
    if (res.notFound) return { agent: "codex", target, status: "failed", message: "codex CLI not found" };
    if (!res.ok) return { agent: "codex", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    return { agent: "codex", target, status: "removed" };
  },
};
