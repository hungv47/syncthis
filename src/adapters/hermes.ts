import yaml from "js-yaml";
import type { Adapter, AdapterRead, AdapterWriteResult, McpServer } from "../types.ts";
import { expandHome, readText, writeText } from "../io.ts";

const TARGET = "~/.hermes/config.yaml";

// Hermes stores config as YAML at top-level key `mcp_servers` (snake_case).
// js-yaml drops comments on write, matching upstream Hermes (PyYAML safe_dump) behavior.
// Round-trip drops `timeout` / `connect_timeout` — TODO: preserve in v0.3.
type HermesStdio = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  connect_timeout?: number;
};
type HermesHttp = {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  connect_timeout?: number;
};
type HermesEntry = HermesStdio | HermesHttp;
type HermesShape = { mcp_servers?: Record<string, HermesEntry> } & Record<string, unknown>;

function fromHermes(raw: HermesShape["mcp_servers"]): Record<string, McpServer> {
  if (!raw) return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if ("url" in entry && typeof entry.url === "string") {
      const server: Extract<McpServer, { url: string }> = { type: "http", url: entry.url };
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

function toHermes(servers: Record<string, McpServer>): Record<string, HermesEntry> {
  const out: Record<string, HermesEntry> = {};
  for (const [name, s] of Object.entries(servers)) {
    if ("url" in s) {
      const entry: HermesHttp = { url: s.url };
      if (s.headers) entry.headers = s.headers;
      out[name] = entry;
    } else {
      const entry: HermesStdio = { command: s.command };
      if (s.args) entry.args = s.args;
      if (s.env) entry.env = s.env;
      out[name] = entry;
    }
  }
  return out;
}

function parseYaml(text: string): HermesShape {
  if (!text.trim()) return {};
  const parsed = yaml.load(text);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as HermesShape;
}

export const hermesAdapter: Adapter = {
  id: "hermes-agent",
  targetPath: () => expandHome(TARGET),

  async read(): Promise<AdapterRead> {
    const path = expandHome(TARGET);
    const text = await readText(path);
    if (text === null) return { agent: "hermes-agent", path, servers: {}, exists: false };
    try {
      const parsed = parseYaml(text);
      return { agent: "hermes-agent", path, servers: fromHermes(parsed.mcp_servers), exists: true };
    } catch (err) {
      return { agent: "hermes-agent", path, servers: {}, exists: true, error: String(err) };
    }
  },

  async write(servers, { dryRun }): Promise<AdapterWriteResult> {
    const path = expandHome(TARGET);
    let existing: HermesShape;
    try {
      const currentText = (await readText(path)) ?? "";
      existing = parseYaml(currentText);
    } catch (err) {
      return { agent: "hermes-agent", path, status: "failed", message: `cannot parse existing file: ${String(err)}` };
    }
    const next: HermesShape = { ...existing, mcp_servers: toHermes(servers) };
    const nextText = yaml.dump(next, { lineWidth: -1, noRefs: true });
    const currentText = (await readText(path)) ?? "";
    if (currentText === nextText) return { agent: "hermes-agent", path, status: "unchanged" };
    if (dryRun) return { agent: "hermes-agent", path, status: "synced", message: "dry-run" };
    try {
      await writeText(path, nextText, { backup: true });
      return { agent: "hermes-agent", path, status: "synced" };
    } catch (err) {
      return { agent: "hermes-agent", path, status: "failed", message: String(err) };
    }
  },
};
