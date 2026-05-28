import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexPluginAdapter } from "../src/plugins/codex.ts";
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

async function installFakeClaude(pluginsJson: string) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const pluginsFile = join(workDir, "plugins.json");
  await writeFile(pluginsFile, pluginsJson);
  const script = `#!/bin/sh
case "$1 $2 $3" in
  "plugin list --json") cat ${pluginsFile} ;;
  *) echo "unexpected: $@" >&2 ; exit 99 ;;
esac
`;
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, script);
  await chmod(claudePath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

describe("codex plugin adapter", () => {
  test("reads plugins from config.toml", async () => {
    await writeCodexConfig(`
[plugins."vercel-plugin@plugins-cli"]
enabled = true

[plugins."expo@plugins-cli"]
enabled = false
`);
    const r = await codexPluginAdapter.read();
    expect(r.exists).toBe(true);
    expect(r.plugins.map((p) => `${p.name}@${p.marketplace}=${p.enabled}`).sort()).toEqual([
      "expo@plugins-cli=false",
      "vercel-plugin@plugins-cli=true",
    ]);
  });

  test("missing config produces empty, exists=false", async () => {
    const r = await codexPluginAdapter.read();
    expect(r.exists).toBe(false);
    expect(r.plugins).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  test("invalid TOML produces error", async () => {
    await writeCodexConfig("this is = not [valid] toml { :");
    const r = await codexPluginAdapter.read();
    expect(r.exists).toBe(true);
    expect(r.error).toBeTruthy();
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
  });

  test("returns error when claude CLI not on PATH", async () => {
    process.env.PATH = "/nonexistent-bin-dir-syncthis-test";
    const r = await claudePluginAdapter.read();
    expect(r.error).toBeTruthy();
    expect(r.exists).toBe(false);
  });
});
