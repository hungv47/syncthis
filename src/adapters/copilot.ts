import type { Adapter, AdapterRead, AdapterWriteResult, McpServer } from "../types.ts";
import { expandHome, readJson, resolveUnderHome, writeJson } from "../io.ts";

const DEFAULT_TARGET = "~/.copilot/mcp-config.json";

// Copilot CLI uses type-tagged JSON: {type: "local"|"http", ...}.
type CopilotStdio = {
  type: "local";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: string[];
  enabled?: boolean;
};
type CopilotHttp = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  tools?: string[];
  enabled?: boolean;
};
type CopilotEntry = CopilotStdio | CopilotHttp;
type CopilotShape = { mcpServers?: Record<string, CopilotEntry> } & Record<string, unknown>;

function targetPath(): string {
  const override = process.env.COPILOT_HOME;
  if (override) return resolveUnderHome(`${override}/mcp-config.json`, "COPILOT_HOME");
  return expandHome(DEFAULT_TARGET);
}

function fromCopilot(raw: CopilotShape["mcpServers"]): Record<string, McpServer> {
  if (!raw) return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "local" && typeof (entry as CopilotStdio).command === "string") {
      const e = entry as CopilotStdio;
      const server: Extract<McpServer, { command: string }> = { type: "stdio", command: e.command };
      if (e.args) server.args = e.args;
      if (e.env) server.env = e.env;
      out[name] = server;
    } else if (entry.type === "http" && typeof (entry as CopilotHttp).url === "string") {
      const e = entry as CopilotHttp;
      const server: Extract<McpServer, { url: string }> = { type: "http", url: e.url };
      if (e.headers) server.headers = e.headers;
      out[name] = server;
    }
  }
  return out;
}

function toCopilot(
  servers: Record<string, McpServer>,
  previous: CopilotShape["mcpServers"] = {},
): Record<string, CopilotEntry> {
  const out: Record<string, CopilotEntry> = {};
  for (const [name, s] of Object.entries(servers)) {
    if ("url" in s) {
      const prior = previous?.[name];
      const entry: CopilotHttp = {
        ...(prior?.type === "http" ? prior : {}),
        type: "http",
        url: s.url,
      };
      if (s.headers) entry.headers = s.headers;
      else delete entry.headers;
      out[name] = entry;
    } else {
      const prior = previous?.[name];
      const entry: CopilotStdio = {
        ...(prior?.type === "local" ? prior : {}),
        type: "local",
        command: s.command,
      };
      if (s.args) entry.args = s.args;
      else delete entry.args;
      if (s.env) entry.env = s.env;
      else delete entry.env;
      out[name] = entry;
    }
  }
  return out;
}

export const copilotAdapter: Adapter = {
  id: "github-copilot",
  targetPath,

  async read(): Promise<AdapterRead> {
    const path = targetPath();
    try {
      const data = await readJson<CopilotShape>(path);
      if (data === null) return { agent: "github-copilot", path, servers: {}, exists: false };
      return { agent: "github-copilot", path, servers: fromCopilot(data.mcpServers), exists: true };
    } catch (err) {
      return { agent: "github-copilot", path, servers: {}, exists: true, error: String(err) };
    }
  },

  async write(servers, { dryRun }): Promise<AdapterWriteResult> {
    const path = targetPath();
    let existing: CopilotShape;
    try {
      existing = (await readJson<CopilotShape>(path)) ?? {};
    } catch (err) {
      return { agent: "github-copilot", path, status: "failed", message: `cannot parse existing file: ${String(err)}` };
    }
    const next: CopilotShape = { ...existing, mcpServers: toCopilot(servers, existing.mcpServers) };
    if (JSON.stringify(existing) === JSON.stringify(next)) {
      return { agent: "github-copilot", path, status: "unchanged" };
    }
    if (dryRun) return { agent: "github-copilot", path, status: "synced", message: "dry-run" };
    try {
      await writeJson(path, next, { backup: true });
      return { agent: "github-copilot", path, status: "synced" };
    } catch (err) {
      return { agent: "github-copilot", path, status: "failed", message: String(err) };
    }
  },
};
