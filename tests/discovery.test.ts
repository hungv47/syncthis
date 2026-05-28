import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPluginsForAgent } from "../src/plugins/discovery.ts";
import type { PluginAdapterRead } from "../src/plugins/types.ts";

let workDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-disc-"));
  originalHome = process.env.HOME;
  process.env.HOME = workDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(workDir, { recursive: true, force: true });
});

function fakeRead(over: Partial<PluginAdapterRead> & Pick<PluginAdapterRead, "agent">): PluginAdapterRead {
  return {
    configPath: "/tmp/fake",
    exists: true,
    supportsPlugins: true,
    supportsMarketplaces: false,
    pluginKind: "bundle",
    plugins: [],
    marketplaces: [],
    ...over,
  };
}

async function makeCodexCache(
  pluginName: string,
  marketplace: string,
  layout: { nested: string[]; flat: string[]; manifest?: boolean; skillsField?: string },
): Promise<string> {
  const cacheRoot = join(workDir, ".codex", "plugins", "cache", marketplace, pluginName, "deadbeef");
  await mkdir(join(cacheRoot, "skills"), { recursive: true });
  for (const nested of layout.nested) {
    const [cat, skill] = nested.split("/");
    await mkdir(join(cacheRoot, "skills", cat!, skill!), { recursive: true });
    await writeFile(join(cacheRoot, "skills", cat!, skill!, "SKILL.md"), `# ${skill}\n`);
  }
  for (const flat of layout.flat) {
    await mkdir(join(cacheRoot, "skills", flat), { recursive: true });
    await writeFile(join(cacheRoot, "skills", flat, "SKILL.md"), `# ${flat}\n`);
  }
  // Real Codex plugins ship .codex-plugin/plugin.json whose `skills` field points
  // at the skills root. manifest:false simulates a cache dir Codex won't load.
  if (layout.manifest !== false) {
    await mkdir(join(cacheRoot, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(cacheRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify(
        { name: pluginName, skills: layout.skillsField ?? "./skills/", interface: { displayName: pluginName } },
        null,
        2,
      ),
    );
  }
  return cacheRoot;
}

describe("discoverPluginsForAgent — codex lifecycle", () => {
  test("nested skills surface — Codex recurses into the skills root (depth<=6)", async () => {
    // Codex's loader scans the manifest skills root recursively, so a nested
    // skills/<cat>/<skill>/ layout surfaces fully. This is NOT a silent failure.
    await makeCodexCache("forsvn-skills", "plugins-cli", {
      nested: ["research/web", "product/spec", "marketing/copy"],
      flat: [],
    });

    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "forsvn-skills", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    expect(reports.length).toBe(1);
    const r = reports[0]!;
    expect(r.loaded).toBe(true);
    expect(r.surfaced).toBe(true);
    expect(r.skills).toEqual({ expected: 3, actual: 3 });
    expect(r.failureTags).toEqual([]);
  });

  test("flat skills surface", async () => {
    await makeCodexCache("pliable", "plugins-cli", { nested: [], flat: ["pristine", "perfect"] });
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "pliable", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    const r = reports[0]!;
    expect(r.skills).toEqual({ expected: 2, actual: 2 });
    expect(r.surfaced).toBe(true);
    expect(r.failureTags).toEqual([]);
  });

  test("manifest present but zero skills still surfaces (commands/tools-only plugin)", async () => {
    await makeCodexCache("typefully", "plugins-cli", { nested: [], flat: [] });
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "typefully", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    const r = reports[0]!;
    expect(r.surfaced).toBe(true);
    expect(r.failureTags).toEqual([]);
  });

  test("cache dir without a .codex-plugin manifest is a real silent failure", async () => {
    await makeCodexCache("nomanifest", "plugins-cli", { nested: [], flat: ["x"], manifest: false });
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "nomanifest", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    const r = reports[0]!;
    expect(r.failureTags).toContain("codex-no-manifest");
    expect(r.surfaced).toBe(false);
  });

  test("a symlink inside skills/ that escapes the scan root is not followed", async () => {
    // Codex follows intra-tree symlinks, but a link pointing outside the plugin
    // (skills/evil -> some external dir) must not make the read-only scan
    // enumerate unrelated directories — keeps resolveSkillsRoot containment honest.
    const cache = await makeCodexCache("linky", "plugins-cli", { nested: [], flat: ["legit"] });
    const external = join(workDir, "external-skill");
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "SKILL.md"), "# external");
    await symlink(external, join(cache, "skills", "evil"));

    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "linky", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    const r = reports[0]!;
    // Only the real in-tree skill counts; the escaping symlink is ignored.
    expect(r.skills).toEqual({ expected: 1, actual: 1 });
    expect(r.surfaced).toBe(true);
  });

  test("manifest skills field escaping the plugin dir is refused (containment guard)", async () => {
    // A rogue/odd manifest must not redirect the read-only skill scan outside the
    // plugin cache dir — it falls back to <pluginDir>/skills.
    await makeCodexCache("escaper", "plugins-cli", {
      nested: [],
      flat: ["legit"],
      skillsField: "../../../../../../etc",
    });
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "escaper", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    const r = reports[0]!;
    expect(r.skills).toEqual({ expected: 1, actual: 1 });
    expect(r.surfaced).toBe(true);
  });

  test("unsafe plugin name from config is refused before resolving a cache dir", async () => {
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "../../etc/evil", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    const r = reports[0]!;
    expect(r.failureTags).toContain("codex-unsafe-name");
    expect(r.paths).toEqual([]);
    expect(r.surfaced).toBe(false);
  });

  test("disabled plugin never surfaces", async () => {
    await makeCodexCache("brave", "plugins-cli", { nested: [], flat: ["search"] });
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "brave", marketplace: "plugins-cli", enabled: false, kind: "bundle" }],
      }),
    );
    expect(reports[0]!.surfaced).toBe(false);
    expect(reports[0]!.reasons.some((r) => r.includes("disabled"))).toBe(true);
  });

  test("registered but cache missing → loaded=false with explicit reason", async () => {
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "ghost", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    const r = reports[0]!;
    expect(r.loaded).toBe(false);
    expect(r.failureTags).toContain("codex-no-cache");
  });
});

describe("discoverPluginsForAgent — claude trust-installPath path", () => {
  test("missing installPath gets reported, not silently ignored", async () => {
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "claude-code",
        plugins: [{ name: "broken", kind: "bundle" }],
      }),
    );
    expect(reports[0]!.loaded).toBe(false);
    expect(reports[0]!.reasons[0]).toContain("installPath");
  });

  test("walks installPath and counts skills (nested ok for claude)", async () => {
    const installPath = join(workDir, "claude-plugin");
    await mkdir(join(installPath, "skills", "category", "alpha"), { recursive: true });
    await writeFile(join(installPath, "skills", "category", "alpha", "SKILL.md"), "# alpha");
    await mkdir(join(installPath, "skills", "category", "beta"), { recursive: true });
    await writeFile(join(installPath, "skills", "category", "beta", "SKILL.md"), "# beta");

    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "claude-code",
        plugins: [{ name: "good", kind: "bundle", path: installPath, enabled: true }],
      }),
    );
    const r = reports[0]!;
    expect(r.skills).toEqual({ expected: 2, actual: 2 });
    expect(r.surfaced).toBe(true);
  });
});
