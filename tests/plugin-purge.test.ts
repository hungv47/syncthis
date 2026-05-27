import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudePluginAdapter } from "../src/plugins/claude.ts";
import { codexPluginAdapter } from "../src/plugins/codex.ts";
import { runPluginRemoveByMarketplace, resolvePluginNamesByMarketplace } from "../src/plugin-rm.ts";
import { isSafeIdentifier, safeRmUnder } from "../src/plugins/shell.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-purge-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = workDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

async function installFakeCli(name: "claude" | "codex", pluginsJson = "[]", marketsJson = "[]") {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const pluginsFile = join(workDir, `${name}-plugins.json`);
  const marketsFile = join(workDir, `${name}-markets.json`);
  await writeFile(pluginsFile, pluginsJson);
  await writeFile(marketsFile, marketsJson);
  let listCase = "";
  if (name === "claude") {
    listCase = `
if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${pluginsFile}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then cat ${marketsFile}; exit 0; fi
`;
  }
  const script = `#!/bin/sh
${listCase}
exit 0
`;
  const cliPath = join(binDir, name);
  await writeFile(cliPath, script);
  await chmod(cliPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

describe("isSafeIdentifier", () => {
  test("accepts normal names", () => {
    for (const ok of ["apollo", "bio-research", "knowledge-work-plugins", "v1.2", "@scope_x"]) {
      expect(isSafeIdentifier(ok)).toBe(true);
    }
  });

  test("rejects path traversal and separators", () => {
    for (const bad of ["", ".", "..", "../etc", "../../etc", "foo/bar", "foo\\bar", "foo..bar", "a/../b", "with\0nul"]) {
      expect(isSafeIdentifier(bad)).toBe(false);
    }
  });
});

describe("adapter rejects unsafe names defensively", () => {
  test("claude removeMarketplace refuses path-traversal name without touching disk", async () => {
    // Even though the CLI validates first, the adapter is public API and must
    // self-defend. Create a sibling dir we'd be sad to lose.
    const sibling = join(workDir, ".claude", "plugins", "marketplaces", "real-mkt");
    await mkdir(sibling, { recursive: true });
    const res = await claudePluginAdapter.removeMarketplace!("../marketplaces/real-mkt", {
      dryRun: false,
      purge: true,
    });
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/unsafe|traversal/i);
    const stillThere = await stat(sibling);
    expect(stillThere.isDirectory()).toBe(true);
  });

  test("codex removeMarketplace refuses unsafe name", async () => {
    const res = await codexPluginAdapter.removeMarketplace!("../somewhere-else", {
      dryRun: false,
      purge: true,
    });
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/unsafe|traversal/i);
  });
});

