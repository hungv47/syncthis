// Silent-failure repair primitives — Phase 3 of plan-cross-agent-sync.md.
//
// Each fixer:
//   1. Inspects state, no-ops if already in good shape.
//   2. Writes .syncthis.bak on first patch (sacred §10).
//   3. Is idempotent — running twice produces the same result.
//   4. Patches only the *agent's local cache*, never upstream sources
//      (per §7 decision #6 — agent cache is source of truth, no overlays).
//
// Fixers are keyed by `failureTags` emitted by discovery.ts so the dispatcher
// can pick the right repair without re-walking the filesystem.

import { readdir, readFile, stat, symlink, unlink, writeFile, chmod, lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { backupIfExists } from "../io.ts";
import { discoverPluginsForAgent, type LifecycleReport } from "./discovery.ts";
import { pluginAdapters } from "./index.ts";
import type { AgentId } from "../types.ts";

export type FixerId = "codex-flatten-skills" | "codex-inject-interface";

export type FixerResult = {
  fixer: FixerId;
  agent: AgentId;
  plugin: string;
  applied: boolean;
  // Was the target already in good state? (idempotency signal.)
  noop: boolean;
  message: string;
  // Files patched (or that would be patched in dry-run).
  patched: string[];
  dryRun: boolean;
};

type FixerOpts = { dryRun: boolean };

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

// CODEX FLATTEN SKILLS — for plugins with skills/<category>/<skill>/SKILL.md,
// create flat aliases at skills/<category>__<skill>/SKILL.md so Codex's
// one-level-deep scanner picks them up. Aliases are symlinks pointing into the
// nested original — no content duplication, no upstream mutation.
async function fixCodexFlattenSkills(report: LifecycleReport, opts: FixerOpts): Promise<FixerResult[]> {
  const out: FixerResult[] = [];
  for (const pluginDir of report.paths) {
    const skillsDir = join(pluginDir, "skills");
    const result: FixerResult = {
      fixer: "codex-flatten-skills",
      agent: report.agent,
      plugin: report.name,
      applied: false,
      noop: true,
      message: "no nested skills",
      patched: [],
      dryRun: opts.dryRun,
    };

    const nested = await collectNestedSkills(skillsDir);
    if (nested.length === 0) {
      out.push(result);
      continue;
    }

    const work: { alias: string; target: string }[] = [];
    for (const item of nested) {
      const alias = join(skillsDir, `${item.category}__${item.skill}`);
      const target = join(skillsDir, item.category, item.skill);
      // Idempotent: skip if the alias already exists and points where we'd point it.
      if (await isSymlink(alias)) {
        // Could be a stale link — be safe and let it stand. Idempotency requires we don't redo it.
        continue;
      }
      if (await pathExists(alias)) {
        // Real dir already at that name — refuse to overwrite.
        continue;
      }
      work.push({ alias, target });
    }

    if (work.length === 0) {
      result.message = `${nested.length} nested skill(s) already aliased`;
      out.push(result);
      continue;
    }

    result.noop = false;
    result.patched = work.map((w) => w.alias);
    result.message = `${work.length} alias(es) for nested skill(s)`;

    if (!opts.dryRun) {
      // Write a single .syncthis.bak marker beside the skills dir so a future
      // revert can find it. The marker records the alias paths created.
      const markerPath = join(skillsDir, ".syncthis-flatten");
      const existing = await safeRead(markerPath);
      const recorded = new Set<string>(existing ? existing.split("\n").filter(Boolean) : []);
      for (const w of work) {
        // Re-check just before linking to close any race.
        if (await pathExists(w.alias)) continue;
        const rel = relative(dirname(w.alias), w.target);
        await symlink(rel, w.alias);
        recorded.add(relative(skillsDir, w.alias));
      }
      await writeFile(markerPath, [...recorded].sort().join("\n") + "\n", { mode: 0o600 });
      await chmod(markerPath, 0o600);
      result.applied = true;
    }

    out.push(result);
  }
  return out;
}

async function collectNestedSkills(skillsDir: string): Promise<{ category: string; skill: string }[]> {
  if (!(await pathExists(skillsDir))) return [];
  const items: { category: string; skill: string }[] = [];
  let categories: import("node:fs").Dirent[];
  try {
    categories = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const cat of categories) {
    if (!cat.isDirectory()) continue;
    if (cat.name.includes("__")) continue; // Already a flat alias name.
    const catPath = join(skillsDir, cat.name);
    // Skip if this directory IS a flat skill (contains its own SKILL.md).
    if (await pathExists(join(catPath, "SKILL.md"))) continue;
    let inner: import("node:fs").Dirent[];
    try {
      inner = await readdir(catPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const skill of inner) {
      if (!skill.isDirectory()) continue;
      if (await pathExists(join(catPath, skill.name, "SKILL.md"))) {
        items.push({ category: cat.name, skill: skill.name });
      }
    }
  }
  return items;
}

// CODEX INJECT INTERFACE — when plugin.json has no `interface` block, inject a
// minimal one synthesized from the skills the plugin actually ships. Without
// this, Codex registers but doesn't surface in its UI.
//
// The injected stub is deliberately conservative: only declares skill names so
// Codex has something to render; no command/agent/hook claims that could be
// wrong. If the plugin already has any `interface` (even partial), we leave it.
async function fixCodexInjectInterface(report: LifecycleReport, opts: FixerOpts): Promise<FixerResult[]> {
  const out: FixerResult[] = [];
  for (const pluginDir of report.paths) {
    const result: FixerResult = {
      fixer: "codex-inject-interface",
      agent: report.agent,
      plugin: report.name,
      applied: false,
      noop: true,
      message: "manifest already has interface block",
      patched: [],
      dryRun: opts.dryRun,
    };

    const manifestPath = await findManifest(pluginDir);
    if (!manifestPath) {
      result.message = "no plugin.json found";
      out.push(result);
      continue;
    }

    let manifest: Record<string, unknown>;
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
      manifest = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      result.message = `manifest unreadable: ${(err as Error).message}`;
      out.push(result);
      continue;
    }

    if (manifest.interface && typeof manifest.interface === "object") {
      out.push(result);
      continue;
    }

    const skills = await listSkillsForInterface(join(pluginDir, "skills"));
    if (skills.length === 0) {
      result.message = "no skills to declare in synthetic interface";
      out.push(result);
      continue;
    }

    const synthetic = {
      // Minimal Codex-compatible interface shape: a `skills` array referencing
      // each skill by name. This is what plugins-cli does for bare upstreams.
      skills: skills.map((name) => ({ name })),
    };

    result.noop = false;
    result.patched = [manifestPath];
    result.message = `injected interface block declaring ${skills.length} skill(s)`;

    if (!opts.dryRun) {
      await backupIfExists(manifestPath);
      const next = { ...manifest, interface: synthetic };
      const text = JSON.stringify(next, null, 2) + "\n";
      await writeFile(manifestPath, text, { mode: 0o600 });
      await chmod(manifestPath, 0o600);
      result.applied = true;
    }

    out.push(result);
  }
  return out;
}

async function findManifest(pluginDir: string): Promise<string | null> {
  for (const name of ["plugin.json", "codex-plugin.json"]) {
    const path = join(pluginDir, name);
    if (await pathExists(path)) return path;
  }
  return null;
}

// List skills directly under <skillsDir>/<name>/ or under <skillsDir>/<cat>/<skill>/
// (the post-flatten alias is also listed). Used to build the synthetic interface.
async function listSkillsForInterface(skillsDir: string): Promise<string[]> {
  if (!(await pathExists(skillsDir))) return [];
  const names = new Set<string>();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const direct = join(skillsDir, e.name, "SKILL.md");
    if (await pathExists(direct)) {
      names.add(e.name);
      continue;
    }
    // Nested case: include each skill below.
    let inner: import("node:fs").Dirent[];
    try {
      inner = await readdir(join(skillsDir, e.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const i of inner) {
      if (i.isDirectory() && (await pathExists(join(skillsDir, e.name, i.name, "SKILL.md")))) {
        names.add(`${e.name}__${i.name}`);
      }
    }
  }
  return [...names].sort();
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export type RunFixersOpts = {
  dryRun: boolean;
  // When provided, only run on these plugin names.
  only?: string[];
};

// Public entry point — discovers across all agents, picks fixers by failureTag,
// returns one FixerResult per (plugin × fixer × cache-dir). Callers can
// summarize / render.
export async function runFixers(opts: RunFixersOpts): Promise<FixerResult[]> {
  const reads = await Promise.all(pluginAdapters.map((a) => a.read()));
  const lifecycles = await Promise.all(reads.map(discoverPluginsForAgent));
  const all = lifecycles.flat();
  const filtered = opts.only?.length ? all.filter((r) => opts.only!.includes(r.name)) : all;
  const out: FixerResult[] = [];
  for (const report of filtered) {
    if (report.failureTags.includes("codex-nested-skills")) {
      out.push(...(await fixCodexFlattenSkills(report, opts)));
    }
    if (report.failureTags.includes("codex-no-interface")) {
      out.push(...(await fixCodexInjectInterface(report, opts)));
    }
  }
  return out;
}

// Variant that takes pre-discovered lifecycle reports (used by sync flow to
// avoid re-scanning the filesystem twice in one command).
export async function runFixersOnReports(reports: LifecycleReport[], opts: RunFixersOpts): Promise<FixerResult[]> {
  const filtered = opts.only?.length ? reports.filter((r) => opts.only!.includes(r.name)) : reports;
  const out: FixerResult[] = [];
  for (const report of filtered) {
    if (report.failureTags.includes("codex-nested-skills")) {
      out.push(...(await fixCodexFlattenSkills(report, opts)));
    }
    if (report.failureTags.includes("codex-no-interface")) {
      out.push(...(await fixCodexInjectInterface(report, opts)));
    }
  }
  return out;
}

// Revert helper used by tests for the round-trip assertion. Reads .syncthis-flatten
// marker, removes only those symlinks (not the marker itself, in case the user
// wants to re-fix). For interface injection, restores plugin.json from .syncthis.bak.
export async function revertFixers(reports: LifecycleReport[]): Promise<{ reverted: string[] }> {
  const reverted: string[] = [];
  for (const report of reports) {
    for (const pluginDir of report.paths) {
      const skillsDir = join(pluginDir, "skills");
      const marker = join(skillsDir, ".syncthis-flatten");
      const recorded = await safeRead(marker);
      if (recorded) {
        for (const line of recorded.split("\n").map((l) => l.trim()).filter(Boolean)) {
          const aliasPath = join(skillsDir, line);
          if (await isSymlink(aliasPath)) {
            await unlink(aliasPath);
            reverted.push(aliasPath);
          }
        }
        await unlink(marker).catch(() => {});
      }
      const manifest = await findManifest(pluginDir);
      if (manifest) {
        const bak = `${manifest}.syncthis.bak`;
        if (await pathExists(bak)) {
          const text = await readFile(bak, "utf8");
          await writeFile(manifest, text, { mode: 0o600 });
          await unlink(bak).catch(() => {});
          reverted.push(manifest);
        }
      }
    }
  }
  return { reverted };
}
