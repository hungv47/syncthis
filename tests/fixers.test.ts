import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPluginsForAgent } from "../src/plugins/discovery.ts";
import { runFixersOnReports, revertFixers } from "../src/plugins/fixers.ts";
import type { PluginAdapterRead } from "../src/plugins/types.ts";

let workDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-fix-"));
  originalHome = process.env.HOME;
  process.env.HOME = workDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(workDir, { recursive: true, force: true });
});

async function makeCodexCache(name: string, mkt: string, opts: { nested: string[]; flat: string[]; interface: boolean }) {
  const cacheDir = join(workDir, ".codex", "plugins", "cache", mkt, name, "deadbeef");
  await mkdir(join(cacheDir, "skills"), { recursive: true });
  for (const n of opts.nested) {
    const [cat, skill] = n.split("/");
    await mkdir(join(cacheDir, "skills", cat!, skill!), { recursive: true });
    await writeFile(join(cacheDir, "skills", cat!, skill!, "SKILL.md"), `# ${skill}\n`);
  }
  for (const f of opts.flat) {
    await mkdir(join(cacheDir, "skills", f), { recursive: true });
    await writeFile(join(cacheDir, "skills", f, "SKILL.md"), `# ${f}\n`);
  }
  await writeFile(
    join(cacheDir, "plugin.json"),
    JSON.stringify(opts.interface ? { name, interface: { skills: [] } } : { name }, null, 2),
  );
  return cacheDir;
}

function fakeRead(plugins: { name: string; marketplace: string }[]): PluginAdapterRead {
  return {
    agent: "codex",
    configPath: "/tmp/fake",
    exists: true,
    supportsPlugins: true,
    supportsMarketplaces: true,
    pluginKind: "bundle",
    plugins: plugins.map((p) => ({ ...p, enabled: true, kind: "bundle" as const })),
    marketplaces: [],
  };
}

