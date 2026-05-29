import { claudePluginAdapter } from "./claude.ts";
import { codexPluginAdapter } from "./codex.ts";
import type { PluginAdapter, PluginAdapterRead } from "./types.ts";

// Plugin adapters: agents with a native bundle-plugin CLI that can be both read
// (plugin list) and written (install/remove) — Claude (`claude plugin install`)
// and Codex (`codex plugin add`). Cursor is also a plugin target but write-only
// (no list CLI), so it's handled separately in the mirror via `npx plugins add
// --target cursor` rather than as an adapter here. OpenCode plugins are npm
// modules in a different cohort entirely — out of scope.
export const pluginAdapters: PluginAdapter[] = [claudePluginAdapter, codexPluginAdapter];

export async function listPlugins(): Promise<PluginAdapterRead[]> {
  return Promise.all(pluginAdapters.map((a) => a.read()));
}
