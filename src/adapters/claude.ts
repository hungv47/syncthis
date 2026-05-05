import { createJsonMcpAdapter } from "./json-mcp.ts";

export const claudeAdapter = createJsonMcpAdapter({
  id: "claude-code",
  path: "~/.claude.json",
});
