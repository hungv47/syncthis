import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { adapters } from "./adapters/index.ts";
import { expandHome, readJson } from "./io.ts";
import { isSafeRepoSlug, isSafeSkillName, run } from "./plugins/shell.ts";
import type { AgentId } from "./types.ts";

// Agents that consume the open-plugin bundle natively — Claude (`claude plugin`),
// Codex (`codex plugin`), Cursor (`npx plugins --target cursor`). They receive the
// FULL plugin (skills + commands + subagents + MCP), so we never re-add a plugin's
// skills to them as loose, un-namespaced skills: that would duplicate what the
// plugin already provides and reintroduce cross-plugin name collisions that the
// `plugin:skill` namespace was preventing.
export const PLUGIN_TARGET_AGENTS: readonly AgentId[] = ["claude-code", "codex", "cursor"];

// Agents that support skills (vercel-labs/skills) but have NO native MCP config to
// sync, so they get no MCP adapter — they appear in the SKILL cohort only, never in
// MCP sync or the plugin→MCP decomposition. Pi (badlogic/pi-mono) ships without MCP
// by design ("No MCP"); its skills id is `pi`, skills land in ~/.pi/agent/skills.
export const SKILL_ONLY_AGENTS: readonly AgentId[] = ["pi"];

// The MCP cohort: every MCP-syncable agent that is NOT plugin-capable. These are the
// targets for the plugin→MCP decomposition (the plugin cohort gets a plugin's MCP
// servers by installing the plugin). Derived from the adapter registry so it tracks
// new MCP adapters automatically.
export function mcpCohort(): AgentId[] {
  return adapters.map((a) => a.id).filter((id) => !PLUGIN_TARGET_AGENTS.includes(id));
}

// The skill cohort: every non-plugin agent that can receive skills via
// `npx skills add -a <agent>`. That's the MCP cohort plus skills-only agents (Pi),
// since skills reach more agents than native MCP sync does.
export function skillCohort(): AgentId[] {
  return [...new Set([...mcpCohort(), ...SKILL_ONLY_AGENTS])];
}

const CLAUDE_MARKETPLACES = "~/.claude/plugins/known_marketplaces.json";
const SKILLS_ADD_TIMEOUT_MS = 180_000;

type KnownMarketplaces = Record<
  string,
  { source?: { source?: string; repo?: string }; installLocation?: string }
>;

export type PluginSkillSource = { marketplace: string; repo: string; installLocation: string };

export type SkillAddStatus = "added" | "skipped" | "failed";
export type SkillAddResult = { repo: string; status: SkillAddStatus; message?: string };

export type PluginSkillsReport = {
  ran: boolean;
  dryRun: boolean;
  agents: AgentId[];
  sources: PluginSkillSource[];
  results: SkillAddResult[];
  message?: string;
};

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

// A cloned marketplace carries skills if its working copy has a root SKILL.md or a
// skills/ dir. Cheap local check (no network) used to skip plugin/MCP-only
// marketplaces so we don't fire `npx skills add` at repos with nothing to add.
async function marketplaceHasSkills(installLocation: string): Promise<boolean> {
  return (await isFile(join(installLocation, "SKILL.md"))) || (await isDir(join(installLocation, "skills")));
}

// Resolve the GitHub source repos behind Claude's installed plugin marketplaces.
// These repos are the source set handed to `npx skills add`. Filtered to github
// sources that actually carry skills, slug-validated (defends the CLI invocation
// against an adversarial marketplace entry being read as a flag), and deduped.
export async function resolvePluginSkillSources(): Promise<PluginSkillSource[]> {
  // A malformed known_marketplaces.json must not crash the whole `sync` — readJson
  // throws on invalid JSON. Treat any read/parse failure as "no skill sources" and
  // continue; the skills pass is best-effort and additive.
  let data: KnownMarketplaces | null;
  try {
    data = await readJson<KnownMarketplaces>(expandHome(CLAUDE_MARKETPLACES));
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const out: PluginSkillSource[] = [];
  const seen = new Set<string>();
  const candidates = await Promise.all(Object.entries(data).map(async ([marketplace, entry]) => {
    const repo = entry?.source?.repo;
    const installLocation = entry?.installLocation;
    if (!repo || entry?.source?.source !== "github" || !installLocation) return null;
    if (!isSafeRepoSlug(repo)) return null;
    if (!(await marketplaceHasSkills(installLocation))) return null;
    return { marketplace, repo, installLocation };
  }));
  for (const source of candidates) {
    if (!source || seen.has(source.repo)) continue;
    seen.add(source.repo);
    out.push(source);
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo));
}

