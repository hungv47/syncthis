#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { AgentId, RowStatus } from "../src/types.ts";

const HELP = `syncthis — keep your AI tools in sync

  syncthis is a sync layer, not an installer. install MCP servers, plugins, and
  skills with whatever tool you prefer (mcpm, claude mcp add, claude plugin
  install, npx plugins add, npx skills add, …), then run \`syncthis sync\` to
  mirror them across every coding agent.

  it does three things:
    • MCP servers — union sync across all 12 agents (the unique core)
    • plugins     — mirror one agent's plugins onto the other plugin agents
                    (Claude ↔ Codex natively; Cursor via \`npx plugins\`)
    • skills      — \`npx skills update -y\`, plus surfacing plugin-bundled skills
                    to the non-plugin agents (vercel-labs/skills)

usage:
  syncthis                         interactive picker (or HELP if non-TTY)
  syncthis sync [--dry-run] [--no-skills]
  syncthis run  [--dry-run] [--no-skills]    alias for sync
  syncthis mcp  [--dry-run]                  MCP only — skip skills update
  syncthis skills                            skills only — \`npx skills update -y\`
  syncthis skills from-plugins [--dry-run]   add skills bundled in Claude plugins to the 8
                                             non-plugin agents (opencode, gemini-cli, windsurf, …)
  syncthis <from> <to> [--yes] [--dry-run]   one-way mirror MCP from one agent to another
  syncthis from <agent> --all [--yes] [--dry-run]
                                             one-way mirror MCP from one agent to every other agent
  syncthis rm <server> --all [--yes] [--dry-run]
                                             remove one MCP server from every supported agent

  selective add / remove (pick items + agents):
  syncthis add skill  <repo…>   --agents <a,b,c> | --all [--dry-run]
  syncthis add plugin <name…>   --agents <a,b,c> | --all [--dry-run]
                                             (plugin must be installed on claude-code, the source)
  syncthis rm  skill  <name…>   --agents <a,b,c> | --all [--yes] [--dry-run]
  syncthis rm  mcp    <server…> --agents <a,b,c> | --all [--yes] [--dry-run]
  syncthis rm  plugin <name…>   --agents <a,b,c> | --all [--yes] [--dry-run]
                                             (no "add mcp" — syncthis mirrors MCP servers, it
                                             doesn't install them; to remove a server literally
                                             named mcp/skill/plugin use the explicit noun, e.g.
                                             "rm mcp mcp --all")
  syncthis doctor                            MCP coverage + conflict report
  syncthis mirror <primary> [--no-provision] [--yes] [--dry-run]
                                             additive: make <primary>'s plugin content reachable on
                                             every other agent. Codex gets native plugins (missing
                                             marketplaces are registered automatically); Cursor is
                                             pushed via \`npx plugins --target cursor\`; the non-plugin
                                             agents get the bundled skills via \`npx skills add\` AND the
                                             bundled MCP servers lifted into their MCP config (additive,
                                             conflicts left untouched). Anything Codex can't load as a
                                             plugin falls back to skills. Never uninstalls.
                                             --no-provision skips network registration.
  syncthis plugin list                       overview of plugins across every agent (read-only)
  syncthis plugin rm <plugin…> [--all | --agents <a,b,c>] [--yes] [--dry-run] [--keep-data]
                                             uninstall plugin(s): the native plugin from
                                             claude-code/codex AND the surfaced skills from the
                                             non-plugin agents (npx skills remove). Guarded:
                                             explicit scope, diff, confirm/--yes, --dry-run.
  syncthis help

what sync does:
  1. reads MCP servers from all 12 supported agents.
     for Claude, merges top-level + every per-project mcpServers scope.
  2. computes the union (servers in any agent → propagated to every agent).
  3. for any name with conflicting configs across agents, leaves each agent's
     own version untouched and reports the conflict — you resolve manually.
  4. surfaces skills bundled inside your Claude plugins to the non-plugin agents
     (\`npx skills add\`), since those agents can't read plugins, then runs
     \`npx skills update -y\` to refresh everything (delegated to vercel-labs/skills).

agents supported for MCP sync (use these IDs with the directional command):
  claude-code, cursor, codex, gemini-cli, kimi-cli, antigravity,
  github-copilot, windsurf, opencode, openclaw, hermes-agent, goose
  plugin cohort (get the full bundle): claude-code, codex (native CLI), cursor
  (write-only via npx plugins). the other non-plugin agents get the skill subset via npx skills.
  skills also reach \`pi\` (no native MCP, so skills-only — not an MCP-sync target).

flags:
  --dry-run       report what would change without writing.
  --no-skills     skip the skill update phase (sync/run only).
  --all           required for fan-out, remove-all, and plugin-rm scope.
  --agents <list> (plugin rm) comma-separated agents to uninstall from.
  --keep-data     (plugin rm) keep claude's plugin data dir on uninstall.
  --yes           skip confirmation prompt for destructive commands.
  --no-provision  (mirror) don't register missing Codex marketplaces or fall
                  unloadable bundles back to skills — Codex installs only what it
                  can already resolve. (The Cursor + non-plugin-agent skills pushes
                  still run.) By default mirror provisions (shells out, hits the
                  network) so a plugin's content actually reaches Codex.

removing a server: use \`syncthis rm <server> --all --dry-run\`, review the diff,
then rerun with \`--yes\`. plain union sync will re-propagate a server if it
still exists in any agent.
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
  all: { type: "boolean" },
  "no-provision": { type: "boolean" },
  // `plugin rm` scope + behavior.
  agents: { type: "string" },
  "keep-data": { type: "boolean" },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

function pluginSkillProgress(repo: string, i: number, total: number) {
  process.stderr.write(dim(`  → [${i}/${total}] npx skills add ${repo}\n`));
}

async function cmdSync(argv: string[]) {
  const { runSync } = await import("../src/sync.ts");
  const { values } = parse(argv);
  const dryRun = !!values["dry-run"];
  printSync(await runSync({ dryRun, skipSkills: !!values["no-skills"], onPluginSkillProgress: pluginSkillProgress }));
}

async function cmdMcp(argv: string[]) {
  const { runSync } = await import("../src/sync.ts");
  const { values } = parse(argv);
  printSync(await runSync({ dryRun: !!values["dry-run"], skipSkills: true }));
}

async function cmdSkills(argv: string[]) {
  const sub = argv[0];
  if (sub === "from-plugins") return cmdSkillsFromPlugins(argv.slice(1));
  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(
      "syncthis skills              — npx skills update -y (refresh every installed skill)\n" +
        "syncthis skills from-plugins — add skills bundled in Claude plugins to the non-plugin agents\n" +
        "                               (gemini-cli, kimi-cli, antigravity, github-copilot, windsurf,\n" +
        "                                opencode, openclaw, hermes-agent, goose, pi). [--dry-run]",
    );
    return;
  }
  if (sub && !sub.startsWith("-")) {
    console.error(red(`unknown skills subcommand: ${sub}. use \`skills\` or \`skills from-plugins\`.`));
    process.exit(2);
  }
  return cmdSkillsOnly();
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

