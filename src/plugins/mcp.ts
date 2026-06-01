// Plugin → MCP decomposition.
//
// A Claude plugin can bundle MCP servers (a root `.mcp.json`, or an `mcpServers`
// field in its manifest). Those servers are standard MCP config, so they're
// portable to ANY MCP-capable agent — but the plugin-native cohort (Claude, Codex,
// Cursor) already gets them by installing the plugin. The 8 non-plugin agents
// can't load plugins at all, so the mirror lifts a plugin's bundled MCP servers
// out and writes them into those agents' own MCP configs (via the normal adapters).
//
// The one transform that matters: a bundled server's paths use
// `${CLAUDE_PLUGIN_ROOT}`, which only Claude Code substitutes at load time. Outside
// Claude there's no such variable, so we resolve it to the plugin's absolute install
// dir. A server that still references a Claude-only variable we can't resolve
// (`${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, …) can't run elsewhere, so it's
// skipped with a reason rather than written as a config that would silently fail.

import { join } from "node:path";
import { readJson } from "../io.ts";
import type { HttpServer, McpServer, StdioServer } from "../types.ts";
import type { PluginRecord } from "./types.ts";

// Claude substitutes ${CLAUDE_PLUGIN_ROOT} (and the bare `$CLAUDE_PLUGIN_ROOT`
// form) with the plugin's install dir. We do the same so the lifted server resolves.
const ROOT_TOKENS = ["${CLAUDE_PLUGIN_ROOT}", "$CLAUDE_PLUGIN_ROOT"];

export type PluginMcpServer = {
  plugin: string;
  marketplace?: string;
  name: string;
  server: McpServer;
};

export type PluginMcpSkip = { plugin: string; name: string; reason: string };

export type PluginMcpResolution = {
  servers: PluginMcpServer[];
  skipped: PluginMcpSkip[];
};

function substituteRoot(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const tok of ROOT_TOKENS) out = out.split(tok).join(root);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => substituteRoot(v, root));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteRoot(v, root);
    return out;
  }
  return value;
}

// A Claude-injected variable other than CLAUDE_PLUGIN_ROOT (already resolved):
// CLAUDE_PLUGIN_DATA, CLAUDE_PROJECT_DIR, CLAUDE_CONFIG_DIR. These have no value
// outside Claude, so a server still referencing one can't run elsewhere — skip it.
// Plain `${ENV_VAR}` refs (the user's own environment) are portable and left alone;
// matching is scoped to the known CLAUDE_ prefixes so a user var that merely starts
// with CLAUDE_ isn't caught.
function hasUnresolvedClaudeVar(server: McpServer): boolean {
  return /\$\{?CLAUDE_(PLUGIN|PROJECT|CONFIG)[A-Z_]*\}?/.test(JSON.stringify(server));
}

// Narrow a raw bundled definition to a syncable McpServer. URL servers map to http
// (sse preserved); command servers keep args/env/cwd. Anything else (no url, no
// command) is unrecognized and gets skipped by the caller.
function coerceServer(raw: unknown): McpServer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url === "string") {
    const s: HttpServer = { type: r.type === "sse" ? "sse" : "http", url: r.url };
    if (r.headers && typeof r.headers === "object") s.headers = r.headers as Record<string, string>;
    return s;
  }
  if (typeof r.command === "string") {
    const s: StdioServer = { command: r.command };
    if (Array.isArray(r.args)) s.args = r.args.filter((a): a is string => typeof a === "string");
    if (r.env && typeof r.env === "object") s.env = r.env as Record<string, string>;
    if (typeof r.cwd === "string") s.cwd = r.cwd;
    return s;
  }
  return null;
}

// Stable JSON for cross-plugin dedup (key order independent).
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

// Read a standard `.mcp.json`-shaped file → its `mcpServers` map. A malformed or
// missing file yields null (best-effort; a broken bundle never aborts a mirror).
async function readServerMap(file: string): Promise<Record<string, unknown> | null> {
  let data: unknown;
  try {
    data = await readJson(file);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const field = (data as Record<string, unknown>).mcpServers;
  return field && typeof field === "object" && !Array.isArray(field) ? (field as Record<string, unknown>) : null;
}

// The `mcpServers` declared by a plugin's manifest. Per the plugin spec the field
// is `object | string | array`: an inline server map, a relative path to a
// `.mcp.json` file, or a list of such paths.
async function manifestServers(root: string): Promise<Record<string, unknown>> {
  let manifest: Record<string, unknown> | null = null;
  for (const rel of [".claude-plugin/plugin.json", "plugin.json"]) {
    try {
      const data = await readJson<Record<string, unknown>>(join(root, rel));
      if (data && typeof data === "object") {
        manifest = data;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  const field = manifest?.mcpServers;
  if (!field) return {};
  if (typeof field === "object" && !Array.isArray(field)) return field as Record<string, unknown>;
  const paths = typeof field === "string"
    ? [field]
    : Array.isArray(field)
      ? field.filter((p): p is string => typeof p === "string")
      : [];
  const out: Record<string, unknown> = {};
  for (const rel of paths) {
    if (rel.includes("..")) continue; // never read outside the plugin dir
    const map = await readServerMap(join(root, rel));
    if (map) Object.assign(out, map);
  }
  return out;
}

// Resolve the MCP servers bundled inside the given installed plugins. Each plugin's
// `path` is its install dir (Claude's `installPath`), used both to locate `.mcp.json`
// / the manifest and to resolve ${CLAUDE_PLUGIN_ROOT}. A plugin with no known path is
// skipped silently (nothing to read). First plugin wins a duplicate server name; a
// conflicting duplicate from a later plugin is reported as skipped.
export async function resolvePluginMcpServers(plugins: PluginRecord[]): Promise<PluginMcpResolution> {
  const servers: PluginMcpServer[] = [];
  const skipped: PluginMcpSkip[] = [];
  const seen = new Map<string, string>();

  for (const plugin of plugins) {
    const root = plugin.path;
    if (!root) continue;
    const fromMcpJson = (await readServerMap(join(root, ".mcp.json"))) ?? {};
    const fromManifest = await manifestServers(root);
    const merged: Record<string, unknown> = { ...fromMcpJson, ...fromManifest };

    for (const [name, rawDef] of Object.entries(merged)) {
      if (!name) continue;
      const server = coerceServer(substituteRoot(rawDef, root));
      if (!server) {
        skipped.push({ plugin: plugin.name, name, reason: "unrecognized MCP server shape" });
        continue;
      }
      if (hasUnresolvedClaudeVar(server)) {
        skipped.push({ plugin: plugin.name, name, reason: "references a Claude-only variable with no value outside Claude" });
        continue;
      }
      const canonical = stableStringify(server);
      const prior = seen.get(name);
      if (prior !== undefined) {
        if (prior !== canonical) {
          skipped.push({ plugin: plugin.name, name, reason: "duplicate server name with a different config in another plugin" });
        }
        continue;
      }
      seen.set(name, canonical);
      servers.push({ plugin: plugin.name, marketplace: plugin.marketplace, name, server });
    }
  }

  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, skipped };
}
