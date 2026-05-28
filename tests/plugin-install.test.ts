import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePluginAdapter } from "../src/plugins/claude.ts";
import { codexPluginAdapter } from "../src/plugins/codex.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let invocationsFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-install-"));
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

async function installFakeCli(name: "claude" | "codex", listOutput: string, opts: { exitOnAdd?: number; addStderr?: string } = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, `${name}-list.json`);
  await writeFile(listFile, listOutput);
  const listCase =
    name === "claude"
      ? `if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then echo "[]"; exit 0; fi`
      : `if [ "$1 $2" = "plugin list" ]; then cat ${listFile}; exit 0; fi`;
  const addCase =
    opts.exitOnAdd != null
      ? `case "$1 $2" in
  "plugin install"|"plugin add")
    echo "${opts.addStderr ?? "fake failure"}" >&2
    exit ${opts.exitOnAdd}
    ;;
esac`
      : "";
  const script = `#!/bin/sh
echo "${name} $@" >> ${invocationsFile}
${listCase}
${addCase}
exit 0
`;
  const p = join(binDir, name);
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function readInvocations(): Promise<string[]> {
  try {
    return (await readFile(invocationsFile, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Render a `codex plugin list` table (the real CLI's fixed-width format) so the
// codex adapter, which now reads install truth from that command, sees state.
type CodexRow = [id: string, status: string, version: string, path: string];
function codexListTable(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w0 = Math.max(...all.map((r) => r[0].length));
  const w1 = Math.max(...all.map((r) => r[1].length));
  const w2 = Math.max(...all.map((r) => r[2].length));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w0 + 2)}${r[1].padEnd(w1 + 2)}${r[2].padEnd(w2 + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `mkt`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

// Fakes for the --provision path: a `codex` whose `plugin list` gains the plugin
// only AFTER fake `npx plugins add` drops a sentinel — exercising the
// provision → re-read → install chain.
async function installProvisionFakes(name: string, opts: { npxFail?: { exit: number; stderr: string } } = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const sentinel = join(workDir, "provisioned");
  const absentFile = join(workDir, "codex-absent.txt");
  const presentFile = join(workDir, "codex-present.txt");
  await writeFile(absentFile, codexListTable([["other@plugins-cli", "not installed", "", "/cache/other"]]));
  await writeFile(
    presentFile,
    codexListTable([
      ["other@plugins-cli", "not installed", "", "/cache/other"],
      [`${name}@plugins-cli`, "not installed", "", `/cache/${name}`],
    ]),
  );
  const codex = `#!/bin/sh
echo "codex $@" >> ${invocationsFile}
if [ "$1 $2" = "plugin list" ]; then
  if [ -f ${sentinel} ]; then cat ${presentFile}; else cat ${absentFile}; fi
  exit 0
fi
exit 0
`;
  await writeFile(join(binDir, "codex"), codex);
  await chmod(join(binDir, "codex"), 0o755);
  // On `plugins add`: succeed (drop sentinel so the next `plugin list` shows it),
  // or, when npxFail is set, emit stderr and exit non-zero without provisioning.
  const addBranch = opts.npxFail
    ? `echo "${opts.npxFail.stderr}" >&2; exit ${opts.npxFail.exit}`
    : `touch ${sentinel}; exit 0`;
  const npx = `#!/bin/sh
echo "npx $@" >> ${invocationsFile}
if [ "$1 $2" = "plugins add" ]; then ${addBranch}; fi
exit 0
`;
  await writeFile(join(binDir, "npx"), npx);
  await chmod(join(binDir, "npx"), 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

describe("claude installPlugin", () => {
  test("returns 'present' when plugin is already installed, does NOT shell out", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "alpha@mkt", enabled: true }]));
    const res = await claudePluginAdapter.installPlugin!("alpha", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("present");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin install/.test(line))).toBe(false);
  });

  test("dry-run reports installed without shelling out", async () => {
    await installFakeCli("claude", JSON.stringify([]));
    const res = await claudePluginAdapter.installPlugin!("newone", { dryRun: true, marketplace: "mkt" });
    expect(res.status).toBe("installed");
    expect(res.message).toBe("dry-run");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin install/.test(line))).toBe(false);
  });

  test("returns 'failed' with 'not found' when claude CLI is missing", async () => {
    // No claude binary on PATH at all.
    process.env.PATH = "";
    const res = await claudePluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("not found");
  });

  test("returns 'failed' with stderr message when CLI exits non-zero", async () => {
    await installFakeCli("claude", JSON.stringify([]), { exitOnAdd: 3, addStderr: "could not resolve marketplace" });
    const res = await claudePluginAdapter.installPlugin!("foo", { dryRun: false, marketplace: "badmkt" });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("could not resolve marketplace");
  });

  test("rejects unsafe plugin names before invoking CLI", async () => {
    await installFakeCli("claude", JSON.stringify([]));
    const res = await claudePluginAdapter.installPlugin!("../etc/passwd", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("traversal");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin install/.test(line))).toBe(false);
  });
});

