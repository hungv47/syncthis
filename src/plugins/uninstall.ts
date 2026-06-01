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
import { parsePluginId } from "./shell.ts";
import type { PluginUninstallResult } from "./types.ts";
import {
  listInstalledSkills,
  pluginSkillIdentities,
  removeSkillNames,
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
  // Requested agents eligible for skill removal (skill cohort + Codex), regardless of
  // whether they currently hold a removable skill. Lets the caller tell that skill
  // removal was *intended* even when nothing resolved.
  skillScope: AgentId[];
  // The subset of skillScope whose ONLY removal mechanism is surfaced-skill removal —
  // the pure non-plugin cohort, EXCLUDING Codex (whose content a native uninstall
  // covers). If Claude is unreadable and this is non-empty, removal genuinely failed
  // for those agents (hard error); a Codex-only scope, by contrast, is covered by its
  // native uninstall, so an unreadable Claude there is only a best-effort warning.
  requiredSkillAgents: AgentId[];
  // Set when Claude's plugin list (the source for mapping plugins → skill names)
  // couldn't be read. With it set, skill names can't be resolved — so a skill-only
  // scope must surface this rather than silently report "nothing to do".
  claudeReadError?: string;
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

// Candidate skill identities a single installed plugin contributes, read from its
// own install dir. Returns BOTH the SKILL.md frontmatter name and the leaf dir name
// (the install slug) per skill, so the caller can match against whichever identity
// `npx skills list`/`remove` uses (they normally agree, but a title-cased frontmatter
// name with a kebab install dir would otherwise be shown but never removed). Empty
// when the plugin has no known path or no skills.
async function pluginSkillIds(path: string | undefined): Promise<string[]> {
  if (!path) return [];
  return await pluginSkillIdentities(path);
}

export async function runPluginUninstall(opts: UninstallRunOpts): Promise<UninstallReport> {
  const requested = [...new Set(opts.agents)];
  const pluginSet = [...new Set(opts.plugins)];
  const cohort = skillCohort();

  const unsupportedAgents = requested.filter(
    (a) => !PLUGIN_UNINSTALL_AGENTS.includes(a) && !cohort.includes(a),
  );

  // Each requested plugin is `name` or `name@marketplace`. A bare name targets every
  // installed instance of that name; an explicit marketplace narrows to one — so a
  // name installed from multiple marketplaces is never collapsed to an arbitrary pick.
  const specs = pluginSet.map((p) => parsePluginId(p));
  const recordMatches = (name: string, marketplace?: string) =>
    specs.some((s) => s.name === name && (!s.marketplace || s.marketplace === marketplace));

  // --- Native plugin uninstall targets (Claude / Codex among the requested) ---
  const native: NativeUninstallTarget[] = [];
  for (const adapter of pluginAdapters) {
    if (!requested.includes(adapter.id)) continue;
    const read = await adapter.read();
    for (const spec of specs) {
      if (read.error) {
        native.push({ agent: adapter.id, plugin: spec.name, marketplace: spec.marketplace, present: false, unreadable: read.error });
        continue;
      }
      const matches = read.plugins.filter(
        (p) => p.name === spec.name && (!spec.marketplace || p.marketplace === spec.marketplace),
      );
      if (matches.length === 0) {
        native.push({ agent: adapter.id, plugin: spec.name, marketplace: spec.marketplace, present: false });
      } else {
        // One target per matched marketplace — uninstall every instance the spec
        // names (a bare name from two marketplaces removes both, each qualified).
        for (const rec of matches) {
          native.push({ agent: adapter.id, plugin: spec.name, marketplace: rec.marketplace, present: true });
        }
      }
    }
  }

  // --- Plugin-derived skill removal ---
  // Candidate agents = the skill cohort PLUS Codex. The mirror's fallback adds a
  // plugin's skills to Codex via `npx skills add` when Codex can't load it as a
  // plugin, so those flat skills must be removable here too. (A Codex-native plugin's
  // skills are namespaced inside the plugin, not in the npx store, so the presence
  // filter below won't match them — the native uninstall handles those.)
  const skillRemovalAgents = [...new Set<AgentId>([...cohort, "codex"])];
  const skillAgents = requested.filter((a) => skillRemovalAgents.includes(a));

  // The authoritative skill identities are what `npx skills list` reports — the same
  // ones `npx skills remove -s` matches. Resolve the plugins' contributed skills to
  // those identities (matching by frontmatter name OR install-slug), so the names we
  // remove are exactly what the CLI recognizes. When the list is unreadable, fall back
  // to the raw candidate identities (degraded, best-effort).
  const installed = await listInstalledSkills();
  const installedNames = installed ? new Set(installed.map((s) => s.name)) : null;

  // Skill propagation is Claude-driven, so derived skills correspond to Claude's
  // installed plugins. Partition each plugin's resolved skill identities into "to
  // remove" (records a requested spec matches) vs "to keep" (every other still-
  // installed record — including a sibling marketplace not being removed) so a name a
  // surviving plugin still provides is never removed.
  const claudeRead = await claudePluginAdapter.read();
  const claudeReadError = claudeRead.error;
  const claudePlugins = claudeRead.error ? [] : claudeRead.plugins;
  const removeNames = new Set<string>();
  const keepNames = new Set<string>();
  await Promise.all(
    claudePlugins.map(async (rec) => {
      const ids = await pluginSkillIds(rec.path);
      const resolved = installedNames ? ids.filter((n) => installedNames.has(n)) : ids;
      const target = recordMatches(rec.name, rec.marketplace);
      for (const n of resolved) (target ? removeNames : keepNames).add(n);
    }),
  );
  const kept = [...removeNames].filter((n) => keepNames.has(n)).sort();
  const namesToRemove = [...removeNames].filter((n) => !keepNames.has(n)).sort();

  // Narrow the candidate agents to those that actually hold a removable skill, so the
  // diff is honest. If the global list is unreadable, keep every requested one.
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
  const base = {
    plugins: pluginSet,
    requestedAgents: requested,
    unsupportedAgents,
    native,
    skills,
    skillScope: skillAgents.slice().sort(),
    requiredSkillAgents: requested.filter((a) => cohort.includes(a)).sort(),
    ...(claudeReadError ? { claudeReadError } : {}),
  };

  if (!opts.apply) {
    return { ...base, applied: false };
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

  return { ...base, nativeResults, skillResult, applied: true };
}

// Anything to actually do? (a present native plugin, or ≥1 skill to remove.)
export function uninstallHasChanges(report: UninstallReport): boolean {
  return report.native.some((t) => t.present || t.unreadable) || (report.skills.names.length > 0 && report.skills.agents.length > 0);
}
