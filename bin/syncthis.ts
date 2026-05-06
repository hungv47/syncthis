#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { AgentId, RowStatus } from "../src/types.ts";

const HELP = `syncthis — keep your AI tools in sync

  syncthis is a sync layer, not an installer. install MCP servers and skills
  with whatever tool you prefer (mcpm, claude mcp add, npx skills add, …),
  then run \`syncthis sync\` to mirror them across every coding agent.

usage:
  syncthis                         interactive picker (or HELP if non-TTY)
  syncthis sync [--dry-run] [--no-skills]
  syncthis run  [--dry-run] [--no-skills]    alias for sync (MCP + skills)
  syncthis mcp  [--dry-run]                  MCP only — skip skills update
  syncthis skills                            skills only — \`npx skills update -y\`
  syncthis <from> <to> [--yes] [--dry-run]   one-way mirror MCP from one agent to another
  syncthis doctor                            coverage + conflict report
  syncthis help

what sync does:
  1. reads MCP servers from all 11 supported agents.
     for Claude, merges top-level + every per-project mcpServers scope.
  2. computes the union (servers in any agent → propagated to every agent).
  3. for any name with conflicting configs across agents, leaves each agent's
     own version untouched and reports the conflict — you resolve manually.
  4. runs \`npx skills update -y\` to refresh skills (delegated to vercel-labs/skills,
     which supports 55 agents).

agents supported (use these IDs with the directional command):
  claude-code, cursor, codex, gemini-cli, kimi-cli, antigravity,
  github-copilot, windsurf, opencode, openclaw, hermes-agent

flags:
  --dry-run    report what would change without writing.
  --no-skills  skip the skill update phase (sync/run only).
  --yes        skip confirmation prompt (directional sync only).

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
  yes: { type: "boolean", short: "y" },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

async function cmdSync(argv: string[]) {
  const { runSync } = await import("../src/sync.ts");
  const { values } = parse(argv);
  printSync(await runSync({ dryRun: !!values["dry-run"], skipSkills: !!values["no-skills"] }));
}

async function cmdMcp(argv: string[]) {
  const { runSync } = await import("../src/sync.ts");
  const { values } = parse(argv);
  printSync(await runSync({ dryRun: !!values["dry-run"], skipSkills: true }));
}

async function cmdSkillsOnly() {
  const { runSkillsOnly } = await import("../src/sync.ts");
  const r = await runSkillsOnly();
  if (r.ok) row("synced", "skills", "", "npx skills update -y");
  else {
    row("drift", "skills", "", r.message ?? "failed");
    process.exit(1);
  }
}

async function cmdDoctor() {
  const { runDoctor } = await import("../src/doctor.ts");
  printDoctor(await runDoctor());
}

async function cmdDirectional(from: string, to: string, argv: string[]) {
  const { runDirectional, listAgentIds } = await import("../src/sync.ts");
  const { values } = parse(argv);
  const ids = listAgentIds();
  if (!ids.includes(from as AgentId)) {
    console.error(red(`unknown agent: ${from}`));
    console.error(dim(`known agents: ${ids.join(", ")}`));
    process.exit(2);
  }
  if (!ids.includes(to as AgentId)) {
    console.error(red(`unknown agent: ${to}`));
    console.error(dim(`known agents: ${ids.join(", ")}`));
    process.exit(2);
  }
  if (from === to) {
    console.error(red(`from and to must differ`));
    process.exit(2);
  }

  const dryRun = !!values["dry-run"];
  const yes = !!values.yes;

  // First read + diff without applying.
  const preview = await runDirectional({ from: from as AgentId, to: to as AgentId, apply: false });

  // Bail before showing a diff if either side failed to parse — otherwise an unreadable
  // source would render as "remove all servers from destination" and the user could approve
  // wiping the destination without realizing the source was broken.
  if (preview.fromRead.error) {
    console.error(red(`cannot read source ${preview.from}: ${preview.fromRead.error}`));
    process.exit(2);
  }
  if (preview.toRead.error) {
    console.error(red(`cannot read destination ${preview.to}: ${preview.toRead.error}`));
    process.exit(2);
  }

  printDirectionalDiff(preview);

  if (preview.diff.add.length === 0 && preview.diff.overwrite.length === 0 && preview.diff.remove.length === 0) {
    console.log(dim("nothing to do."));
    return;
  }

  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }

  if (!yes && process.stdin.isTTY) {
    process.stdout.write("\nContinue? [y/N] ");
    const answer = await readLine();
    if (answer.trim().toLowerCase() !== "y") {
      console.log(dim("aborted."));
      return;
    }
  } else if (!yes && !process.stdin.isTTY) {
    console.error(red("refusing destructive write without --yes in non-interactive mode."));
    process.exit(2);
  }

  const applied = await runDirectional({ from: from as AgentId, to: to as AgentId, apply: true });
  if (applied.write) {
    if (applied.write.status === "failed") {
      row("failed", to, applied.write.path, applied.write.message);
      process.exit(1);
    }
    row(applied.write.status, to, applied.write.path, applied.write.message);
  }
}

function printDirectionalDiff(r: import("../src/sync.ts").DirectionalReport) {
  console.log(`Mirror MCP servers from ${green(r.from)} → ${green(r.to)}:`);
  if (r.diff.add.length) console.log(`  ${green("+")} add ${r.diff.add.length}:        ${r.diff.add.join(", ")}`);
  if (r.diff.overwrite.length) console.log(`  ${yellow("~")} overwrite ${r.diff.overwrite.length}:  ${r.diff.overwrite.join(", ")}`);
  if (r.diff.remove.length) console.log(`  ${red("-")} remove ${r.diff.remove.length}:     ${r.diff.remove.join(", ")}`);
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl));
      }
    };
    process.stdin.on("data", onData);
  });
}

function row(status: RowStatus, label: string, path: string, message?: string) {
  const detail = path ? dim(path) + (message ? dim(` (${message})`) : "") : message ? dim(message) : "";
  console.log(`  ${GLYPHS[status]} ${label.padEnd(14)} ${detail}`);
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
  const { showWelcomeIfFirstRun, showInteractivePicker } = await import("../src/tui.ts");
  await showWelcomeIfFirstRun();

  const [, , cmd, ...rest] = process.argv;

  // No command: open the picker (or HELP if non-TTY).
  if (!cmd) {
    if (process.stdin.isTTY && process.stdout.isTTY) return showInteractivePicker();
    return console.log(HELP);
  }

  if (cmd === "help" || cmd === "-h" || cmd === "--help") return console.log(HELP);
  if (cmd === "sync") return cmdSync(rest);
  if (cmd === "run") return cmdSync(rest);
  if (cmd === "mcp") return cmdMcp(rest);
  if (cmd === "skills") return cmdSkillsOnly();
  if (cmd === "doctor") return cmdDoctor();

  // Directional: two positional agent IDs.
  if (rest.length >= 1 && !cmd.startsWith("-")) {
    const second = rest[0];
    if (second && !second.startsWith("-")) {
      return cmdDirectional(cmd, second, rest.slice(1));
    }
  }

  console.error(red(`unknown command: ${cmd}`));
  console.error(HELP);
  process.exit(2);
}

main().catch((err) => {
  console.error(red(`syncthis: ${err?.message ?? err}`));
  process.exit(1);
});
