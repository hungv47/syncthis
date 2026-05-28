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
  syncthis run  [--dry-run] [--no-skills]    alias for sync
  syncthis mcp  [--dry-run]                  MCP only — skip skills update
  syncthis skills                            skills only — \`npx skills update -y\`
  syncthis status [--detailed] [--json]      plugin × agent × stage matrix
                                             (shows silent failures with reasons)
  syncthis mirror <primary> [--remove-stale] [--yes] [--dry-run]
                                             destructive: install primary's plugins on
                                             every other agent. --remove-stale also
                                             uninstalls plugins not in primary.
  syncthis <from> <to> [--yes] [--dry-run]   one-way mirror MCP from one agent to another
  syncthis from <agent> --all [--yes] [--dry-run]
                                             one-way mirror MCP from one agent to every other agent
  syncthis rm <server> --all [--yes] [--dry-run]
                                             remove one MCP server from every supported agent
  syncthis doctor                            coverage + conflict report
  syncthis plugin list                       list installed plugins per agent (read-only)
  syncthis plugin doctor                     plugin + marketplace coverage report (read-only)
  syncthis plugin rm <name> --all [--yes] [--dry-run] [--no-prune] [--purge]
                                             uninstall a plugin from every agent. --purge also
                                             sweeps the on-disk cache dir.
  syncthis plugin rm <name> --agents claude-code,codex [--yes] [--dry-run] [--purge]
                                             uninstall a plugin from specific agents
  syncthis plugin rm --marketplace <name> --all [--yes] [--dry-run] [--purge]
                                             uninstall every plugin that came from a marketplace
  syncthis marketplace list                  list configured marketplaces per agent (read-only)
  syncthis marketplace rm <name> --all [--yes] [--dry-run] [--purge]
                                             remove a marketplace. --purge also sweeps the
                                             on-disk marketplace + cache dirs (works even when
                                             registration is already absent).
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
  --all        required for fan-out and remove-all commands.
  --yes        skip confirmation prompt for destructive commands.

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
  agents: { type: "string" },
  prune: { type: "boolean" },
  "no-prune": { type: "boolean" },
  marketplace: { type: "string" },
  purge: { type: "boolean" },
  detailed: { type: "boolean" },
  json: { type: "boolean" },
  "remove-stale": { type: "boolean" },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

async function cmdSync(argv: string[]) {
  const { runSync } = await import("../src/sync.ts");
  const { values } = parse(argv);
  const dryRun = !!values["dry-run"];
  printSync(await runSync({ dryRun, skipSkills: !!values["no-skills"] }));
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

async function cmdStatus(argv: string[]) {
  const { buildStatusReport, cellGlyph } = await import("../src/plugins/status.ts");
  const { values } = parse(argv);
  const detailed = !!values.detailed;
  const report = await buildStatusReport();

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (report.rows.length === 0) {
    console.log(dim("no plugins installed in any tracked agent."));
    return;
  }

  let silentCount = 0;
  for (const row of report.rows) {
    const idLabel = detailed && row.marketplace ? `${row.name}@${row.marketplace}` : row.name;
    console.log(`${green(idLabel)}`);
    for (const cell of row.cells) {
      const tag = cellGlyph(cell);
      let glyph: string;
      let detail = "";
      if (tag === "absent") {
        glyph = dim("·");
        detail = dim("not installed");
      } else if (tag === "error") {
        glyph = red("✗");
        detail = dim(cell.error!);
      } else if (tag === "disabled") {
        glyph = yellow("○");
        detail = dim("disabled");
      } else if (tag === "surfaced") {
        glyph = green("✓");
        const r = cell.report!;
        const counts = r.skills.expected ? `${r.skills.actual}/${r.skills.expected} skills` : "registered";
        detail = dim(counts);
      } else {
        // silent failure
        silentCount += 1;
        glyph = red("✗");
        const r = cell.report!;
        const counts = r.skills.expected ? `${r.skills.actual}/${r.skills.expected} skills surfaced` : "registered but not surfaced";
        detail = `${red("silent failure:")} ${dim(counts)} — ${r.reasons[0] ?? "unknown reason"}`;
        if (detailed && r.reasons.length > 1) {
          for (const more of r.reasons.slice(1)) detail += `\n              ${dim("· " + more)}`;
        }
      }
      console.log(`  ${glyph} ${cell.agent.padEnd(14)} ${detail}`);
    }
  }
  if (silentCount > 0) {
    console.log(yellow(`\n${silentCount} silent failure(s) — see the reason on each row above.`));
  }
}

async function cmdMirror(argv: string[]) {
  const { runMirror, mirrorHasChanges } = await import("../src/plugins/mirror.ts");
  const { pluginAdapters } = await import("../src/plugins/index.ts");
  const { values, positionals } = parse(argv);
  const from = positionals[0];
  // Validate against plugin-capable agents only — listAgentIds() includes the
  // 11 MCP-sync agents, but only 4 have plugin adapters. Mirror against a
  // non-plugin agent would otherwise throw from runMirror.
  const pluginIds = pluginAdapters.map((a) => a.id);
  if (!from || !pluginIds.includes(from as AgentId)) {
    console.error(red(`mirror: pass a plugin-capable primary agent. known: ${pluginIds.join(", ")}`));
    process.exit(2);
  }
  const dryRun = !!values["dry-run"];
  const removeStale = !!values["remove-stale"];

  const preview = await runMirror({ from: from as AgentId, apply: false, removeStale });
  printMirrorPreview(preview);
  if (!mirrorHasChanges(preview)) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  await confirmDestructive(!!values.yes);
  const applied = await runMirror({ from: from as AgentId, apply: true, removeStale });
  printMirrorApplied(applied);
}

function printMirrorPreview(r: import("../src/plugins/mirror.ts").MirrorReport) {
  console.log(`Mirror plugins from ${green(r.from)} → all other agents:`);
  for (const t of r.targets) {
    // No diff at all → unmirrorable target (kind mismatch / unreadable). Reason only.
    if (!t.diff) {
      if (t.unsupportedReason) console.log(`  ${dim("·")} ${t.to.padEnd(14)} ${dim(t.unsupportedReason)}`);
      continue;
    }
    const adds = t.diff.add.length ? `${green("+")}${t.diff.add.length}` : "";
    const rms = t.diff.remove.length ? `${red("-")}${t.diff.remove.length}` : "";
    const summary = [adds, rms].filter(Boolean).join(" ") || dim("unchanged");
    console.log(`  ${green("→")} ${t.to.padEnd(14)} ${summary}`);
    for (const p of t.diff.add) console.log(`      ${green("+")} ${p.marketplace ? `${p.name}@${p.marketplace}` : p.name}`);
    for (const p of t.diff.remove) console.log(`      ${red("-")} ${p.marketplace ? `${p.name}@${p.marketplace}` : p.name}`);
    // Target has a diff but also a caveat (e.g. Cursor can remove but not install):
    // explain why some plugins won't be pushed so the confirmed diff isn't misread.
    if (t.unsupportedReason) console.log(`      ${dim(t.unsupportedReason)}`);
  }
}

function printMirrorApplied(r: import("../src/plugins/mirror.ts").MirrorReport) {
  let failed = 0;
  for (const t of r.targets) {
    for (const ins of t.installs ?? []) {
      if (ins.status === "failed") {
        failed += 1;
        row("failed", t.to, ins.target, ins.message);
      } else if (ins.status === "installed") {
        row("synced", t.to, ins.target, "installed");
      }
    }
    for (const rm of t.removes ?? []) {
      if (rm.status === "failed") {
        failed += 1;
        row("failed", t.to, rm.target, rm.message);
      } else if (rm.status === "removed") {
        row("synced", t.to, rm.target, "removed");
      }
    }
  }
  if (failed > 0) {
    console.log(red(`\n${failed} install/remove(s) failed.`));
    process.exit(1);
  }
}

async function cmdPlugin(argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    console.log(
      "syncthis plugin <list|doctor|rm> — inspect or remove plugins across claude, codex, cursor, opencode.",
    );
    return;
  }
  if (sub === "list") return cmdPluginList();
  if (sub === "doctor") return cmdPluginDoctor();
  if (sub === "rm" || sub === "remove" || sub === "uninstall") return cmdPluginRemove(argv.slice(1));
  console.error(red(`unknown plugin subcommand: ${sub}`));
  process.exit(2);
}

async function cmdPluginList() {
  const { listPlugins } = await import("../src/plugin-doctor.ts");
  printPluginList(await listPlugins());
}

async function cmdPluginDoctor() {
  const { runPluginDoctor } = await import("../src/plugin-doctor.ts");
  printPluginDoctor(await runPluginDoctor());
}

async function cmdMarketplace(argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    console.log("syncthis marketplace <list|rm> — inspect or remove marketplaces (claude, codex).");
    return;
  }
  if (sub === "list") return cmdMarketplaceList();
  if (sub === "rm" || sub === "remove") return cmdMarketplaceRemove(argv.slice(1));
  console.error(red(`unknown marketplace subcommand: ${sub}`));
  process.exit(2);
}

async function cmdMarketplaceList() {
  const { listPlugins } = await import("../src/plugin-doctor.ts");
  printMarketplaceList(await listPlugins());
}

function parseScope(values: { all?: boolean; agents?: string }):
  | { kind: "ok"; scope: import("../src/plugin-rm.ts").RemoveScope }
  | { kind: "err"; message: string } {
  if (values.all && values.agents) {
    return { kind: "err", message: "--all and --agents are mutually exclusive" };
  }
  if (values.all) return { kind: "ok", scope: { all: true } };
  if (values.agents) {
    const ids = values.agents
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return { kind: "err", message: "--agents requires a non-empty list" };
    const known = new Set<string>(["claude-code", "codex", "cursor", "opencode"]);
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) {
      return {
        kind: "err",
        message: `unknown agent(s): ${unknown.join(", ")}. plugin/marketplace commands support: ${[...known].join(", ")}`,
      };
    }
    return { kind: "ok", scope: { agents: ids as AgentId[] } };
  }
  return { kind: "err", message: "scope required: pass --all or --agents <id,id,...>" };
}

async function cmdPluginRemove(argv: string[]) {
  const { runPluginRemove, runPluginRemoveByMarketplace, hasChanges, bulkHasChanges } =
    await import("../src/plugin-rm.ts");
  const { isSafeIdentifier } = await import("../src/plugins/shell.ts");
  const { values, positionals } = parse(argv);
  const positionalName = positionals[0];
  const marketplace = values.marketplace;
  if (!positionalName && !marketplace) {
    console.error(red("plugin name OR --marketplace <name> is required"));
    process.exit(2);
  }
  if (positionalName && marketplace) {
    console.error(red("pass a plugin name OR --marketplace, not both"));
    process.exit(2);
  }
  if (positionalName && !isSafeIdentifier(positionalName)) {
    console.error(red(`plugin name contains unsafe characters or path traversal: ${JSON.stringify(positionalName)}`));
    process.exit(2);
  }
  if (marketplace && !isSafeIdentifier(marketplace)) {
    console.error(red(`marketplace name contains unsafe characters or path traversal: ${JSON.stringify(marketplace)}`));
    process.exit(2);
  }
  const scope = parseScope(values);
  if (scope.kind === "err") {
    console.error(red(scope.message));
    process.exit(2);
  }
  const prune = values.prune ? true : values["no-prune"] ? false : true;
  const purge = !!values.purge;
  const dryRun = !!values["dry-run"];

  if (marketplace) {
    const previewBulk = await runPluginRemoveByMarketplace(marketplace, {
      scope: scope.scope,
      apply: false,
      prune,
      purge,
    });
    printBulkRemoveReport(previewBulk);
    if (!bulkHasChanges(previewBulk)) {
      console.log(dim("nothing to do."));
      return;
    }
    if (dryRun) {
      console.log(dim("dry-run — no changes applied."));
      return;
    }
    await confirmDestructive(!!values.yes);
    const appliedBulk = await runPluginRemoveByMarketplace(marketplace, {
      scope: scope.scope,
      apply: true,
      prune,
      purge,
    });
    printBulkRemoveReport(appliedBulk);
    const allResults = appliedBulk.perPlugin.flatMap((r) => r.results);
    exitIfRemovesFailed(allResults);
    return;
  }

  const name = positionalName!;
  const preview = await runPluginRemove({ name, scope: scope.scope, apply: false, prune, purge });
  printRemoveReport(preview, "plugin");
  if (!hasChanges(preview)) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  await confirmDestructive(!!values.yes);
  const applied = await runPluginRemove({ name, scope: scope.scope, apply: true, prune, purge });
  printRemoveReport(applied, "plugin");
  exitIfRemovesFailed(applied.results);
}

async function cmdMarketplaceRemove(argv: string[]) {
  const { runMarketplaceRemove, hasChanges } = await import("../src/plugin-rm.ts");
  const { isSafeIdentifier } = await import("../src/plugins/shell.ts");
  const { values, positionals } = parse(argv);
  const name = positionals[0];
  if (!name) {
    console.error(red("marketplace name is required"));
    process.exit(2);
  }
  if (!isSafeIdentifier(name)) {
    console.error(red(`marketplace name contains unsafe characters or path traversal: ${JSON.stringify(name)}`));
    process.exit(2);
  }
  const scope = parseScope(values);
  if (scope.kind === "err") {
    console.error(red(scope.message));
    process.exit(2);
  }
  const dryRun = !!values["dry-run"];
  const purge = !!values.purge;

  const preview = await runMarketplaceRemove({ name, scope: scope.scope, apply: false, purge });
  printRemoveReport(preview, "marketplace");
  if (!hasChanges(preview)) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  await confirmDestructive(!!values.yes);
  const applied = await runMarketplaceRemove({ name, scope: scope.scope, apply: true, purge });
  printRemoveReport(applied, "marketplace");
  exitIfRemovesFailed(applied.results);
}

function printRemoveReport(report: import("../src/plugin-rm.ts").RemoveReport, label: "plugin" | "marketplace") {
  console.log(`Remove ${label} ${green(report.name)}:`);
  for (const r of report.results) {
    const status =
      r.status === "removed" ? "synced" :
      r.status === "absent" ? "unchanged" :
      r.status === "skipped" ? "skipped" :
      "failed";
    const detail = r.message ?? (r.status === "absent" ? "not present" : r.status === "skipped" ? "n/a" : "");
    row(status, r.agent, r.target === report.name ? "" : r.target, detail);
  }
}

function printBulkRemoveReport(bulk: import("../src/plugin-rm.ts").BulkRemoveReport) {
  if (bulk.resolvedNames.length === 0) {
    console.log(`No plugins found under marketplace ${green(bulk.marketplace)} in any in-scope agent.`);
    return;
  }
  console.log(
    `Remove ${bulk.resolvedNames.length} plugin(s) from marketplace ${green(bulk.marketplace)}: ${dim(bulk.resolvedNames.join(", "))}`,
  );
  for (const r of bulk.perPlugin) {
    printRemoveReport(r, "plugin");
  }
}

function exitIfRemovesFailed(results: import("../src/plugins/types.ts").PluginRemoveResult[]) {
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length) {
    console.log(red(`\n${failed.length} adapter(s) failed.`));
    process.exit(1);
  }
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

async function cmdRemove(argv: string[]) {
  const { runRemove } = await import("../src/sync.ts");
  const { values, positionals } = parse(argv);
  const name = positionals[0];
  if (!name) {
    console.error(red("server name is required"));
    process.exit(2);
  }
  if (!values.all) {
    console.error(red("remove requires --all"));
    process.exit(2);
  }

  const dryRun = !!values["dry-run"];
  const preview = await runRemove({ name, apply: false });
  printRemove(preview);
  const willChange = preview.writes.some((w) => w.status === "synced");
  if (!willChange) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  await confirmDestructive(!!values.yes);
  const applied = await runRemove({ name, apply: true });
  printRemove(applied);
  exitIfFailed(applied.writes);
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
  console.log(`Remove MCP server ${green(r.name)} from all supported agents:`);
  for (const write of r.writes) row(write.status, write.agent, write.path, write.message);
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

function printPluginList(reads: import("../src/plugins/types.ts").PluginAdapterRead[]) {
  for (const r of reads) {
    if (r.error) {
      row("invalid", r.agent, r.configPath, r.error);
      continue;
    }
    if (!r.exists) {
      row("missing", r.agent, r.configPath, "no config");
      continue;
    }
    const kindTag = r.pluginKind === "npm" ? dim(" (npm)") : "";
    row("ok", r.agent, r.configPath, `${r.plugins.length} plugin(s)${kindTag}`);
    for (const p of r.plugins) {
      const mkt = p.marketplace ? dim(`@${p.marketplace}`) : "";
      const ver = p.version ? dim(` v${p.version}`) : "";
      const enabled = p.enabled === false ? yellow(" (disabled)") : "";
      console.log(`      ${dim("·")} ${p.name}${mkt}${ver}${enabled}`);
    }
  }
}

function printMarketplaceList(reads: import("../src/plugins/types.ts").PluginAdapterRead[]) {
  for (const r of reads) {
    if (!r.supportsMarketplaces) {
      row("skipped", r.agent, r.configPath, "no marketplace concept");
      continue;
    }
    if (r.error) {
      row("invalid", r.agent, r.configPath, r.error);
      continue;
    }
    if (!r.exists) {
      row("missing", r.agent, r.configPath, "no config");
      continue;
    }
    row("ok", r.agent, r.configPath, `${r.marketplaces.length} marketplace(s)`);
    for (const m of r.marketplaces) {
      console.log(`      ${dim("·")} ${m.name} ${dim(`(${m.sourceType}) ${m.source}`)}`);
    }
  }
}

function printPluginDoctor(r: import("../src/plugin-doctor.ts").PluginDoctorReport) {
  for (const read of r.reads) {
    if (read.error) row("invalid", read.agent, read.configPath, read.error);
    else if (!read.exists) row("missing", read.agent, read.configPath, "no config");
    else {
      const detail = read.supportsMarketplaces
        ? `${read.plugins.length} plugin(s), ${read.marketplaces.length} marketplace(s)`
        : `${read.plugins.length} plugin(s)`;
      row("ok", read.agent, read.configPath, detail);
    }
  }

  printPluginCoverageSection("bundle plugins", r.pluginCoverage.bundle, r.reads, "bundle");
  printPluginCoverageSection("npm plugins", r.pluginCoverage.npm, r.reads, "npm");

  if (r.marketplaceCoverage.length === 0) {
    console.log(dim("\nno marketplaces configured."));
  } else {
    const mktCohort = r.reads.filter((rd) => rd.supportsMarketplaces).length;
    console.log(dim(`\nmarketplaces:`));
    for (const c of r.marketplaceCoverage) {
      const tag = c.missing.length === 0 ? green(`[full]`) : yellow(`[${c.present.length}/${mktCohort}]`);
      const detail = c.missing.length === 0 ? "" : dim(` — missing in ${c.missing.join(", ")}`);
      console.log(`  ${tag} ${c.name}${detail}`);
    }
  }

  if (r.marketplaceConflicts.length) {
    console.log(yellow(`\n${r.marketplaceConflicts.length} marketplace conflict(s) — same name, different source:`));
    for (const c of r.marketplaceConflicts) {
      console.log(`  ${yellow("~")} ${c.name}`);
      for (const v of c.versions) console.log(`      ${dim(`${v.agent}: ${v.source}`)}`);
    }
    process.exit(1);
  }
}

function printPluginCoverageSection(
  title: string,
  rows: import("../src/plugin-doctor.ts").PluginCoverageRow[],
  reads: import("../src/plugins/types.ts").PluginAdapterRead[],
  kind: import("../src/plugins/types.ts").PluginKind,
) {
  if (rows.length === 0) return;
  const cohort = reads.filter((r) => r.pluginKind === kind).length;
  console.log(dim(`\n${title}:`));
  for (const c of rows) {
    const tag = c.missing.length === 0 ? green(`[full]`) : yellow(`[${c.present.length}/${cohort}]`);
    const detail = c.missing.length === 0 ? "" : dim(` — missing in ${c.missing.join(", ")}`);
    console.log(`  ${tag} ${c.name}${detail}`);
  }
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
  if (cmd === "skills") return cmdSkillsOnly();
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "status") return cmdStatus(rest);
  if (cmd === "mirror") return cmdMirror(rest);
  if (cmd === "from") return cmdFanOut(rest);
  if (cmd === "rm" || cmd === "remove") return cmdRemove(rest);
  if (cmd === "plugin" || cmd === "plugins") return cmdPlugin(rest);
  if (cmd === "marketplace" || cmd === "marketplaces") return cmdMarketplace(rest);

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
