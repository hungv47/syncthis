import type { Adapter } from "../types.ts";
import { claudeAdapter } from "./claude.ts";
import { cursorAdapter } from "./cursor.ts";
import { codexAdapter } from "./codex.ts";
import { geminiAdapter } from "./gemini.ts";

export const adapters: Adapter[] = [claudeAdapter, cursorAdapter, codexAdapter, geminiAdapter];