describe("codex installPlugin", () => {
  test("returns 'present' when plugin is already installed, does NOT shell out", async () => {
    await installFakeCli("codex", codexListTable([["alpha@mkt", "installed, enabled", "1.0.0", "/cache/alpha"]]));
    const res = await codexPluginAdapter.installPlugin!("alpha", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("present");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin add/.test(line))).toBe(false);
  });

  test("does NOT treat a 'not installed' registration as present", async () => {
    await installFakeCli("codex", codexListTable([["alpha@mkt", "not installed", "", "/cache/alpha"]]));
    const res = await codexPluginAdapter.installPlugin!("alpha", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("installed");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin add/.test(line))).toBe(true);
  });

  test("dry-run does not shell out", async () => {
    await installFakeCli("codex", "");
    const res = await codexPluginAdapter.installPlugin!("fresh", { dryRun: true, marketplace: "mkt" });
    expect(res.status).toBe("installed");
    expect(res.message).toBe("dry-run");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin add/.test(line))).toBe(false);
  });

  test("missing CLI surfaces a clear failure", async () => {
    process.env.PATH = "";
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("not found");
  });

  test("non-zero exit propagates stderr", async () => {
    await installFakeCli("codex", "", { exitOnAdd: 5, addStderr: "marketplace not registered" });
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, marketplace: "ghost" });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("marketplace not registered");
  });

  test("resolves a bare name to <name>@<marketplace> from the snapshot", async () => {
    // `codex plugin add` rejects a bare name; the adapter must find the
    // marketplace from a (not-installed) plugin-list row and qualify the add.
    await installFakeCli("codex", codexListTable([["foo@plugins-cli", "not installed", "", "/cache/foo"]]));
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("installed");
    expect(res.target).toBe("foo@plugins-cli");
    const invocations = await readInvocations();
    expect(invocations.some((l) => l.trim() === "codex plugin add -- foo@plugins-cli")).toBe(true);
  });

  test("skips (not fails) when a bare name is in no Codex marketplace", async () => {
    await installFakeCli("codex", codexListTable([["other@plugins-cli", "not installed", "", "/cache/other"]]));
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("skipped");
    expect(res.message).toContain("no registered Codex marketplace");
    const invocations = await readInvocations();
    expect(invocations.some((l) => /plugin add/.test(l))).toBe(false);
  });

  test("prefers plugins-cli when a bare name is in multiple marketplaces", async () => {
    await installFakeCli(
      "codex",
      codexListTable([
        ["foo@openai-curated", "not installed", "", "/cache/foo-openai"],
        ["foo@plugins-cli", "not installed", "", "/cache/foo-plugins"],
      ]),
    );
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("installed");
    expect(res.target).toBe("foo@plugins-cli");
    const invocations = await readInvocations();
    expect(invocations.some((l) => l.trim() === "codex plugin add -- foo@plugins-cli")).toBe(true);
  });

  test("skips on ambiguity when plugins-cli is not a candidate", async () => {
    await installFakeCli(
      "codex",
      codexListTable([
        ["foo@openai-curated", "not installed", "", "/cache/foo-a"],
        ["foo@openai-bundled", "not installed", "", "/cache/foo-b"],
      ]),
    );
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("skipped");
    expect(res.message).toContain("ambiguous across Codex marketplaces");
    const invocations = await readInvocations();
    expect(invocations.some((l) => /plugin add/.test(l))).toBe(false);
  });

  test("provision: registers the marketplace via npx plugins then installs", async () => {
    await installProvisionFakes("foo");
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, provision: true, sourceRepo: "acme/foo" });
    expect(res.status).toBe("installed");
    expect(res.target).toBe("foo@plugins-cli");
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === "npx plugins add acme/foo --target codex -y")).toBe(true);
    expect(inv.some((l) => l.trim() === "codex plugin add -- foo@plugins-cli")).toBe(true);
  });

  test("provision: a failed `npx plugins add` is reported as failed with the cause", async () => {
    await installProvisionFakes("foo", { npxFail: { exit: 1, stderr: "repo not found" } });
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, provision: true, sourceRepo: "acme/foo" });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("provision failed");
    expect(res.message).toContain("repo not found");
    const inv = await readInvocations();
    expect(inv.some((l) => l.startsWith("npx plugins add"))).toBe(true);
    // must not attempt the native install after the provision errored
    expect(inv.some((l) => /codex plugin add/.test(l))).toBe(false);
  });

  test("provision: refuses an unsafe sourceRepo, never shells npx", async () => {
    await installProvisionFakes("foo");
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, provision: true, sourceRepo: "../evil" });
    expect(res.status).toBe("skipped");
    const inv = await readInvocations();
    expect(inv.some((l) => /npx plugins add/.test(l))).toBe(false);
  });

  test("no --provision flag: stays skipped even with a sourceRepo", async () => {
    await installProvisionFakes("foo");
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, sourceRepo: "acme/foo" });
    expect(res.status).toBe("skipped");
    expect(res.message).toContain("retry with --provision");
    const inv = await readInvocations();
    expect(inv.some((l) => /npx plugins add/.test(l))).toBe(false);
  });
});