describe("safeRmUnder", () => {
  test("rm a real dir under the anchor", async () => {
    const anchor = join(workDir, "root");
    await mkdir(join(anchor, "child"), { recursive: true });
    const res = await safeRmUnder(join(anchor, "child"), anchor);
    expect(res.removed).toBe(true);
    let exists = true;
    try { await stat(join(anchor, "child")); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  test("refuses to delete the anchor itself", async () => {
    const anchor = join(workDir, "root");
    await mkdir(anchor, { recursive: true });
    const res = await safeRmUnder(anchor, anchor);
    expect(res.removed).toBe(false);
    expect(res.message).toContain("anchor");
  });

  test("refuses a target whose realpath escapes the anchor via symlink", async () => {
    const anchor = join(workDir, "root");
    await mkdir(anchor, { recursive: true });
    const outside = join(workDir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "important.txt"), "do not delete");
    await symlink(outside, join(anchor, "evil"));
    const res = await safeRmUnder(join(anchor, "evil"), anchor);
    expect(res.removed).toBe(false);
    expect(res.message).toMatch(/outside/i);
    // Outside data still there
    const ok = await stat(join(outside, "important.txt"));
    expect(ok.isFile()).toBe(true);
  });

  test("absent target returns removed:false with absent message", async () => {
    const anchor = join(workDir, "root");
    await mkdir(anchor, { recursive: true });
    const res = await safeRmUnder(join(anchor, "nothing-here"), anchor);
    expect(res.removed).toBe(false);
    expect(res.message).toBe("absent");
  });

  test("refuses a file target (only directories allowed)", async () => {
    const anchor = join(workDir, "root");
    await mkdir(anchor, { recursive: true });
    await writeFile(join(anchor, "afile"), "x");
    const res = await safeRmUnder(join(anchor, "afile"), anchor);
    expect(res.removed).toBe(false);
    expect(res.message).toMatch(/not a directory/i);
  });
});

describe("claude removeMarketplace --purge", () => {
  test("purges marketplace + cache dirs even when registration is already absent", async () => {
    // Marketplace not registered, but on-disk dirs exist (the orphan case).
    const mkRoot = join(workDir, ".claude", "plugins", "marketplaces", "ghost");
    const cacheRoot = join(workDir, ".claude", "plugins", "cache", "ghost");
    await mkdir(join(mkRoot, "some-plugin"), { recursive: true });
    await mkdir(join(cacheRoot, "another"), { recursive: true });
    await installFakeCli("claude", "[]", "[]");

    const res = await claudePluginAdapter.removeMarketplace!("ghost", {
      dryRun: false,
      purge: true,
    });
    expect(res.status).toBe("removed");
    expect(res.message).toContain("purged");

    let mkExists = true;
    try { await stat(mkRoot); } catch { mkExists = false; }
    expect(mkExists).toBe(false);
    let cacheExists = true;
    try { await stat(cacheRoot); } catch { cacheExists = false; }
    expect(cacheExists).toBe(false);
  });

  test("dry-run with --purge reports the intent without deleting", async () => {
    const mkRoot = join(workDir, ".claude", "plugins", "marketplaces", "ghost");
    await mkdir(mkRoot, { recursive: true });
    await installFakeCli("claude", "[]", "[]");

    const res = await claudePluginAdapter.removeMarketplace!("ghost", {
      dryRun: true,
      purge: true,
    });
    expect(res.status).toBe("removed");
    expect(res.message).toContain("purge");
    const still = await stat(mkRoot);
    expect(still.isDirectory()).toBe(true);
  });

  test("without --purge, orphan dirs are left alone", async () => {
    const mkRoot = join(workDir, ".claude", "plugins", "marketplaces", "ghost");
    await mkdir(mkRoot, { recursive: true });
    await installFakeCli("claude", "[]", "[]");

    const res = await claudePluginAdapter.removeMarketplace!("ghost", {
      dryRun: false,
      purge: false,
    });
    expect(res.status).toBe("absent");
    const still = await stat(mkRoot);
    expect(still.isDirectory()).toBe(true);
  });
});

describe("codex removeMarketplace --purge", () => {
  test("purges cache dir even when marketplace is not registered", async () => {
    const cacheDir = join(workDir, ".codex", "plugins", "cache", "knowledge-work-plugins");
    await mkdir(join(cacheDir, "apollo"), { recursive: true });
    // No config.toml registration. The dir is fully orphaned.
    await installFakeCli("codex");

    const res = await codexPluginAdapter.removeMarketplace!("knowledge-work-plugins", {
      dryRun: false,
      purge: true,
    });
    expect(res.status).toBe("removed");
    expect(res.message).toContain("purged");
    let exists = true;
    try { await stat(cacheDir); } catch { exists = false; }
    expect(exists).toBe(false);
  });
});

describe("--marketplace filter (orchestrator)", () => {
  test("resolves plugin names from any agent's marketplace label", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([
        { id: "apollo@knowledge-work-plugins", enabled: true },
        { id: "bio-research@knowledge-work-plugins", enabled: true },
        { id: "vercel-plugin@other-mkt", enabled: true },
      ]),
      "[]",
    );
    // Codex has the same plugin names under @plugins-cli (the dogfood scenario).
    await mkdir(join(workDir, ".codex"), { recursive: true });
    await writeFile(
      join(workDir, ".codex", "config.toml"),
      `[plugins."apollo@plugins-cli"]
enabled = true
[plugins."bio-research@plugins-cli"]
enabled = true
`,
    );

    const names = await resolvePluginNamesByMarketplace("knowledge-work-plugins", { all: true });
    expect(names).toEqual(["apollo", "bio-research"]);
  });

  test("runPluginRemoveByMarketplace expands to per-plugin removes", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([
        { id: "apollo@knowledge-work-plugins", enabled: true },
        { id: "bio-research@knowledge-work-plugins", enabled: true },
      ]),
      "[]",
    );
    const bulk = await runPluginRemoveByMarketplace("knowledge-work-plugins", {
      scope: { agents: ["claude-code"] },
      apply: false,
    });
    expect(bulk.resolvedNames).toEqual(["apollo", "bio-research"]);
    expect(bulk.perPlugin).toHaveLength(2);
    for (const r of bulk.perPlugin) {
      const claude = r.results.find((x) => x.agent === "claude-code")!;
      expect(claude.status).toBe("removed");
      expect(claude.message).toBe("dry-run");
    }
  });

  test("empty result when no plugins match", async () => {
    await installFakeCli("claude", "[]", "[]");
    const bulk = await runPluginRemoveByMarketplace("nothing-here", {
      scope: { agents: ["claude-code"] },
      apply: false,
    });
    expect(bulk.resolvedNames).toEqual([]);
    expect(bulk.perPlugin).toEqual([]);
  });
});

describe("claude removePlugin --purge", () => {
  test("rms the installPath after successful uninstall", async () => {
    const installPath = join(workDir, ".claude", "plugins", "cache", "mkt", "myplugin", "sha123");
    await mkdir(installPath, { recursive: true });
    await installFakeCli(
      "claude",
      JSON.stringify([{ id: "myplugin@mkt", enabled: true, installPath }]),
      "[]",
    );
    const res = await claudePluginAdapter.removePlugin!("myplugin", {
      dryRun: false,
      purge: true,
    });
    expect(res.status).toBe("removed");
    expect(res.message).toContain("purged");
    let exists = true;
    try { await stat(installPath); } catch { exists = false; }
    expect(exists).toBe(false);
  });
});
