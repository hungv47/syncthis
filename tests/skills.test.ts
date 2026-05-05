import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncSkills } from "../src/skills.ts";

let workDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-skills-"));
  originalHome = process.env.HOME;
  process.env.HOME = workDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(workDir, { recursive: true, force: true });
});

async function writeClaudeSkill(name: string, fm: Record<string, string>, body: string) {
  const dir = join(workDir, ".claude", "skills", name);
  await mkdir(dir, { recursive: true });
  const fmText = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  await Bun.write(join(dir, "SKILL.md"), `---\n${fmText}\n---\n\n${body}`);
}

async function writeCursorRule(name: string, fm: Record<string, string>, body: string) {
  const dir = join(workDir, ".cursor", "rules");
  await mkdir(dir, { recursive: true });
  const fmText = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  await Bun.write(join(dir, `${name}.mdc`), `---\n${fmText}\n---\n\n${body}`);
}

describe("syncSkills", () => {
  test("propagates Claude-only skill to Cursor", async () => {
    await writeClaudeSkill("test-skill", { name: "test-skill", description: "does X" }, "# Body\n");
    const report = await syncSkills();
    expect(report.claudeOnly).toEqual(["test-skill"]);
    expect(report.created).toHaveLength(1);
    expect(report.created[0]!.from).toBe("claude");
    expect(report.created[0]!.to).toBe("cursor");
    const written = await Bun.file(join(workDir, ".cursor", "rules", "test-skill.mdc")).text();
    expect(written).toContain("description: does X");
    expect(written).toContain("# Body");
  });

  test("propagates Cursor-only rule to Claude", async () => {
    await writeCursorRule("ts-style", { description: "TypeScript style" }, "Always use type aliases.\n");
    const report = await syncSkills();
    expect(report.cursorOnly).toEqual(["ts-style"]);
    const written = await Bun.file(join(workDir, ".claude", "skills", "ts-style", "SKILL.md")).text();
    expect(written).toContain("name: ts-style");
    expect(written).toContain("description: TypeScript style");
    expect(written).toContain("Always use type aliases.");
  });

  test("leaves shared skills alone (no overwrite)", async () => {
    await writeClaudeSkill("shared", { name: "shared", description: "v1" }, "Same body\n");
    await writeCursorRule("shared", { description: "v1" }, "Same body\n");
    const report = await syncSkills();
    expect(report.shared).toEqual(["shared"]);
    expect(report.created).toHaveLength(0);
    expect(report.diverged).toHaveLength(0);
  });

  test("flags divergence when shared skills have different bodies", async () => {
    await writeClaudeSkill("forked", { name: "forked", description: "x" }, "Claude body\n");
    await writeCursorRule("forked", { description: "x" }, "Cursor body\n");
    const report = await syncSkills();
    expect(report.diverged).toEqual([{ name: "forked" }]);
    expect(report.created).toHaveLength(0);
  });

  test("dry-run does not write", async () => {
    await writeClaudeSkill("only-claude", { name: "only-claude", description: "x" }, "Body\n");
    const report = await syncSkills({ dryRun: true });
    expect(report.claudeOnly).toEqual(["only-claude"]);
    expect(report.created[0]!.path).toBe("(dry-run)");
    expect(await Bun.file(join(workDir, ".cursor", "rules", "only-claude.mdc")).exists()).toBe(false);
  });

  test("handles empty/missing dirs gracefully", async () => {
    const report = await syncSkills();
    expect(report.created).toHaveLength(0);
    expect(report.shared).toHaveLength(0);
    expect(report.diverged).toHaveLength(0);
  });

  test("ignores non-mdc files in cursor rules dir", async () => {
    await mkdir(join(workDir, ".cursor", "rules"), { recursive: true });
    await Bun.write(join(workDir, ".cursor", "rules", "README.md"), "not a rule");
    const report = await syncSkills();
    expect(report.created).toHaveLength(0);
  });

  test("rejects skill with path-traversal name in frontmatter", async () => {
    const dir = join(workDir, ".claude", "skills", "innocent");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "SKILL.md"), "---\nname: ../../../tmp/EVIL\ndescription: x\n---\n\nbody\n");
    const report = await syncSkills();
    expect(report.created).toEqual([]);
    expect(await Bun.file("/tmp/EVIL.mdc").exists()).toBe(false);
  });
});
