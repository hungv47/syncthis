import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMirror, mirrorHasChanges } from "../src/plugins/mirror.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-mir-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = workDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

async function installFakeCli(name: "claude" | "codex", listOutput: string) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, `${name}-list.json`);
  await writeFile(listFile, listOutput);
  const log = join(workDir, "invocations.log");
  const listMatch =
    name === "claude"
      ? `if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then echo "[]"; exit 0; fi`
      : "";
  const script = `#!/bin/sh
echo "${name} $@" >> ${log}
${listMatch}
exit 0
`;
  const p = join(binDir, name);
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function readInvocations() {
  try {
    return (await readFile(join(workDir, "invocations.log"), "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function writeCodexConfig(content: string) {
  await mkdir(join(workDir, ".codex"), { recursive: true });
  await writeFile(join(workDir, ".codex", "config.toml"), content);
}

describe("runMirror — preview (no apply)", () => {
  test("computes diff of plugins from primary to each target", async () => {
    // Claude has foo, bar. Codex has bar. Mirror claude → all should propose +foo to codex.
    await installFakeCli(
      "claude",
      JSON.stringify([
        { id: "foo@mkt1", enabled: true },
        { id: "bar@mkt1", enabled: true },
      ]),
    );
    await installFakeCli("codex", "");
    await writeCodexConfig(`
[plugins."bar@mkt1"]
enabled = true
`);

    const report = await runMirror({ from: "claude-code", apply: false });
    expect(mirrorHasChanges(report)).toBe(true);
    const codexTarget = report.targets.find((t) => t.to === "codex")!;
    expect(codexTarget.diff).not.toBeNull();
    expect(codexTarget.diff!.add.map((p) => p.name).sort()).toEqual(["foo"]);
  });

  test("kind mismatch (bundle → npm) is flagged unsupported, not silently mirrored", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "foo", enabled: true }]));
    const report = await runMirror({ from: "claude-code", apply: false });
    const opencode = report.targets.find((t) => t.to === "opencode")!;
    expect(opencode.diff).toBeNull();
    expect(opencode.unsupportedReason).toContain("kind mismatch");
  });

  test("preview without apply does not invoke CLI install", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "alpha@mkt", enabled: true }]));
    await installFakeCli("codex", "");
    await writeCodexConfig("");
    await runMirror({ from: "claude-code", apply: false });
    const invocations = await readInvocations();
    // claude plugin list is fine; codex plugin add must NOT appear.
    expect(invocations.some((line) => /codex plugin add/.test(line))).toBe(false);
  });
});

describe("runMirror — safety: refuse dangerous --remove-stale", () => {
  test("throws when primary's read errored and --remove-stale is set (sacred rule #1)", async () => {
    // No claude CLI on PATH → fromRead.error fires.
    // With --remove-stale, fromIdx would be empty; without the guard, every
    // plugin in every target gets queued for deletion. Refuse instead.
    await installFakeCli("codex", "");
    await writeCodexConfig(`
[plugins."existing@mkt"]
enabled = true
`);
    expect(runMirror({ from: "claude-code", apply: false, removeStale: true })).rejects.toThrow(/refusing --remove-stale/);
  });

  test("throws when primary reports zero plugins and --remove-stale is set", async () => {
    await installFakeCli("claude", JSON.stringify([]));
    await installFakeCli("codex", "");
    await writeCodexConfig(`
[plugins."existing@mkt"]
enabled = true
`);
    expect(runMirror({ from: "claude-code", apply: false, removeStale: true })).rejects.toThrow(/zero plugins/);
  });

  test("allows empty-primary mirror WITHOUT --remove-stale (no deletions to schedule)", async () => {
    await installFakeCli("claude", JSON.stringify([]));
    await installFakeCli("codex", "");
    await writeCodexConfig(`
[plugins."existing@mkt"]
enabled = true
`);
    const report = await runMirror({ from: "claude-code", apply: false, removeStale: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add).toEqual([]);
    expect(codex.diff!.remove).toEqual([]);
  });
});

describe("runMirror — apply", () => {
  test("apply invokes target's install primitive for each missing plugin", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([
        { id: "alpha@mkt", enabled: true },
        { id: "beta@mkt", enabled: true },
      ]),
    );
    await installFakeCli("codex", "");
    await writeCodexConfig("");
    const report = await runMirror({ from: "claude-code", apply: true });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.installs).toBeDefined();
    expect(codex.installs!.length).toBe(2);
    const invocations = await readInvocations();
    expect(invocations.filter((l) => l.startsWith("codex plugin add")).length).toBe(2);
  });

  test("--remove-stale removes plugins not in primary", async () => {
    // Primary must be non-empty to pass the safety guard (see refuse-tests above).
    await installFakeCli("claude", JSON.stringify([{ id: "keep@mkt", enabled: true }]));
    await installFakeCli("codex", "");
    await writeCodexConfig(`
[plugins."keep@mkt"]
enabled = true

[plugins."stale@mkt"]
enabled = true
`);
    const report = await runMirror({ from: "claude-code", apply: false, removeStale: true });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.remove.map((p) => p.name)).toEqual(["stale"]);
    expect(codex.diff!.add).toEqual([]);
  });
});
