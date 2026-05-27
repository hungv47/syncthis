// Plugin lifecycle discovery — given an installed plugin, decide whether it's
// merely *registered* in config, *loaded* (cache materialized + manifest parses),
// and *surfaced* (would the agent's scanner actually pick up its artifacts).
//
// The point of this layer is to light up the "registered ✓ but surfaced ✗" gap
// described in plan-cross-agent-sync.md §3 — the silent-failure zone where
// every existing tool reports green.

import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expandHome } from "../io.ts";
import { pluginAdapters } from "./index.ts";
import type { PluginAdapterRead, PluginRecord } from "./types.ts";
import type { AgentId } from "../types.ts";

export type LifecycleReport = {
  agent: AgentId;
  name: string;
  marketplace?: string;
  registered: boolean;
  loaded: boolean;
  surfaced: boolean;
  enabled?: boolean;
  // Counts: what the manifest claims vs what the agent's scanner will actually find.
  skills: { expected: number; actual: number };
  // One human-readable reason per gap. Order: most-blocking first.
  reasons: string[];
  // Resolved plugin directories on disk (Codex may have multiple under different owners).
  paths: string[];
  // Free-form tags consumed by fixers — e.g. "codex-nested-skills", "codex-no-interface".
  failureTags: string[];
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirs(p: string): Promise<string[]> {
  try {
    const entries = await readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// Walk a plugin directory looking for SKILL.md files. Returns depth of each find
// (relative to <pluginDir>/skills/). Depth 1 = flat layout (skills/<skill>/SKILL.md).
// Depth >=2 = nested (skills/<cat>/<skill>/SKILL.md).
async function findSkillManifests(pluginDir: string): Promise<{ path: string; depth: number }[]> {
  const skillsDir = join(pluginDir, "skills");
  if (!(await isDir(skillsDir))) return [];
  const found: { path: string; depth: number }[] = [];
  await walk(skillsDir, 0);
  return found;

  async function walk(dir: string, depth: number) {
    if (depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let hasSkillMd = false;
    for (const e of entries) {
      if (e.name === "SKILL.md" && e.isFile()) {
        hasSkillMd = true;
        found.push({ path: join(dir, e.name), depth });
      }
    }
    if (hasSkillMd) return;
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(dir, e.name), depth + 1);
    }
  }
}

// Codex's UI surfacing depends on plugin.json declaring an `interface` block with
// at least one tool/skill descriptor. plugins-cli will auto-inject a stub; raw
// installs may not. Returns true if the manifest reads as "surfaceable".
async function codexManifestSurfaceable(pluginDir: string): Promise<{ ok: boolean; reason?: string }> {
  for (const name of ["plugin.json", "codex-plugin.json"]) {
    const path = join(pluginDir, name);
    if (!(await pathExists(path))) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      return { ok: false, reason: `${name} did not parse: ${(err as Error).message}` };
    }
    const iface = parsed.interface;
    if (!iface) return { ok: false, reason: `${name} has no \`interface\` block (Codex will register but won't surface in UI)` };
    if (typeof iface !== "object" || iface === null) return { ok: false, reason: `${name} has non-object \`interface\`` };
    return { ok: true };
  }
  return { ok: false, reason: "no plugin.json or codex-plugin.json found in cache dir" };
}

// CODEX —
// Cache layout: ~/.codex/plugins/cache/<owner>/<plugin>/<sha>/. We may not know
// the owner upfront, so glob the cache root and find dirs whose leaf matches the
// plugin name, then descend into the latest sha.
async function discoverCodexPlugin(plugin: PluginRecord): Promise<LifecycleReport> {
  const cacheRoot = expandHome("~/.codex/plugins/cache");
  const report: LifecycleReport = {
    agent: "codex",
    name: plugin.name,
    marketplace: plugin.marketplace,
    registered: true,
    loaded: false,
    surfaced: false,
    enabled: plugin.enabled,
    skills: { expected: 0, actual: 0 },
    reasons: [],
    paths: [],
    failureTags: [],
  };

  if (plugin.enabled === false) report.reasons.push("plugin is disabled in config.toml");

  const owners = await listDirs(cacheRoot);
  const candidatePluginDirs: string[] = [];
  for (const owner of owners) {
    const pluginDir = join(cacheRoot, owner, plugin.name);
    if (!(await isDir(pluginDir))) continue;
    const shas = await listDirs(pluginDir);
    if (shas.length === 0) {
      candidatePluginDirs.push(pluginDir);
      continue;
    }
    // Git shas are random hex; lexicographic order is unrelated to install
    // recency. Pick the most-recently-modified sha dir to match what Codex
    // actually loads after a `plugin update`.
    const stats = await Promise.all(
      shas.map(async (sha) => {
        try {
          const s = await stat(join(pluginDir, sha));
          return { sha, mtime: s.mtimeMs };
        } catch {
          return { sha, mtime: 0 };
        }
      }),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    candidatePluginDirs.push(join(pluginDir, stats[0]!.sha));
  }

  if (candidatePluginDirs.length === 0) {
    report.reasons.unshift(`no cache dir under ${cacheRoot}/*/${plugin.name}`);
    report.failureTags.push("codex-no-cache");
    return report;
  }
  report.paths = candidatePluginDirs;
  report.loaded = true;

  let totalSkills = 0;
  let nestedSkills = 0;
  let flatSkills = 0;
  for (const dir of candidatePluginDirs) {
    const skills = await findSkillManifests(dir);
    totalSkills += skills.length;
    for (const s of skills) {
      if (s.depth >= 2) nestedSkills += 1;
      else flatSkills += 1;
    }
  }
  report.skills.expected = totalSkills;
  // Codex's skill scanner is one-level-deep (skills/<skill>/SKILL.md). Nested
  // SKILL.md files are silently ignored. Surfaced count = flat-only.
  report.skills.actual = flatSkills;

  if (nestedSkills > 0 && flatSkills === 0) {
    report.reasons.push(
      `Codex skill scanner is one-level-deep; plugin uses skills/<category>/<skill>/ — ${nestedSkills} skill(s) will not surface`,
    );
    report.failureTags.push("codex-nested-skills");
  } else if (nestedSkills > 0) {
    report.reasons.push(`${nestedSkills} skill(s) under nested categories will not surface (only ${flatSkills} are flat)`);
    report.failureTags.push("codex-nested-skills");
  }

  // Manifest / interface block check — only matters as a *surfacing blocker*
  // when no other surfaceable artifact is present. plugins-cli installs ship
  // a working manifest; bare-git installs frequently don't, and that's the
  // documented silent-failure mode (impeccable etc.). But if flat skills are
  // already surfacing, missing manifest is informational, not a blocker.
  if (flatSkills === 0) {
    for (const dir of candidatePluginDirs) {
      const m = await codexManifestSurfaceable(dir);
      if (!m.ok && m.reason) {
        report.reasons.push(m.reason);
        report.failureTags.push("codex-no-interface");
        break;
      }
    }
  }

  const manifestOk = !report.failureTags.includes("codex-no-interface");
  const skillsOk = totalSkills === 0 ? true : flatSkills > 0;
  report.surfaced = plugin.enabled !== false && manifestOk && skillsOk;

  return report;
}

// CLAUDE —
// Claude's `claude plugin list --json` reports an installPath. We trust it,
// then walk the dir to count skills. Claude's scanner accepts nested layouts.
async function discoverClaudePlugin(plugin: PluginRecord): Promise<LifecycleReport> {
  const report: LifecycleReport = {
    agent: "claude-code",
    name: plugin.name,
    marketplace: plugin.marketplace,
    registered: true,
    loaded: false,
    surfaced: false,
    enabled: plugin.enabled,
    skills: { expected: 0, actual: 0 },
    reasons: [],
    paths: [],
    failureTags: [],
  };
  if (plugin.enabled === false) report.reasons.push("plugin is disabled");
  if (!plugin.path) {
    report.reasons.unshift("claude did not report an installPath — cannot probe cache");
    return report;
  }
  if (!(await isDir(plugin.path))) {
    report.reasons.unshift(`installPath does not exist: ${plugin.path}`);
    return report;
  }
  report.paths = [plugin.path];
  report.loaded = true;
  const skills = await findSkillManifests(plugin.path);
  report.skills.expected = skills.length;
  report.skills.actual = skills.length;
  report.surfaced = plugin.enabled !== false;
  return report;
}

// CURSOR —
// Cursor's install dirs are sitting under ~/.cursor/plugins/<scope>/<owner>/<name>/.
// The adapter records `path` already. Cursor's scanner accepts nested layouts.
async function discoverCursorPlugin(plugin: PluginRecord): Promise<LifecycleReport> {
  const report: LifecycleReport = {
    agent: "cursor",
    name: plugin.name,
    marketplace: plugin.marketplace,
    registered: true,
    loaded: false,
    surfaced: false,
    skills: { expected: 0, actual: 0 },
    reasons: [],
    paths: [],
    failureTags: [],
  };
  if (!plugin.path) {
    report.reasons.unshift("no path recorded for cursor plugin");
    return report;
  }
  if (!(await isDir(plugin.path))) {
    report.reasons.unshift(`plugin dir missing: ${plugin.path}`);
    return report;
  }
  report.paths = [plugin.path];
  report.loaded = true;
  const skills = await findSkillManifests(plugin.path);
  report.skills.expected = skills.length;
  report.skills.actual = skills.length;
  report.surfaced = true;
  return report;
}

// OPENCODE —
// OpenCode plugins are npm modules — no cache layout to probe and no skill
// concept (yet). Registered-only check.
function discoverOpencodePlugin(plugin: PluginRecord): LifecycleReport {
  return {
    agent: "opencode",
    name: plugin.name,
    registered: true,
    // We can't easily check whether the npm module is actually installed in the
    // user's environment from here. Treat registered = loaded for opencode.
    loaded: true,
    surfaced: true,
    skills: { expected: 0, actual: 0 },
    reasons: [],
    paths: [],
    failureTags: [],
  };
}

export async function discoverPluginsForAgent(
  read: PluginAdapterRead,
): Promise<LifecycleReport[]> {
  if (read.error || !read.exists) return [];
  const out: LifecycleReport[] = [];
  for (const p of read.plugins) {
    switch (read.agent) {
      case "codex":
        out.push(await discoverCodexPlugin(p));
        break;
      case "claude-code":
        out.push(await discoverClaudePlugin(p));
        break;
      case "cursor":
        out.push(await discoverCursorPlugin(p));
        break;
      case "opencode":
        out.push(discoverOpencodePlugin(p));
        break;
      default:
        // Other agents don't yet have plugin support in syncthis.
        break;
    }
  }
  return out;
}

export async function discoverAll(): Promise<LifecycleReport[]> {
  const reads = await Promise.all(pluginAdapters.map((a) => a.read()));
  const all = await Promise.all(reads.map(discoverPluginsForAgent));
  return all.flat();
}
