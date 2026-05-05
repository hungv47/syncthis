import type { Adapter, AdapterRead, AdapterWriteResult, AgentId, McpServer } from "../types.ts";
import { expandHome, readJson, writeJson } from "../io.ts";

type SettingsShape = { mcpServers?: Record<string, McpServer> } & Record<string, unknown>;

export function createJsonMcpAdapter(opts: { id: AgentId; path: string }): Adapter {
  const targetPath = () => expandHome(opts.path);

  return {
    id: opts.id,
    targetPath,
    async read(): Promise<AdapterRead> {
      const path = targetPath();
      try {
        const data = await readJson<SettingsShape>(path);
        if (data === null) {
          return { agent: opts.id, path, servers: {}, exists: false };
        }
        return { agent: opts.id, path, servers: data.mcpServers ?? {}, exists: true };
      } catch (err) {
        return { agent: opts.id, path, servers: {}, exists: true, error: String(err) };
      }
    },
    async write(servers, { dryRun }): Promise<AdapterWriteResult> {
      const path = targetPath();
      let existing: SettingsShape;
      try {
        existing = (await readJson<SettingsShape>(path)) ?? {};
      } catch (err) {
        return { agent: opts.id, path, status: "failed", message: `cannot parse existing file: ${String(err)}` };
      }
      const next: SettingsShape = { ...existing, mcpServers: servers };
      if (JSON.stringify(existing) === JSON.stringify(next)) {
        return { agent: opts.id, path, status: "unchanged" };
      }
      if (dryRun) {
        return { agent: opts.id, path, status: "synced", message: "dry-run" };
      }
      try {
        await writeJson(path, next, { backup: true });
        return { agent: opts.id, path, status: "synced" };
      } catch (err) {
        return { agent: opts.id, path, status: "failed", message: String(err) };
      }
    },
  };
}