async function cmdSkillsFromPlugins(argv: string[]) {
  const { addSkillsFromPlugins } = await import("../src/skills.ts");
  const { values } = parse(argv);
  const dryRun = !!values["dry-run"];
  const report = await addSkillsFromPlugins({ dryRun, onProgress: pluginSkillProgress });
  printPluginSkills(report, dryRun);
  if (report.results.some((r) => r.status === "failed")) process.exit(1);
}

function printPluginSkills(r: import("../src/skills.ts").PluginSkillsReport, dryRun: boolean) {
  if (!r.ran) {
    row("skipped", "plugin-skills", "", r.message);
    return;
  }
  let added = 0;
  let skipped = 0;
  let failed = 0;
  for (const res of r.results) {
    if (res.status === "added") added += 1;
    else if (res.status === "skipped") skipped += 1;
    else failed += 1;
  }
  const verb = dryRun ? "would add" : "added";
  const detail = `${verb} ${added}${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${failed} failed` : ""}`;
  row(failed ? "drift" : "synced", "plugin-skills", `${r.sources.length} repo(s) → ${r.agents.length} agent(s)`, detail);
  for (const res of r.results) {
    if (res.status === "failed") console.log(`      ${red("✗")} ${res.repo} ${dim(res.message ?? "")}`);
  }
}

async function cmdDoctor() {
  const { runDoctor } = await import("../src/doctor.ts");
  printDoctor(await runDoctor());
}

async function cmdMirror(argv: string[]) {
  const { runMirror, mirrorHasChanges } = await import("../src/plugins/mirror.ts");
  const { pluginAdapters } = await import("../src/plugins/index.ts");
  const { values, positionals } = parse(argv);
  const from = positionals[0];
  // Validate against the plugin cohort (claude-code, codex), not the 11 MCP-sync
  // agents — a non-plugin primary would otherwise throw from runMirror.
  const pluginIds = pluginAdapters.map((a) => a.id);
  if (!from || !pluginIds.includes(from as AgentId)) {
    console.error(red(`mirror: pass a plugin-capable primary agent. known: ${pluginIds.join(", ")}`));
    process.exit(2);
  }
  const dryRun = !!values["dry-run"];
  const provision = !values["no-provision"];

  const preview = await runMirror({ from: from as AgentId, apply: false, provision });
  printMirrorPreview(preview);
  if (!mirrorHasChanges(preview)) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  if (provision) {
    console.log(
      dim(
        "provisioning on: missing marketplaces are registered via `npx plugins add`, and bundles a target can't load as plugins are added as skills via `npx skills add` (network). Pass --no-provision to skip.",
      ),
    );
  }
  await confirmDestructive(!!values.yes);
  // A full mirror is many sequential npx/codex network calls — stream per-item
  // progress to stderr so it doesn't look frozen.
  const onProgress = (label: string, i: number, total: number) =>
    process.stderr.write(dim(`  → [${i}/${total}] ${label}\n`));
  const applied = await runMirror({ from: from as AgentId, apply: true, provision, onProgress });
  printMirrorApplied(applied, provision);
}

function printMirrorPreview(r: import("../src/plugins/mirror.ts").MirrorReport) {
  console.log(`Mirror plugins from ${green(r.from)} → every other agent (additive):`);
  for (const t of r.targets) {
    // No diff → target config was unreadable. Show the reason only.
    if (!t.diff) {
      if (t.unsupportedReason) console.log(`  ${dim("·")} ${t.to.padEnd(14)} ${dim(t.unsupportedReason)}`);
      continue;
    }
    const summary = t.diff.add.length ? `${green("+")}${t.diff.add.length}` : dim("unchanged");
    console.log(`  ${green("→")} ${t.to.padEnd(14)} ${summary}`);
    for (const p of t.diff.add) console.log(`      ${green("+")} ${p.marketplace ? `${p.name}@${p.marketplace}` : p.name}`);
  }
  printCursorPush(r.cursor);
  printSkillCohortPreview(r.skillCohort);
  printMcpCohortPreview(r.mcpCohort);
}

function printMcpCohortPreview(m: import("../src/plugins/mirror.ts").MirrorMcpCohort) {
  const label = "mcp→agents";
  if (!m.supported) {
    console.log(`  ${dim("·")} ${label.padEnd(14)} ${dim(m.reason ?? "unsupported")}`);
    return;
  }
  if (m.servers.length === 0) {
    const why = m.skipped.length
      ? `no portable MCP servers (${m.skipped.length} skipped)`
      : "no plugin-bundled MCP servers to surface";
    console.log(`  ${dim("·")} ${label.padEnd(14)} ${dim(why)}`);
    return;
  }
  console.log(
    `  ${green("→")} ${label.padEnd(14)} ${green("+")}${m.servers.length} ${dim(`server(s) → ${m.agents.length} non-plugin agents (lifted from plugins; additive, conflicts left untouched)`)}`,
  );
  for (const s of m.servers) console.log(`      ${green("+")} ${s.name} ${dim(`(from ${s.plugin})`)}`);
  for (const sk of m.skipped) console.log(`      ${dim("·")} ${dim(`${sk.name} skipped — ${sk.reason}`)}`);
}

function printSkillCohortPreview(s: import("../src/plugins/mirror.ts").MirrorSkillCohort) {
  const label = "skills→agents";
  if (!s.supported) {
    console.log(`  ${dim("·")} ${label.padEnd(14)} ${dim(s.reason ?? "unsupported")}`);
    return;
  }
  const n = s.report?.sources.length ?? 0;
  if (n === 0) {
    console.log(`  ${dim("·")} ${label.padEnd(14)} ${dim("no skill-bearing plugins to surface")}`);
    return;
  }
  console.log(
    `  ${green("→")} ${label.padEnd(14)} ${green("+")}${n} ${dim(`repo(s) → ${s.agents.length} non-plugin agents (npx skills; additive, already-synced skipped)`)}`,
  );
}

function printCursorPush(c: import("../src/plugins/mirror.ts").CursorPush) {
  if (!c.supported) {
    console.log(`  ${dim("·")} ${"cursor".padEnd(14)} ${dim(c.reason ?? "unsupported")}`);
    return;
  }
  if (c.repos.length === 0) {
    console.log(`  ${dim("·")} ${"cursor".padEnd(14)} ${dim("no github-backed plugins to push")}`);
    return;
  }
  // Cursor state isn't readable, so this is an additive push of every repo.
  console.log(`  ${green("→")} ${"cursor".padEnd(14)} ${green("+")}${c.repos.length} ${dim("(via npx plugins; additive — cursor state not readable)")}`);
  for (const repo of c.repos) console.log(`      ${green("+")} ${repo}`);
}

function printMirrorApplied(r: import("../src/plugins/mirror.ts").MirrorReport, provision: boolean) {
  let installed = 0;
  let covered = 0;
  let skipped = 0;
  let failed = 0;
  // True only when a plugin install was skipped for lack of a resolvable
  // marketplace (the one cause the --no-provision tip actually addresses) — not
  // for a no-skills fallback or an unsupported cohort, which provisioning won't fix.
  let sawUnresolvedSkip = false;
  for (const t of r.targets) {
    for (const ins of t.installs ?? []) {
      if (ins.status === "failed") {
        failed += 1;
        row("failed", t.to, ins.target, ins.message);
      } else if (ins.status === "skipped") {
        // A bundle that fell back to `npx skills add` is reported by the
        // skills-fallback row below — don't also print it as a bare skip.
        if (ins.skillsFallbackRepo) continue;
        if (ins.coveredBy) {
          // Content is on the target as a plugin already (canonical name / sibling
          // alias). Not a miss — surface it, but it didn't need its own install.
          covered += 1;
          row("synced", t.to, ins.target, ins.message ?? `covered by ${ins.coveredBy}`);
        } else {
          // Genuinely not mirror-able to this target (e.g. --no-provision and no
          // resolvable marketplace, or ambiguous) — not an error.
          skipped += 1;
          sawUnresolvedSkip = true;
          row("skipped", t.to, ins.target, ins.message);
        }
      } else if (ins.status === "installed") {
        installed += 1;
        row("synced", t.to, ins.target, "installed");
      }
    }
    for (const sf of t.skillsFallback ?? []) {
      if (sf.status === "failed") {
        failed += 1;
        row("failed", t.to, sf.repo, `skills fallback: ${sf.message ?? "failed"}`);
      } else if (sf.status === "added") {
        installed += 1;
        row("synced", t.to, sf.repo, "added as skills (npx skills — not loadable as a plugin here)");
      } else {
        // "skipped" — the bundle had no skills after all. Nothing to add; say why.
        skipped += 1;
        row("skipped", t.to, sf.repo, sf.message ?? "no skills in bundle");
      }
    }
  }
  if (r.cursor.supported) {
    for (const res of r.cursor.results) {
      if (res.status === "failed") {
        failed += 1;
        row("failed", "cursor", res.repo, res.message);
      } else {
        installed += 1;
        row("synced", "cursor", res.repo, "installed (npx plugins)");
      }
    }
  } else if (r.cursor.reason) {
    skipped += 1;
    row("skipped", "cursor", "", r.cursor.reason);
  }
  // Skill-cohort push (the non-plugin agents).
  if (!r.skillCohort.supported) {
    if (r.skillCohort.reason) {
      skipped += 1;
      row("skipped", "skills→agents", "", r.skillCohort.reason);
    }
  } else {
    for (const res of r.skillCohort.report?.results ?? []) {
      if (res.status === "failed") {
        failed += 1;
        row("failed", "skills→agents", res.repo, res.message);
      } else if (res.status === "added") {
        installed += 1;
        row("synced", "skills→agents", res.repo, `added to ${r.skillCohort.agents.length} non-plugin agents`);
      }
      // "skipped" (already synced / no skills) is the common, quiet case — omit.
    }
  }
  // Plugin-bundled MCP servers lifted into the non-plugin agents.
  if (!r.mcpCohort.supported) {
    if (r.mcpCohort.reason) {
      skipped += 1;
      row("skipped", "mcp→agents", "", r.mcpCohort.reason);
    }
  } else {
    for (const res of r.mcpCohort.results ?? []) {
      if (res.status === "failed") {
        failed += 1;
        row("failed", res.agent, "", `mcp: ${res.message ?? "failed"}`);
      } else if (res.added.length) {
        installed += res.added.length;
        row("synced", res.agent, "", `+${res.added.length} mcp: ${res.added.join(", ")}`);
      }
      // A name already present with a different config is left untouched — surface
      // it so the user can resolve it (same policy as union sync), but it's not a
      // failure and doesn't block.
      if (res.conflicts.length) {
        row("drift", res.agent, "", `${res.conflicts.length} conflict(s) left untouched: ${res.conflicts.join(", ")}`);
      }
    }
  }
  const parts = [
    installed ? green(`${installed} added`) : "",
    covered ? dim(`${covered} already covered`) : "",
    skipped ? dim(`${skipped} skipped`) : "",
    failed ? red(`${failed} failed`) : "",
  ].filter(Boolean);
  if (parts.length) console.log(`\n${parts.join(dim(" · "))}`);
  // Only meaningful when the user disabled provisioning: that's the one cause
  // "re-run without --no-provision" actually fixes. With provisioning on, a skip is
  // ambiguity or a non-github marketplace — re-running changes nothing.
  if (!provision && sawUnresolvedSkip) {
    console.log(dim("tip: skipped plugins had no marketplace Codex could resolve — re-run without --no-provision to register their marketplaces and add unloadable bundles as skills."));
  }
  // Only genuine CLI errors count as failures; skips/covered are expected.
  if (failed > 0) process.exit(1);
}

async function cmdPlugin(argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === "list") return cmdPluginList();
  if (sub === "rm" || sub === "remove" || sub === "uninstall") return cmdPluginRemove(argv.slice(1));
  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(
      "syncthis plugin list                 — overview of plugins across every agent (read-only)\n" +
        "syncthis plugin rm <plugin…> --all   — uninstall plugin(s) everywhere (native plugin on\n" +
        "                                       claude-code/codex + surfaced skills on the rest)\n" +
        "syncthis plugin rm <plugin…> --agents <a,b,c>\n" +
        "                                     — uninstall only from the named agents\n" +
        "  flags: --dry-run (preview), --yes (skip confirm), --keep-data (claude: keep plugin data dir)",
    );
    return;
  }
  console.error(red(`unknown plugin subcommand: ${sub}. use \`plugin list\` or \`plugin rm\`.`));
  process.exit(2);
}

