import { expandHome } from "../io.ts";
import { assertSafeIdentifier, isSafeRepoSlug, parsePluginId, run } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallOpts,
  PluginInstallResult,
  PluginRecord,
  PluginUninstallOpts,
  PluginUninstallResult,
} from "./types.ts";

const CONFIG_PATH = "~/.codex/config.toml";

function resolvedConfigPath(): string {
  return expandHome(CONFIG_PATH);
}

// The vercel-labs `npx plugins` marketplace — the cross-agent ecosystem syncthis
// mirrors. Preferred when a bare plugin name is ambiguous across Codex
// marketplaces (e.g. also present in an OpenAI-bundled/curated one).
const PREFERRED_MARKETPLACE = "plugins-cli";

// `codex plugin list` is usually fast, but the default 15s `run()` timeout is too
// tight for a cold CLI start on a loaded machine — a timed-out read would look like
// "no plugins" and silently skip everything. `codex plugin add` may fetch, so longer.
const LIST_TIMEOUT_MS = 60_000;
const ADD_TIMEOUT_MS = 180_000;
// `codex plugin remove` only edits local config + prunes the cache — no fetch — so
// it doesn't need the install path's long fetch headroom, but keep generous slack
// over the cold-start default.
const REMOVE_TIMEOUT_MS = 60_000;

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

// Distinct marketplaces in the snapshot that carry a plugin of this name.
function marketplacesFor(rows: CodexListRow[], name: string): string[] {
  return [...new Set(rows.filter((r) => r.name === name && r.marketplace).map((r) => r.marketplace as string))];
}

// Keys (`name@marketplace`, or bare name) of the *installed* plugins in a snapshot.
// Used to diff before/after a provisioning `npx plugins add`: a multi-plugin repo
// installs its canonical plugin under the repo's own plugin.json name — which may
// differ from the Claude-side name we were asked for (e.g. Claude's
// `github.com-garrytan-gstack` vs the repo's `gstack`). The name we asked for then
// stays unresolvable, but the bundle IS on Codex as a plugin — so the diff, not the
// name lookup, is what tells us the content landed (and that no skills dup is due).
function installedKeys(rows: CodexListRow[]): Set<string> {
  return new Set(rows.filter((r) => r.installed).map((r) => (r.marketplace ? `${r.name}@${r.marketplace}` : r.name)));
}

