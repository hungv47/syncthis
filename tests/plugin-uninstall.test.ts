import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePluginAdapter } from "../src/plugins/claude.ts";
import { codexPluginAdapter } from "../src/plugins/codex.ts";
import { removeArgs, removeSkillNames } from "../src/skills.ts";
import { runPluginUninstall, uninstallHasChanges } from "../src/plugins/uninstall.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let invocationsFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-uninstall-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = workDir;
  invocationsFile = join(workDir, "invocations.log");
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

async function readInvocations(): Promise<string[]> {
  try {
    return (await readFile(invocationsFile, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// `codex plugin list` fixed-width table, as the real CLI prints it.
type CodexRow = [id: string, status: string, version: string, path: string];
function codexTable(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w = [0, 1, 2].map((i) => Math.max(...all.map((r) => r[i]!.length)));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w[0]! + 2)}${r[1].padEnd(w[1]! + 2)}${r[2].padEnd(w[2]! + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `mkt`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

// Fake `claude`: plugin list (+ marketplace list) + a configurable `plugin uninstall`.
async function installFakeClaude(listJson: string, opts: { uninstallExit?: number; uninstallStderr?: string } = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, "claude-list.json");
  await writeFile(listFile, listJson);
  const stderr = (opts.uninstallStderr ?? "fake uninstall failure").replace(/`/g, "\\`");
  const script = `#!/bin/sh
echo "claude $@" >> ${invocationsFile}
if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then echo "[]"; exit 0; fi
if [ "$1 $2" = "plugin uninstall" ]; then ${opts.uninstallExit != null ? `echo "${stderr}" >&2; exit ${opts.uninstallExit}` : "exit 0"}; fi
exit 0
`;
  const p = join(binDir, "claude");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

// Fake `codex`: plugin list + a configurable `plugin remove`. Additive to PATH so a
// fake claude installed first survives.
async function installFakeCodex(listText: string, opts: { removeExit?: number; removeStderr?: string } = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, "codex-list.txt");
  await writeFile(listFile, listText);
  const stderr = (opts.removeStderr ?? "fake remove failure").replace(/`/g, "\\`");
  const script = `#!/bin/sh
echo "codex $@" >> ${invocationsFile}
if [ "$1 $2" = "plugin list" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2" = "plugin remove" ]; then ${opts.removeExit != null ? `echo "${stderr}" >&2; exit ${opts.removeExit}` : "exit 0"}; fi
exit 0
`;
  const p = join(binDir, "codex");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
}

// Fake `npx`: skills list (returns listJson) + a configurable skills remove.
async function installFakeNpx(opts: { listJson?: string; removeExit?: number; removeStderr?: string } = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const script = `#!/bin/sh
echo "npx $@" >> ${invocationsFile}
if [ "$2 $3" = "skills list" ]; then echo '${opts.listJson ?? "[]"}'; exit 0; fi
if [ "$2 $3" = "skills remove" ]; then ${opts.removeStderr ? `echo "${opts.removeStderr}" >&2;` : ""} exit ${opts.removeExit ?? 0}; fi
exit 0
`;
  const p = join(binDir, "npx");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
}

// Materialize a plugin install dir with skills/<name>/SKILL.md leaves.
async function writePluginSkills(dir: string, skills: string[]) {
  for (const s of skills) {
    await mkdir(join(dir, "skills", s), { recursive: true });
    await writeFile(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
}

describe("claude uninstallPlugin", () => {
  test("returns 'absent' without shelling uninstall when the plugin isn't installed", async () => {
    await installFakeClaude(JSON.stringify([{ id: "other@mkt", enabled: true }]));
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("absent");
    expect((await readInvocations()).some((l) => /plugin uninstall/.test(l))).toBe(false);
  });

  test("dry-run reports uninstalled without shelling out", async () => {
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true }]));
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: true, marketplace: "mkt" });
    expect(res.status).toBe("uninstalled");
    expect(res.message).toBe("dry-run");
    expect((await readInvocations()).some((l) => /plugin uninstall/.test(l))).toBe(false);
  });

  test("uninstalls with `--yes --` and the qualified target", async () => {
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true }]));
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("uninstalled");
    expect((await readInvocations()).some((l) => l.trim() === "claude plugin uninstall --yes -- foo@mkt")).toBe(true);
  });

  test("passes --keep-data before the separator when requested", async () => {
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true }]));
    await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false, marketplace: "mkt", keepData: true });
    expect((await readInvocations()).some((l) => l.trim() === "claude plugin uninstall --yes --keep-data -- foo@mkt")).toBe(true);
  });

  test("rejects unsafe plugin names before invoking the CLI", async () => {
    await installFakeClaude(JSON.stringify([]));
    const res = await claudePluginAdapter.uninstallPlugin("../etc/passwd", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("traversal");
    expect((await readInvocations()).some((l) => /plugin uninstall/.test(l))).toBe(false);
  });

  test("surfaces a non-zero uninstall exit as failed with stderr", async () => {
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true }]), { uninstallExit: 3, uninstallStderr: "still in use" });
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("still in use");
  });

  test("missing claude CLI is a clear failure", async () => {
    process.env.PATH = "";
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("not found");
  });
});

