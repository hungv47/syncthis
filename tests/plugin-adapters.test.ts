import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexPluginAdapter } from "../src/plugins/codex.ts";
import { cursorPluginAdapter } from "../src/plugins/cursor.ts";
import { opencodePluginAdapter } from "../src/plugins/opencode.ts";
import { claudePluginAdapter } from "../src/plugins/claude.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-plugins-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = workDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

async function writeCodexConfig(text: string) {
  await mkdir(join(workDir, ".codex"), { recursive: true });
  await writeFile(join(workDir, ".codex", "config.toml"), text);
}

async function writeOpencodeConfig(json: object) {
  await mkdir(join(workDir, ".config", "opencode"), { recursive: true });
  await writeFile(join(workDir, ".config", "opencode", "opencode.json"), JSON.stringify(json));
}

async function installFakeClaude(pluginsJson: string, marketplacesJson: string) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const pluginsFile = join(workDir, "plugins.json");
  const marketsFile = join(workDir, "markets.json");
  await writeFile(pluginsFile, pluginsJson);
  await writeFile(marketsFile, marketplacesJson);
  const script = `#!/bin/sh
case "$1 $2 $3" in
  "plugin list --json") cat ${pluginsFile} ;;
  "plugin marketplace list") cat ${marketsFile} ;;
  *) echo "unexpected: $@" >&2 ; exit 99 ;;
esac
`;
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, script);
  await chmod(claudePath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

describe("codex plugin adapter", () => {
  test("reads plugins and marketplaces from config.toml", async () => {
    await writeCodexConfig(`
[plugins."vercel-plugin@plugins-cli"]
enabled = true

[plugins."expo@plugins-cli"]
enabled = false

[marketplaces.openai-bundled]
source_type = "local"
source = "/opt/openai/bundle"

[marketplaces.plugins-cli]
source_type = "git"
source = "https://github.com/x/y"
`);
    const r = await codexPluginAdapter.read();
    expect(r.exists).toBe(true);
    expect(r.plugins.map((p) => `${p.name}@${p.marketplace}=${p.enabled}`).sort()).toEqual([
      "expo@plugins-cli=false",
      "vercel-plugin@plugins-cli=true",
    ]);
    expect(r.marketplaces.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "openai-bundled", source: "/opt/openai/bundle", sourceType: "local" },
      { name: "plugins-cli", source: "https://github.com/x/y", sourceType: "git" },
    ]);
  });

  test("missing config produces empty, exists=false", async () => {
    const r = await codexPluginAdapter.read();
    expect(r.exists).toBe(false);
    expect(r.plugins).toEqual([]);
    expect(r.marketplaces).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  test("invalid TOML produces error", async () => {
    await writeCodexConfig("this is = not [valid] toml { :");
    const r = await codexPluginAdapter.read();
    expect(r.exists).toBe(true);
    expect(r.error).toBeTruthy();
  });
});

describe("opencode plugin adapter", () => {
  test("reads plugin array as npm-kind plugins", async () => {
    await writeOpencodeConfig({
      plugin: ["@warp-dot-dev/opencode-warp", "some-other-plugin"],
      mcp: {},
    });
    const r = await opencodePluginAdapter.read();
    expect(r.exists).toBe(true);
    expect(r.pluginKind).toBe("npm");
    expect(r.supportsMarketplaces).toBe(false);
    expect(r.plugins.map((p) => p.name).sort()).toEqual([
      "@warp-dot-dev/opencode-warp",
      "some-other-plugin",
    ]);
    expect(r.plugins.every((p) => p.kind === "npm")).toBe(true);
  });

  test("missing config produces empty, exists=false", async () => {
    const r = await opencodePluginAdapter.read();
    expect(r.exists).toBe(false);
    expect(r.plugins).toEqual([]);
  });

  test("config without plugin array yields empty plugins", async () => {
    await writeOpencodeConfig({ mcp: {} });
    const r = await opencodePluginAdapter.read();
    expect(r.exists).toBe(true);
    expect(r.plugins).toEqual([]);
  });
});

describe("cursor plugin adapter", () => {
  test("missing directory produces empty, exists=false", async () => {
    const r = await cursorPluginAdapter.read();
    expect(r.exists).toBe(false);
    expect(r.plugins).toEqual([]);
    expect(r.supportsMarketplaces).toBe(false);
  });

  test("enumerates plugins under scope and cache layouts", async () => {
    // cache-style: <root>/<marketplace>/<plugin>/<sha>/
    const cacheRoot = join(workDir, ".cursor", "plugins");
    await mkdir(join(cacheRoot, "vercel", "vercel-plugin", "abc123"), { recursive: true });
    // scope-style: <root>/local/<plugin>/
    await mkdir(join(cacheRoot, "local", "my-local-plugin"), { recursive: true });

    const r = await cursorPluginAdapter.read();
    expect(r.exists).toBe(true);
    const names = r.plugins.map((p) => p.name).sort();
    expect(names).toContain("vercel-plugin");
    expect(names).toContain("my-local-plugin");
    const vercel = r.plugins.find((p) => p.name === "vercel-plugin");
    expect(vercel?.marketplace).toBe("vercel");
    const local = r.plugins.find((p) => p.name === "my-local-plugin");
    expect(local?.scope).toBe("local");
  });
});

describe("claude plugin adapter", () => {
  test("parses --json output from claude CLI", async () => {
    await installFakeClaude(
      JSON.stringify([
        {
          id: "vercel-plugin@plugins-cli",
          version: "1.0.0",
          scope: "user",
          enabled: true,
          installPath: "/x/y",
        },
        {
          id: "noscope-plugin",
          version: "0.1.0",
          enabled: false,
        },
      ]),
      JSON.stringify([
        { name: "plugins-cli", source: "github", repo: "x/y" },
        { name: "private", url: "https://example.com/registry" },
      ]),
    );
    const r = await claudePluginAdapter.read();
    expect(r.error).toBeUndefined();
    expect(r.exists).toBe(true);
    expect(r.plugins).toHaveLength(2);
    const vercel = r.plugins.find((p) => p.name === "vercel-plugin");
    expect(vercel?.marketplace).toBe("plugins-cli");
    expect(vercel?.enabled).toBe(true);
    const noscope = r.plugins.find((p) => p.name === "noscope-plugin");
    expect(noscope?.marketplace).toBeUndefined();
    expect(noscope?.enabled).toBe(false);

    expect(r.marketplaces).toHaveLength(2);
    const gh = r.marketplaces.find((m) => m.name === "plugins-cli");
    expect(gh?.sourceType).toBe("github");
    expect(gh?.source).toBe("github:x/y");
    const url = r.marketplaces.find((m) => m.name === "private");
    expect(url?.sourceType).toBe("git");
    expect(url?.source).toBe("https://example.com/registry");
  });

  test("returns error when claude CLI not on PATH", async () => {
    process.env.PATH = "/nonexistent-bin-dir-syncthis-test";
    const r = await claudePluginAdapter.read();
    expect(r.error).toBeTruthy();
    expect(r.exists).toBe(false);
  });
});