// Source repos (owner/repo) that already have at least one plugin INSTALLED on a
// target, determined by matching the target's installed plugin names against each
// cloned marketplace's declared plugin entry names. A repo here is "covered": its
// skills are present via the installed plugin, so the mirror must NOT re-add them
// flat (`npx skills add`) — that would duplicate the plugin's namespaced skills.
// Name-based, so it works even when the target's canonical name differs from the
// primary's install id (the `github.com-*` re-run case). Best-effort: an unreadable
// known_marketplaces.json yields an empty set (no coverage claimed → safe default).
export async function resolveInstalledRepoCoverage(installedNames: Set<string>): Promise<Set<string>> {
  const covered = new Set<string>();
  let data: KnownMarketplaces | null;
  try {
    data = await readJson<KnownMarketplaces>(expandHome(CLAUDE_MARKETPLACES));
  } catch {
    return covered;
  }
  if (!data || typeof data !== "object") return covered;
  const candidates = await Promise.all(Object.values(data).map(async (entry) => {
    const repo = entry?.source?.repo;
    const installLocation = entry?.installLocation;
    if (!repo || entry?.source?.source !== "github" || !installLocation) return null;
    if (!isSafeRepoSlug(repo)) return null;
    const names = await marketplacePluginNames(installLocation);
    return names.some((n) => installedNames.has(n)) ? repo : null;
  }));
  for (const repo of candidates) {
    if (repo) covered.add(repo);
  }
  return covered;
}

// The plugin entry names a cloned marketplace declares in its marketplace.json.
// These are the names a plugin agent installs under — which, for a multi-plugin
// marketplace, differ from the Claude-side install id (e.g. Claude's URL-named
// `github.com-garrytan-gstack` vs the entry `gstack`). Used to map a target's
// installed plugin back to its source repo even across that name difference.
async function marketplacePluginNames(installLocation: string): Promise<string[]> {
  for (const rel of [".claude-plugin/marketplace.json", "marketplace.json"]) {
    try {
      const data = await readJson<{ plugins?: Array<{ name?: unknown }> }>(join(installLocation, rel));
      const plugins = data?.plugins;
      if (Array.isArray(plugins)) {
        return plugins.map((p) => p?.name).filter((n): n is string => typeof n === "string");
      }
    } catch {
      /* try the next candidate path */
    }
  }
  return [];
}

// Skill names already installed globally, per `npx skills list -g --json`. Used to
// skip source repos whose skills are all present already, so re-runs (and every
// `syncthis run`) don't re-fetch every repo. Best-effort: any failure (npx
// missing, bad JSON) yields an empty set, which simply disables the skip.
async function installedSkillNames(): Promise<Set<string>> {
  const res = await run("npx", ["-y", "skills", "list", "-g", "--json"], { timeoutMs: 60_000 });
  if (!res.ok) return new Set();
  try {
    const arr = JSON.parse(res.stdout || "[]");
    if (!Array.isArray(arr)) return new Set();
    return new Set(
      (arr as Array<{ name?: unknown }>).map((s) => s?.name).filter((n): n is string => typeof n === "string"),
    );
  } catch {
    return new Set();
  }
}

// The skills CLI reports each skill's agents by human display label ("Hermes
// Agent", "Gemini CLI", "GitHub Copilot"), not by syncthis AgentId. Map the labels
// syncthis knows; an unknown label (e.g. "Warp", which has no MCP adapter) resolves
// to undefined and is dropped. Lowercased keys so casing/spacing variance is moot.
const SKILL_AGENT_LABELS: Record<string, AgentId> = {
  "claude code": "claude-code",
  cursor: "cursor",
  codex: "codex",
  "gemini cli": "gemini-cli",
  gemini: "gemini-cli",
  "kimi cli": "kimi-cli",
  kimi: "kimi-cli",
  antigravity: "antigravity",
  "github copilot": "github-copilot",
  "github copilot cli": "github-copilot",
  windsurf: "windsurf",
  opencode: "opencode",
  openclaw: "openclaw",
  "hermes agent": "hermes-agent",
  hermes: "hermes-agent",
  goose: "goose",
  pi: "pi",
};

