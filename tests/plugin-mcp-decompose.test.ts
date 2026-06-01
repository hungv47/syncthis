import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginMcpServers } from "../src/plugins/mcp.ts";
import type { PluginRecord } from "../src/plugins/types.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-pmcp-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// Materialize a plugin install dir with the given files, return a PluginRecord whose
// `path` points at it (matching Claude's `installPath`).
async function plugin(name: string, files: Record<string, unknown>, marketplace?: string): Promise<PluginRecord> {
  const root = join(workDir, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return { name, marketplace, path: root };
}

describe("resolvePluginMcpServers", () => {
  test("lifts .mcp.json servers and resolves ${CLAUDE_PLUGIN_ROOT}", async () => {
    const p = await plugin("db", {
      ".mcp.json": {
        mcpServers: {
          db: { command: "${CLAUDE_PLUGIN_ROOT}/bin/db", args: ["--root", "${CLAUDE_PLUGIN_ROOT}"] },
        },
      },
    });
    const { servers, skipped } = await resolvePluginMcpServers([p]);
    expect(skipped).toEqual([]);
    expect(servers.map((s) => s.name)).toEqual(["db"]);
    expect(servers[0]!.plugin).toBe("db");
    const s = servers[0]!.server as { command: string; args: string[] };
    expect(s.command).toBe(join(p.path!, "bin/db"));
    expect(s.args).toEqual(["--root", p.path!]);
  });

  test("lifts an inline mcpServers map from the plugin manifest", async () => {
    const p = await plugin("x", {
      ".claude-plugin/plugin.json": { name: "x", mcpServers: { api: { command: "node", args: ["server.js"] } } },
    });
    const { servers } = await resolvePluginMcpServers([p]);
    expect(servers.map((s) => s.name)).toEqual(["api"]);
    expect(servers[0]!.server).toEqual({ command: "node", args: ["server.js"] });
  });

  test("lifts a manifest mcpServers string path to a .mcp.json file", async () => {
    const p = await plugin("y", {
      ".claude-plugin/plugin.json": { name: "y", mcpServers: "./servers.json" },
      "servers.json": { mcpServers: { sub: { command: "run" } } },
    });
    const { servers } = await resolvePluginMcpServers([p]);
    expect(servers.map((s) => s.name)).toEqual(["sub"]);
  });

  test("lifts a url server as http and preserves sse", async () => {
    const p = await plugin("h", {
      ".mcp.json": { mcpServers: { remote: { url: "https://x/mcp" }, streamed: { type: "sse", url: "https://y/sse" } } },
    });
    const { servers } = await resolvePluginMcpServers([p]);
    const byName = Object.fromEntries(servers.map((s) => [s.name, s.server]));
    expect(byName.remote).toEqual({ type: "http", url: "https://x/mcp" });
    expect(byName.streamed).toEqual({ type: "sse", url: "https://y/sse" });
  });

  test("skips a server that still references a Claude-only variable", async () => {
    const p = await plugin("d", {
      ".mcp.json": { mcpServers: { data: { command: "x", args: ["${CLAUDE_PLUGIN_DATA}/db"] } } },
    });
    const { servers, skipped } = await resolvePluginMcpServers([p]);
    expect(servers).toEqual([]);
    expect(skipped[0]!.name).toBe("data");
    expect(skipped[0]!.reason).toMatch(/Claude-only/);
  });

  test("leaves a portable ${ENV_VAR} reference untouched (not a Claude var)", async () => {
    const p = await plugin("e", {
      ".mcp.json": { mcpServers: { svc: { command: "run", env: { TOKEN: "${MY_TOKEN}" } } } },
    });
    const { servers, skipped } = await resolvePluginMcpServers([p]);
    expect(skipped).toEqual([]);
    expect((servers[0]!.server as { env: Record<string, string> }).env).toEqual({ TOKEN: "${MY_TOKEN}" });
  });

  test("skips an unrecognized server shape (no command, no url)", async () => {
    const p = await plugin("u", { ".mcp.json": { mcpServers: { weird: { foo: "bar" } } } });
    const { servers, skipped } = await resolvePluginMcpServers([p]);
    expect(servers).toEqual([]);
    expect(skipped[0]!.reason).toMatch(/unrecognized/);
  });

  test("ignores a plugin with no install path and tolerates malformed json", async () => {
    const noPath: PluginRecord = { name: "np" };
    const bad = await plugin("bad", { ".mcp.json": "{ not valid json ,,," });
    const { servers, skipped } = await resolvePluginMcpServers([noPath, bad]);
    expect(servers).toEqual([]);
    expect(skipped).toEqual([]);
  });

  test("first plugin wins a duplicate name; a conflicting duplicate is skipped", async () => {
    const a = await plugin("a", { ".mcp.json": { mcpServers: { dup: { command: "a" } } } });
    const b = await plugin("b", { ".mcp.json": { mcpServers: { dup: { command: "b" } } } });
    const { servers, skipped } = await resolvePluginMcpServers([a, b]);
    expect(servers.length).toBe(1);
    expect((servers[0]!.server as { command: string }).command).toBe("a");
    expect(skipped[0]).toMatchObject({ plugin: "b", name: "dup" });
    expect(skipped[0]!.reason).toMatch(/duplicate/);
  });

  test("an identical duplicate across plugins is deduped silently", async () => {
    const a = await plugin("a", { ".mcp.json": { mcpServers: { same: { command: "x", args: ["--y"] } } } });
    const b = await plugin("b", { ".mcp.json": { mcpServers: { same: { args: ["--y"], command: "x" } } } });
    const { servers, skipped } = await resolvePluginMcpServers([a, b]);
    expect(servers.length).toBe(1);
    expect(skipped).toEqual([]);
  });
});
