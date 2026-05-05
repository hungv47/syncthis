import * as TOML from "smol-toml";
import type { Adapter, AdapterRead, AdapterWriteResult, McpServer } from "../types.ts";
import { expandHome, readText, writeText } from "../io.ts";

const TARGET = "~/.codex/config.toml";

function isHttp(s: McpServer): s is Extract<McpServer, { url: string }> {
  return "url" in s;
}

function toCodexShape(servers: Record<string, McpServer>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    if (isHttp(s)) {
      const entry: Record<string, unknown> = { url: s.url };
      if (s.type) entry.type = s.type;
      if (s.headers) entry.headers = s.headers;
      out[name] = entry;
    } else {
      const entry: Record<string, unknown> = { command: s.command };
      if (s.args) entry.args = s.args;
      if (s.env) entry.env = s.env;
      if (s.cwd) entry.cwd = s.cwd;
      out[name] = entry;
    }
  }
  return out;
}

function fromCodexShape(raw: unknown): Record<string, McpServer> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.url === "string") {
      const t = e.type === "sse" ? "sse" : "http";
      const server: Extract<McpServer, { url: string }> = { type: t, url: e.url };
      if (e.headers && typeof e.headers === "object") server.headers = e.headers as Record<string, string>;
      out[name] = server;
    } else if (typeof e.command === "string") {
      const server: Extract<McpServer, { command: string }> = { type: "stdio", command: e.command };
      if (Array.isArray(e.args)) server.args = e.args.map(String);
      if (e.env && typeof e.env === "object") server.env = e.env as Record<string, string>;
      if (typeof e.cwd === "string") server.cwd = e.cwd;
      out[name] = server;
    }
  }
  return out;
}

function stripMcpServers(parsed: Record<string, unknown>): Record<string, unknown> {
  const { mcp_servers: _, ...rest } = parsed as Record<string, unknown> & { mcp_servers?: unknown };
  return rest;
}

export const codexAdapter: Adapter = {
  id: "codex",
  targetPath: () => expandHome(TARGET),

  async read(): Promise<AdapterRead> {
    const path = expandHome(TARGET);
    const text = await readText(path);
    if (text === null) return { agent: "codex", path, servers: {}, exists: false };
    try {
      const parsed = TOML.parse(text) as Record<string, unknown>;
      return { agent: "codex", path, servers: fromCodexShape(parsed.mcp_servers), exists: true };
    } catch (err) {
      return { agent: "codex", path, servers: {}, exists: true, error: String(err) };
    }
  },

  async write(servers, { dryRun }): Promise<AdapterWriteResult> {
    const path = expandHome(TARGET);
    try {
      const currentText = (await readText(path)) ?? "";
      const existing = currentText ? (TOML.parse(currentText) as Record<string, unknown>) : {};
      const next = TOML.stringify({ ...stripMcpServers(existing), mcp_servers: toCodexShape(servers) });
      if (currentText === next) return { agent: "codex", path, status: "unchanged" };
      if (dryRun) return { agent: "codex", path, status: "synced", message: "dry-run" };
      await writeText(path, next, { backup: true });
      return { agent: "codex", path, status: "synced" };
    } catch (err) {
      return { agent: "codex", path, status: "failed", message: String(err) };
    }
  },
};
