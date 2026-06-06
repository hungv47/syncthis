import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginOverview } from "../src/plugins/overview.ts";
import { skillAgentLabelToId, listInstalledSkills } from "../src/skills.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-overview-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = workDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

type CodexRow = [id: string, status: string, version: string, path: string];
function codexTable(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w = [0, 1, 2].map((i) => Math.max(...all.map((r) => r[i]!.length)));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w[0]! + 2)}${r[1].padEnd(w[1]! + 2)}${r[2].padEnd(w[2]! + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `mkt`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

// Install fake claude + codex + npx, plus a known_marketplaces.json with an
// on-disk skill so resolvePluginDerivedSkills picks it up.
async function installFakes(opts: { claudeJson: string; codexList: string; skillsListJson?: string; skillsListFail?: boolean }) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });

  const claudeList = join(workDir, "claude.json");
  await writeFile(claudeList, opts.claudeJson);
  const claude = `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${claudeList}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then echo "[]"; exit 0; fi
exit 0
`;
  await writeFile(join(binDir, "claude"), claude);
  await chmod(join(binDir, "claude"), 0o755);

  const codexList = join(workDir, "codex.txt");
  await writeFile(codexList, opts.codexList);
  const codex = `#!/bin/sh
if [ "$1 $2" = "plugin list" ]; then cat ${codexList}; exit 0; fi
exit 0
`;
  await writeFile(join(binDir, "codex"), codex);
  await chmod(join(binDir, "codex"), 0o755);

  const npx = `#!/bin/sh
if [ "$2 $3" = "skills list" ]; then ${opts.skillsListFail ? "exit 1" : `echo '${opts.skillsListJson ?? "[]"}'; exit 0`}; fi
exit 0
`;
  await writeFile(join(binDir, "npx"), npx);
  await chmod(join(binDir, "npx"), 0o755);

  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function writeMarketplaceWithSkill(repo: string, marketplace: string, skill: string) {
  const loc = join(workDir, "mp", marketplace);
  await mkdir(join(loc, "skills", skill), { recursive: true });
  await writeFile(join(loc, "skills", skill, "SKILL.md"), `---\nname: ${skill}\n---\n`);
  const dir = join(workDir, ".claude", "plugins");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "known_marketplaces.json"),
    JSON.stringify({ [marketplace]: { source: { source: "github", repo }, installLocation: loc } }),
  );
}

describe("skillAgentLabelToId", () => {
  test("maps the skills CLI's display labels to syncthis ids", () => {
    expect(skillAgentLabelToId("Gemini CLI")).toBe("gemini-cli");
    expect(skillAgentLabelToId("Kimi Code CLI")).toBe("kimi-cli");
    expect(skillAgentLabelToId("Antigravity")).toBe("antigravity");
    expect(skillAgentLabelToId("Antigravity CLI")).toBeUndefined();
    expect(skillAgentLabelToId("Hermes Agent")).toBe("hermes-agent");
    expect(skillAgentLabelToId("OpenCode")).toBe("opencode");
    expect(skillAgentLabelToId("Pi")).toBe("pi");
    expect(skillAgentLabelToId("Warp")).toBeUndefined(); // not a syncthis agent
  });
});

describe("listInstalledSkills", () => {
  test("returns null when `npx skills list` can't be read", async () => {
    await installFakes({ claudeJson: "[]", codexList: codexTable([]), skillsListFail: true });
    expect(await listInstalledSkills()).toBeNull();
  });

  test("parses names + maps agent labels to ids", async () => {
    await installFakes({
      claudeJson: "[]",
      codexList: codexTable([]),
      skillsListJson: '[{"name":"alpha","agents":["OpenCode","Kimi Code CLI","Antigravity","Antigravity CLI","Warp"]}]',
    });
    const skills = await listInstalledSkills();
    expect(skills).toEqual([{ name: "alpha", path: "", agents: ["opencode", "kimi-cli", "antigravity"] }]); // "Warp" dropped
  });
});

describe("buildPluginOverview", () => {
  test("combines native plugins + per-agent plugin-derived skills", async () => {
    await installFakes({
      claudeJson: JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: "/x/foo" }]),
      codexList: codexTable([["bar@mkt", "installed, enabled", "1.0.0", "/c/bar"]]),
      skillsListJson: '[{"name":"alpha","agents":["OpenCode","Gemini CLI","Kimi Code CLI"]}]',
    });
    await writeMarketplaceWithSkill("owner/foo", "mkt", "alpha");

    const o = await buildPluginOverview();
    expect(o.skillsReadable).toBe(true);
    // native
    expect(o.native.find((r) => r.agent === "claude-code")?.plugins.map((p) => p.name)).toEqual(["foo"]);
    expect(o.native.find((r) => r.agent === "codex")?.plugins.map((p) => p.name)).toEqual(["bar"]);
    // derived: alpha is a plugin-derived skill present on opencode + gemini-cli
    expect(o.derivedRepos).toEqual(["owner/foo"]);
    const opencode = o.derived.find((d) => d.agent === "opencode");
    expect(opencode?.skills.map((s) => s.name)).toEqual(["alpha"]);
    expect(opencode?.skills[0]?.repo).toBe("owner/foo");
    const gemini = o.derived.find((d) => d.agent === "gemini-cli");
    expect(gemini?.skills.map((s) => s.name)).toEqual(["alpha"]);
    const kimi = o.derived.find((d) => d.agent === "kimi-cli");
    expect(kimi?.skills.map((s) => s.name)).toEqual(["alpha"]);
  });

  // Regression (Claude review P3): the overview must match derived skills by the same
  // name+slug identity the removal path uses, so a skill whose frontmatter name differs
  // from its install slug is still shown (not under-reported as 0).
  test("matches a derived skill by install slug when it differs from the frontmatter name", async () => {
    const loc = join(workDir, "mp", "mkt");
    await mkdir(join(loc, "skills", "convex-best-practices"), { recursive: true });
    await writeFile(join(loc, "skills", "convex-best-practices", "SKILL.md"), "---\nname: Convex Best Practices\n---\n");
    const dir = join(workDir, ".claude", "plugins");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "known_marketplaces.json"),
      JSON.stringify({ mkt: { source: { source: "github", repo: "owner/foo" }, installLocation: loc } }),
    );
    await installFakes({
      claudeJson: JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: loc }]),
      codexList: codexTable([]),
      // `skills list` reports the SLUG, not the spaced frontmatter name.
      skillsListJson: '[{"name":"convex-best-practices","agents":["OpenCode"]}]',
    });
    const o = await buildPluginOverview();
    const opencode = o.derived.find((d) => d.agent === "opencode");
    expect(opencode?.skills.map((s) => s.name)).toEqual(["convex-best-practices"]);
  });

  test("skillsReadable false leaves derived blank but still lists native plugins", async () => {
    await installFakes({
      claudeJson: JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: "/x/foo" }]),
      codexList: codexTable([]),
      skillsListFail: true,
    });
    await writeMarketplaceWithSkill("owner/foo", "mkt", "alpha");
    const o = await buildPluginOverview();
    expect(o.skillsReadable).toBe(false);
    expect(o.native.find((r) => r.agent === "claude-code")?.plugins.map((p) => p.name)).toEqual(["foo"]);
    expect(o.derived.every((d) => d.skills.length === 0)).toBe(true);
  });
});
