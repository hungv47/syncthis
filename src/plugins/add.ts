// Scoped plugin add — make ONE (or a few) chosen plugin reachable on a chosen set
// of agents. It's a narrowed `mirror`: where `mirror` pushes every plugin from a
// primary to every agent, this pushes the named plugins to just the agents you pick.
//
// Source of truth is Claude (the only agent exposing the marketplace → owner/repo map
// needed to install elsewhere and to surface skills), matching `mirror`'s Claude-
// primary constraint. For each chosen plugin, by target:
//   • Codex (plugin cohort): native `installPlugin` (provision on) — reuses all of the
//     adapter's resolve/provision/covered/skills-fallback logic.
//   • Cursor (write-only): `npx plugins add <repo> --target cursor`.
//   • Non-plugin agents: the plugin's bundled skills (`npx skills add`) AND its bundled
//     MCP servers, lifted into each agent's own config (additive, conflict-safe).
// Additive only — never removes. A plugin not installed on Claude is reported, not
// guessed at.

import { claudePluginAdapter } from "./claude.ts";
import { pluginAdapters } from "./index.ts";
import { resolvePluginMcpServers } from "./mcp.ts";
import type { McpCohortResult } from "./mirror.ts";
import { isSafeRepoSlug, run } from "./shell.ts";
import type { PluginInstallResult, PluginRecord } from "./types.ts";
import { addSkillRepos, mcpCohort, skillCohort, type SkillAddResult } from "../skills.ts";
import { diffServers, findAdapter } from "../sync.ts";
import type { AgentId, McpServer } from "../types.ts";

const CURSOR_PLUGINS_TIMEOUT_MS = 180_000;

export type PluginAddCursor = { repos: string[]; results: { repo: string; status: "installed" | "failed"; message?: string }[] };

export type PluginAddReport = {
  plugins: string[];
  requestedAgents: AgentId[];
  source: AgentId; // always claude-code
  // Set when Claude's plugin list couldn't be read — nothing can be resolved.
  sourceError?: string;
  // Requested plugin names not installed on the source (can't be added elsewhere).
  notFound: string[];
  // Native installs on the scoped plugin-cohort agents (Codex).
  installs: PluginInstallResult[];
  // Skills added (npx skills) — to scoped non-plugin agents, and the Codex skills
  // fallback for bundles Codex can't load natively.
  skills: SkillAddResult[];
  // Cursor push (only when cursor is in scope).
  cursor?: PluginAddCursor;
  // Plugin-bundled MCP servers lifted into scoped non-plugin agents.
  mcp: McpCohortResult[];
  applied: boolean;
};

export type PluginAddRunOpts = {
  plugins: string[];
  agents: AgentId[]; // validated by the caller
  apply: boolean;
  // Register a missing marketplace on Codex before installing + fall unloadable
  // bundles back to skills. On by default (the point of an add is for it to land).
  provision?: boolean;
  onProgress?: (label: string, index: number, total: number) => void;
};

