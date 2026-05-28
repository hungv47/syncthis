// Plugin lifecycle discovery — given an installed plugin, decide whether it's
// merely *registered* in config, *loaded* (cache materialized + manifest parses),
// and *surfaced* (would the agent's scanner actually pick up its artifacts).
//
// The point of this layer is to light up the "registered ✓ but surfaced ✗" gap
// described in plan-cross-agent-sync.md §3 — the silent-failure zone where
// every existing tool reports green.

import { readdir, stat, readFile, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { expandHome } from "../io.ts";
import { pluginAdapters } from "./index.ts";
import { isSafeIdentifier } from "./shell.ts";
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
  // Free-form tags for real, verifiable failure states — e.g. "codex-no-cache",
  // "codex-no-manifest", "codex-unsafe-name".
  failureTags: string[];
};

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

// Recursively find SKILL.md files under a skills directory, mirroring Codex's
// loader (codex-rs/core-skills/src/loader.rs): it descends real AND symlinked
// directories, capped at depth 6 from the root, so nested skills/<cat>/<skill>/
// SKILL.md surface exactly as Codex (and Claude/Cursor) see them. One path per skill.
const MAX_SKILL_SCAN_DEPTH = 6;
async function collectSkillManifests(skillsDir: string): Promise<string[]> {
  if (!(await isDir(skillsDir))) return [];
  const root = resolve(skillsDir);
  const found: string[] = [];
  await walk(skillsDir, 0);
  return found;

  async function walk(dir: string, depth: number) {
    if (depth > MAX_SKILL_SCAN_DEPTH) return;
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
        found.push(join(dir, e.name));
      }
    }
    if (hasSkillMd) return;
    for (const e of entries) {
      const child = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(child, depth + 1);
      } else if (e.isSymbolicLink() && (await isDir(child))) {
        // Codex follows symlinked skill dirs, but only honor links that resolve
        // back inside the scan root — a link escaping the plugin tree (e.g.
        // skills/x -> /etc) must not make this read-only scan enumerate unrelated
        // directories. Keeps the resolveSkillsRoot containment guarantee intact.
        const target = await realpath(child).catch(() => null);
        if (target && (target === root || target.startsWith(root + sep))) {
          await walk(child, depth + 1);
        }
      }
    }
  }
}

// Skills shipped under <pluginDir>/skills (Claude/Cursor install layout).
async function findSkillManifests(pluginDir: string): Promise<string[]> {
  return collectSkillManifests(join(pluginDir, "skills"));
}

// Codex reads a plugin's manifest from .codex-plugin/plugin.json (verified across
// every installed plugin), falling back to .claude-plugin/plugin.json. The `skills`
// field, when a string, points at the skills root Codex scans; otherwise it defaults
// to ./skills/. (Confirmed against codex-rs/core-skills/src/loader.rs.)
type CodexManifest = { skills?: unknown };
async function readCodexManifest(pluginDir: string): Promise<CodexManifest | null> {
  for (const rel of [".codex-plugin", ".claude-plugin"]) {
    try {
      return JSON.parse(await readFile(join(pluginDir, rel, "plugin.json"), "utf8")) as CodexManifest;
    } catch {
      continue;
    }
  }
  return null;
}

function resolveSkillsRoot(pluginDir: string, manifest: CodexManifest | null): string {
  const fallback = join(pluginDir, "skills");
  const s = manifest?.skills;
  if (typeof s !== "string" || !s.trim()) return fallback;
  // The manifest is plugin-authored data. Containment guard: refuse a `skills`
  // value that escapes the plugin dir (absolute path or ../ traversal). The scan
  // is read-only, but a rogue value could enumerate an unrelated/huge tree or
  // report skills from outside the plugin.
  const resolved = resolve(pluginDir, s);
  const rel = relative(resolve(pluginDir), resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return fallback;
  return resolved;
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

  // A malformed/malicious config.toml table key (e.g. [plugins."../../x"]) parses
  // into a name with path separators. Refuse to resolve a cache dir for an unsafe
  // name before it reaches any join() — same guard codex.ts applies on the remove path.
  if (!isSafeIdentifier(plugin.name)) {
    report.reasons.unshift(`unsafe plugin name in config (path separators/traversal): ${plugin.name}`);
    report.failureTags.push("codex-unsafe-name");
    return report;
  }

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

  // Codex's loader reads .codex-plugin/plugin.json, takes its `skills` field as a
  // root, and recursively scans it (depth<=6, following symlinks) for SKILL.md.
  // Surfacing is manifest + recursion driven — there is no one-level-deep limit and
  // no interface-block gate, so we report exactly what that scan would find. A
  // plugin with a manifest but no skills still surfaces (commands/tools-only).
  let totalSkills = 0;
  let manifestPresent = false;
  for (const dir of candidatePluginDirs) {
    const manifest = await readCodexManifest(dir);
    if (manifest) manifestPresent = true;
    totalSkills += (await collectSkillManifests(resolveSkillsRoot(dir, manifest))).length;
  }
  report.skills.expected = totalSkills;
  report.skills.actual = totalSkills;

  if (!manifestPresent) {
    report.reasons.push("no .codex-plugin/plugin.json in cache dir — Codex will not load this as a plugin");
    report.failureTags.push("codex-no-manifest");
  }

  report.surfaced = plugin.enabled !== false && manifestPresent;

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