async function cmdPluginList() {
  const { buildPluginOverview } = await import("../src/plugins/overview.ts");
  printPluginOverview(await buildPluginOverview());
}

async function cmdPluginRemove(argv: string[]) {
  const { runPluginUninstall, uninstallHasChanges } = await import("../src/plugins/uninstall.ts");
  const { listAgentIds } = await import("../src/sync.ts");
  const { values, positionals } = parse(argv);
  const plugins = positionals;
  if (plugins.length === 0) {
    console.error(red("plugin rm: name at least one plugin to uninstall"));
    process.exit(2);
  }
  // The full agent universe: MCP-syncable agents + skills-only agents (Pi).
  const known = [...listAgentIds(), "pi"] as AgentId[];
  const hasAgents = typeof values.agents === "string" && values.agents.trim().length > 0;
  // --all and --agents are mutually exclusive scopes — for a destructive command,
  // silently letting one win could uninstall from unintended agents. Reject both.
  if (values.all && hasAgents) {
    console.error(red("plugin rm: pass either --all or --agents <a,b,c>, not both"));
    process.exit(2);
  }
  let agents: AgentId[];
  if (values.all) {
    agents = known;
  } else if (hasAgents) {
    const wanted = (values.agents as string).split(",").map((s) => s.trim()).filter(Boolean);
    const bad = wanted.filter((a) => !known.includes(a as AgentId));
    if (bad.length) {
      console.error(red(`unknown agent(s): ${bad.join(", ")}`));
      console.error(dim(`known agents: ${known.join(", ")}`));
      process.exit(2);
    }
    agents = wanted as AgentId[];
  } else {
    console.error(red("plugin rm requires an explicit scope: --all or --agents <a,b,c>"));
    process.exit(2);
  }
  const keepData = !!values["keep-data"];

  const dryRun = !!values["dry-run"];
  const preview = await runPluginUninstall({ plugins, agents, apply: false, keepData });
  printUninstallPreview(preview);
  // Skill removal was scoped, but Claude's plugin list (the source for resolving which
  // skills a plugin contributed) couldn't be read — so we can't honor it. Don't let
  // that masquerade as a clean "nothing to do".
  const skillBlocked = !!preview.claudeReadError && preview.skillScope.length > 0;
  if (!uninstallHasChanges(preview) && !skillBlocked) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    if (skillBlocked) process.exit(1);
    return;
  }
  await confirmDestructive(!!values.yes);
  const onProgress = (label: string, i: number, total: number) =>
    process.stderr.write(dim(`  → [${i}/${total}] ${label}\n`));
  const applied = await runPluginUninstall({ plugins, agents, apply: true, keepData, onProgress });
  const failed = printUninstallApplied(applied);
  // The apply phase re-reads Claude; if that read fails now (even though the preview's
  // succeeded), skill names couldn't be resolved and skill removal was dropped. Surface
  // it loudly instead of letting the apply look clean.
  // Base the exit on the APPLY outcome, not the stale preview `skillBlocked` — a
  // preview that couldn't read Claude but an apply that then succeeded is a success.
  const appliedBlocked = !!applied.claudeReadError && applied.skillScope.length > 0;
  if (appliedBlocked) {
    console.error(red(`couldn't read Claude's plugins during apply (${applied.claudeReadError}) — surfaced skills on ${applied.skillScope.join(", ")} were NOT removed; re-run once claude is available`));
  }
  if (failed > 0 || appliedBlocked) process.exit(1);
}