export async function runPluginAdd(opts: PluginAddRunOpts): Promise<PluginAddReport> {
  const provision = opts.provision ?? true;
  const requested = [...new Set(opts.agents)];
  const wantNames = [...new Set(opts.plugins)];

  const base: PluginAddReport = {
    plugins: wantNames,
    requestedAgents: requested,
    source: "claude-code",
    notFound: [],
    installs: [],
    skills: [],
    mcp: [],
    applied: opts.apply,
  };

  const read = await claudePluginAdapter.read();
  if (read.error) return { ...base, sourceError: read.error };

  const byName = new Map(read.plugins.map((p) => [p.name, p]));
  const chosen: PluginRecord[] = [];
  for (const name of wantNames) {
    const rec = byName.get(name);
    if (rec) chosen.push(rec);
    else base.notFound.push(name);
  }
  if (chosen.length === 0) return base;

  const sources = (await claudePluginAdapter.marketplaceSources?.()) ?? null;
  const repoOf = (p: PluginRecord): string | undefined =>
    p.marketplace ? sources?.get(p.marketplace) : undefined;
  const chosenRepos = [
    ...new Set(chosen.map(repoOf).filter((r): r is string => !!r && isSafeRepoSlug(r))),
  ].sort();

  const scopedSkillCohort = requested.filter((a) => skillCohort().includes(a));
  const scopedMcpCohort = requested.filter((a) => mcpCohort().includes(a));
  const wantCursor = requested.includes("cursor");
  const wantCodex = requested.includes("codex");

  if (!opts.apply) {
    // Preview: resolve what WOULD happen without shelling out.
    if (wantCodex) {
      for (const p of chosen) base.installs.push({ agent: "codex", target: p.name, status: "installed", message: "would install" });
    }
    if (wantCursor) base.cursor = { repos: chosenRepos, results: [] };
    if (scopedSkillCohort.length && chosenRepos.length) {
      for (const repo of chosenRepos) base.skills.push({ repo, status: "added", message: "would add" });
    }
    if (scopedMcpCohort.length) {
      // Read+diff each agent so the dry-run reports only what would actually be added
      // (additive, conflict-safe) — not every bundled server regardless of what's present.
      const { servers } = await resolvePluginMcpServers(chosen);
      const serverMap: Record<string, McpServer> = {};
      for (const s of servers) serverMap[s.name] = s.server;
      for (const agent of scopedMcpCohort) {
        const adapter = findAdapter(agent);
        if (!adapter) {
          base.mcp.push({ agent, added: [], conflicts: [], status: "skipped", message: "no MCP adapter" });
          continue;
        }
        const aRead = await adapter.read();
        if (aRead.error) {
          base.mcp.push({ agent, added: [], conflicts: [], status: "failed", message: aRead.error });
          continue;
        }
        const diff = diffServers(serverMap, aRead.servers);
        base.mcp.push({ agent, added: diff.add, conflicts: diff.overwrite, status: "synced" });
      }
    }
    return base;
  }

  // --- Apply ---
  let step = 0;
  const total =
    (wantCodex ? chosen.length : 0) +
    (wantCursor ? chosenRepos.length : 0) +
    (scopedSkillCohort.length && chosenRepos.length ? 1 : 0) +
    (scopedMcpCohort.length ? scopedMcpCohort.length : 0);
  const tick = (label: string) => opts.onProgress?.(label, ++step, total);

  // Codex native installs (installPlugin handles provision / covered / fallback).
  if (wantCodex) {
    const codex = pluginAdapters.find((a) => a.id === "codex")!;
    for (const p of chosen) {
      tick(`codex: ${p.name}`);
      const res = await codex.installPlugin(p.name, { dryRun: false, provision, sourceRepo: repoOf(p) });
      base.installs.push(res);
      // A bundle Codex can't load as a plugin → add its skills to Codex.
      if (res.skillsFallbackRepo) {
        base.skills.push(...(await addSkillRepos([res.skillsFallbackRepo], ["codex"])));
      }
    }
  }

  // Cursor push by source repo (write-only target).
  if (wantCursor) {
    const results: PluginAddCursor["results"] = [];
    for (const repo of chosenRepos) {
      tick(`cursor: ${repo}`);
      const r = await run("npx", ["plugins", "add", repo, "--target", "cursor", "-y"], { timeoutMs: CURSOR_PLUGINS_TIMEOUT_MS });
      if (r.notFound) results.push({ repo, status: "failed", message: "`npx plugins` not found on PATH" });
      else if (r.timedOut) results.push({ repo, status: "failed", message: `timed out after ${CURSOR_PLUGINS_TIMEOUT_MS / 1000}s` });
      else if (!r.ok) results.push({ repo, status: "failed", message: r.stderr.trim() || `exit ${r.exitCode}` });
      else results.push({ repo, status: "installed" });
    }
    base.cursor = { repos: chosenRepos, results };
  }

  // Skills → scoped non-plugin agents.
  if (scopedSkillCohort.length && chosenRepos.length) {
    tick(`skills → ${scopedSkillCohort.length} agent(s)`);
    base.skills.push(...(await addSkillRepos(chosenRepos, scopedSkillCohort)));
  }

  // Plugin-bundled MCP servers → scoped non-plugin agents (additive, conflict-safe).
  if (scopedMcpCohort.length) {
    const { servers } = await resolvePluginMcpServers(chosen);
    const serverMap: Record<string, McpServer> = {};
    for (const s of servers) serverMap[s.name] = s.server;
    for (const agentId of scopedMcpCohort) {
      tick(`mcp → ${agentId}`);
      const adapter = findAdapter(agentId);
      if (!adapter) {
        base.mcp.push({ agent: agentId, added: [], conflicts: [], status: "skipped", message: "no MCP adapter" });
        continue;
      }
      const aRead = await adapter.read();
      if (aRead.error) {
        base.mcp.push({ agent: agentId, added: [], conflicts: [], status: "failed", message: aRead.error });
        continue;
      }
      const diff = diffServers(serverMap, aRead.servers);
      if (diff.add.length === 0) {
        base.mcp.push({
          agent: agentId,
          added: [],
          conflicts: diff.overwrite,
          status: "skipped",
          message: diff.overwrite.length ? "conflict(s) left untouched" : "already present",
        });
        continue;
      }
      const next: Record<string, McpServer> = { ...aRead.servers };
      for (const name of diff.add) next[name] = serverMap[name]!;
      const write = await adapter.write(next, { dryRun: false });
      base.mcp.push({ agent: agentId, added: diff.add, conflicts: diff.overwrite, status: write.status, message: write.message });
    }
  }

  return base;
}

// Anything to do? (a chosen plugin resolvable on the source + at least one target.)
export function pluginAddHasWork(report: PluginAddReport): boolean {
  if (report.sourceError) return false;
  const resolvable = report.plugins.length - report.notFound.length;
  return resolvable > 0 && report.requestedAgents.some((a) => a !== "claude-code");
}