export function skillAgentLabelToId(label: string): AgentId | undefined {
  return SKILL_AGENT_LABELS[label.trim().toLowerCase()];
}

export type InstalledSkill = { name: string; agents: AgentId[] };

// Every globally-installed skill with the agents it's registered on, from
// `npx skills list -g --json`. Returns null when the CLI can't be read (missing
// npx, bad JSON) so callers can distinguish "couldn't read" from "no skills".
export async function listInstalledSkills(): Promise<InstalledSkill[] | null> {
  const res = await run("npx", ["-y", "skills", "list", "-g", "--json"], { timeoutMs: 60_000 });
  if (!res.ok) return null;
  try {
    const arr = JSON.parse(res.stdout || "[]");
    if (!Array.isArray(arr)) return null;
    return (arr as Array<{ name?: unknown; agents?: unknown }>)
      .map((s) => ({
        name: typeof s?.name === "string" ? s.name : "",
        agents: Array.isArray(s?.agents)
          ? (s.agents as unknown[])
              .map((a) => (typeof a === "string" ? skillAgentLabelToId(a) : undefined))
              .filter((a): a is AgentId => !!a)
          : [],
      }))
      .filter((s) => s.name);
  } catch {
    return null;
  }
}

export type PluginDerivedSkills = { repo: string; marketplace: string; names: string[] };

// The skill names contributed by each of Claude's skill-bearing plugin marketplaces.
// This is the "plugins, expressed as skills" set — what the mirror surfaces to the
// non-plugin agents, and what `plugin rm` removes from them. Local-only (no network).
export async function resolvePluginDerivedSkills(): Promise<PluginDerivedSkills[]> {
  const sources = await resolvePluginSkillSources();
  return Promise.all(
    sources.map(async (s) => ({
      repo: s.repo,
      marketplace: s.marketplace,
      names: (await repoSkillNames(s.installLocation)) ?? [],
    })),
  );
}

// The skill names a marketplace clone provides. Walks the `skills/` subtree (and a
// root-level SKILL.md) for every SKILL.md, since real marketplaces nest by category
// (`skills/<category>/<skill>/SKILL.md`) as well as flat (`skills/<skill>/`). Keys
// on each skill's frontmatter `name` — what `npx skills list` reports — falling back
// to the directory name. Returns null when no SKILL.md is found, so the caller never
// skips a repo it can't account for.
export async function repoSkillNames(installLocation: string): Promise<string[] | null> {
  const files: string[] = [];
  await collectSkillMd(join(installLocation, "skills"), files, 3);
  if (await isFile(join(installLocation, "SKILL.md"))) files.push(join(installLocation, "SKILL.md"));
  if (files.length === 0) return null;
  return Promise.all(files.map(skillName));
}

// Candidate install identities for the skills a plugin bundles: for every SKILL.md
// leaf, BOTH its frontmatter `name` and its leaf directory name (the install slug).
// `npx skills list`/`remove` key on one identity; the two normally agree, but a
// title-cased frontmatter name with a kebab install dir would otherwise be shown yet
// never removed. Returning both lets a caller match whichever the CLI uses. Deduped;
// empty when the install dir has no SKILL.md.
export async function pluginSkillIdentities(installLocation: string): Promise<string[]> {
  const files: string[] = [];
  await collectSkillMd(join(installLocation, "skills"), files, 3);
  if (await isFile(join(installLocation, "SKILL.md"))) files.push(join(installLocation, "SKILL.md"));
  const ids = new Set<string>();
  for (const f of files) {
    ids.add(await skillName(f)); // frontmatter name (falls back to dir name)
    ids.add(basename(dirname(f))); // leaf dir name = install slug
  }
  return [...ids];
}

// Collect SKILL.md paths under `dir`. A directory containing SKILL.md is a skill leaf
// — record it and don't descend into its support files. Depth-bounded as a backstop.
async function collectSkillMd(dir: string, out: string[], depth: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    out.push(join(dir, "SKILL.md"));
    return;
  }
  if (depth <= 0) return;
  for (const e of entries) {
    if (e.isDirectory()) await collectSkillMd(join(dir, e.name), out, depth - 1);
  }
}