async function cmdFanOut(argv: string[]) {
  const { runFanOut, listAgentIds } = await import("../src/sync.ts");
  const { values, positionals } = parse(argv);
  const from = positionals[0];
  const ids = listAgentIds();
  if (!from || !ids.includes(from as AgentId)) {
    console.error(red(`unknown agent: ${from ?? ""}`));
    console.error(dim(`known agents: ${ids.join(", ")}`));
    process.exit(2);
  }
  if (!values.all) {
    console.error(red("fan-out requires --all"));
    process.exit(2);
  }

  const dryRun = !!values["dry-run"];
  const preview = await runFanOut({ from: from as AgentId, apply: false });
  printFanOut(preview);
  if (!fanOutHasChanges(preview)) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  await confirmDestructive(!!values.yes);
  const applied = await runFanOut({ from: from as AgentId, apply: true });
  printFanOutWrites(applied);
  exitIfFailed(applied.targets.map((t) => t.write).filter((w): w is NonNullable<typeof w> => !!w));
}

// Shared scope resolver for the add/rm grammar. `--all` and `--agents` are mutually
// exclusive; one is required (the user must say exactly where). Validates against the
// command's known agent set.
type ParsedValues = ReturnType<typeof parse>["values"];
function resolveAgentScope(values: ParsedValues, known: AgentId[], label: string): AgentId[] {
  const hasAgents = typeof values.agents === "string" && (values.agents as string).trim().length > 0;
  if (values.all && hasAgents) {
    console.error(red(`${label}: pass either --all or --agents <a,b,c>, not both`));
    process.exit(2);
  }
  if (values.all) return known;
  if (hasAgents) {
    const wanted = (values.agents as string).split(",").map((s) => s.trim()).filter(Boolean);
    const bad = wanted.filter((a) => !known.includes(a as AgentId));
    if (bad.length) {
      console.error(red(`unknown agent(s): ${bad.join(", ")}`));
      console.error(dim(`known agents: ${known.join(", ")}`));
      process.exit(2);
    }
    return wanted as AgentId[];
  }
  console.error(red(`${label} requires a scope: --all or --agents <a,b,c>`));
  process.exit(2);
}