describe("fixer: codex-flatten-skills", () => {
  test("creates alias symlinks for nested skills", async () => {
    const cacheDir = await makeCodexCache("forsvn-skills", "plugins-cli", {
      nested: ["research/web", "product/spec"],
      flat: [],
      interface: true,
    });
    const reports = await discoverPluginsForAgent(fakeRead([{ name: "forsvn-skills", marketplace: "plugins-cli" }]));
    const results = await runFixersOnReports(reports, { dryRun: false });
    const flat = results.filter((r) => r.fixer === "codex-flatten-skills");
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every((r) => r.applied || r.noop)).toBe(true);

    const alias = join(cacheDir, "skills", "research__web");
    const stats = await lstat(alias);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await readlink(alias)).toBe("research/web");
  });

  test("dry-run reports work but creates no files", async () => {
    const cacheDir = await makeCodexCache("dry", "plugins-cli", {
      nested: ["x/y"],
      flat: [],
      interface: true,
    });
    const reports = await discoverPluginsForAgent(fakeRead([{ name: "dry", marketplace: "plugins-cli" }]));
    const results = await runFixersOnReports(reports, { dryRun: true });
    const flat = results.find((r) => r.fixer === "codex-flatten-skills" && !r.noop);
    expect(flat).toBeDefined();
    expect(flat!.applied).toBe(false);
    expect(flat!.patched.length).toBe(1);
    // Symlink not created.
    let exists = true;
    try {
      await lstat(join(cacheDir, "skills", "x__y"));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("second apply is a no-op (idempotency)", async () => {
    await makeCodexCache("idem", "plugins-cli", { nested: ["a/b"], flat: [], interface: true });
    const reports = await discoverPluginsForAgent(fakeRead([{ name: "idem", marketplace: "plugins-cli" }]));
    const first = await runFixersOnReports(reports, { dryRun: false });
    const firstApplied = first.find((r) => r.fixer === "codex-flatten-skills" && r.applied);
    expect(firstApplied).toBeDefined();

    // Rediscover (alias now exists → discovery still flags nested unless surfaced changes;
    // fixer should detect existing alias and no-op).
    const reports2 = await discoverPluginsForAgent(fakeRead([{ name: "idem", marketplace: "plugins-cli" }]));
    const second = await runFixersOnReports(reports2, { dryRun: false });
    const reapplied = second.find((r) => r.fixer === "codex-flatten-skills" && r.applied);
    expect(reapplied).toBeUndefined();
  });

  test("round-trip: apply → revert → apply produces same final state (sacred §10)", async () => {
    const cacheDir = await makeCodexCache("trip", "plugins-cli", {
      nested: ["k1/v1", "k2/v2"],
      flat: [],
      interface: true,
    });
    const alias1 = join(cacheDir, "skills", "k1__v1");
    const alias2 = join(cacheDir, "skills", "k2__v2");

    const r1 = await discoverPluginsForAgent(fakeRead([{ name: "trip", marketplace: "plugins-cli" }]));
    await runFixersOnReports(r1, { dryRun: false });
    expect((await lstat(alias1)).isSymbolicLink()).toBe(true);
    expect((await lstat(alias2)).isSymbolicLink()).toBe(true);

    const reverted = await revertFixers(r1);
    expect(reverted.reverted).toContain(alias1);
    expect(reverted.reverted).toContain(alias2);
    let aliasGone = true;
    try {
      await lstat(alias1);
      aliasGone = false;
    } catch {}
    expect(aliasGone).toBe(true);

    const r2 = await discoverPluginsForAgent(fakeRead([{ name: "trip", marketplace: "plugins-cli" }]));
    await runFixersOnReports(r2, { dryRun: false });
    expect((await lstat(alias1)).isSymbolicLink()).toBe(true);
    expect((await lstat(alias2)).isSymbolicLink()).toBe(true);
  });
});

describe("fixer: codex-inject-interface", () => {
  test("injects interface block when missing, backs up original", async () => {
    // Discovery tags codex-no-interface only when there are no flat skills.
    // Build the cache without skills initially so discovery fires the tag, then
    // seed skills before the fixer runs so listSkillsForInterface has names.
    const cacheDir = await makeCodexCache("nointerface", "plugins-cli", {
      nested: [],
      flat: [],
      interface: false,
    });
    const reports = await discoverPluginsForAgent(fakeRead([{ name: "nointerface", marketplace: "plugins-cli" }]));
    expect(reports[0]!.failureTags).toContain("codex-no-interface");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cacheDir, "skills", "one"), { recursive: true });
    await writeFile(join(cacheDir, "skills", "one", "SKILL.md"), "# one");
    await mkdir(join(cacheDir, "skills", "two"), { recursive: true });
    await writeFile(join(cacheDir, "skills", "two", "SKILL.md"), "# two");

    const results = await runFixersOnReports(reports, { dryRun: false });
    const inj = results.find((r) => r.fixer === "codex-inject-interface" && r.applied);
    expect(inj).toBeDefined();

    const manifest = JSON.parse(await readFile(join(cacheDir, "plugin.json"), "utf8"));
    expect(manifest.interface).toBeDefined();
    expect(Array.isArray(manifest.interface.skills)).toBe(true);
    expect(manifest.interface.skills.length).toBe(2);

    const bak = await stat(join(cacheDir, "plugin.json.syncthis.bak"));
    expect(bak.isFile()).toBe(true);
  });

  test("no-op when interface already present", async () => {
    await makeCodexCache("hasiface", "plugins-cli", {
      nested: [],
      flat: ["alpha"],
      interface: true,
    });
    const reports = await discoverPluginsForAgent(fakeRead([{ name: "hasiface", marketplace: "plugins-cli" }]));
    const results = await runFixersOnReports(reports, { dryRun: false });
    // Should not include codex-inject-interface at all (discovery wouldn't tag it).
    expect(results.find((r) => r.fixer === "codex-inject-interface")).toBeUndefined();
  });
});
