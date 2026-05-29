import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMirror, mirrorHasChanges } from "../src/plugins/mirror.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-cursor-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = workDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

const binDir = () => join(workDir, "bin");
const log = () => join(workDir, "invocations.log");

// claude fake with both `plugin list --json` and `plugin marketplace list --json`
// (the latter drives marketplaceSources → cursor repo resolution).
async function fakeClaude(
  plugins: { id: string }[],
  marketplaces: { name: string; source: string; repo: string }[],
  opts: { marketplaceListExit?: number } = {},
) {
  await mkdir(binDir(), { recursive: true });
  const pl = join(workDir, "claude-plugins.json");
  const mk = join(workDir, "claude-mkts.json");
  await writeFile(pl, JSON.stringify(plugins));
  await writeFile(mk, JSON.stringify(marketplaces));
  const mktBranch =
    opts.marketplaceListExit != null ? `exit ${opts.marketplaceListExit}` : `cat ${mk}; exit 0`;
  const script = `#!/bin/sh
echo "claude $@" >> ${log()}
if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${pl}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then ${mktBranch}; fi
exit 0
`;
  await writeFile(join(binDir(), "claude"), script);
  await chmod(join(binDir(), "claude"), 0o755);
  process.env.PATH = `${binDir()}:${originalPath ?? ""}`;
}