describe("codex uninstallPlugin", () => {
  test("'absent' (no shell out) when not installed", async () => {
    await installFakeCodex(codexTable([["other@mkt", "installed, enabled", "1.0.0", "/c/other"]]));
    const res = await codexPluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("absent");
    expect((await readInvocations()).some((l) => /plugin remove/.test(l))).toBe(false);
  });

  test("resolves the installed marketplace from the snapshot and removes with `--`", async () => {
    await installFakeCodex(codexTable([["foo@mkt", "installed, enabled", "1.0.0", "/c/foo"]]));
    const res = await codexPluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("uninstalled");
    expect(res.target).toBe("foo@mkt");
    expect((await readInvocations()).some((l) => l.trim() === "codex plugin remove -- foo@mkt")).toBe(true);
  });

  test("skips (no removal) when installed under multiple marketplaces and none given", async () => {
    await installFakeCodex(
      codexTable([
        ["foo@mkt-a", "installed, enabled", "1.0.0", "/c/a"],
        ["foo@mkt-b", "installed, enabled", "1.0.0", "/c/b"],
      ]),
    );
    const res = await codexPluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("skipped");
    expect(res.message).toContain("multiple marketplaces");
    expect((await readInvocations()).some((l) => /plugin remove/.test(l))).toBe(false);
  });

  test("dry-run does not shell out", async () => {
    await installFakeCodex(codexTable([["foo@mkt", "installed, enabled", "1.0.0", "/c/foo"]]));
    const res = await codexPluginAdapter.uninstallPlugin("foo", { dryRun: true });
    expect(res.status).toBe("uninstalled");
    expect(res.message).toBe("dry-run");
    expect((await readInvocations()).some((l) => /plugin remove/.test(l))).toBe(false);
  });

  test("missing codex CLI is a clear failure", async () => {
    process.env.PATH = "";
    const res = await codexPluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("not found");
  });
});

describe("removeArgs", () => {
  test("builds `skills remove -g -a <agents> -s <names> -y`", () => {
    expect(removeArgs(["alpha", "beta"], ["gemini-cli", "opencode"])).toEqual([
      "-y", "skills", "remove", "-g", "-a", "gemini-cli", "opencode", "-s", "alpha", "beta", "-y",
    ]);
  });
});