// A skill's name = its SKILL.md frontmatter `name` (matches `npx skills list`);
// fall back to the containing directory name if the frontmatter can't be read.
async function skillName(skillMdPath: string): Promise<string> {
  try {
    const text = await readFile(skillMdPath, "utf8");
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    // Capture the whole value then strip matching surrounding quotes, so names
    // containing spaces or punctuation (e.g. `name: "My Skill"`) aren't truncated
    // — a truncated name would never match `npx skills list`, defeating the skip.
    const raw = fm?.[1]?.match(/^name:[ \t]*(.+?)[ \t]*$/m)?.[1];
    const nm = raw?.replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
    if (nm) return nm;
  } catch {
    /* fall through to dir name */
  }
  return basename(dirname(skillMdPath));
}

// `npx skills add <repo> -g -s '*' -a <agent>... -y` — install every skill the
// repo provides, globally, into each named agent, non-interactively.
export function addArgs(repo: string, agents: readonly AgentId[]): string[] {
  const args = ["-y", "skills", "add", repo, "-g", "-s", "*"];
  for (const a of agents) args.push("-a", a);
  args.push("-y");
  return args;
}

function addOne(repo: string, agents: readonly AgentId[]): Promise<SkillAddResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("npx", addArgs(repo, agents), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SKILLS_ADD_TIMEOUT_MS);
    // 'error' (spawn failure) and 'close' can both fire — settle exactly once.
    const finish = (r: SkillAddResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (err: Error) => finish({ repo, status: "failed", message: err.message }));
    child.on("close", (code) => {
      if (timedOut) return finish({ repo, status: "failed", message: `timed out after ${SKILLS_ADD_TIMEOUT_MS / 1000}s` });
      if (code === 0) return finish({ repo, status: "added" });
      const blob = `${stdout}\n${stderr}`;
      const tail = stderr.trim().split("\n").pop() || stdout.trim().split("\n").pop() || "";
      // The skills CLI exits non-zero when a repo has no installable skills. That's
      // not a failure for us — the pre-filter should avoid it, but tolerate it.
      if (/no skills?\b|no SKILL\.md|nothing to (install|add)/i.test(blob)) {
        return finish({ repo, status: "skipped", message: "no skills found" });
      }
      finish({ repo, status: "failed", message: `exit ${code}: ${tail}` });
    });
  });
}

// Install specific source repos as loose skills into specific agents. Used by the
// plugin mirror's Codex skills-fallback: when Codex can't load a skills-only bundle
// as a plugin, its skills are still added here. Repos are deduped, sorted, and
// slug-validated (an unsafe slug could be read as a flag by the skills CLI). One
// `npx skills add` per repo, sequentially — concurrent invocations race on the
// shared agent skill directories.
export async function addSkillRepos(
  repos: string[],
  agents: readonly AgentId[],
  opts: { dryRun?: boolean } = {},
): Promise<SkillAddResult[]> {
  const unique = [...new Set(repos)].filter((r) => isSafeRepoSlug(r)).sort();
  const out: SkillAddResult[] = [];
  for (const repo of unique) {
    if (opts.dryRun) {
      out.push({ repo, status: "added", message: "dry-run" });
      continue;
    }
    out.push(await addOne(repo, agents));
  }
  return out;
}

export type SkillRemoveResult = {
  skills: string[];
  agents: AgentId[];
  status: "removed" | "skipped" | "failed";
  message?: string;
};

// `npx skills remove -g -a <agent>… -s <name>… -y` — remove the named skills from
// each named agent, globally, non-interactively. Both flags are variadic in the
// skills CLI (`--agent claude-code cursor`, `--skill pr-review commit`); `-s` is
// placed last so the trailing `-y` flag terminates its value list.
export function removeArgs(names: string[], agents: readonly AgentId[]): string[] {
  return ["-y", "skills", "remove", "-g", "-a", ...agents, "-s", ...names, "-y"];
}

