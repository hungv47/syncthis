import { claudePluginAdapter } from "./claude.ts";
import { codexPluginAdapter } from "./codex.ts";
import { cursorPluginAdapter } from "./cursor.ts";
import { opencodePluginAdapter } from "./opencode.ts";
import type { PluginAdapter } from "./types.ts";

export const pluginAdapters: PluginAdapter[] = [
  claudePluginAdapter,
  codexPluginAdapter,
  cursorPluginAdapter,
  opencodePluginAdapter,
];
