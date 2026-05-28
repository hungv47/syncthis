import { expandHome } from "../io.ts";
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

const CONFIG_PATH = "~/.claude.json";

type ClaudePluginListItem = {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
};

function resolvedConfigPath(): string {
  return expandHome(CONFIG_PATH);
}

export const claudePluginAdapter: PluginAdapter = {
  id: "claude-code",
  configPath: resolvedConfigPath,
  async read(): Promise<PluginAdapterRead> {
    const base: PluginAdapterRead = {
      agent: "claude-code",
      configPath: resolvedConfigPath(),
      exists: false,
      plugins: [],
    };

    const pluginsRes = await run("claude", ["plugin", "list", "--json"]);
    if (pluginsRes.notFound) return { ...base, error: "claude CLI not found on PATH" };
    if (!pluginsRes.ok) return { ...base, error: pluginsRes.stderr.trim() || `claude plugin list exit ${pluginsRes.exitCode}` };

    let pluginsRaw: ClaudePluginListItem[] = [];
    try {
      pluginsRaw = JSON.parse(pluginsRes.stdout || "[]");
    } catch (err) {
      return { ...base, error: `claude plugin list: invalid JSON (${(err as Error).message})` };
    }

    const plugins: PluginRecord[] = pluginsRaw.map((p) => {
      const { name, marketplace } = parsePluginId(p.id);
      return {
        name,
        marketplace,
        version: p.version,
        enabled: p.enabled,
        scope: p.scope,
        path: p.installPath,
      };
    });

    return { ...base, exists: true, plugins };
  },

  async installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult> {
    try {
      assertSafeIdentifier(name, "plugin name");
      if (opts.marketplace) assertSafeIdentifier(opts.marketplace, "marketplace name");
    } catch (err) {
      return { agent: "claude-code", target: name, status: "failed", message: (err as Error).message };
    }
    const target = opts.marketplace ? `${name}@${opts.marketplace}` : name;
    // Skip if already present in the canonical identity.
    const read = await this.read();
    if (!read.error) {
      const found = read.plugins.find((p) => p.name === name && (!opts.marketplace || p.marketplace === opts.marketplace));
      if (found) return { agent: "claude-code", target, status: "present" };
    }
    if (opts.dryRun) return { agent: "claude-code", target, status: "installed", message: "dry-run" };
    const res = await run("claude", ["plugin", "install", "--yes", "--", target]);
    if (res.notFound) return { agent: "claude-code", target, status: "failed", message: "claude CLI not found" };
    if (!res.ok) return { agent: "claude-code", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    return { agent: "claude-code", target, status: "installed" };
  },

  async removePlugin(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult> {
    const read = await this.read();
    if (read.error) return { agent: "claude-code", target: name, status: "failed", message: read.error };
    // Accept bare name or fully-qualified <name>@<marketplace>.
    const { name: bare, marketplace: explicitMkt } = parsePluginId(name);
    try {
      assertSafeIdentifier(bare, "plugin name");
      if (explicitMkt) assertSafeIdentifier(explicitMkt, "marketplace name");
    } catch (err) {
      return { agent: "claude-code", target: name, status: "failed", message: (err as Error).message };
    }
    const matches = read.plugins.filter(
      (p) => p.name === bare && (!explicitMkt || p.marketplace === explicitMkt),
    );
    if (matches.length === 0) return { agent: "claude-code", target: name, status: "absent" };
    if (matches.length > 1) {
      return {
        agent: "claude-code",
        target: name,
        status: "failed",
        message: `ambiguous — installed under multiple marketplaces: ${matches.map((m) => m.marketplace).join(", ")}. Pass <name>@<marketplace> to disambiguate.`,
      };
    }
    const match = matches[0]!;
    const target = match.marketplace ? `${match.name}@${match.marketplace}` : match.name;
    if (opts.dryRun) return { agent: "claude-code", target, status: "removed", message: "dry-run" };
    const args = ["plugin", "uninstall", "--yes"];
    if (opts.prune) args.push("--prune");
    args.push("--", target);
    const res = await run("claude", args);
    if (res.notFound) return { agent: "claude-code", target, status: "failed", message: "claude CLI not found" };
    if (!res.ok) return { agent: "claude-code", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    return { agent: "claude-code", target, status: "removed" };
  },
};
