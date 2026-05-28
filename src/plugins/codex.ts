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

const CONFIG_PATH = "~/.codex/config.toml";

function resolvedConfigPath(): string {
  return expandHome(CONFIG_PATH);
}

// The vercel-labs `npx plugins` marketplace — the cross-agent ecosystem syncthis
// mirrors. Preferred when a bare plugin name is ambiguous across Codex
// marketplaces (e.g. also present in an OpenAI-bundled/curated one).
const PREFERRED_MARKETPLACE = "plugins-cli";

type CodexCols = { plugin: number; status: number; version: number; path: number };

// `codex plugin list` prints a fixed-width table per registered marketplace:
//
//   Marketplace `plugins-cli`
//   /path/to/marketplace.json
//
//   PLUGIN              STATUS              VERSION  PATH
//   foo@plugins-cli     not installed                /cache/foo
//   bar@plugins-cli     installed, enabled  1.2.3    /cache/bar
//
// Column widths vary per section, so we re-derive column offsets from each
// header row and slice data rows by those offsets — STATUS values contain
// spaces ("not installed", "installed, enabled") so naive whitespace splitting
// is wrong.
function headerCols(line: string): CodexCols | null {
  const plugin = line.indexOf("PLUGIN");
  const status = line.indexOf("STATUS");
  const version = line.indexOf("VERSION");
  const path = line.indexOf("PATH");
  if (plugin !== 0 || status < 0 || version < 0 || path < 0) return null;
  return { plugin, status, version, path };
}

type CodexListRow = PluginRecord & { installed: boolean };

// Parse every row of `codex plugin list` (installed AND not-installed), each
// tagged with its marketplace (from the PLUGIN column id) and whether Codex
// actually has it installed. Not-installed rows still tell us which marketplace
// can provide a plugin — needed to resolve a bare name to <name>@<marketplace>
// for `codex plugin add`.
function parseCodexListRows(text: string): CodexListRow[] {
  const out: CodexListRow[] = [];
  let cols: CodexCols | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (line.startsWith("Marketplace ")) {
      cols = null;
      continue;
    }
    const header = headerCols(line);
    if (header) {
      cols = header;
      continue;
    }
    if (!cols) continue; // marketplace path line / pre-header noise
    const id = line.slice(cols.plugin, cols.status).trim();
    const status = line.slice(cols.status, cols.version).trim();
    const version = line.slice(cols.version, cols.path).trim();
    const path = line.slice(cols.path).trim();
    if (!id) continue;
    const installed = /^installed\b/i.test(status); // "installed, enabled" — not "not installed"
    const enabled = !installed ? undefined : /\benabled\b/i.test(status) ? true : /\bdisabled\b/i.test(status) ? false : undefined;
    const { name, marketplace } = parsePluginId(id);
    out.push({ name, marketplace, version: version || undefined, enabled, path: path || undefined, installed });
  }
  return out;
}

// Records for the *installed* plugins only. Codex registers many plugins in
// config/cache that it does not actually load ("not installed"); the only state
// Codex uses is what this table reports as installed, so that is the set we
// treat as present.
export function parseCodexPluginList(text: string): PluginRecord[] {
  return parseCodexListRows(text)
    .filter((r) => r.installed)
    .map((r) => ({ name: r.name, marketplace: r.marketplace, version: r.version, enabled: r.enabled, path: r.path }));
}

export const codexPluginAdapter: PluginAdapter = {
  id: "codex",
  configPath: resolvedConfigPath,
  async read(): Promise<PluginAdapterRead> {
    const base: PluginAdapterRead = {
      agent: "codex",
      configPath: resolvedConfigPath(),
      exists: false,
      plugins: [],
    };

    const res = await run("codex", ["plugin", "list"]);
    if (res.notFound) return { ...base, error: "codex CLI not found on PATH" };
    if (!res.ok) return { ...base, error: res.stderr.trim() || `codex plugin list exit ${res.exitCode}` };

    return { ...base, exists: true, plugins: parseCodexPluginList(res.stdout || "") };
  },

  async installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult> {
    try {
      assertSafeIdentifier(name, "plugin name");
      if (opts.marketplace) assertSafeIdentifier(opts.marketplace, "marketplace name");
    } catch (err) {
      return { agent: "codex", target: name, status: "failed", message: (err as Error).message };
    }

    const listRes = await run("codex", ["plugin", "list"]);
    if (listRes.notFound) return { agent: "codex", target: name, status: "failed", message: "codex CLI not found" };
    const rows = listRes.ok ? parseCodexListRows(listRes.stdout || "") : [];

    // Already installed? (real install state, not config registration.)
    const present = rows.find(
      (r) => r.installed && r.name === name && (!opts.marketplace || r.marketplace === opts.marketplace),
    );
    if (present) {
      return { agent: "codex", target: present.marketplace ? `${name}@${present.marketplace}` : name, status: "present" };
    }

    // `codex plugin add` rejects a bare name — it needs <name>@<marketplace>.
    // The source agent's marketplace tag doesn't exist in Codex, so resolve the
    // marketplace from Codex's own snapshot (any plugin-list row for this name).
    let marketplace = opts.marketplace;
    if (!marketplace) {
      if (!listRes.ok) {
        return {
          agent: "codex",
          target: name,
          status: "failed",
          message: `cannot resolve marketplace — codex plugin list failed: ${listRes.stderr.trim() || `exit ${listRes.exitCode}`}`,
        };
      }
      const candidates = [...new Set(rows.filter((r) => r.name === name && r.marketplace).map((r) => r.marketplace as string))];
      if (candidates.length === 1) {
        marketplace = candidates[0];
      } else if (candidates.length === 0) {
        // Not a failure — Codex simply has no marketplace that provides this
        // plugin, so there is nothing to attempt. Skip with a reason.
        return {
          agent: "codex",
          target: name,
          status: "skipped",
          message: "no registered Codex marketplace provides it — add its marketplace first (codex plugin marketplace add ...)",
        };
      } else if (candidates.includes(PREFERRED_MARKETPLACE)) {
        // Ambiguous, but prefer plugins-cli — the npx-plugins ecosystem these
        // Claude plugins came from — over Codex/OpenAI-bundled marketplaces.
        marketplace = PREFERRED_MARKETPLACE;
      } else {
        return {
          agent: "codex",
          target: name,
          status: "skipped",
          message: `ambiguous across Codex marketplaces (${candidates.join(", ")}) — pass <name>@<marketplace> to choose`,
        };
      }
    }

    const target = `${name}@${marketplace}`;
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
