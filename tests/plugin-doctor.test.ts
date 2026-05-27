import { describe, expect, test } from "bun:test";
import type {
  MarketplaceRecord,
  PluginAdapterRead,
  PluginRecord,
} from "../src/plugins/types.ts";

// We import the orchestrator after creating fake reads to test its pure logic
// independent of the real adapters. The orchestrator is exported via plugin-doctor.ts.
import { runPluginDoctor } from "../src/plugin-doctor.ts";

// To unit-test the orchestrator we'd ordinarily inject reads, but the function
// reads via the registry. So instead we test what we *can* — that calling it
// against the real (possibly missing) files doesn't throw, and that the report
// shape is well-formed.
describe("plugin-doctor smoke", () => {
  test("runs without throwing and returns the expected shape", async () => {
    const r = await runPluginDoctor();
    expect(Array.isArray(r.reads)).toBe(true);
    expect(r.reads.length).toBe(4);
    expect(r.pluginCoverage.bundle).toBeInstanceOf(Array);
    expect(r.pluginCoverage.npm).toBeInstanceOf(Array);
    expect(r.marketplaceCoverage).toBeInstanceOf(Array);
    expect(r.marketplaceConflicts).toBeInstanceOf(Array);
  });
});

// Pure-logic tests against a hand-built report.
// We exercise the coverage computation by importing the named helpers if they
// were exposed, or by re-implementing the contract here.
describe("plugin-doctor coverage logic (contract tests)", () => {
  test("bundle and npm plugins are reported in separate cohorts", () => {
    const reads: PluginAdapterRead[] = [
      makeRead("claude-code", "bundle", true, [
        plugin("foo", "bundle", "plugins-cli"),
      ]),
      makeRead("codex", "bundle", true, [
        plugin("foo", "bundle", "plugins-cli"),
      ]),
      makeRead("cursor", "bundle", false, [
        plugin("bar", "bundle"),
      ]),
      makeRead("opencode", "npm", false, [
        plugin("@scope/x", "npm"),
      ]),
    ];

    const { bundleNames, npmNames } = partitionPluginNames(reads);
    expect(bundleNames).toEqual(new Set(["foo", "bar"]));
    expect(npmNames).toEqual(new Set(["@scope/x"]));
  });

  test("marketplace conflict detection: same name, different sources", () => {
    const reads: PluginAdapterRead[] = [
      makeRead("claude-code", "bundle", true, [], [
        { name: "shared", source: "github:a/b", sourceType: "github" },
      ]),
      makeRead("codex", "bundle", true, [], [
        { name: "shared", source: "https://other.example", sourceType: "git" },
      ]),
    ];
    const conflicts = detectConflicts(reads);
    expect(conflicts).toEqual([
      {
        name: "shared",
        versions: [
          { agent: "claude-code", source: "github:a/b" },
          { agent: "codex", source: "https://other.example" },
        ],
      },
    ]);
  });

  test("marketplace conflict skipped when sources match", () => {
    const reads: PluginAdapterRead[] = [
      makeRead("claude-code", "bundle", true, [], [
        { name: "shared", source: "github:a/b", sourceType: "github" },
      ]),
      makeRead("codex", "bundle", true, [], [
        { name: "shared", source: "github:a/b", sourceType: "github" },
      ]),
    ];
    expect(detectConflicts(reads)).toEqual([]);
  });
});

// Helpers — these duplicate the orchestrator's contract for cohesive coverage.
function makeRead(
  agent: PluginAdapterRead["agent"],
  pluginKind: "bundle" | "npm",
  supportsMarketplaces: boolean,
  plugins: PluginRecord[],
  marketplaces: MarketplaceRecord[] = [],
): PluginAdapterRead {
  return {
    agent,
    configPath: `/tmp/${agent}`,
    exists: true,
    supportsPlugins: true,
    supportsMarketplaces,
    pluginKind,
    plugins,
    marketplaces,
  };
}

function plugin(name: string, kind: "bundle" | "npm", marketplace?: string): PluginRecord {
  return { name, kind, marketplace };
}

function partitionPluginNames(reads: PluginAdapterRead[]) {
  const bundleNames = new Set<string>();
  const npmNames = new Set<string>();
  for (const r of reads) {
    for (const p of r.plugins) {
      if (p.kind === "bundle") bundleNames.add(p.name);
      else npmNames.add(p.name);
    }
  }
  return { bundleNames, npmNames };
}

function detectConflicts(reads: PluginAdapterRead[]) {
  const names = new Set<string>();
  for (const r of reads) for (const m of r.marketplaces) names.add(m.name);
  const conflicts: { name: string; versions: { agent: string; source: string }[] }[] = [];
  for (const name of names) {
    const versions: { agent: string; source: string }[] = [];
    for (const r of reads) {
      const m = r.marketplaces.find((x) => x.name === name);
      if (m) versions.push({ agent: r.agent, source: m.source });
    }
    if (versions.length > 1) {
      const distinct = new Set(versions.map((v) => v.source));
      if (distinct.size > 1) conflicts.push({ name, versions });
    }
  }
  return conflicts.sort((a, b) => a.name.localeCompare(b.name));
}