// `syncthis add <skill|plugin> <items…> --agents <list>|--all` — additive (no confirm;
// supports --dry-run). MCP has no add (syncthis is a sync layer, not an installer).
async function cmdAdd(argv: string[]) {
  const noun = argv[0];
  if (noun === "skill" || noun === "skills") return cmdAddSkill(argv.slice(1));
  if (noun === "plugin" || noun === "plugins") return cmdAddPlugin(argv.slice(1));
  if (noun === "mcp") {
    console.error(red("there's no `add mcp` — syncthis mirrors MCP servers, it doesn't install them. Add a server with `claude mcp add`/mcpm, then `syncthis sync`."));
    process.exit(2);
  }
  console.error(red(`add: say what to add — \`add skill <repo…>\` or \`add plugin <name…>\` (with --all | --agents <a,b,c>)`));
  process.exit(2);
}

async function cmdAddSkill(argv: string[]) {
  const { addSkillRepos } = await import("../src/skills.ts");
  const { listAgentIds } = await import("../src/sync.ts");
  const { values, positionals } = parse(argv);
  if (positionals.length === 0) {
    console.error(red("add skill: name at least one repo (e.g. vercel-labs/agent-skills)"));
    process.exit(2);
  }
  const agents = resolveAgentScope(values, [...listAgentIds(), "pi"] as AgentId[], "add skill");
  const dryRun = !!values["dry-run"];
  console.log(`Add skills ${positionals.map((p) => green(p)).join(", ")} → ${agents.join(", ")}${dryRun ? dim(" (dry-run)") : ""}`);
  const results = await addSkillRepos(positionals, agents, { dryRun });
  let added = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "failed") { failed += 1; row("failed", "skills", r.repo, r.message); }
    else { added += 1; row("synced", "skills", r.repo, dryRun ? "dry-run" : r.status === "skipped" ? (r.message ?? "no skills") : "added"); }
  }
  if (failed > 0) process.exit(1);
}

async function cmdAddPlugin(argv: string[]) {
  const { runPluginAdd, pluginAddHasWork } = await import("../src/plugins/add.ts");
  const { listAgentIds } = await import("../src/sync.ts");
  const { values, positionals } = parse(argv);
  if (positionals.length === 0) {
    console.error(red("add plugin: name at least one plugin (must be installed on claude-code, the source)"));
    process.exit(2);
  }
  const agents = resolveAgentScope(values, [...listAgentIds(), "pi"] as AgentId[], "add plugin");
  const dryRun = !!values["dry-run"];
  const preview = await runPluginAdd({ plugins: positionals, agents, apply: false });
  printPluginAdd(preview, true);
  if (preview.sourceError) {
    console.error(red(`cannot read claude-code (the source): ${preview.sourceError}`));
    process.exit(1);
  }
  if (!pluginAddHasWork(preview)) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  console.log(dim("installing — may register Codex marketplaces and run npx (network)…"));
  const onProgress = (label: string, i: number, total: number) =>
    process.stderr.write(dim(`  → [${i}/${total}] ${label}\n`));
  const applied = await runPluginAdd({ plugins: positionals, agents, apply: true, onProgress });
  const failed = printPluginAdd(applied, false);
  // Claude (the source) failing at apply time means nothing could be resolved — surface
  // it rather than reporting an empty, clean-looking add.
  if (applied.sourceError) {
    console.error(red(`couldn't read claude-code (the source) during apply: ${applied.sourceError}`));
    process.exit(1);
  }
  if (failed > 0) process.exit(1);
}