describe("removeSkillNames", () => {
  test("no-op (no names) is a skip, never shells out", async () => {
    await installFakeNpx({});
    const r = await removeSkillNames([], ["opencode"]);
    expect(r.status).toBe("skipped");
    expect((await readInvocations())).toEqual([]);
  });

  test("dry-run reports removed without shelling out, drops unsafe names", async () => {
    const r = await removeSkillNames(["beta", "-rf", "alpha", "alpha"], ["opencode"], { dryRun: true });
    expect(r.status).toBe("removed");
    expect(r.skills).toEqual(["alpha", "beta"]); // deduped, sorted, "-rf" dropped
    expect((await readInvocations())).toEqual([]);
  });

  test("shells `npx skills remove` for the named skills + agents", async () => {
    await installFakeNpx({ removeExit: 0 });
    const r = await removeSkillNames(["alpha"], ["gemini-cli", "opencode"]);
    expect(r.status).toBe("removed");
    expect((await readInvocations()).some((l) => l.trim() === "npx -y skills remove -g -a gemini-cli opencode -s alpha -y")).toBe(true);
  });

  test("a 'no matching skills' exit is a benign skip", async () => {
    await installFakeNpx({ removeExit: 1, removeStderr: "No matching skills found" });
    const r = await removeSkillNames(["alpha"], ["opencode"]);
    expect(r.status).toBe("skipped");
  });

  test("a genuine non-zero exit is failed with the cause", async () => {
    await installFakeNpx({ removeExit: 2, removeStderr: "permission denied" });
    const r = await removeSkillNames(["alpha"], ["opencode"]);
    expect(r.status).toBe("failed");
    expect(r.message).toContain("permission denied");
  });
});