// `codex plugin add <alias>@<mkt>` fails when the marketplace entry's name differs
// from the underlying plugin.json `name` — the shape of every multi-plugin
// marketplace that aliases one bundle under several discovery names (browserbase's
// browse/functions/safe-browser, expo's expo/expo-app-design/…, anthropics'
// document-skills/claude-api/…). Claude tolerates the mismatch and installs each
// alias; Codex hard-rejects it. So this is not a real failure — the canonical
// sibling carries the same bundle, and we fall the alias back to skills.
function isNameMismatch(stderr: string): boolean {
  return /does not match marketplace plugin name/i.test(stderr);
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

    const res = await run("codex", ["plugin", "list"], { timeoutMs: LIST_TIMEOUT_MS });
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

    const listRes = await run("codex", ["plugin", "list"], { timeoutMs: LIST_TIMEOUT_MS });
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
    // Plugins installed by a provisioning `npx plugins add` this call (canonical
    // names that may differ from the one we asked for). Hoisted so the name-mismatch
    // handler below can tell whether the bundle's canonical plugin just landed.
    let newlyInstalled: string[] = [];
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
      let candidates = marketplacesFor(rows, name);

      // No marketplace yet, but with provisioning (on by default) we can register
      // the plugin's source repo into Codex via the open-plugin installer, then
      // retry. `npx plugins add <repo> --target codex` also INSTALLS the repo's
      // canonical plugin — so after it, either this exact name resolves, or the
      // bundle landed under its own (different) name. Re-read and diff to tell.
      let provisioned = false;
      if (candidates.length === 0 && opts.provision && opts.sourceRepo && isSafeRepoSlug(opts.sourceRepo)) {
        if (opts.dryRun) {
          return { agent: "codex", target: `${name}@(${opts.sourceRepo})`, status: "installed", message: "dry-run (would provision)" };
        }
        const before = installedKeys(rows);
        const prov = await run("npx", ["plugins", "add", opts.sourceRepo, "--target", "codex", "-y"], { timeoutMs: 180_000 });
        if (prov.notFound) {
          return { agent: "codex", target: name, status: "skipped", message: "cannot provision — `npx plugins` not found" };
        }
        if (!prov.ok) {
          // The provision we were explicitly asked to do actually errored (bad
          // repo, network, auth, timeout) — surface the cause as a real failure,
          // not a benign skip, so it exits non-zero instead of looking like a no-op.
          return {
            agent: "codex",
            target: name,
            status: "failed",
            message: `provision failed (npx plugins add ${opts.sourceRepo}): ${prov.stderr.trim() || `exit ${prov.exitCode}`}`,
          };
        }
        provisioned = true;
        const reRead = await run("codex", ["plugin", "list"], { timeoutMs: LIST_TIMEOUT_MS });
        if (reRead.ok) {
          const afterRows = parseCodexListRows(reRead.stdout || "");
          candidates = marketplacesFor(afterRows, name);
          newlyInstalled = [...installedKeys(afterRows)].filter((k) => !before.has(k));
        } else {
          // Provision succeeded but we can't verify the result — don't pretend it's
          // a benign "nothing to install" skip; report it as a failure with the cause.
          return {
            agent: "codex",
            target: name,
            status: "failed",
            message: `provisioned, but verify failed (codex plugin list): ${reRead.stderr.trim() || `exit ${reRead.exitCode}`}`,
          };
        }
      }

      if (candidates.length === 1) {
        marketplace = candidates[0];
      } else if (candidates.length === 0) {
        // Codex has no marketplace entry for this exact name. Not a failure — but
        // what we do next depends on what provisioning achieved:
        if (provisioned && newlyInstalled.length > 0) {
          // The repo's canonical plugin installed under its own name (≠ the Claude
          // name we asked for). The bundle IS on Codex as a plugin — content
          // covered, and adding its skills loosely would duplicate. No fallback.
          return {
            agent: "codex",
            target: name,
            status: "skipped",
            coveredBy: newlyInstalled.join(", "),
            message: `covered — provisioning ${opts.sourceRepo} installed ${newlyInstalled.join(", ")} as a Codex plugin`,
          };
        }
        // Otherwise nothing loadable came from the repo (skills-only bundle), or we
        // couldn't provision at all (no usable repo, or --no-provision).
        const message = provisioned
          ? "provisioned, but Codex's loader exposes no plugin — skills-only bundle; adding its skills to Codex instead"
          : opts.provision
            ? "no usable source repo to provision from — its marketplace isn't a github owner/repo syncthis can register in Codex"
            : "no registered Codex marketplace provides it (provisioning disabled via --no-provision)";
        // When provisioning ran but exposed no plugin, hand the source repo back so
        // the mirror can add its skills to Codex via `npx skills add`. sourceRepo is
        // present and slug-validated here: provisioning required it (guard above).
        return {
          agent: "codex",
          target: name,
          status: "skipped",
          message,
          ...(provisioned ? { skillsFallbackRepo: opts.sourceRepo } : {}),
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
    const res = await run("codex", ["plugin", "add", "--", target], { timeoutMs: ADD_TIMEOUT_MS });
    if (res.notFound) return { agent: "codex", target, status: "failed", message: "codex CLI not found" };
    if (!res.ok) {
      // A multi-plugin marketplace aliases one bundle under several names; Codex
      // rejects every alias whose plugin.json name differs from the entry name.
      // That's not a real failure — the canonical sibling carries the bundle. The
      // mismatch error names that canonical plugin (`plugin.json name \`X\``). If X is
      // already installed on Codex (a prior run / sibling) OR this run's provision
      // just installed it, the bundle's skills are here as a namespaced plugin —
      // mark covered, NO skills fallback (re-adding them flat would duplicate). Only
      // when the canonical genuinely isn't present do we fall back to skills.
      if (isNameMismatch(res.stderr)) {
        const canonical = res.stderr.match(/plugin\.json name [`'"]([^`'"]+)[`'"]/i)?.[1];
        const canonicalPresent =
          (!!canonical && rows.some((r) => r.installed && r.name === canonical)) || newlyInstalled.length > 0;
        if (canonicalPresent) {
          return {
            agent: "codex",
            target,
            status: "skipped",
            coveredBy: canonical ?? newlyInstalled.join(", "),
            message: `covered by the bundle's canonical plugin${canonical ? ` \`${canonical}\`` : ""} on Codex — not re-added as skills`,
          };
        }
        return {
          agent: "codex",
          target,
          status: "skipped",
          message: opts.provision
            ? `Codex won't load this alias (its plugin.json name differs from \`${name}\`) — added to Codex as skills instead`
            : `Codex won't load this alias (its plugin.json name differs from \`${name}\`) — skipped (skills-fallback disabled via --no-provision)`,
          // Gate the skills-fallback on provisioning, like the candidates===0 branch:
          // --no-provision means no network skills add (documented contract).
          ...(opts.provision && opts.sourceRepo && isSafeRepoSlug(opts.sourceRepo)
            ? { skillsFallbackRepo: opts.sourceRepo }
            : {}),
        };
      }
      return { agent: "codex", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    }
    return { agent: "codex", target, status: "installed" };
  },

  // Guarded uninstall — reached only by `syncthis plugin rm`. Reads install truth
  // from `codex plugin list` first: an absent plugin is a no-op, and the installed
  // marketplace is resolved from the snapshot (`codex plugin remove` needs
  // <name>@<marketplace>, and the agent-local marketplace tag isn't known up front).
  async uninstallPlugin(name: string, opts: PluginUninstallOpts): Promise<PluginUninstallResult> {
    try {
      assertSafeIdentifier(name, "plugin name");
      if (opts.marketplace) assertSafeIdentifier(opts.marketplace, "marketplace name");
    } catch (err) {
      return { agent: "codex", target: name, status: "failed", message: (err as Error).message };
    }

    const listRes = await run("codex", ["plugin", "list"], { timeoutMs: LIST_TIMEOUT_MS });
    if (listRes.notFound) return { agent: "codex", target: name, status: "failed", message: "codex CLI not found" };
    const rows = listRes.ok ? parseCodexListRows(listRes.stdout || "") : [];

    const installed = rows.filter(
      (r) => r.installed && r.name === name && (!opts.marketplace || r.marketplace === opts.marketplace),
    );
    if (installed.length === 0) {
      return { agent: "codex", target: opts.marketplace ? `${name}@${opts.marketplace}` : name, status: "absent" };
    }

    let marketplace = opts.marketplace;
    if (!marketplace) {
      const mkts = [...new Set(installed.map((r) => r.marketplace).filter((m): m is string => !!m))];
      if (mkts.length === 1) marketplace = mkts[0];
      else if (mkts.length > 1) {
        return {
          agent: "codex",
          target: name,
          status: "skipped",
          message: `installed under multiple marketplaces (${mkts.join(", ")}) — pass <name>@<marketplace> to choose`,
        };
      }
    }

    const target = marketplace ? `${name}@${marketplace}` : name;
    if (opts.dryRun) return { agent: "codex", target, status: "uninstalled", message: "dry-run" };
    const res = await run("codex", ["plugin", "remove", "--", target], { timeoutMs: REMOVE_TIMEOUT_MS });
    if (res.notFound) return { agent: "codex", target, status: "failed", message: "codex CLI not found" };
    if (!res.ok) return { agent: "codex", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    return { agent: "codex", target, status: "uninstalled" };
  },
};
