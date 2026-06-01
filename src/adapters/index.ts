import type { Adapter } from "../types.ts";
import { claudeAdapter } from "./claude.ts";
import { cursorAdapter } from "./cursor.ts";
import { codexAdapter } from "./codex.ts";
import { geminiAdapter } from "./gemini.ts";
import { kimiAdapter } from "./kimi.ts";
import { antigravityAdapter } from "./antigravity.ts";
import { copilotAdapter } from "./copilot.ts";
import { windsurfAdapter } from "./windsurf.ts";
import { opencodeAdapter } from "./opencode.ts";
import { openclawAdapter } from "./openclaw.ts";
import { hermesAdapter } from "./hermes.ts";
import { gooseAdapter } from "./goose.ts";

export const adapters: Adapter[] = [
  claudeAdapter,
  cursorAdapter,
  codexAdapter,
  geminiAdapter,
  kimiAdapter,
  antigravityAdapter,
  copilotAdapter,
  windsurfAdapter,
  opencodeAdapter,
  openclawAdapter,
  hermesAdapter,
  gooseAdapter,
];
