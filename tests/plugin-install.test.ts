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
      : "";
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
  test("returns 'present' when plugin already in config.toml", async () => {
    await installFakeCli("codex", "");
    await mkdir(join(workDir, ".codex"), { recursive: true });
    await writeFile(join(workDir, ".codex", "config.toml"), `
[plugins."alpha@mkt"]
enabled = true
`);
    const res = await codexPluginAdapter.installPlugin!("alpha", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("present");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin add/.test(line))).toBe(false);
  });

  test("dry-run does not shell out", async () => {
    await installFakeCli("codex", "");
    await mkdir(join(workDir, ".codex"), { recursive: true });
    await writeFile(join(workDir, ".codex", "config.toml"), "");
    const res = await codexPluginAdapter.installPlugin!("fresh", { dryRun: true, marketplace: "mkt" });
    expect(res.status).toBe("installed");
    expect(res.message).toBe("dry-run");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin add/.test(line))).toBe(false);
  });

  test("missing CLI surfaces a clear failure", async () => {
    process.env.PATH = "";
    await mkdir(join(workDir, ".codex"), { recursive: true });
    await writeFile(join(workDir, ".codex", "config.toml"), "");
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("not found");
  });

  test("non-zero exit propagates stderr", async () => {
    await installFakeCli("codex", "", { exitOnAdd: 5, addStderr: "marketplace not registered" });
    await mkdir(join(workDir, ".codex"), { recursive: true });
    await writeFile(join(workDir, ".codex", "config.toml"), "");
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, marketplace: "ghost" });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("marketplace not registered");
  });
});