describe("runPluginUninstall (orchestrator)", () => {
  // Two plugins sharing a skill: foo→{alpha,shared}, bar→{beta,shared}. Uninstalling
  // foo must remove alpha but KEEP shared (bar still provides it).
  async function setupTwoPlugins() {
    const fooDir = join(workDir, "plugins", "foo");
    const barDir = join(workDir, "plugins", "bar");
    await writePluginSkills(fooDir, ["alpha", "shared"]);
    await writePluginSkills(barDir, ["beta", "shared"]);
    await installFakeClaude(
      JSON.stringify([
        { id: "foo@mkt", enabled: true, installPath: fooDir },
        { id: "bar@mkt", enabled: true, installPath: barDir },
      ]),
    );
    await installFakeCodex(codexTable([["foo@mkt", "installed, enabled", "1.0.0", "/c/foo"]]));
    await installFakeNpx({
      listJson: '[{"name":"alpha","agents":["OpenCode","Gemini CLI"]},{"name":"shared","agents":["OpenCode"]},{"name":"beta","agents":["OpenCode"]}]',
    });
  }

  test("preview: keeps a skill another plugin still provides; narrows skill agents to those holding it", async () => {
    await setupTwoPlugins();
    const r = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["claude-code", "codex", "opencode", "gemini-cli"],
      apply: false,
    });
    // native present on both plugin agents
    expect(r.native.find((t) => t.agent === "claude-code")?.present).toBe(true);
    expect(r.native.find((t) => t.agent === "codex")?.present).toBe(true);
    // alpha removed, shared kept (bar provides it)
    expect(r.skills.names).toEqual(["alpha"]);
    expect(r.skills.kept).toEqual(["shared"]);
    // alpha lives on opencode + gemini-cli (both requested) → both targeted
    expect(r.skills.agents).toEqual(["gemini-cli", "opencode"]);
    expect(uninstallHasChanges(r)).toBe(true);
    // preview must not have shelled any uninstall/remove
    expect((await readInvocations()).some((l) => /plugin uninstall|plugin remove|skills remove/.test(l))).toBe(false);
  });

  test("apply: uninstalls natively on claude+codex and removes the right skill", async () => {
    await setupTwoPlugins();
    const r = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["claude-code", "codex", "opencode", "gemini-cli"],
      apply: true,
    });
    expect(r.nativeResults?.find((x) => x.agent === "claude-code")?.status).toBe("uninstalled");
    expect(r.nativeResults?.find((x) => x.agent === "codex")?.status).toBe("uninstalled");
    expect(r.skillResult?.status).toBe("removed");
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === "claude plugin uninstall --yes -- foo@mkt")).toBe(true);
    expect(inv.some((l) => l.trim() === "codex plugin remove -- foo@mkt")).toBe(true);
    expect(inv.some((l) => l.trim() === "npx -y skills remove -g -a gemini-cli opencode -s alpha -y")).toBe(true);
  });

  test("scoping to only plugin agents removes no skills", async () => {
    await setupTwoPlugins();
    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["claude-code", "codex"], apply: false });
    expect(r.skills.agents).toEqual([]);
    expect(r.skills.names).toEqual(["alpha"]); // computed, but no agents in scope to remove from
    expect(uninstallHasChanges(r)).toBe(true); // native still has work
  });

  // Regression (review P1): a name installed from multiple marketplaces must not be
  // collapsed to one arbitrary marketplace — every instance is targeted, and an
  // explicit `name@marketplace` scopes to just one.
  test("a duplicate plugin name across marketplaces targets every instance, not an arbitrary one", async () => {
    await installFakeClaude(
      JSON.stringify([
        { id: "foo@mkt-a", enabled: true, installPath: join(workDir, "plugins", "foo-a") },
        { id: "foo@mkt-b", enabled: true, installPath: join(workDir, "plugins", "foo-b") },
      ]),
    );
    await installFakeNpx({ listJson: "[]" });
    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["claude-code"], apply: false });
    const claudeTargets = r.native.filter((t) => t.agent === "claude-code" && t.present);
    expect(claudeTargets.map((t) => t.marketplace).sort()).toEqual(["mkt-a", "mkt-b"]);
  });

  test("an explicit name@marketplace scopes to a single instance", async () => {
    await installFakeClaude(
      JSON.stringify([
        { id: "foo@mkt-a", enabled: true, installPath: join(workDir, "plugins", "foo-a") },
        { id: "foo@mkt-b", enabled: true, installPath: join(workDir, "plugins", "foo-b") },
      ]),
    );
    await installFakeNpx({ listJson: "[]" });
    const r = await runPluginUninstall({ plugins: ["foo@mkt-a"], agents: ["claude-code"], apply: false });
    const claudeTargets = r.native.filter((t) => t.agent === "claude-code" && t.present);
    expect(claudeTargets.map((t) => t.marketplace)).toEqual(["mkt-a"]);
  });

  // Regression (review P2): when the mirror put a plugin's skills onto Codex via the
  // skills fallback (Codex couldn't load it natively), `plugin rm` must remove those
  // flat skills from Codex too — not just the skill-cohort agents.
  test("removes a plugin's fallback skills from Codex when scoped there", async () => {
    const fooDir = join(workDir, "plugins", "foo");
    await writePluginSkills(fooDir, ["alpha"]);
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: fooDir }]));
    // Codex has NO native foo plugin (it was a skills-only/unloadable bundle)...
    await installFakeCodex(codexTable([["other@mkt", "installed, enabled", "1.0.0", "/c/other"]]));
    // ...but `npx skills` registered alpha for Codex (the mirror fallback) + OpenCode.
    await installFakeNpx({ listJson: '[{"name":"alpha","agents":["Codex","OpenCode"]}]', removeExit: 0 });

    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["codex", "opencode"], apply: true });
    expect(r.native.find((t) => t.agent === "codex")?.present).toBe(false); // not native on codex
    expect(r.skills.agents).toEqual(["codex", "opencode"]);
    expect(r.skillResult?.status).toBe("removed");
    expect((await readInvocations()).some((l) => l.trim() === "npx -y skills remove -g -a codex opencode -s alpha -y")).toBe(true);
  });

  test("cursor is reported unsupported, nothing to do when the plugin is absent everywhere", async () => {
    await installFakeClaude(JSON.stringify([]));
    await installFakeCodex(codexTable([["other@mkt", "installed, enabled", "1.0.0", "/c/other"]]));
    await installFakeNpx({ listJson: "[]" });
    const r = await runPluginUninstall({ plugins: ["ghost"], agents: ["claude-code", "codex", "cursor"], apply: false });
    expect(r.unsupportedAgents).toContain("cursor");
    expect(uninstallHasChanges(r)).toBe(false);
  });
});
