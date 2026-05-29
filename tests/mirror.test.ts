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
      : `if [ "$1 $2" = "plugin list" ]; then cat ${listFile}; exit 0; fi`;
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

// Render the `codex plugin list` table the codex adapter now reads for install
// truth. Each row: [id, status, version, path]. Codex install identity carries
// an agent-local marketplace tag (e.g. "@plugins-cli"), distinct from Claude's.
type CodexRow = [id: string, status: string, version: string, path: string];
function codexList(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w0 = Math.max(...all.map((r) => r[0].length));
  const w1 = Math.max(...all.map((r) => r[1].length));
  const w2 = Math.max(...all.map((r) => r[2].length));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w0 + 2)}${r[1].padEnd(w1 + 2)}${r[2].padEnd(w2 + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `plugins-cli`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

// Shorthand: an installed codex plugin row from a fully-qualified id.
function codexInstalled(...ids: string[]): string {
  return codexList(ids.map((id) => [id, "installed, enabled", "1.0.0", `/cache/${id.split("@")[0]}`]));
}

// Shorthand: plugins present in a Codex marketplace snapshot but NOT installed —
// available for `codex plugin add` (marketplace resolvable, but not yet loaded).
function codexAvailable(...ids: string[]): string {
  return codexList(ids.map((id) => [id, "not installed", "", `/cache/${id.split("@")[0]}`]));
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
    await installFakeCli("codex", codexInstalled("bar@plugins-cli"));

    const report = await runMirror({ from: "claude-code", apply: false });
    expect(mirrorHasChanges(report)).toBe(true);
    const codexTarget = report.targets.find((t) => t.to === "codex")!;
    expect(codexTarget.diff).not.toBeNull();
    expect(codexTarget.diff!.add.map((p) => p.name).sort()).toEqual(["foo"]);
  });

  test("preview without apply does not invoke CLI install", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "alpha@mkt", enabled: true }]));
    await installFakeCli("codex", "");
    await runMirror({ from: "claude-code", apply: false });
    const invocations = await readInvocations();
    // claude plugin list is fine; codex plugin add must NOT appear.
    expect(invocations.some((line) => /codex plugin add/.test(line))).toBe(false);
  });
});

describe("runMirror — additive only (no uninstall path)", () => {
  test("empty primary schedules no installs, and the diff has no `remove`", async () => {
    await installFakeCli("claude", JSON.stringify([]));
    await installFakeCli("codex", codexInstalled("existing@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add).toEqual([]);
    // MirrorDiff has no `remove` field — a mirror can only add, never uninstall.
    expect("remove" in codex.diff!).toBe(false);
    expect(mirrorHasChanges(report)).toBe(false);
  });

  test("a plugin only the target has is left untouched (never queued for removal)", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "keep@mkt", enabled: true }]));
    await installFakeCli("codex", codexInstalled("keep@plugins-cli", "extra@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add).toEqual([]); // keep already present; extra left alone
    expect(mirrorHasChanges(report)).toBe(false);
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
    // Both available in Codex's snapshot (not yet installed) so add can resolve.
    await installFakeCli("codex", codexAvailable("alpha@plugins-cli", "beta@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: true });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.installs).toBeDefined();
    expect(codex.installs!.length).toBe(2);
    const invocations = await readInvocations();
    expect(invocations.filter((l) => l.startsWith("codex plugin add")).length).toBe(2);
  });
});

describe("runMirror — cross-agent marketplace tags (regression)", () => {
  // The same upstream plugin carries an agent-local marketplace tag:
  // forsvn-skills@forsvn-skills in Claude, forsvn-skills@plugins-cli in Codex.
  // Identity for the diff must be the BARE name, or every such plugin gets a
  // spurious re-add. (Fixtures elsewhere reuse one tag on both sides, which is
  // why this gap went unnoticed.)
  test("same plugin under different marketplace tags is NOT re-added", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "forsvn-skills@forsvn-skills", enabled: true }]));
    await installFakeCli("codex", codexInstalled("forsvn-skills@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add).toEqual([]);
    expect(mirrorHasChanges(report)).toBe(false);
  });

  test("only a genuinely-absent bare name is proposed for add", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([
        { id: "forsvn-skills@forsvn-skills", enabled: true },
        { id: "vercel@claude-mkt", enabled: true },
      ]),
    );
    await installFakeCli("codex", codexInstalled("forsvn-skills@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add.map((p) => p.name)).toEqual(["vercel"]);
  });

  test("apply resolves the TARGET's marketplace, never the source tag", async () => {
    // Claude tags it vercel@claude-mkt; Codex provides it as vercel@plugins-cli.
    // The install must use Codex's resolved tag, not Claude's (which Codex can't
    // resolve), and `codex plugin add` requires a tag — a bare name is rejected.
    await installFakeCli("claude", JSON.stringify([{ id: "vercel@claude-mkt", enabled: true }]));
    await installFakeCli("codex", codexAvailable("vercel@plugins-cli"));
    await runMirror({ from: "claude-code", apply: true });
    const invocations = await readInvocations();
    expect(invocations.some((l) => l.trim() === "codex plugin add -- vercel@plugins-cli")).toBe(true);
    expect(invocations.some((l) => /vercel@claude-mkt/.test(l))).toBe(false);
  });
});