// `syncthis rm <mcp|skill|plugin> <items…>`. A bare `rm <server> --all` (no noun)
// stays MCP, for back-compat with the original single-server remove.
async function cmdRm(argv: string[]) {
  const noun = argv[0];
  if (noun === "skill" || noun === "skills") return cmdRmSkill(argv.slice(1));
  if (noun === "plugin" || noun === "plugins") return cmdPluginRemove(argv.slice(1));
  if (noun === "mcp") return cmdRmMcp(argv.slice(1));
  return cmdRmMcp(argv); // legacy: `rm <server> --all`
}

async function cmdRmMcp(argv: string[]) {
  const { runRemove, listAgentIds } = await import("../src/sync.ts");
  const { values, positionals } = parse(argv);
  if (positionals.length === 0) {
    console.error(red("rm mcp: name at least one server"));
    process.exit(2);
  }
  const agents = resolveAgentScope(values, listAgentIds(), "rm mcp");
  const dryRun = !!values["dry-run"];
  const previews = [];
  for (const name of positionals) previews.push(await runRemove({ name, agents, apply: false }));
  for (const p of previews) printRemove(p);
  const willChange = previews.some((p) => p.writes.some((w) => w.status === "synced"));
  if (!willChange) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  await confirmDestructive(!!values.yes);
  const writes = [];
  for (const name of positionals) {
    const applied = await runRemove({ name, agents, apply: true });
    printRemove(applied);
    writes.push(...applied.writes);
  }
  exitIfFailed(writes);
}

async function cmdRmSkill(argv: string[]) {
  const { removeSkillNames, listInstalledSkills } = await import("../src/skills.ts");
  const { listAgentIds } = await import("../src/sync.ts");
  const { values, positionals } = parse(argv);
  if (positionals.length === 0) {
    console.error(red("rm skill: name at least one skill"));
    process.exit(2);
  }
  const agents = resolveAgentScope(values, [...listAgentIds(), "pi"] as AgentId[], "rm skill");
  const dryRun = !!values["dry-run"];

  // Preview: which requested skills actually live on which scoped agents.
  const installed = await listInstalledSkills();
  console.log(`Remove skills ${positionals.map((p) => green(p)).join(", ")} from ${agents.join(", ")}:`);
  let present = false;
  if (installed) {
    for (const name of positionals) {
      const hit = installed.find((s) => s.name === name);
      const on = hit ? hit.agents.filter((a) => agents.includes(a)) : [];
      if (on.length) { present = true; console.log(`  ${red("-")} ${name} ${dim(`(on ${on.join(", ")})`)}`); }
      else console.log(`  ${dim("·")} ${name} ${dim("not installed on the scoped agents")}`);
    }
  } else {
    present = true; // can't read the list — proceed and let the CLI report per agent
    console.log(dim("  (couldn't read `npx skills list` — proceeding by name)"));
  }
  if (!present) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  await confirmDestructive(!!values.yes);
  const r = await removeSkillNames(positionals, agents);
  if (r.status === "failed") { row("failed", "skills", "", r.message); process.exit(1); }
  else if (r.status === "skipped") row("skipped", "skills", "", r.message);
  else row("synced", "skills", "", `removed ${r.skills.length} skill(s) from ${r.agents.length} agent(s)`);
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

  await confirmDestructive(yes);

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

function printFanOut(r: import("../src/sync.ts").FanOutReport) {
  console.log(`Mirror MCP servers from ${green(r.from)} → ${green("all other agents")}:`);
  for (const target of r.targets) {
    if (target.toRead.error) {
      console.log(`  ${red("✗")} ${target.to.padEnd(14)} ${dim(target.toRead.error)}`);
      continue;
    }
    const parts = [
      target.diff.add.length ? `${green("+")}${target.diff.add.length}` : "",
      target.diff.overwrite.length ? `${yellow("~")}${target.diff.overwrite.length}` : "",
      target.diff.remove.length ? `${red("-")}${target.diff.remove.length}` : "",
    ].filter(Boolean);
    console.log(`  ${parts.length ? yellow("~") : green("=")} ${target.to.padEnd(14)} ${parts.join(" ") || dim("unchanged")}`);
  }
}

function printFanOutWrites(r: import("../src/sync.ts").FanOutReport) {
  for (const target of r.targets) {
    if (target.write) row(target.write.status, target.to, target.write.path, target.write.message);
  }
}

function fanOutHasChanges(r: import("../src/sync.ts").FanOutReport): boolean {
  return r.targets.some((target) =>
    target.toRead.error ||
    target.diff.add.length > 0 ||
    target.diff.overwrite.length > 0 ||
    target.diff.remove.length > 0,
  );
}

function printRemove(r: import("../src/sync.ts").RemoveReport) {
  console.log(`Remove MCP server ${green(r.name)} from ${r.writes.length} agent(s):`);
  for (const write of r.writes) row(write.status, write.agent, write.path, write.message);
}

function printPluginAdd(r: import("../src/plugins/add.ts").PluginAddReport, preview: boolean): number {
  const targets = r.requestedAgents.filter((a) => a !== "claude-code");
  console.log(`${preview ? "Add" : "Added"} ${r.plugins.map((p) => green(p)).join(", ")} → ${targets.join(", ") || dim("(no targets)")} ${dim("(source: claude-code)")}`);
  for (const n of r.notFound) row("missing", "claude-code", n, "not installed on the source");
  let failed = 0;
  for (const ins of r.installs) {
    if (ins.status === "failed") { failed += 1; row("failed", ins.agent, ins.target, ins.message); }
    else if (ins.status === "present") row("synced", ins.agent, ins.target, "already present");
    else if (ins.status === "installed") row("synced", ins.agent, ins.target, preview ? "would install" : "installed");
    else if (ins.status === "skipped" && !ins.skillsFallbackRepo) row("skipped", ins.agent, ins.target, ins.message); // fallback shown under skills
  }
  if (r.cursor) {
    for (const res of r.cursor.results) {
      if (res.status === "failed") { failed += 1; row("failed", "cursor", res.repo, res.message); }
      else row("synced", "cursor", res.repo, "installed (npx plugins)");
    }
    if (preview) for (const repo of r.cursor.repos) row("synced", "cursor", repo, "would push");
  }
  for (const s of r.skills) {
    if (s.status === "failed") { failed += 1; row("failed", "skills", s.repo, s.message); }
    else row("synced", "skills", s.repo, preview ? "would add" : s.status === "skipped" ? (s.message ?? "no skills") : "added");
  }
  for (const m of r.mcp) {
    if (m.status === "failed") { failed += 1; row("failed", m.agent, "", `mcp: ${m.message ?? "failed"}`); }
    else if (m.added.length) row("synced", m.agent, "", `${preview ? "would add " : "+"}${m.added.length} mcp: ${m.added.join(", ")}`);
    if (m.conflicts.length) row("drift", m.agent, "", `${m.conflicts.length} mcp conflict(s) left untouched: ${m.conflicts.join(", ")}`);
  }
  return failed;
}

async function confirmDestructive(yes: boolean) {
  if (yes) return;
  if (process.stdin.isTTY) {
    process.stdout.write("\nContinue? [y/N] ");
    const answer = await readLine();
    if (answer.trim().toLowerCase() !== "y") {
      console.log(dim("aborted."));
      process.exit(0);
    }
    return;
  }
  console.error(red("refusing destructive write without --yes in non-interactive mode."));
  process.exit(2);
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const finish = (line: string) => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
      resolve(line);
    };
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish(buf.slice(0, nl));
    };
    // EOF without a trailing newline (Ctrl-D, or a closed/empty pipe) must resolve —
    // otherwise the destructive-confirm prompt hangs forever. Resolve with whatever
    // was typed; confirmDestructive treats anything but "y" as abort, so EOF = abort.
    const onEnd = () => finish(buf);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
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

  if (r.pluginSkills) printPluginSkills(r.pluginSkills, r.pluginSkills.dryRun);

  if (r.skills) {
    if (!r.skills.ran) row("skipped", "skills", "", r.skills.message);
    else if (r.skills.ok) row("synced", "skills", "", "npx skills update -y");
    else row("drift", "skills", "", r.skills.message ?? "failed");
  }

  exitIfFailed(r.writes);
}

