// Guarded plugin uninstall — the ONLY removal path for plugins, reached only by the
// explicit `syncthis plugin rm` command (never by sync or mirror). It removes, in
// the agents the user scoped to:
//   • the native plugin from the plugin-capable agents (Claude, Codex), and
//   • the plugin's surfaced skills from the non-plugin agents (the skill cohort),
//     via `npx skills remove` — the "everywhere" reach matching how `mirror` spreads
//     a plugin's content.
//
// It is gated behind the same rails as MCP `rm`: an explicit agent scope, a diff
// printed before any write, TTY-confirm or `--yes`, and `--dry-run` (the preview).
//
// Over-removal guard: a skill name still provided by ANOTHER installed Claude plugin
// is NOT removed (reported as `kept`). syncthis can't see skills a user added by hand
// from a non-plugin repo, though — so the diff lists the exact skill names, and the
// caller shows them before any write.

import { pluginAdapters } from "./index.ts";
import { claudePluginAdapter } from "./claude.ts";
import type { PluginUninstallResult } from "./types.ts";
import {
  listInstalledSkills,
  removeSkillNames,
  repoSkillNames,
  skillCohort,
  type SkillRemoveResult,
} from "../skills.ts";
import type { AgentId } from "../types.ts";

// Plugin-capable agents with a list+uninstall CLI. Cursor is a plugin target but
// write-only (no list CLI), so it can't be read or uninstalled from here.
const PLUGIN_UNINSTALL_AGENTS: readonly AgentId[] = pluginAdapters.map((a) => a.id);

export type NativeUninstallTarget = {
  agent: AgentId;
  plugin: string;
  marketplace?: string;
  // Currently installed on this agent? (computed from the agent's plugin list.)
  present: boolean;
  // Set when the agent's plugin list couldn't be read — we can't tell presence, so
  // an apply reports a failure rather than silently doing nothing.
  unreadable?: string;
};

export type SkillRemovalPlan = {
  // Skill names that will be removed from the skill-cohort agents in scope.
  names: string[];
  // Names NOT removed because another still-installed Claude plugin provides them.
  kept: string[];
  // Skill-cohort agents in scope that currently hold ≥1 of `names`. When the global
  // skill list is unreadable, falls back to every requested skill-cohort agent.
  agents: AgentId[];
};

export type UninstallReport = {
  plugins: string[];
  requestedAgents: AgentId[];
  // Requested agents that can't be touched at all (currently just Cursor — a
  // write-only plugin target with no list/uninstall CLI).
  unsupportedAgents: AgentId[];
  native: NativeUninstallTarget[];
  skills: SkillRemovalPlan;
  // Apply outputs (undefined in preview).
  nativeResults?: PluginUninstallResult[];
  skillResult?: SkillRemoveResult;
  applied: boolean;
};

export type UninstallRunOpts = {
  plugins: string[];
  agents: AgentId[]; // already validated against known agent ids by the caller
  apply: boolean;
  keepData?: boolean;
  onProgress?: (label: string, index: number, total: number) => void;
};

// The skill names a single installed plugin contributes, read from its own install
// dir. Empty when the plugin has no known path or no skills.
async function pluginSkillNames(path: string | undefined): Promise<string[]> {
  if (!path) return [];
  return (await repoSkillNames(path)) ?? [];
}

