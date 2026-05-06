import type { Adapter, AdapterRead, AdapterWriteResult, McpServer } from "../types.ts";
import { expandHome, readJson, writeJson } from "../io.ts";

const TARGET = "~/.codeium/windsurf/mcp_config.json";

// Windsurf is canonical-ish: top-level `mcpServers`, but HTTP entries use `serverUrl` instead of `url`.
type WindsurfStdio = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
type WindsurfHttp = {
  serverUrl: string;
  headers?: Record<string, string>;
};
type WindsurfShape = {
  mcpServers?: Record<string, WindsurfStdio | WindsurfHttp>;
} & Record<string, unknown>;

function fromWindsurf(raw: WindsurfShape["mcpServers"]): Record<string, McpServer> {
  if (!raw) return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if ("serverUrl" in entry && typeof entry.serverUrl === "string") {
      const server: Extract<McpServer, { url: string }> = { type: "http", url: entry.serverUrl };
      if (entry.headers) server.headers = entry.headers;
      out[name] = server;
    } else if ("command" in entry && typeof entry.command === "string") {
      const server: Extract<McpServer, { command: string }> = { type: "stdio", command: entry.command };
      if (entry.args) server.args = entry.args;
      if (entry.env) server.env = entry.env;
      out[name] = server;
    }
  }
  return out;
}

function toWindsurf(servers: Record<string, McpServer>): Record<string, WindsurfStdio | WindsurfHttp> {
  const out: Record<string, WindsurfStdio | WindsurfHttp> = {};
  for (const [name, s] of Object.entries(servers)) {
    if ("url" in s) {
      const entry: WindsurfHttp = { serverUrl: s.url };
      if (s.headers) entry.headers = s.headers;
      out[name] = entry;
    } else {
      const entry: WindsurfStdio = { command: s.command };
      if (s.args) entry.args = s.args;
      if (s.env) entry.env = s.env;
      out[name] = entry;
    }
  }
  return out;
}

export const windsurfAdapter: Adapter = {
  id: "windsurf",
  targetPath: () => expandHome(TARGET),

  async read(): Promise<AdapterRead> {
    const path = expandHome(TARGET);
    try {
      const data = await readJson<WindsurfShape>(path);
      if (data === null) return { agent: "windsurf", path, servers: {}, exists: false };
      return { agent: "windsurf", path, servers: fromWindsurf(data.mcpServers), exists: true };
    } catch (err) {
      return { agent: "windsurf", path, servers: {}, exists: true, error: String(err) };
    }
  },

  async write(servers, { dryRun }): Promise<AdapterWriteResult> {
    const path = expandHome(TARGET);
    let existing: WindsurfShape;
    try {
      existing = (await readJson<WindsurfShape>(path)) ?? {};
    } catch (err) {
      return { agent: "windsurf", path, status: "failed", message: `cannot parse existing file: ${String(err)}` };
    }
    const next: WindsurfShape = { ...existing, mcpServers: toWindsurf(servers) };
    if (JSON.stringify(existing) === JSON.stringify(next)) {
      return { agent: "windsurf", path, status: "unchanged" };
    }
    if (dryRun) return { agent: "windsurf", path, status: "synced", message: "dry-run" };
    try {
      await writeJson(path, next, { backup: true });
      return { agent: "windsurf", path, status: "synced" };
    } catch (err) {
      return { agent: "windsurf", path, status: "failed", message: String(err) };
    }
  },
};
