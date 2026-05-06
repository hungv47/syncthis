import type { Adapter, AdapterRead, AdapterWriteResult, McpServer } from "../types.ts";
import { expandHome, readJson, writeJson } from "../io.ts";

const TARGET = "~/.claude.json";

type ClaudeProject = { mcpServers?: Record<string, McpServer> } & Record<string, unknown>;
type ClaudeShape = {
  mcpServers?: Record<string, McpServer>;
  projects?: Record<string, ClaudeProject>;
} & Record<string, unknown>;

// Claude Code stores MCP servers in two places:
//   - top-level `mcpServers` (user scope)
//   - `projects.<absolute_path>.mcpServers` (local/project scope, the default for `claude mcp add`)
// Read merges every scope so syncthis sees them all. Top-level wins on name collisions; project
// scopes only fill in names not already present. Writes go to top-level only — project scopes
// are left untouched so Claude's per-project behavior is preserved.
function mergeAllScopes(data: ClaudeShape): Record<string, McpServer> {
  const merged: Record<string, McpServer> = { ...(data.mcpServers ?? {}) };
  if (data.projects && typeof data.projects === "object") {
    for (const project of Object.values(data.projects)) {
      if (!project || typeof project !== "object") continue;
      const projServers = project.mcpServers;
      if (!projServers || typeof projServers !== "object") continue;
      for (const [name, server] of Object.entries(projServers)) {
        if (!(name in merged)) {
          merged[name] = server;
          continue;
        }
        // Same name in another scope with a different config — warn so the user knows
        // a project-scoped variant is being shadowed by the broader scope's version.
        if (JSON.stringify(merged[name]) !== JSON.stringify(server)) {
          console.warn(
            `syncthis: claude has divergent '${name}' across scopes; using broader-scope version`,
          );
        }
      }
    }
  }
  return merged;
}

export const claudeAdapter: Adapter = {
  id: "claude-code",
  targetPath: () => expandHome(TARGET),

  async read(): Promise<AdapterRead> {
    const path = expandHome(TARGET);
    try {
      const data = await readJson<ClaudeShape>(path);
      if (data === null) return { agent: "claude-code", path, servers: {}, exists: false };
      return { agent: "claude-code", path, servers: mergeAllScopes(data), exists: true };
    } catch (err) {
      return { agent: "claude-code", path, servers: {}, exists: true, error: String(err) };
    }
  },

  async write(servers, { dryRun }): Promise<AdapterWriteResult> {
    const path = expandHome(TARGET);
    let existing: ClaudeShape;
    try {
      existing = (await readJson<ClaudeShape>(path)) ?? {};
    } catch (err) {
      return { agent: "claude-code", path, status: "failed", message: `cannot parse existing file: ${String(err)}` };
    }
    const next: ClaudeShape = { ...existing, mcpServers: servers };
    if (JSON.stringify(existing) === JSON.stringify(next)) {
      return { agent: "claude-code", path, status: "unchanged" };
    }
    if (dryRun) {
      return { agent: "claude-code", path, status: "synced", message: "dry-run" };
    }
    try {
      await writeJson(path, next, { backup: true });
      return { agent: "claude-code", path, status: "synced" };
    } catch (err) {
      return { agent: "claude-code", path, status: "failed", message: String(err) };
    }
  },
};
