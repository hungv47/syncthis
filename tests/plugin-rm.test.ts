import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod, stat, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexPluginAdapter } from "../src/plugins/codex.ts";
import { cursorPluginAdapter } from "../src/plugins/cursor.ts";
import { opencodePluginAdapter } from "../src/plugins/opencode.ts";
import { claudePluginAdapter } from "../src/plugins/claude.ts";
import { runPluginRemove, runMarketplaceRemove, hasChanges } from "../src/plugin-rm.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let invocationsFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-rm-"));
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

async function installFakeCli(name: "claude" | "codex", pluginsJson: string, marketsJson: string) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const pluginsFile = join(workDir, `${name}-plugins.json`);
  const marketsFile = join(workDir, `${name}-markets.json`);
  await writeFile(pluginsFile, pluginsJson);
  await writeFile(marketsFile, marketsJson);

  let listCase = "";
  if (name === "claude") {
    listCase = `
if [ "$1 $2 $3 $4" = "plugin list --json" ] || [ "$1 $2" = "plugin list" -a "$3" = "--json" ]; then
  cat ${pluginsFile}
  exit 0
fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then
  cat ${marketsFile}
  exit 0
fi
`;
  }

  const script = `#!/bin/sh
echo "${name} $@" >> ${invocationsFile}
${listCase}
# Remove paths: any arg that contains "FAIL" forces a failure.
for arg in "$@"; do
  case "$arg" in *FAIL*) exit 7 ;; esac
done
case "$1 $2" in
  "plugin uninstall") exit 0 ;;
  "plugin remove") exit 0 ;;
esac
if [ "$1 $2 $3" = "plugin marketplace remove" ] || [ "$1 $2 $3" = "plugin marketplace rm" ]; then
  exit 0
fi
exit 0
`;
  const cliPath = join(binDir, name);
  await writeFile(cliPath, script);
  await chmod(cliPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function readInvocations(): Promise<string[]> {
  try {
    const text = await readFile(invocationsFile, "utf8");
    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function writeCodexConfig(text: string) {
  await mkdir(join(workDir, ".codex"), { recursive: true });
  await writeFile(join(workDir, ".codex", "config.toml"), text);
}

async function writeOpencodeConfig(json: object) {
  await mkdir(join(workDir, ".config", "opencode"), { recursive: true });
  await writeFile(join(workDir, ".config", "opencode", "opencode.json"), JSON.stringify(json, null, 2));
}

describe("claude removePlugin", () => {
  test("dry-run reports removed without invoking the CLI", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([{ id: "foo@bar", enabled: true }]),
      "[]",
    );
    const res = await claudePluginAdapter.removePlugin!("foo", { dryRun: true });
    expect(res.status).toBe("removed");
    expect(res.target).toBe("foo@bar");
    expect(res.message).toBe("dry-run");
    // The list call still happens on read; uninstall should NOT.
    const calls = await readInvocations();
    expect(calls.some((c) => c.includes("plugin uninstall"))).toBe(false);
  });

  test("absent when plugin not installed", async () => {
    await installFakeCli("claude", "[]", "[]");
    const res = await claudePluginAdapter.removePlugin!("nothing", { dryRun: true });
    expect(res.status).toBe("absent");
  });

  test("apply path invokes claude plugin uninstall", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([{ id: "foo@bar", enabled: true }]),
      "[]",
    );
    const res = await claudePluginAdapter.removePlugin!("foo", { dryRun: false });
    expect(res.status).toBe("removed");
    const calls = await readInvocations();
    expect(calls.some((c) => c.includes("plugin uninstall"))).toBe(true);
    expect(calls.some((c) => c.includes("foo@bar"))).toBe(true);
  });

  test("apply with prune adds --prune flag", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([{ id: "foo@bar", enabled: true }]),
      "[]",
    );
    await claudePluginAdapter.removePlugin!("foo", { dryRun: false, prune: true });
    const calls = await readInvocations();
    expect(calls.some((c) => c.includes("--prune"))).toBe(true);
  });

  test("flags ambiguous plugin installed under multiple marketplaces", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([
        { id: "foo@one", enabled: true },
        { id: "foo@two", enabled: true },
      ]),
      "[]",
    );
    const res = await claudePluginAdapter.removePlugin!("foo", { dryRun: true });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("ambiguous");
  });

  test("fully-qualified name disambiguates between marketplaces", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([
        { id: "foo@one", enabled: true },
        { id: "foo@two", enabled: true },
      ]),
      "[]",
    );
    const res = await claudePluginAdapter.removePlugin!("foo@two", { dryRun: true });
    expect(res.status).toBe("removed");
    expect(res.target).toBe("foo@two");
  });

  test("apply path uses -- separator before the plugin name", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([{ id: "foo@bar", enabled: true }]),
      "[]",
    );
    await claudePluginAdapter.removePlugin!("foo", { dryRun: false });
    const calls = await readInvocations();
    expect(calls.some((c) => c.includes("plugin uninstall --yes -- foo@bar"))).toBe(true);
  });
});

