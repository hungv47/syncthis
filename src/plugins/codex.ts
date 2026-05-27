import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "smol-toml";
import { expandHome, readText } from "../io.ts";
import { assertSafeIdentifier, isSafeIdentifier, parsePluginId, run, safeRmUnder } from "./shell.ts";
import type {
  MarketplaceRecord,
  MarketplaceSourceType,
  PluginAdapter,
  PluginAdapterRead,
  PluginRecord,
  PluginRemoveOpts,
  PluginRemoveResult,
} from "./types.ts";

const CONFIG_PATH = "~/.codex/config.toml";

function resolvedConfigPath(): string {
  return expandHome(CONFIG_PATH);
}

function codexCacheRoot(): string {
  return expandHome("~/.codex/plugins/cache");
}

// Find any cache dirs holding this plugin name. Codex organizes its cache as
// <cache-root>/<upstream-repo>/<plugin>/<sha>/, but the upstream-repo segment
// does not always match the marketplace name (e.g. `apollo@plugins-cli` from
// `knowledge-work-plugins` upstream lives at cache/knowledge-work-plugins/apollo/).
// So we glob the marketplaces and return paths whose <plugin> matches.
async function findCodexPluginDirs(pluginName: string): Promise<string[]> {
  // Defense in depth: even though the caller validates the user's CLI input,
  // pluginName here comes from the codex config.toml plugin records. A
  // malicious or malformed config key could still inject path separators.
  // Reject before any join().
  if (!isSafeIdentifier(pluginName)) return [];
  const root = codexCacheRoot();
  let owners: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    owners = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const owner of owners) {
    const candidate = join(root, owner, pluginName);
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      // If this dir has subdirs at all, treat it as a plugin install dir.
      if (entries.some((e) => e.isDirectory())) matches.push(candidate);
    } catch {
      // not present under this owner — skip
    }
  }
  return matches;
}

function classifySourceType(raw: unknown): MarketplaceSourceType {
  if (raw === "git") return "git";
  if (raw === "local") return "local";
  if (raw === "github") return "github";
  return "unknown";
}

export const codexPluginAdapter: PluginAdapter = {
  id: "codex",
  pluginKind: "bundle",
  supportsMarketplaces: true,
  configPath: resolvedConfigPath,
  async read(): Promise<PluginAdapterRead> {
    const configPath = resolvedConfigPath();
    const base: PluginAdapterRead = {
      agent: "codex",
      configPath,
      exists: false,
      supportsPlugins: true,
      supportsMarketplaces: true,
      pluginKind: "bundle",
      plugins: [],
      marketplaces: [],
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
          kind: "bundle",
        });
      }
    }

    const marketplaces: MarketplaceRecord[] = [];
    const marketTable = parsed.marketplaces;
    if (marketTable && typeof marketTable === "object" && !Array.isArray(marketTable)) {
      for (const [name, value] of Object.entries(marketTable as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const v = value as Record<string, unknown>;
        const source = typeof v.source === "string" ? v.source : "";
        marketplaces.push({
          name,
          source,
          sourceType: classifySourceType(v.source_type),
        });
      }
    }

    return { ...base, exists: true, plugins, marketplaces };
  },

  async removePlugin(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult> {
    const read = await this.read();
    if (read.error) return { agent: "codex", target: name, status: "failed", message: read.error };
    // Accept bare name or fully-qualified <name>@<marketplace>.
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
    let message: string | undefined;
    if (opts.purge) {
      const dirs = await findCodexPluginDirs(match.name);
      const swept: string[] = [];
      for (const dir of dirs) {
        const r = await safeRmUnder(dir, codexCacheRoot());
        if (r.removed) swept.push(dir);
      }
      if (swept.length) message = `purged ${swept.join(", ")}`;
    }
    return { agent: "codex", target, status: "removed", message };
  },

  async removeMarketplace(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult> {
    try {
      assertSafeIdentifier(name, "marketplace name");
    } catch (err) {
      return { agent: "codex", target: name, status: "failed", message: (err as Error).message };
    }
    const read = await this.read();
    if (read.error) return { agent: "codex", target: name, status: "failed", message: read.error };
    const found = read.marketplaces.find((m) => m.name === name);
    const cacheDir = join(codexCacheRoot(), name);

    if (!found) {
      if (!opts.purge) return { agent: "codex", target: name, status: "absent" };
      if (opts.dryRun) {
        return {
          agent: "codex",
          target: name,
          status: "removed",
          message: `purge ${cacheDir} (if present)`,
        };
      }
      const r = await safeRmUnder(cacheDir, codexCacheRoot());
      if (r.removed) {
        return { agent: "codex", target: name, status: "removed", message: `purged ${cacheDir} (registration was already absent)` };
      }
      return { agent: "codex", target: name, status: "absent" };
    }

    if (opts.dryRun) {
      const note = opts.purge ? " + purge cache dir" : "";
      return { agent: "codex", target: name, status: "removed", message: `dry-run${note}` };
    }
    const res = await run("codex", ["plugin", "marketplace", "remove", "--", name]);
    if (res.notFound) return { agent: "codex", target: name, status: "failed", message: "codex CLI not found" };
    if (!res.ok) return { agent: "codex", target: name, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    let message: string | undefined;
    if (opts.purge) {
      const r = await safeRmUnder(cacheDir, codexCacheRoot());
      if (r.removed) message = `purged ${cacheDir}`;
      else if (r.message !== "absent") message = `purge skipped: ${r.message}`;
    }
    return { agent: "codex", target: name, status: "removed", message };
  },
};
