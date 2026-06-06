// Plugin mirror — additive primary → other-agent propagation.
//
// Reads the primary agent's installed plugins and makes that content reachable on
// every other agent, by the best mechanism each one has:
//   • Codex (native read+write plugin CLI): install each plugin; provision its
//     marketplace first when missing (on by default). A plugin Codex can't load as
//     a plugin — a skills-only bundle, or a multi-plugin marketplace alias whose
//     plugin.json name Codex rejects — falls back to `npx skills add` UNLESS the
//     same repo already landed as a real plugin (no flat/namespaced duplication).
//   • Cursor (write-only plugin target, no list CLI): pushed by source repo via
//     `npx plugins add <repo> --target cursor` — additive, can't be diffed.
//   • The non-plugin agents (gemini, kimi, opencode, …): receive the primary's
//     plugin-bundled skills via `npx skills add` (vercel-labs/skills) AND the
//     primary's plugin-bundled MCP servers, lifted into their own MCP config (the
//     plugin cohort already gets those by installing the plugin).
//
// It is additive only: there is no uninstall path anywhere. A mirror can add a
// plugin/skill/MCP server to an agent, never remove one — so a mistake can't wipe
// plugins, and a name that already exists with a different config is left untouched.

import { claudeMarketplaceClonePaths } from "./claude.ts";
import { pluginAdapters } from "./index.ts";
import { resolvePluginMcpServers, type PluginMcpServer, type PluginMcpSkip } from "./mcp.ts";
import { isSafeRepoSlug, pluginIdentityKeys, run } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallResult,
  PluginRecord,
} from "./types.ts";
import {
  addSkillRepos,
  addSkillsFromPlugins,
  mcpCohort,
  resolveInstalledRepoCoverage,
  resolvePluginSkillSources,
  skillCohort,
  type PluginSkillsReport,
} from "../skills.ts";
import { diffServers, findAdapter } from "../sync.ts";
import type { AgentId, McpServer, SyncStatus } from "../types.ts";

const CURSOR_PLUGINS_TIMEOUT_MS = 180_000;

export type MirrorDiff = {
  // Plugins present in primary but missing from the target → install (additive).
  add: PluginRecord[];
};

export type MirrorTarget = {
  to: AgentId;
  toRead: PluginAdapterRead;
  // null when the target's config could not be read (see unsupportedReason).
  diff: MirrorDiff | null;
  unsupportedReason?: string;
  installs?: PluginInstallResult[];
  // Skills added to this target as a fallback for plugins it couldn't install
  // natively (skills-only bundles / unloadable aliases). Populated on apply only.
  skillsFallback?: SkillAddResult[];
};

export type CursorPushResult = { repo: string; status: "installed" | "failed"; message?: string };

// Cursor's write-only plugin push. `supported` is false when the primary can't
// supply github source repos (only Claude can). `repos` is the deduped set of
// owner/repo slugs behind the primary's installed plugins; on apply each is
// installed via `npx plugins add <repo> --target cursor`.
export type CursorPush = {
  supported: boolean;
  reason?: string;
  repos: string[];
  results: CursorPushResult[];
};

// The non-plugin agents' skill push. Driven from the primary's plugin-bundled
// skills (only a Claude primary can supply them). `report` carries the source
// repos (preview) and per-repo `npx skills add` results (apply).
export type MirrorSkillCohort = {
  supported: boolean;
  reason?: string;
  agents: AgentId[];
  report?: PluginSkillsReport;
};

// The non-plugin agents' bundled-MCP push. Driven from the primary's plugin-bundled
// MCP servers (only a Claude primary can supply them). `servers` is the resolved set
// (preview); `results` carries the per-agent additive write outcome (apply). Additive
// and conflict-safe: a server name already present with a different config is left
// untouched and surfaced as a conflict.
export type McpCohortResult = {
  agent: AgentId;
  added: string[];
  conflicts: string[];
  status: SyncStatus;
  message?: string;
};

export type MirrorMcpCohort = {
  supported: boolean;
  reason?: string;
  agents: AgentId[];
  servers: PluginMcpServer[];
  skipped: PluginMcpSkip[];
  results?: McpCohortResult[];
};

export type MirrorReport = {
  from: AgentId;
  fromRead: PluginAdapterRead;
  targets: MirrorTarget[];
  cursor: CursorPush;
  skillCohort: MirrorSkillCohort;
  mcpCohort: MirrorMcpCohort;
  applied: boolean;
};