function removeOne(names: string[], agents: readonly AgentId[]): Promise<SkillRemoveResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("npx", removeArgs(names, agents), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SKILLS_ADD_TIMEOUT_MS);
    const finish = (r: SkillRemoveResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (err: Error) => finish({ skills: names, agents: [...agents], status: "failed", message: err.message }));
    child.on("close", (code) => {
      if (timedOut) return finish({ skills: names, agents: [...agents], status: "failed", message: `timed out after ${SKILLS_ADD_TIMEOUT_MS / 1000}s` });
      if (code === 0) return finish({ skills: names, agents: [...agents], status: "removed" });
      const blob = `${stdout}\n${stderr}`;
      const tail = stderr.trim().split("\n").pop() || stdout.trim().split("\n").pop() || "";
      // The skills CLI exits non-zero when nothing matched — not a failure for us
      // (the skill was already gone), so report it as a benign skip.
      if (/no (matching )?skills?\b|not found|nothing to remove/i.test(blob)) {
        return finish({ skills: names, agents: [...agents], status: "skipped", message: "no matching skills" });
      }
      finish({ skills: names, agents: [...agents], status: "failed", message: `exit ${code}: ${tail}` });
    });
  });
}

// Remove specific skills (by name) from specific agents — the skill-cohort side of
// `syncthis plugin rm`. Names are slug-validated (a leading "-" would be read as a
// flag by the skills CLI) and deduped. One `npx skills remove` call covers every
// (name, agent) pair. A no-op input (no names or no agents) returns "skipped"
// without shelling out.
export async function removeSkillNames(
  names: string[],
  agents: readonly AgentId[],
  opts: { dryRun?: boolean } = {},
): Promise<SkillRemoveResult> {
  const safe = [...new Set(names)].filter((n) => isSafeSkillName(n)).sort();
  if (safe.length === 0 || agents.length === 0) {
    return { skills: [], agents: [...agents], status: "skipped", message: "nothing to remove" };
  }
  if (opts.dryRun) return { skills: safe, agents: [...agents], status: "removed", message: "dry-run" };
  return removeOne(safe, agents);
}

// Surface skills bundled inside Claude's installed plugins to the skill-cohort
// agents (everything that can't consume plugins natively). One `npx skills add`
// per source repo, sequentially — concurrent invocations would race on the shared
// agent skill directories.
export async function addSkillsFromPlugins(
  opts: {
    dryRun?: boolean;
    agents?: AgentId[];
    onProgress?: (repo: string, i: number, total: number) => void;
  } = {},
): Promise<PluginSkillsReport> {
  const dryRun = !!opts.dryRun;
  const agents = opts.agents ?? skillCohort();
  const sources = await resolvePluginSkillSources();
  if (sources.length === 0) {
    return { ran: false, dryRun, agents, sources, results: [], message: "no skill-bearing plugins found in ~/.claude/plugins" };
  }

  // Skip repos already fully present (every skill name in the global list). New
  // plugins still get added; this is what keeps a repeat `run` from re-fetching.
  // Deliberately coarse: keyed on global presence, not per-agent registration. We
  // always add with the full cohort `-a` set, so global presence implies cohort
  // coverage in practice. The only gap is a skill that entered the store via some
  // other path (a manual single-agent `npx skills add`, or a newly added adapter
  // widening the cohort) — rare, and resolved by a forced `skills from-plugins`.
  // Not worth an 8× per-agent `skills list` probe + a brittle id→display-name map.
  const [installed, sourceSkills] = await Promise.all([
    installedSkillNames(),
    Promise.all(sources.map(async (source) => ({ source, names: await repoSkillNames(source.installLocation) }))),
  ]);
  const results: SkillAddResult[] = [];
  const toAdd: PluginSkillSource[] = [];
  for (const { source: s, names } of sourceSkills) {
    if (names && names.every((n) => installed.has(n))) {
      results.push({ repo: s.repo, status: "skipped", message: "already synced" });
    } else {
      toAdd.push(s);
    }
  }

  if (dryRun) {
    for (const s of toAdd) results.push({ repo: s.repo, status: "added", message: "dry-run" });
    return { ran: true, dryRun, agents, sources, results };
  }

  let i = 0;
  for (const s of toAdd) {
    i += 1;
    opts.onProgress?.(s.repo, i, toAdd.length);
    results.push(await addOne(s.repo, agents));
  }
  return { ran: true, dryRun, agents, sources, results };
}