describe("codex removePlugin", () => {
  test("resolves marketplace suffix from config.toml", async () => {
    await writeCodexConfig(`
[plugins."foo@plugins-cli"]
enabled = true
`);
    await installFakeCli("codex", "", "");
    const res = await codexPluginAdapter.removePlugin!("foo", { dryRun: true });
    expect(res.status).toBe("removed");
    expect(res.target).toBe("foo@plugins-cli");
  });

  test("flags ambiguous plugin installed under multiple marketplaces", async () => {
    await writeCodexConfig(`
[plugins."foo@plugins-cli"]
enabled = true
[plugins."foo@other-mkt"]
enabled = true
`);
    const res = await codexPluginAdapter.removePlugin!("foo", { dryRun: true });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("ambiguous");
  });

  test("apply invokes codex plugin remove <name>@<mkt>", async () => {
    await writeCodexConfig(`
[plugins."foo@plugins-cli"]
enabled = true
`);
    await installFakeCli("codex", "", "");
    const res = await codexPluginAdapter.removePlugin!("foo", { dryRun: false });
    expect(res.status).toBe("removed");
    const calls = await readInvocations();
    expect(calls.some((c) => c.includes("plugin remove -- foo@plugins-cli"))).toBe(true);
  });
});

describe("cursor removePlugin", () => {
  test("deletes the matched plugin directory", async () => {
    const root = join(workDir, ".cursor", "plugins");
    await mkdir(join(root, "vercel", "vercel-plugin", "abc"), { recursive: true });
    const target = join(root, "vercel", "vercel-plugin");
    expect((await stat(target)).isDirectory()).toBe(true);
    const res = await cursorPluginAdapter.removePlugin!("vercel-plugin", { dryRun: false });
    expect(res.status).toBe("removed");
    let exists = true;
    try { await stat(target); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  test("symlinks under the plugins root are filtered by read() and never reach rm", async () => {
    const root = join(workDir, ".cursor", "plugins");
    await mkdir(root, { recursive: true });
    // A real directory outside the plugins root that we'd be sad to lose.
    const outside = join(workDir, "outside-target");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "important.txt"), "do not delete");
    // Place a symlink under cursor plugins pointing at the outside target.
    await symlink(outside, join(root, "evil"));

    // First defense: read() uses Dirent.isDirectory(), which is false for symlinks,
    // so the symlinked entry is never returned as a plugin record.
    const r = await cursorPluginAdapter.read();
    expect(r.plugins.some((p) => p.name === "evil")).toBe(false);

    // Therefore removePlugin reports absent, never hitting the realpath check or rm.
    const res = await cursorPluginAdapter.removePlugin!("evil", { dryRun: false });
    expect(res.status).toBe("absent");

    // Sanity: the outside file must still exist.
    const stillThere = await stat(join(outside, "important.txt"));
    expect(stillThere.isFile()).toBe(true);
  });

  test("clean dry-run on a real in-root plugin dir does not trip the symlink guard", async () => {
    const root = join(workDir, ".cursor", "plugins");
    await mkdir(join(root, "ok-plugin"), { recursive: true });
    const res = await cursorPluginAdapter.removePlugin!("ok-plugin", { dryRun: true });
    expect(res.status).toBe("removed");
  });

  test("absent when name not found", async () => {
    await mkdir(join(workDir, ".cursor", "plugins"), { recursive: true });
    const res = await cursorPluginAdapter.removePlugin!("missing", { dryRun: true });
    expect(res.status).toBe("absent");
  });
});

describe("opencode removePlugin", () => {
  test("filters plugin from array and writes back with backup", async () => {
    await writeOpencodeConfig({
      plugin: ["@a/keep", "@b/drop", "@c/keep"],
      mcp: {},
    });
    const res = await opencodePluginAdapter.removePlugin!("@b/drop", { dryRun: false });
    expect(res.status).toBe("removed");

    const configPath = join(workDir, ".config", "opencode", "opencode.json");
    const after = JSON.parse(await readFile(configPath, "utf8"));
    expect(after.plugin).toEqual(["@a/keep", "@c/keep"]);

    // Backup created on first write.
    const bakStat = await stat(`${configPath}.syncthis.bak`);
    expect(bakStat.isFile()).toBe(true);
  });

  test("absent when plugin not in array", async () => {
    await writeOpencodeConfig({ plugin: ["@a/keep"] });
    const res = await opencodePluginAdapter.removePlugin!("missing", { dryRun: true });
    expect(res.status).toBe("absent");
  });

  test("absent when config file does not exist", async () => {
    const res = await opencodePluginAdapter.removePlugin!("anything", { dryRun: true });
    expect(res.status).toBe("absent");
  });
});

describe("orchestrator: runPluginRemove", () => {
  test("--all fans out across all 4 adapters", async () => {
    // Set up Claude with foo, Codex with foo (different marketplace), OpenCode without.
    await installFakeCli(
      "claude",
      JSON.stringify([{ id: "foo@plugins-cli", enabled: true }]),
      "[]",
    );
    await writeCodexConfig(`[plugins."foo@plugins-cli"]\nenabled = true\n`);
    await writeOpencodeConfig({ plugin: [] });

    const report = await runPluginRemove({ name: "foo", scope: { all: true }, apply: false });
    expect(report.results).toHaveLength(4);
    const removedAgents = report.results.filter((r) => r.status === "removed").map((r) => r.agent).sort();
    expect(removedAgents).toEqual(["claude-code", "codex"]);
    const absentAgents = report.results.filter((r) => r.status === "absent").map((r) => r.agent).sort();
    expect(absentAgents).toEqual(["cursor", "opencode"]);
  });

  test("--agents filter restricts the fan-out", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([{ id: "foo@plugins-cli", enabled: true }]),
      "[]",
    );
    await writeCodexConfig(`[plugins."foo@plugins-cli"]\nenabled = true\n`);
    const report = await runPluginRemove({
      name: "foo",
      scope: { agents: ["claude-code"] },
      apply: false,
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.agent).toBe("claude-code");
    expect(report.results[0]!.status).toBe("removed");
  });

  test("partial failure does not abort other adapters", async () => {
    await writeCodexConfig(`[plugins."FAIL@plugins-cli"]\nenabled = true\n`);
    await installFakeCli("codex", "", "");
    await writeOpencodeConfig({ plugin: ["FAIL"] });

    const report = await runPluginRemove({
      name: "FAIL",
      scope: { agents: ["codex", "opencode"] },
      apply: true,
    });
    expect(report.results).toHaveLength(2);
    const codex = report.results.find((r) => r.agent === "codex")!;
    const opencode = report.results.find((r) => r.agent === "opencode")!;
    expect(codex.status).toBe("failed");
    // opencode should still have succeeded since its work is local.
    expect(opencode.status).toBe("removed");
  });

  test("hasChanges true when any adapter would remove", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([{ id: "foo@bar", enabled: true }]),
      "[]",
    );
    const report = await runPluginRemove({
      name: "foo",
      scope: { agents: ["claude-code"] },
      apply: false,
    });
    expect(hasChanges(report)).toBe(true);
  });

  test("hasChanges false when nothing matches", async () => {
    const report = await runPluginRemove({
      name: "nothing-installed",
      scope: { all: true },
      apply: false,
    });
    expect(hasChanges(report)).toBe(false);
  });
});

describe("orchestrator: runMarketplaceRemove", () => {
  test("only adapters that support marketplaces are queried", async () => {
    await installFakeCli(
      "claude",
      "[]",
      JSON.stringify([{ name: "shared", source: "github", repo: "x/y" }]),
    );
    await writeCodexConfig(`
[marketplaces.shared]
source_type = "git"
source = "https://github.com/x/y"
`);
    await installFakeCli("codex", "", "");

    const report = await runMarketplaceRemove({
      name: "shared",
      scope: { all: true },
      apply: false,
    });
    const cursor = report.results.find((r) => r.agent === "cursor")!;
    const opencode = report.results.find((r) => r.agent === "opencode")!;
    expect(cursor.status).toBe("skipped");
    expect(opencode.status).toBe("skipped");
    const claude = report.results.find((r) => r.agent === "claude-code")!;
    const codex = report.results.find((r) => r.agent === "codex")!;
    expect(claude.status).toBe("removed");
    expect(codex.status).toBe("removed");
  });
});