export type MirrorRunOpts = {
  from: AgentId;
  apply: boolean;
  // Register a missing marketplace on a target before installing, and fall unloadable
  // bundles back to skills. ON by default (the point of a mirror is to make content
  // reachable); pass false (`--no-provision`) for an offline / no-network run.
  provision?: boolean;
  // Per-item progress for the apply phase. A full mirror runs many sequential
  // `npx`/`codex` network calls (codex installs + cursor pushes + skill adds) with
  // no other output, so without this the CLI/TUI look frozen. Called once per item.
  onProgress?: (label: string, index: number, total: number) => void;
};

type SkillAddResult = Awaited<ReturnType<typeof addSkillRepos>>[number];

function adapterFor(id: AgentId): PluginAdapter | undefined {
  return pluginAdapters.find((a) => a.id === id);
}

// Cross-agent identity is the BARE plugin name, not name@marketplace. The
// marketplace tag is agent-local: the same upstream plugin is "forsvn-skills@
// forsvn-skills" in Claude but "forsvn-skills@plugins-cli" in Codex. Some URL-
// derived names are also sanitized per target (`github.com-x` vs `github-com-x`).
// Keying on the agent-local spelling would queue spurious re-adds.
function identitySet(plugins: PluginRecord[]): Set<string> {
  const out = new Set<string>();
  for (const p of plugins) for (const key of pluginIdentityKeys(p.name)) out.add(key);
  return out;
}

export async function runMirror(opts: MirrorRunOpts): Promise<MirrorReport> {
  const provision = opts.provision ?? true;
  const primary = adapterFor(opts.from);
  if (!primary) {
    throw new Error(
      `mirror: ${opts.from} has no plugin adapter. plugin-capable agents: ${pluginAdapters.map((a) => a.id).join(", ")}`,
    );
  }
  const fromRead = await primary.read();
  if (fromRead.error) {
    throw new Error(`mirror: cannot read primary ${opts.from}: ${fromRead.error}`);
  }

  // The primary's marketplace name → owner/repo. Used to provision a marketplace a
  // target lacks, by the cursor push, and to map a plugin to its skills-fallback
  // repo. Fetched once; only Claude implements it. Needed for the preview too.
  let sources: Map<string, string> | null | undefined;
  if (primary.marketplaceSources) {
    sources = await primary.marketplaceSources();
  }
  const repoOf = (p: PluginRecord): string | undefined => (p.marketplace ? sources?.get(p.marketplace) : undefined);
  // Local marketplace clone dir per plugin — the network-free install path. Only a
  // Claude primary exposes clone locations (known_marketplaces installLocation); for
  // any other primary the map is empty and installs fall back to the legacy path.
  const clonePaths = opts.from === "claude-code" ? await claudeMarketplaceClonePaths() : new Map<string, string>();
  const cloneOf = (p: PluginRecord): string | undefined => (p.marketplace ? clonePaths.get(p.marketplace) : undefined);

  const targets: MirrorTarget[] = [];

  for (const a of pluginAdapters) {
    if (a.id === primary.id) continue;
    const toRead = await a.read();

    if (toRead.error) {
      targets.push({ to: a.id, toRead, diff: null, unsupportedReason: `cannot read target: ${toRead.error}` });
      continue;
    }

    const toIdentities = identitySet(toRead.plugins);
    const add: PluginRecord[] = [];
    const queued = new Set<string>();
    for (const p of fromRead.plugins) {
      const keys = pluginIdentityKeys(p.name);
      if (keys.some((key) => toIdentities.has(key))) continue;
      const queueKey = keys[0]!;
      if (queued.has(queueKey)) continue;
      queued.add(queueKey);
      add.push(p);
    }

    const target: MirrorTarget = { to: a.id, toRead, diff: { add } };

    if (opts.apply) {
      // Install by bare name and let the target resolve its own marketplace — the
      // primary's marketplace tag won't exist on the target.
      const installs: PluginInstallResult[] = [];
      for (const [i, p] of add.entries()) {
        opts.onProgress?.(`${a.id}: ${p.name}`, i + 1, add.length);
        installs.push(await a.installPlugin(p.name, { dryRun: false, provision, sourceRepo: repoOf(p), sourceClonePath: cloneOf(p) }));
      }
      target.installs = installs;

      // Repos that are on this target as a real plugin — so their skills are present
      // namespaced and must NOT be re-added flat via `npx skills add` (duplication).
      const coveredRepos = new Set<string>();
      // (a) Already installed on the target BEFORE this run — a prior mirror's
      // canonical install, or a sibling of the same bundle. Matched by the
      // marketplace's DECLARED plugin names (not the primary's install id), so it
      // covers the case where the target's canonical name differs from the primary's
      // (`github.com-*` URL-named plugins). Without this, every re-run would re-add
      // the bundle's skills flat for the alias still left in `add`. (Claude primary
      // only — the coverage map comes from Claude's marketplace clones.)
      if (opts.from === "claude-code") {
        const installedNames = new Set(toRead.plugins.map((p) => p.name));
        for (const r of await resolveInstalledRepoCoverage(installedNames)) coveredRepos.add(r);
      }
      // (b) Landed during this run — directly installed, already present, or covered
      // (provisioning installed the bundle under its canonical name).
      add.forEach((p, i) => {
        const r = repoOf(p);
        if (!r) return;
        const ins = installs[i]!;
        if (ins.status === "installed" || ins.status === "present" || ins.coveredBy) coveredRepos.add(r);
      });
      // An unloadable alias whose canonical sibling DID install is covered too —
      // reclassify it (drop the fallback) so its skills aren't added redundantly.
      for (const ins of installs) {
        if (ins.skillsFallbackRepo && coveredRepos.has(ins.skillsFallbackRepo)) {
          ins.coveredBy = ins.coveredBy ?? "the bundle's canonical plugin";
          ins.message = `covered by the bundle's canonical plugin on ${a.id} — not re-added as skills`;
          ins.skillsFallbackRepo = undefined;
        }
      }

      // Remaining fallback repos: genuinely unloadable on this target AND not
      // already present as a plugin. Add their skills loosely so the content lands.
      const fallbackRepos = [
        ...new Set(installs.map((i) => i.skillsFallbackRepo).filter((r): r is string => !!r)),
      ];
      if (fallbackRepos.length) {
        target.skillsFallback = await addSkillRepos(fallbackRepos, [a.id]);
      }
    }

    targets.push(target);
  }

  const cursor = await pushToCursor(fromRead, sources, opts.apply, opts.onProgress);
  const skillCohortPush = await pushToSkillCohort(opts.from, opts.apply, opts.onProgress);
  const mcpCohortPush = await pushPluginMcpToCohort(opts.from, fromRead.plugins, opts.apply, opts.onProgress);

  return {
    from: opts.from,
    fromRead,
    targets,
    cursor,
    skillCohort: skillCohortPush,
    mcpCohort: mcpCohortPush,
    applied: opts.apply,
  };
}

