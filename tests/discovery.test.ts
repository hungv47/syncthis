import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
  layout: { nested: string[]; flat: string[]; interface: boolean },
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
  const manifest = layout.interface
    ? { name: pluginName, interface: { skills: [] } }
    : { name: pluginName };
  await writeFile(join(cacheRoot, "plugin.json"), JSON.stringify(manifest, null, 2));
  return cacheRoot;
}

describe("discoverPluginsForAgent — codex silent failure modes", () => {
  test("nested-only skills surface as silent failure with codex-nested-skills tag", async () => {
    await makeCodexCache("forsvn-skills", "plugins-cli", {
      nested: ["research/web", "product/spec", "marketing/copy"],
      flat: [],
      interface: true,
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
    expect(r.surfaced).toBe(false);
    expect(r.skills).toEqual({ expected: 3, actual: 0 });
    expect(r.failureTags).toContain("codex-nested-skills");
    expect(r.reasons[0]).toContain("one-level-deep");
  });

  test("flat skills surface even without interface block — manifest absence demoted to informational", async () => {
    // Reflects real-world plugins-cli installs where the manifest is missing/sparse
    // but skills are still picked up. The interface check is a surfacing blocker
    // *only* when no flat skills are present (the genuine impeccable case).
    await makeCodexCache("pliable", "plugins-cli", {
      nested: [],
      flat: ["pristine", "perfect"],
      interface: false,
    });
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "pliable", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    const r = reports[0]!;
    expect(r.skills).toEqual({ expected: 2, actual: 2 });
    expect(r.failureTags).not.toContain("codex-no-interface");
    expect(r.surfaced).toBe(true);
  });

  test("no skills + no interface → silent failure (the impeccable case)", async () => {
    await makeCodexCache("impeccable", "plugins-cli", {
      nested: [],
      flat: [],
      interface: false,
    });
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "impeccable", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    const r = reports[0]!;
    expect(r.failureTags).toContain("codex-no-interface");
    expect(r.surfaced).toBe(false);
  });

  test("everything correct → surfaced", async () => {
    await makeCodexCache("brave", "plugins-cli", { nested: [], flat: ["search"], interface: true });
    const reports = await discoverPluginsForAgent(
      fakeRead({
        agent: "codex",
        plugins: [{ name: "brave", marketplace: "plugins-cli", enabled: true, kind: "bundle" }],
      }),
    );
    const r = reports[0]!;
    expect(r.surfaced).toBe(true);
    expect(r.failureTags).toEqual([]);
  });

  test("disabled plugin never surfaces, regardless of correctness", async () => {
    await makeCodexCache("brave", "plugins-cli", { nested: [], flat: ["search"], interface: true });
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
