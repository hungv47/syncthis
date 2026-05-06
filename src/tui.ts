import { intro, outro, select, isCancel, cancel } from "@clack/prompts";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expandHome, readJson, writeText } from "./io.ts";
import { listAgentIds, runDirectional, runSync, runSkillsOnly } from "./sync.ts";
import { runDoctor } from "./doctor.ts";
import type { AgentId } from "./types.ts";

const MARKER_PATH = "~/.syncthis/seen.json";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

export async function showWelcomeIfFirstRun(): Promise<void> {
  const path = expandHome(MARKER_PATH);
  const seen = await readJson<{ version?: string }>(path);
  if (seen !== null) return;

  console.log("");
  console.log(`  ${"syncthis 0.2"} — keep your AI coding agents in sync`);
  console.log("");
  console.log(dim("  • MCP servers: synced across 11 agents (Claude, Cursor, Codex, Gemini,"));
  console.log(dim("    Kimi, OpenCode, OpenClaw, Hermes, Windsurf, Antigravity, Copilot)"));
  console.log(dim("  • Skills: delegated to `npx skills` (55 agents)"));
  console.log("");
  console.log(dim("  Run `syncthis` with no args to open the menu, or `syncthis help`."));
  console.log("");

  await mkdir(dirname(path), { recursive: true });
  await writeText(path, JSON.stringify({ version: "0.2.0", firstRunAt: new Date().toISOString() }, null, 2) + "\n");
}

type PickerChoice = "sync" | "mcp" | "skills" | "directional" | "doctor" | "quit";

export async function showInteractivePicker(): Promise<void> {
  intro("syncthis");

  const choice = (await select({
    message: "what do you want to do?",
    options: [
      { value: "sync", label: "sync everything (MCP + skills, all agents)" },
      { value: "mcp", label: "sync MCP only" },
      { value: "skills", label: "sync skills only" },
      { value: "directional", label: "mirror agent → agent" },
      { value: "doctor", label: "doctor (coverage + conflicts)" },
      { value: "quit", label: "quit" },
    ],
  })) as PickerChoice | symbol;

  if (isCancel(choice) || choice === "quit") {
    cancel("aborted.");
    return;
  }

  if (choice === "sync") {
    await runSync({});
    outro("done.");
    return;
  }

  if (choice === "mcp") {
    await runSync({ skipSkills: true });
    outro("done.");
    return;
  }

  if (choice === "skills") {
    await runSkillsOnly();
    outro("done.");
    return;
  }

  if (choice === "doctor") {
    await runDoctor();
    outro("done.");
    return;
  }

  if (choice === "directional") {
    const ids = listAgentIds();
    const fromRaw = await select({
      message: "from which agent?",
      options: ids.map((id) => ({ value: id, label: id })),
    });
    if (isCancel(fromRaw)) return cancel("aborted.");
    const from = fromRaw as AgentId;

    const toRaw = await select({
      message: "to which agent?",
      options: ids.filter((id) => id !== from).map((id) => ({ value: id, label: id })),
    });
    if (isCancel(toRaw)) return cancel("aborted.");
    const to = toRaw as AgentId;

    const preview = await runDirectional({ from, to, apply: false });
    console.log(`\n  diff: +${preview.diff.add.length}  ~${preview.diff.overwrite.length}  -${preview.diff.remove.length}`);

    const confirm = await select({
      message: "apply?",
      options: [
        { value: "no", label: "no" },
        { value: "yes", label: "yes — write to " + to },
      ],
    });
    if (isCancel(confirm) || confirm === "no") return cancel("aborted.");

    await runDirectional({ from, to, apply: true });
    outro("done.");
  }
}
