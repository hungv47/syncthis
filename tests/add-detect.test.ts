import { describe, expect, test } from "bun:test";
import { detectAddType, isAddType, needsInstalledPlugins } from "../src/plugins/detect.ts";

describe("detectAddType", () => {
  const installed = new Set(["my-plugin", "browse"]);

  test("owner/repo slug → skill (no installed-plugin lookup needed)", () => {
    expect(detectAddType("vercel-labs/agent-skills")).toBe("skill");
    // Even when the repo's basename collides with an installed plugin name, the slash wins.
    expect(detectAddType("someone/my-plugin", { installedPluginNames: installed })).toBe("skill");
  });

  test("bare name installed on claude-code → plugin", () => {
    expect(detectAddType("my-plugin", { installedPluginNames: installed })).toBe("plugin");
    expect(detectAddType("browse", { installedPluginNames: installed })).toBe("plugin");
  });

  test("bare name not installed → mcp (syncthis doesn't install MCP servers)", () => {
    expect(detectAddType("context7", { installedPluginNames: installed })).toBe("mcp");
    // No installed-plugin set at all → still mcp for a bare name.
    expect(detectAddType("context7")).toBe("mcp");
  });

  test("--as overrides detection entirely", () => {
    expect(detectAddType("vercel-labs/agent-skills", { as: "plugin" })).toBe("plugin");
    expect(detectAddType("context7", { as: "skill" })).toBe("skill");
    expect(detectAddType("my-plugin", { as: "mcp", installedPluginNames: installed })).toBe("mcp");
  });

  test("invalid --as throws", () => {
    expect(() => detectAddType("anything", { as: "bogus" })).toThrow(/--as must be one of/);
  });
});

describe("isAddType", () => {
  test("accepts the three add types, rejects others", () => {
    expect(isAddType("skill")).toBe(true);
    expect(isAddType("plugin")).toBe(true);
    expect(isAddType("mcp")).toBe(true);
    expect(isAddType("repo")).toBe(false);
    expect(isAddType("")).toBe(false);
  });
});

describe("needsInstalledPlugins", () => {
  test("only a bare name without --as needs Claude's plugin list", () => {
    expect(needsInstalledPlugins("context7")).toBe(true);
    expect(needsInstalledPlugins("owner/repo")).toBe(false); // slash → skill, no lookup
    expect(needsInstalledPlugins("context7", "skill")).toBe(false); // --as set → no lookup
  });
});
