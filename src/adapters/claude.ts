import type { McpServer } from "../types.ts";
import { createJsonAdapter } from "./json-mcp.ts";

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

export const claudeAdapter = createJsonAdapter<ClaudeShape>({
  id: "claude-code",
  path: TARGET,
  readServers: mergeAllScopes,
  writeServers: (data, servers) => ({ ...data, mcpServers: servers }),
});
