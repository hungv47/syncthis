import { join } from "node:path";
import { expandHome } from "../io.ts";
import { assertSafeIdentifier, parsePluginId, run, safeRmUnder } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginRecord,
  PluginRemoveOpts,
  PluginRemoveResult,
  MarketplaceRecord,
} from "./types.ts";

const CONFIG_PATH = "~/.claude.json";

type ClaudePluginListItem = {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
};

type ClaudeMarketplaceItem = {
  name: string;
  source?: string;
  repo?: string;
  url?: string;
  path?: string;
  installLocation?: string;
};

function resolvedConfigPath(): string {
  return expandHome(CONFIG_PATH);
}

function claudePluginsRoot(): string {
  return expandHome("~/.claude/plugins");
}

function toMarketplaceRecord(item: ClaudeMarketplaceItem): MarketplaceRecord {
  if (item.source === "github" && item.repo) {
    return { name: item.name, source: `github:${item.repo}`, sourceType: "github" };
  }
  if (item.url) return { name: item.name, source: item.url, sourceType: "git" };
  if (item.path) return { name: item.name, source: item.path, sourceType: "local" };
  // Fallback: stringify whatever we got so the source field is non-empty.
  const source = item.source ?? item.installLocation ?? "";
  return { name: item.name, source, sourceType: "unknown" };
}

export const claudePluginAdapter: PluginAdapter = {
  id: "claude-code",
  pluginKind: "bundle",
  supportsMarketplaces: true,
  configPath: resolvedConfigPath,
  async read(): Promise<PluginAdapterRead> {
    const base: PluginAdapterRead = {
      agent: "claude-code",
      configPath: resolvedConfigPath(),
      exists: false,
      supportsPlugins: true,
      supportsMarketplaces: true,
      pluginKind: "bundle",
      plugins: [],
      marketplaces: [],
    };

    // The two list calls are independent; run them in parallel.
    const [pluginsRes, marketRes] = await Promise.all([
      run("claude", ["plugin", "list", "--json"]),
      run("claude", ["plugin", "marketplace", "list", "--json"]),
    ]);

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
        kind: "bundle",
      };
    });

    let marketplaces: MarketplaceRecord[] = [];
    if (marketRes.ok) {
      try {
        const raw = JSON.parse(marketRes.stdout || "[]") as ClaudeMarketplaceItem[];
        marketplaces = raw.map(toMarketplaceRecord);
      } catch {
        // Surface plugin data even if marketplace JSON is malformed.
      }
    }

    return {
      ...base,
      exists: true,
      plugins,
      marketplaces,
    };
  },

  async removePlugin(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult> {
    const read = await this.read();
    if (read.error) return { agent: "claude-code", target: name, status: "failed", message: read.error };
    // Accept bare name or fully-qualified <name>@<marketplace>. Parse the input first
    // so a bare match doesn't short-circuit a fully-qualified request.
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
    if (opts.dryRun) {
      return { agent: "claude-code", target, status: "removed", message: "dry-run" };
    }
    // `--` separates flags from positional args — defense in depth against any
    // future plugin name that happens to start with `-`.
    const args = ["plugin", "uninstall", "--yes"];
    if (opts.prune) args.push("--prune");
    args.push("--", target);
    const res = await run("claude", args);
    if (res.notFound) return { agent: "claude-code", target, status: "failed", message: "claude CLI not found" };
    if (!res.ok) return { agent: "claude-code", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    let message: string | undefined;
    if (opts.purge) {
      if (!match.path) {
        message = "purge skipped: claude did not report an installPath for this plugin";
      } else {
        const sweep = await safeRmUnder(match.path, claudePluginsRoot());
        if (sweep.removed) message = `purged ${match.path}`;
        else if (sweep.message === "absent") message = "purge: install dir already gone";
        else message = `purge skipped: ${sweep.message}`;
      }
    }
    return { agent: "claude-code", target, status: "removed", message };
  },

  async removeMarketplace(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult> {
    try {
      assertSafeIdentifier(name, "marketplace name");
    } catch (err) {
      return { agent: "claude-code", target: name, status: "failed", message: (err as Error).message };
    }
    const read = await this.read();
    if (read.error) return { agent: "claude-code", target: name, status: "failed", message: read.error };
    const found = read.marketplaces.find((m) => m.name === name);
    const root = claudePluginsRoot();
    const marketplaceDir = join(root, "marketplaces", name);
    const cacheDir = join(root, "cache", name);

    // If the registration is absent but --purge was requested AND we can see
    // residual on-disk dirs, sweep them and report as removed. This handles
    // the orphan case the user just hit.
    if (!found) {
      if (!opts.purge) return { agent: "claude-code", target: name, status: "absent" };
      const swept: string[] = [];
      for (const dir of [marketplaceDir, cacheDir]) {
        if (opts.dryRun) {
          // We can't tell at dry-run time whether the dir exists without stat,
          // so be honest and report what we'd attempt.
          swept.push(`${dir} (if present)`);
        } else {
          const r = await safeRmUnder(dir, root);
          if (r.removed) swept.push(dir);
        }
      }
      if (swept.length === 0) return { agent: "claude-code", target: name, status: "absent" };
      return {
        agent: "claude-code",
        target: name,
        status: "removed",
        message: opts.dryRun ? `purge ${swept.join(", ")}` : `purged ${swept.join(", ")} (registration was already absent)`,
      };
    }

    if (opts.dryRun) {
      const note = opts.purge ? " + purge marketplace/cache dirs" : "";
      return { agent: "claude-code", target: name, status: "removed", message: `dry-run${note}` };
    }
    const res = await run("claude", ["plugin", "marketplace", "remove", "--", name]);
    if (res.notFound) return { agent: "claude-code", target: name, status: "failed", message: "claude CLI not found" };
    if (!res.ok) return { agent: "claude-code", target: name, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    let message: string | undefined;
    if (opts.purge) {
      const swept: string[] = [];
      const skipped: string[] = [];
      for (const dir of [marketplaceDir, cacheDir]) {
        const r = await safeRmUnder(dir, root);
        if (r.removed) swept.push(dir);
        else if (r.message !== "absent") skipped.push(`${dir} (${r.message})`);
      }
      const parts: string[] = [];
      if (swept.length) parts.push(`purged ${swept.join(", ")}`);
      if (skipped.length) parts.push(`skipped ${skipped.join(", ")}`);
      message = parts.length ? parts.join("; ") : undefined;
    }
    return { agent: "claude-code", target: name, status: "removed", message };
  },
};
