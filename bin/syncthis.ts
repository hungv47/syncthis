#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { RowStatus } from "../src/types.ts";

const HELP = `syncthis — keep your AI tools in sync

  syncthis is a sync layer, not an installer. install MCP servers and skills
  with whatever tool you prefer (mcpm, claude mcp add, npx skills add, …),
  then run \`syncthis sync\` to mirror them to every coding agent.

usage:
  syncthis sync [--dry-run] [--no-skills]
  syncthis doctor
  syncthis help

what sync does:
  1. reads MCP servers from Claude Code, Cursor, Codex, and Gemini CLI.
  2. computes the union (servers in any agent → propagated to every agent).
  3. for any name with conflicting configs across agents, leaves each agent's
     own version untouched and reports the conflict — you resolve manually.
  4. propagates skills between Claude and Cursor (the gap \`npx skills update\`
     doesn't fill — for skills you authored without using a registry).
  5. runs \`npx skills update -y\` to refresh registry-installed skills.

flags:
  --dry-run    report what would change without writing.
  --no-skills  skip the skill update + propagation phase.

removing a server: install/remove with your installer, then sync. if a server
remains in any agent, sync re-propagates it. to remove from all agents at once,
use your installer's "remove from all" mode.
`;

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => c("32", s);
const red = (s: string) => c("31", s);
const yellow = (s: string) => c("33", s);
const dim = (s: string) => c("2", s);

const GLYPHS: Record<RowStatus, string> = {
  ok: green("✓"),
  synced: green("✓"),
  unchanged: green("="),
  skipped: dim("·"),
  drift: yellow("~"),
  missing: yellow("?"),
  invalid: red("✗"),
  failed: red("✗"),
};

const OPTIONS = {
  "no-skills": { type: "boolean" },
  "dry-run": { type: "boolean" },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

async function cmdSync(argv: string[]) {
  const { runSync } = await import("../src/sync.ts");
  const { values } = parse(argv);
  printSync(await runSync({ dryRun: !!values["dry-run"], skipSkills: !!values["no-skills"] }));
}

async function cmdDoctor() {
  const { runDoctor } = await import("../src/doctor.ts");
  printDoctor(await runDoctor());
}

function row(status: RowStatus, label: string, path: string, message?: string) {
  const detail = path ? dim(path) + (message ? dim(` (${message})`) : "") : message ? dim(message) : "";
  console.log(`  ${GLYPHS[status]} ${label.padEnd(12)} ${detail}`);
}

function printSync(r: import("../src/sync.ts").SyncReport) {
  const totalNames = new Set<string>();
  for (const read of r.reads) for (const n of Object.keys(read.servers)) totalNames.add(n);
  const safeCount = Object.keys(r.union).length;
  console.log(
    dim(
      `read ${totalNames.size} server name(s) across ${r.reads.length} agent(s); ${safeCount} synced, ${r.conflicts.length} conflict(s)`,
    ),
  );

  for (const w of r.writes) row(w.status, w.agent, w.path, w.message);

  if (r.conflicts.length) {
    console.log(yellow(`\n${r.conflicts.length} conflict(s) — left each agent's own copy untouched:`));
    for (const c of r.conflicts) {
      console.log(`  ${yellow("~")} ${c.name}`);
      for (const v of c.versions) console.log(`      ${dim(`in ${v.agent}`)}`);
    }
    console.log(dim(`  resolve by deleting the version you don't want, then re-run sync.`));
  }

  if (r.skills) {
    if (!r.skills.ran) row("skipped", "skills", "", r.skills.message);
    else if (r.skills.ok) row("synced", "skills", "", "npx skills update -y");
    else row("drift", "skills", "", r.skills.message ?? "failed");
  }

  if (r.skillPropagation) {
    const sp = r.skillPropagation;
    if (sp.created.length === 0) row("skipped", "skill-prop", "", "nothing to propagate");
    else {
      row("synced", "skill-prop", "", `${sp.created.length} mirrored`);
      for (const x of sp.created) console.log(`      ${dim("→")} ${x.name} ${dim(`(${x.from} → ${x.to})`)}`);
    }
    for (const w of sp.diverged) {
      row("drift", "skill-prop", "", `${w.name} differs in both agents — left alone`);
    }
  }

  const failed = r.writes.filter((w) => w.status === "failed");
  if (failed.length) {
    console.log(red(`\n${failed.length} adapter(s) failed.`));
    process.exit(1);
  }
}

function printDoctor(r: import("../src/doctor.ts").DoctorReport) {
  for (const read of r.reads) {
    if (read.error) row("invalid", read.agent, read.path, read.error);
    else if (!read.exists) row("missing", read.agent, read.path, "file does not exist");
    else row("ok", read.agent, read.path, `${Object.keys(read.servers).length} server(s)`);
  }

  if (r.coverage.length === 0) {
    console.log(dim("\nno servers configured in any agent."));
    return;
  }

  console.log(dim(`\ncoverage:`));
  for (const c of r.coverage) {
    const tag = c.missing.length === 0 ? green("[full]") : yellow(`[${c.present.length}/${r.reads.length}]`);
    const detail = c.missing.length === 0 ? "" : dim(` — missing in ${c.missing.join(", ")}`);
    console.log(`  ${tag} ${c.name}${detail}`);
  }

  if (r.conflicts.length) {
    console.log(yellow(`\n${r.conflicts.length} conflict(s):`));
    for (const c of r.conflicts) {
      console.log(`  ${yellow("~")} ${c.name} — different config in ${c.versions.map((v) => v.agent).join(", ")}`);
    }
    process.exit(1);
  }
}

async function main() {
  const [, , cmd = "help", ...rest] = process.argv;
  if (cmd === "help" || cmd === "-h" || cmd === "--help") return console.log(HELP);
  if (cmd === "sync") return cmdSync(rest);
  if (cmd === "doctor") return cmdDoctor();
  console.error(red(`unknown command: ${cmd}`));
  console.error(HELP);
  process.exit(2);
}

main().catch((err) => {
  console.error(red(`syncthis: ${err?.message ?? err}`));
  process.exit(1);
});