// Install the primary's plugins onto Cursor by source repo. Cursor has no
// plugin-list CLI, so this is additive and unconditional — we can't diff against
// cursor's current state. Repos are deduped (a multi-plugin marketplace installs
// once) and slug-validated (an adversarial marketplace entry can't smuggle a flag
// into the `npx plugins` invocation).
async function pushToCursor(
  fromRead: PluginAdapterRead,
  sources: Map<string, string> | null | undefined,
  apply: boolean,
  onProgress?: (label: string, index: number, total: number) => void,
): Promise<CursorPush> {
  if (fromRead.error) {
    return { supported: false, reason: `primary unreadable: ${fromRead.error}`, repos: [], results: [] };
  }
  if (sources === undefined) {
    return {
      supported: false,
      reason: "primary can't supply github source repos for `npx plugins` — run `syncthis mirror claude-code` to populate cursor",
      repos: [],
      results: [],
    };
  }
  if (sources === null) {
    return {
      supported: false,
      reason: "couldn't read the primary's marketplaces (`claude plugin marketplace list` failed) — cursor not updated",
      repos: [],
      results: [],
    };
  }
  const repos = [
    ...new Set(
      fromRead.plugins
        .map((p) => (p.marketplace ? sources.get(p.marketplace) : undefined))
        .filter((r): r is string => !!r && isSafeRepoSlug(r)),
    ),
  ].sort();

  if (!apply) return { supported: true, repos, results: [] };

  const results: CursorPushResult[] = [];
  for (const [i, repo] of repos.entries()) {
    onProgress?.(`cursor: ${repo}`, i + 1, repos.length);
    const res = await run("npx", ["plugins", "add", repo, "--target", "cursor", "-y"], {
      timeoutMs: CURSOR_PLUGINS_TIMEOUT_MS,
    });
    if (res.notFound) {
      results.push({ repo, status: "failed", message: "`npx plugins` not found on PATH" });
      continue;
    }
    if (res.timedOut) {
      results.push({ repo, status: "failed", message: `timed out after ${CURSOR_PLUGINS_TIMEOUT_MS / 1000}s` });
      continue;
    }
    if (!res.ok) {
      results.push({ repo, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` });
      continue;
    }
    results.push({ repo, status: "installed" });
  }
  return { supported: true, repos, results };
}

// Surface the primary's plugin-bundled skills to the non-plugin agents (gemini,
// kimi, opencode, …) via `npx skills add`. The source repos come from the Claude
// plugin store, so only a Claude primary can supply them — a Codex primary is
// reported unsupported with a clear reason (matching the cursor push).
async function pushToSkillCohort(
  from: AgentId,
  apply: boolean,
  onProgress?: (label: string, index: number, total: number) => void,
): Promise<MirrorSkillCohort> {
  const agents = skillCohort();
  if (from !== "claude-code") {
    return {
      supported: false,
      reason: "skill propagation reads Claude's installed plugins — run `syncthis mirror claude-code`",
      agents,
    };
  }
  if (!apply) {
    // Preview is local-only (no `npx skills` subprocess): just resolve the repos.
    const sources = await resolvePluginSkillSources();
    return { supported: true, agents, report: { ran: sources.length > 0, dryRun: true, agents, sources, results: [] } };
  }
  const report = await addSkillsFromPlugins({
    agents,
    onProgress: (repo, i, total) => onProgress?.(`skills: ${repo}`, i, total),
  });
  return { supported: true, agents, report };
}

// Lift the primary's plugin-bundled MCP servers into the non-plugin agents' own MCP
// config. The plugin cohort (Claude/Codex/Cursor) already gets these by installing
// the plugin, so the target set is the MCP cohort (the non-plugin MCP-syncable
// agents — skills-only agents like Pi are excluded; they have no MCP config). Source
// paths come from Claude's plugin store, so only a Claude primary can supply them.
// Additive and conflict-safe: each agent keeps every server it already has; a name
// present with a DIFFERENT config is left untouched and reported as a conflict
// (sacred conflict policy), never overwritten.
async function pushPluginMcpToCohort(
  from: AgentId,
  plugins: PluginRecord[],
  apply: boolean,
  onProgress?: (label: string, index: number, total: number) => void,
): Promise<MirrorMcpCohort> {
  const agents = mcpCohort();
  if (from !== "claude-code") {
    return {
      supported: false,
      reason: "plugin MCP decomposition reads Claude's installed plugins — run `syncthis mirror claude-code`",
      agents,
      servers: [],
      skipped: [],
    };
  }
  const { servers, skipped } = await resolvePluginMcpServers(plugins);
  if (!apply || servers.length === 0) {
    return { supported: true, agents, servers, skipped };
  }

  const serverMap: Record<string, McpServer> = {};
  for (const s of servers) serverMap[s.name] = s.server;

  const results: McpCohortResult[] = [];
  let i = 0;
  for (const agentId of agents) {
    i += 1;
    onProgress?.(`mcp→${agentId}`, i, agents.length);
    const adapter = findAdapter(agentId);
    if (!adapter) {
      results.push({ agent: agentId, added: [], conflicts: [], status: "skipped", message: "no MCP adapter" });
      continue;
    }
    const read = await adapter.read();
    if (read.error) {
      results.push({ agent: agentId, added: [], conflicts: [], status: "failed", message: read.error });
      continue;
    }
    // diff(plugin servers → agent's current): `add` = not yet present; `overwrite` =
    // present with a different config = a conflict we must NOT touch.
    const diff = diffServers(serverMap, read.servers);
    if (diff.add.length === 0) {
      results.push({
        agent: agentId,
        added: [],
        conflicts: diff.overwrite,
        status: "skipped",
        message: diff.overwrite.length ? "conflict(s) left untouched" : "already present",
      });
      continue;
    }
    // Merge additively: keep every existing server (conflicting names retain the
    // agent's own value), add only the new ones.
    const next: Record<string, McpServer> = { ...read.servers };
    for (const name of diff.add) next[name] = serverMap[name]!;
    const write = await adapter.write(next, { dryRun: false });
    results.push({
      agent: agentId,
      added: diff.add,
      conflicts: diff.overwrite,
      status: write.status,
      message: write.message,
    });
  }
  return { supported: true, agents, servers, skipped, results };
}

export function mirrorHasChanges(report: MirrorReport): boolean {
  const skillSources = report.skillCohort.supported ? report.skillCohort.report?.sources.length ?? 0 : 0;
  const mcpServers = report.mcpCohort.supported ? report.mcpCohort.servers.length : 0;
  return (
    report.targets.some((t) => t.diff && t.diff.add.length > 0) ||
    report.cursor.repos.length > 0 ||
    skillSources > 0 ||
    mcpServers > 0
  );
}
