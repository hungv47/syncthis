import { claudePluginAdapter } from "./claude.ts";
import { codexPluginAdapter } from "./codex.ts";
import type { PluginAdapter, PluginAdapterRead } from "./types.ts";

// Plugin cohort: only agents that expose a native bundle-plugin install CLI can
// participate in mirror. Claude (`claude plugin install`) and Codex (`codex
// plugin add`). Cursor has no install CLI; OpenCode plugins are npm modules in a
// different cohort — neither can be a mirror target, so they're out of scope.
export const pluginAdapters: PluginAdapter[] = [claudePluginAdapter, codexPluginAdapter];

export async function listPlugins(): Promise<PluginAdapterRead[]> {
  return Promise.all(pluginAdapters.map((a) => a.read()));
}