function printDoctor(r: import("../src/doctor.ts").DoctorReport) {
  for (const read of r.reads) {
    if (read.error) row("invalid", read.agent, read.path, read.error);
    else if (!read.exists) row("missing", read.agent, read.path, "file does not exist");
    else row("ok", read.agent, read.path, `${Object.keys(read.servers).length} server(s)`);
  }

  if (r.coverage.length === 0) {
    console.log(dim("\nno servers configured in any agent."));
  } else {
    console.log(dim(`\ncoverage:`));
    for (const c of r.coverage) {
      const tag = c.missing.length === 0 ? green("[full]") : yellow(`[${c.present.length}/${r.reads.length}]`);
      const detail = c.missing.length === 0 ? "" : dim(` — missing in ${c.missing.join(", ")}`);
      console.log(`  ${tag} ${c.name}${detail}`);
    }
  }

  if (r.conflicts.length) {
    console.log(yellow(`\n${r.conflicts.length} conflict(s):`));
    for (const c of r.conflicts) {
      console.log(`  ${yellow("~")} ${c.name} — different config in ${c.versions.map((v) => v.agent).join(", ")}`);
    }
    process.exit(1);
  }

  if (r.unmanaged.length) {
    console.log(yellow(`\nunmanaged MCP config(s) with servers:`));
    for (const u of r.unmanaged) {
      console.log(`  ${yellow("~")} ${u.label.padEnd(18)} ${dim(u.path)} ${dim(`(${u.serverNames.join(", ")})`)}`);
    }
    console.log(dim("  these files are not written by syncthis; clear or manage them separately."));
  }
}

function printPluginOverview(o: import("../src/plugins/overview.ts").PluginOverview) {
  console.log("Plugins across your agents:\n");
  // Native plugins on the plugin-capable agents (claude-code, codex).
  for (const r of o.native) {
    if (r.error) {
      row("invalid", r.agent, r.configPath, r.error);
      continue;
    }
    if (!r.exists) {
      row("missing", r.agent, r.configPath, "no config");
      continue;
    }
    row("ok", r.agent, r.configPath, `${r.plugins.length} plugin(s)`);
    for (const p of r.plugins) {
      const mkt = p.marketplace ? dim(`@${p.marketplace}`) : "";
      const ver = p.version ? dim(` v${p.version}`) : "";
      const enabled = p.enabled === false ? yellow(" (disabled)") : "";
      console.log(`      ${dim("·")} ${p.name}${mkt}${ver}${enabled}`);
    }
  }
  // Cursor is a plugin target but write-only — no list CLI to read.
  row("missing", "cursor", "~/.cursor", "write-only plugin target — Cursor's plugin state isn't readable");

  // The non-plugin agents: plugins reach them only as surfaced skills.
  console.log(dim("\nplugin-derived skills (on agents that can't load plugins natively):"));
  if (!o.skillsReadable) {
    console.log(dim("  couldn't read `npx skills list` — derived-skill view unavailable"));
    return;
  }
  if (o.derivedRepos.length === 0) {
    console.log(dim("  none surfaced yet — run `syncthis mirror claude-code` to push plugin skills to other agents"));
    return;
  }
  console.log(dim(`  source repos: ${o.derivedRepos.join(", ")}`));
  const union = new Set<string>();
  for (const d of o.derived) for (const s of d.skills) union.add(s.name);
  if (union.size) console.log(dim(`  skills: ${[...union].sort().join(", ")}`));
  for (const d of o.derived) {
    const glyph = d.skills.length ? green("✓") : dim("·");
    console.log(`  ${glyph} ${d.agent.padEnd(14)} ${d.skills.length} skill(s)`);
  }
}