type CodexRow = [string, string, string, string];
function codexList(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w = [0, 1, 2].map((i) => Math.max(...all.map((r) => r[i]!.length)));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w[0]! + 2)}${r[1].padEnd(w[1]! + 2)}${r[2].padEnd(w[2]! + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `plugins-cli`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

async function fakeCodex(installedIds: string[]) {
  await mkdir(binDir(), { recursive: true });
  const out = codexList(installedIds.map((id) => [id, "installed, enabled", "1.0.0", `/cache/${id.split("@")[0]}`]));
  const f = join(workDir, "codex-list.txt");
  await writeFile(f, out);
  const script = `#!/bin/sh
echo "codex $@" >> ${log()}
if [ "$1 $2" = "plugin list" ]; then cat ${f}; exit 0; fi
exit 0
`;
  await writeFile(join(binDir(), "codex"), script);
  await chmod(join(binDir(), "codex"), 0o755);
  process.env.PATH = `${binDir()}:${originalPath ?? ""}`;
}

async function fakeNpx() {
  await mkdir(binDir(), { recursive: true });
  const script = `#!/bin/sh
echo "npx $@" >> ${log()}
exit 0
`;
  await writeFile(join(binDir(), "npx"), script);
  await chmod(join(binDir(), "npx"), 0o755);
  process.env.PATH = `${binDir()}:${originalPath ?? ""}`;
}

async function invocations(): Promise<string[]> {
  try {
    return (await readFile(log(), "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("mirror cursor push", () => {
  test("resolves deduped source repos from the Claude primary's plugins", async () => {
    await fakeClaude(
      [{ id: "foo@mkt1" }, { id: "bar@mkt1" }, { id: "baz@mkt2" }],
      [
        { name: "mkt1", source: "github", repo: "owner/one" },
        { name: "mkt2", source: "github", repo: "owner/two" },
      ],
    );
    await fakeCodex(["foo@plugins-cli", "bar@plugins-cli", "baz@plugins-cli"]);
    const report = await runMirror({ from: "claude-code", apply: false });
    expect(report.cursor.supported).toBe(true);
    // foo+bar share mkt1 → owner/one once; baz → owner/two.
    expect(report.cursor.repos).toEqual(["owner/one", "owner/two"]);
    expect(mirrorHasChanges(report)).toBe(true);
  });

  test("apply installs each repo to cursor via `npx plugins add --target cursor`", async () => {
    await fakeClaude(
      [{ id: "foo@mkt1" }, { id: "bar@mkt1" }],
      [{ name: "mkt1", source: "github", repo: "owner/one" }],
    );
    await fakeCodex(["foo@plugins-cli", "bar@plugins-cli"]);
    await fakeNpx();
    const report = await runMirror({ from: "claude-code", apply: true });
    expect(report.cursor.results).toEqual([{ repo: "owner/one", status: "installed" }]);
    const inv = await invocations();
    const cursorCalls = inv.filter((l) => /^npx plugins add .* --target cursor -y$/.test(l.trim()));
    expect(cursorCalls).toEqual(["npx plugins add owner/one --target cursor -y"]);
  });

  test("drops plugins whose marketplace has no github repo", async () => {
    await fakeClaude(
      [{ id: "foo@mkt1" }, { id: "local@localmkt" }],
      [{ name: "mkt1", source: "github", repo: "owner/one" }], // localmkt absent → no repo
    );
    await fakeCodex([]);
    const report = await runMirror({ from: "claude-code", apply: false });
    expect(report.cursor.repos).toEqual(["owner/one"]);
  });

  test("unsupported from a Codex primary (no marketplace→repo map)", async () => {
    await fakeClaude([{ id: "foo@mkt1" }], [{ name: "mkt1", source: "github", repo: "owner/one" }]);
    await fakeCodex(["foo@plugins-cli"]);
    const report = await runMirror({ from: "codex", apply: false });
    expect(report.cursor.supported).toBe(false);
    expect(report.cursor.repos).toEqual([]);
  });

  test("unsupported with a distinct reason when Claude marketplace list fails", async () => {
    await fakeClaude([{ id: "foo@mkt1" }], [{ name: "mkt1", source: "github", repo: "owner/one" }], { marketplaceListExit: 1 });
    await fakeCodex(["foo@plugins-cli"]);
    const report = await runMirror({ from: "claude-code", apply: false });
    expect(report.cursor.supported).toBe(false);
    expect(report.cursor.reason).toMatch(/couldn't read/i);
  });
});

describe("mirror codex skills-fallback (--provision)", () => {
  test("a skills-only bundle Codex can't load is added to Codex as skills", async () => {
    // Claude has `kit` under a github marketplace; Codex's plugin-list never shows
    // it, even after provisioning → skills-only bundle. It must fall back to
    // `npx skills add <repo> -a codex` rather than silently vanishing.
    await fakeClaude([{ id: "kit@mkt1" }], [{ name: "mkt1", source: "github", repo: "owner/kit" }]);
    await fakeCodex([]); // Codex has nothing, and its list never exposes `kit`
    await fakeNpx(); // `plugins add` (provision + cursor) and `skills add` all exit 0

    const report = await runMirror({ from: "claude-code", apply: true, provision: true });
    const codex = report.targets.find((t) => t.to === "codex")!;

    // The native install skipped (skills-only) but carried the fallback repo…
    const attempt = codex.installs!.find((i) => i.target === "kit");
    expect(attempt?.status).toBe("skipped");
    expect(attempt?.skillsFallbackRepo).toBe("owner/kit");
    // …and the fallback added it as skills on Codex.
    expect(codex.skillsFallback).toEqual([{ repo: "owner/kit", status: "added" }]);

    const inv = await invocations();
    expect(inv.some((l) => l.trim() === "npx -y skills add owner/kit -g -s * -a codex -y")).toBe(true);
  });

  test("without --provision there is no skills-fallback (stays a plain skip)", async () => {
    await fakeClaude([{ id: "kit@mkt1" }], [{ name: "mkt1", source: "github", repo: "owner/kit" }]);
    await fakeCodex([]);
    await fakeNpx();

    const report = await runMirror({ from: "claude-code", apply: true }); // no provision
    const codex = report.targets.find((t) => t.to === "codex")!;
    const attempt = codex.installs!.find((i) => i.target === "kit");
    expect(attempt?.status).toBe("skipped");
    expect(attempt?.skillsFallbackRepo).toBeUndefined();
    expect(codex.skillsFallback).toBeUndefined();

    const inv = await invocations();
    expect(inv.some((l) => /skills add/.test(l))).toBe(false);
  });
});