export async function runPluginUninstall(opts: UninstallRunOpts): Promise<UninstallReport> {
  const requested = [...new Set(opts.agents)];
  const pluginSet = [...new Set(opts.plugins)];
  const cohort = skillCohort();

  const unsupportedAgents = requested.filter(
    (a) => !PLUGIN_UNINSTALL_AGENTS.includes(a) && !cohort.includes(a),
  );

  // --- Native plugin uninstall targets (Claude / Codex among the requested) ---
  const native: NativeUninstallTarget[] = [];
  for (const adapter of pluginAdapters) {
    if (!requested.includes(adapter.id)) continue;
    const read = await adapter.read();
    for (const plugin of pluginSet) {
      if (read.error) {
        native.push({ agent: adapter.id, plugin, present: false, unreadable: read.error });
        continue;
      }
      const rec = read.plugins.find((p) => p.name === plugin);
      native.push({ agent: adapter.id, plugin, marketplace: rec?.marketplace, present: !!rec });
    }
  }

  // --- Plugin-derived skill removal across the requested skill-cohort agents ---
  const skillAgents = requested.filter((a) => cohort.includes(a));
  // Skill propagation is Claude-driven, so derived skills correspond to Claude's
  // installed plugins. Partition every Claude plugin's skill names into "to remove"
  // (the plugins being uninstalled) vs "to keep" (every other still-installed plugin)
  // so a name shared with a surviving plugin is never removed.
  const claudeRead = await claudePluginAdapter.read();
  const claudePlugins = claudeRead.error ? [] : claudeRead.plugins;
  const removeNames = new Set<string>();
  const keepNames = new Set<string>();
  await Promise.all(
    claudePlugins.map(async (rec) => {
      const names = await pluginSkillNames(rec.path);
      const target = pluginSet.includes(rec.name);
      for (const n of names) (target ? removeNames : keepNames).add(n);
    }),
  );
  const kept = [...removeNames].filter((n) => keepNames.has(n)).sort();
  const namesToRemove = [...removeNames].filter((n) => !keepNames.has(n)).sort();

  // Narrow the skill-cohort agents to those that actually hold a removable skill, so
  // the diff is honest. If the global list is unreadable, keep every requested one.
  const installed = await listInstalledSkills();
  let effectiveSkillAgents = skillAgents;
  if (installed && namesToRemove.length > 0) {
    const removeSet = new Set(namesToRemove);
    const present = new Set<AgentId>();
    for (const s of installed) {
      if (removeSet.has(s.name)) for (const a of s.agents) if (skillAgents.includes(a)) present.add(a);
    }
    effectiveSkillAgents = [...present];
  } else if (namesToRemove.length === 0) {
    effectiveSkillAgents = [];
  }

  const skills: SkillRemovalPlan = { names: namesToRemove, kept, agents: effectiveSkillAgents.sort() };

  if (!opts.apply) {
    return { plugins: pluginSet, requestedAgents: requested, unsupportedAgents, native, skills, applied: false };
  }

  // --- Apply ---
  const items = native.filter((t) => t.present || t.unreadable).length + (skills.names.length && skills.agents.length ? 1 : 0);
  let step = 0;
  const nativeResults: PluginUninstallResult[] = [];
  for (const t of native) {
    if (t.unreadable) {
      nativeResults.push({ agent: t.agent, target: t.plugin, status: "failed", message: `cannot read plugins: ${t.unreadable}` });
      continue;
    }
    if (!t.present) {
      nativeResults.push({ agent: t.agent, target: t.marketplace ? `${t.plugin}@${t.marketplace}` : t.plugin, status: "absent" });
      continue;
    }
    const adapter = pluginAdapters.find((a) => a.id === t.agent)!;
    step += 1;
    opts.onProgress?.(`${t.agent}: uninstall ${t.plugin}`, step, items);
    nativeResults.push(await adapter.uninstallPlugin(t.plugin, { dryRun: false, marketplace: t.marketplace, keepData: opts.keepData }));
  }

  let skillResult: SkillRemoveResult | undefined;
  if (skills.names.length > 0 && skills.agents.length > 0) {
    step += 1;
    opts.onProgress?.(`skills: remove ${skills.names.length} from ${skills.agents.length} agent(s)`, step, items);
    skillResult = await removeSkillNames(skills.names, skills.agents);
  }

  return { plugins: pluginSet, requestedAgents: requested, unsupportedAgents, native, skills, nativeResults, skillResult, applied: true };
}

// Anything to actually do? (a present native plugin, or ≥1 skill to remove.)
export function uninstallHasChanges(report: UninstallReport): boolean {
  return report.native.some((t) => t.present || t.unreadable) || (report.skills.names.length > 0 && report.skills.agents.length > 0);
}
