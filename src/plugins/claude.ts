import { expandHome } from "../io.ts";
import { assertSafeIdentifier, parsePluginId, run } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallOpts,
  PluginInstallResult,
  PluginRecord,
} from "./types.ts";

const CONFIG_PATH = "~/.claude.json";

type ClaudePluginListItem = {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
};

// The `claude` CLI loads every plugin/MCP on startup, so a cold invocation can run
// several seconds (occasionally >15s on a loaded machine with many marketplaces).
// The default 15s `run()` timeout is too tight for it. Give reads generous
// headroom so transient cold-start slowness does not abort a mirror; installs may
// also clone, so they get longer.
const READ_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 180_000;

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

    const pluginsRes = await run("claude", ["plugin", "list", "--json"], { timeoutMs: READ_TIMEOUT_MS });
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

  // marketplace name → "owner/repo" for Claude's registered github marketplaces.
  // Lets the mirror tell a target (Codex) where to provision a plugin whose
  // marketplace it lacks. Local/non-github sources are omitted (no repo to add).
  async marketplaceSources(): Promise<Map<string, string> | null> {
    const map = new Map<string, string>();
    const res = await run("claude", ["plugin", "marketplace", "list", "--json"], { timeoutMs: READ_TIMEOUT_MS });
    if (!res.ok) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(res.stdout || "[]");
    } catch {
      return null;
    }
    if (!Array.isArray(raw)) return null;
    for (const m of raw as Array<{ name?: string; source?: string; repo?: string }>) {
      if (m.name && m.source === "github" && m.repo) map.set(m.name, m.repo);
    }
    return map;
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
    const res = await run("claude", ["plugin", "install", "--yes", "--", target], { timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.notFound) return { agent: "claude-code", target, status: "failed", message: "claude CLI not found" };
    if (!res.ok) return { agent: "claude-code", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    return { agent: "claude-code", target, status: "installed" };
  },
};