function printUninstallPreview(r: import("../src/plugins/uninstall.ts").UninstallReport) {
  console.log(`Uninstall ${r.plugins.map((p) => green(p)).join(", ")}:`);
  for (const t of r.native) {
    const target = t.marketplace ? `${t.plugin}@${t.marketplace}` : t.plugin;
    if (t.unreadable) row("invalid", t.agent, "", `can't read plugins: ${t.unreadable}`);
    else if (t.present) console.log(`  ${red("-")} ${t.agent.padEnd(14)} ${target} ${dim("(native plugin)")}`);
    else console.log(`  ${dim("·")} ${t.agent.padEnd(14)} ${dim(`${target} not installed`)}`);
  }
  if (r.skills.names.length && r.skills.agents.length) {
    console.log(
      `  ${red("-")} ${"skills".padEnd(14)} ${red(`${r.skills.names.length}`)} skill(s) from ${r.skills.agents.length} non-plugin agent(s)`,
    );
    console.log(`      ${dim(`names:  ${r.skills.names.join(", ")}`)}`);
    console.log(`      ${dim(`agents: ${r.skills.agents.join(", ")}`)}`);
  } else if (r.skills.names.length) {
    console.log(`  ${dim("·")} ${"skills".padEnd(14)} ${dim("derived skills exist, but none of the scoped agents hold them")}`);
  }
  if (r.skills.kept.length) {
    console.log(dim(`  kept (still provided by another installed plugin): ${r.skills.kept.join(", ")}`));
  }
  for (const a of r.unsupportedAgents) {
    console.log(`  ${dim("·")} ${a.padEnd(14)} ${dim("can't uninstall here (write-only plugin target, no list/uninstall CLI)")}`);
  }
  if (r.claudeReadError && r.skillScope.length) {
    console.log(
      yellow(
        `  ! couldn't read Claude's plugins (${r.claudeReadError}) — can't resolve which surfaced skills to remove from ${r.skillScope.join(", ")}; those skills will be left in place`,
      ),
    );
  }
}

function printUninstallApplied(r: import("../src/plugins/uninstall.ts").UninstallReport): number {
  let removed = 0;
  let absent = 0;
  let skipped = 0;
  let failed = 0;
  for (const res of r.nativeResults ?? []) {
    if (res.status === "uninstalled") {
      removed += 1;
      row("synced", res.agent, res.target, "uninstalled");
    } else if (res.status === "absent") {
      absent += 1; // quiet — nothing was there
    } else if (res.status === "skipped") {
      skipped += 1;
      row("skipped", res.agent, res.target, res.message);
    } else {
      failed += 1;
      row("failed", res.agent, res.target, res.message);
    }
  }
  if (r.skillResult) {
    const sr = r.skillResult;
    if (sr.status === "removed") {
      removed += sr.skills.length;
      row("synced", "skills", "", `removed ${sr.skills.length} skill(s) from ${sr.agents.length} agent(s)`);
    } else if (sr.status === "skipped") {
      skipped += 1;
      row("skipped", "skills", "", sr.message);
    } else {
      failed += 1;
      row("failed", "skills", "", sr.message);
    }
  }
  const parts = [
    removed ? green(`${removed} removed`) : "",
    absent ? dim(`${absent} absent`) : "",
    skipped ? dim(`${skipped} skipped`) : "",
    failed ? red(`${failed} failed`) : "",
  ].filter(Boolean);
  if (parts.length) console.log(`\n${parts.join(dim(" · "))}`);
  return failed;
}

function exitIfFailed(writes: { status: RowStatus }[]) {
  const failed = writes.filter((w) => w.status === "failed");
  if (failed.length) {
    console.log(red(`\n${failed.length} adapter(s) failed.`));
    process.exit(1);
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  // No command: render the ink welcome, then open the picker (or HELP if non-TTY).
  if (!cmd) {
    const { renderWelcome } = await import("../src/welcome.tsx");
    await renderWelcome();
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { showInteractivePicker } = await import("../src/tui.ts");
      return showInteractivePicker();
    }
    return console.log(HELP);
  }

  if (cmd === "help" || cmd === "-h" || cmd === "--help") return console.log(HELP);
  if (cmd === "sync") return cmdSync(rest);
  if (cmd === "run") return cmdSync(rest);
  if (cmd === "mcp") return cmdMcp(rest);
  if (cmd === "skills") return cmdSkills(rest);
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "mirror") return cmdMirror(rest);
  if (cmd === "from") return cmdFanOut(rest);
  if (cmd === "add") return cmdAdd(rest);
  if (cmd === "rm" || cmd === "remove") return cmdRm(rest);
  if (cmd === "plugin" || cmd === "plugins") return cmdPlugin(rest);

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
  // A bad flag / arg is a usage error → exit 2, matching every other usage-error
  // path (unknown command, missing --all, etc.). Everything else is a runtime
  // failure → exit 1.
  const code = typeof err?.code === "string" && err.code.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  process.exit(code);
});
