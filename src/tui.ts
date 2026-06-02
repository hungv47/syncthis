import { intro, outro, select, text, isCancel, cancel, log, note, spinner } from "@clack/prompts";
import {
  findAdapter,
  listAgentIds,
  runRemove,
  runSelectiveMcpSync,
  runSkillsOnly,
  runSync,
  type SelectiveMcpReport,
} from "./sync.ts";
import { runDoctor } from "./doctor.ts";
import { mirrorHasChanges, runMirror, type MirrorReport } from "./plugins/mirror.ts";
import { listPlugins, pluginAdapters } from "./plugins/index.ts";
import { buildPluginOverview } from "./plugins/overview.ts";
import { runPluginUninstall, uninstallHasChanges } from "./plugins/uninstall.ts";
import { runPluginAdd, pluginAddHasWork, type PluginAddReport } from "./plugins/add.ts";
import { addSkillRepos, addSkillsFromPlugins, listInstalledSkills, removeSkillNames, skillCohort } from "./skills.ts";
import type { AgentId } from "./types.ts";
import type { PluginRecord } from "./plugins/types.ts";

const MAX_MENU_ITEMS = 12;

type MainChoice = "plugins" | "skills" | "mcp" | "doctor" | "quit";
type MenuOption<T extends string> = { value: T; label: string; hint?: string };
type MenuResult = "back" | "done";

class FlowCancel extends Error {}

export async function showInteractivePicker(): Promise<void> {
  intro("syncthis");

  note(
    "Pick a capability type first. Each manager asks for source, items, destinations, then preview/confirm.",
    "what is this?",
  );

  try {
    while (true) {
      const choice = await pickOne<MainChoice>("What do you want to manage?", [
        { value: "plugins", label: "Manage plugins", hint: "sync, list, remove" },
        { value: "skills", label: "Manage skills", hint: "add, update, sync from plugins, remove" },
        { value: "mcp", label: "Manage MCPs", hint: "sync or remove MCP servers" },
        { value: "doctor", label: "Check problems", hint: "MCP coverage + conflicts" },
        { value: "quit", label: "Quit" },
      ]);
      if (!choice || choice === "quit") {
        cancel("aborted - nothing was changed.");
        return;
      }

      let result: MenuResult = "done";
      switch (choice) {
        case "plugins":
          result = await managePlugins();
          break;
        case "skills":
          result = await manageSkills();
          break;
        case "mcp":
          result = await manageMcps();
          break;
        case "doctor":
          await doDoctor();
          result = "done";
          break;
      }
      if (result === "back") continue;
      break;
    }
  } catch (err) {
    if (err instanceof FlowCancel) return;
    cancel(err instanceof Error ? err.message : String(err));
    return;
  }

  outro("Done. Re-run `syncthis` anytime, or `syncthis help` for the full command list.");
}

async function managePlugins(): Promise<MenuResult> {
  const op = await pickOne<"sync" | "mirror" | "list" | "remove" | "back">("Plugins: what do you want to do?", [
    { value: "sync", label: "Sync selected plugins", hint: "Claude source, choose plugins and destination agents" },
    { value: "mirror", label: "Mirror all from source", hint: "Claude or Codex source, additive" },
    { value: "list", label: "List installed plugins", hint: "read-only overview" },
    { value: "remove", label: "Remove plugins", hint: "guarded uninstall + surfaced skill removal" },
    { value: "back", label: "Back" },
  ]);
  if (!op || op === "back") return "back";
  if (op === "sync") await syncPlugins();
  else if (op === "mirror") await mirrorPluginsFromSource();
  else if (op === "list") await doPluginList();
  else await removePlugins();
  return "done";
}

async function manageSkills(): Promise<MenuResult> {
  const op = await pickOne<"add" | "plugin-derived" | "update" | "remove" | "back">("Skills: what do you want to do?", [
    { value: "add", label: "Add from repo", hint: "npx skills add <repo>" },
    { value: "plugin-derived", label: "Sync from plugins", hint: "surface Claude plugin skills to chosen agents" },
    { value: "update", label: "Update installed skills", hint: "npx skills update -y" },
    { value: "remove", label: "Remove skills", hint: "guarded npx skills remove" },
    { value: "back", label: "Back" },
  ]);
  if (!op || op === "back") return "back";
  if (op === "add") await addSkillsFromRepo();
  else if (op === "plugin-derived") await syncPluginDerivedSkills();
  else if (op === "update") await doSkills();
  else await removeSkills();
  return "done";
}

async function manageMcps(): Promise<MenuResult> {
  const op = await pickOne<"sync" | "everything" | "mcp-only" | "remove" | "doctor" | "back">("MCPs: what do you want to do?", [
    { value: "everything", label: "Sync everything", hint: "MCP union + plugin-derived skills + skills update" },
    { value: "sync", label: "Sync selected MCPs", hint: "add selected servers from one agent to others" },
    { value: "mcp-only", label: "Sync all MCPs only", hint: "union sync across every MCP agent, skip skills" },
    { value: "remove", label: "Remove MCPs", hint: "explicit scope + diff + confirm" },
    { value: "doctor", label: "Check problems", hint: "coverage + conflicts" },
    { value: "back", label: "Back" },
  ]);
  if (!op || op === "back") return "back";
  if (op === "sync") await syncSelectedMcps();
  else if (op === "everything") await doSync({ skipSkills: false });
  else if (op === "mcp-only") await doSync({ skipSkills: true });
  else if (op === "doctor") await doDoctor();
  else await removeMcps();
  return "done";
}

async function doSync(opts: { skipSkills?: boolean }) {
  const s = spinner();
  s.start(opts.skipSkills ? "Syncing MCP servers across agents..." : "Syncing MCP servers + skills across agents...");
  const r = await runSync({
    skipSkills: opts.skipSkills,
    onPluginSkillProgress: (repo, i, total) => s.message(`adding plugin skills to other agents... ${i}/${total} (${repo})`),
  });
  s.stop("Sync complete.");

  const names = new Set<string>();
  for (const read of r.reads) for (const n of Object.keys(read.servers)) names.add(n);
  log.success(`Shared ${names.size} MCP server(s) across ${r.reads.length} agents.`);
  if (r.conflicts.length) log.warn(`${r.conflicts.length} conflict(s) left untouched - run "Check problems" for detail.`);
  const failed = r.writes.filter((w) => w.status === "failed");
  if (failed.length) log.error(`${failed.length} agent(s) couldn't be written.`);

  if (r.pluginSkills?.ran) {
    const added = r.pluginSkills.results.filter((x) => x.status === "added").length;
    const skipped = r.pluginSkills.results.filter((x) => x.status === "skipped").length;
    const psFailed = r.pluginSkills.results.filter((x) => x.status === "failed").length;
    if (added || psFailed) {
      const parts = [`${added} added`, skipped ? `${skipped} already synced` : "", psFailed ? `${psFailed} failed` : ""].filter(Boolean);
      log.info(`Plugin skills -> ${r.pluginSkills.agents.length} non-plugin agents: ${parts.join(", ")}.`);
    }
  }

  if (r.skills) {
    if (!r.skills.ran) log.info(`Skills update: ${r.skills.message ?? "skipped"}.`);
    else if (r.skills.ok) log.success("Skills refreshed (npx skills update).");
    else log.error(`Skills update failed: ${r.skills.message ?? "unknown error"}.`);
  }
}

async function doSkills() {
  const r = await runSkillsOnly();
  if (r.ok) log.success("skills: npx skills update -y");
  else log.error(`skills: ${r.message ?? "failed"}`);
}

async function doDoctor() {
  const r = await runDoctor();
  const errors = r.reads.filter((rd) => rd.error).length;
  const missing = r.reads.filter((rd) => !rd.exists && !rd.error).length;
  const ok = r.reads.length - errors - missing;
  log.success(`${ok} agent(s) readable, ${missing} missing, ${errors} error(s)`);
  if (r.conflicts.length) log.warn(`${r.conflicts.length} conflict(s) - run \`syncthis doctor\` for detail`);
  if (r.unmanaged.length) log.info(`${r.unmanaged.length} unmanaged MCP config(s) detected`);
}

async function doPluginList() {
  const o = await buildPluginOverview();
  for (const r of o.native) {
    if (r.error) log.error(`${r.agent}: ${r.error}`);
    else if (!r.exists) log.info(`${r.agent}: no config`);
    else log.success(`${r.agent}: ${r.plugins.length} plugin(s) - ${dedupe(r.plugins.map((p) => p.name)).join(", ") || "none"}`);
  }
  log.info("cursor: write-only plugin target - not readable");
  if (!o.skillsReadable) {
    log.warn("plugin-derived skills: `npx skills list` unavailable");
    return;
  }
  if (o.derivedRepos.length === 0) {
    log.info("plugin-derived skills: none surfaced yet (run the mirror/sync flow)");
    return;
  }
  const lines = o.derived.map((d) => `${d.agent}: ${d.skills.length}`).join("  ");
  log.info(`plugin-derived skills (from ${o.derivedRepos.join(", ")}):\n${lines}`);
}

async function syncPlugins() {
  const source = await pickOne<AgentId>("plugin source agent", [
    { value: "claude-code", label: "claude-code", hint: "required for GitHub repo fallback into skills/MCPs" },
  ]);
  if (!source) return;

  const adapter = pluginAdapters.find((a) => a.id === source);
  if (!adapter) throw new Error(`plugin source is not supported: ${source}`);
  const read = await adapter.read();
  if (read.error) {
    log.error(`can't read ${source}: ${read.error}`);
    return;
  }

  const plugins = await pickManyPaged("choose plugin(s) to sync", pluginOptions(read.plugins));
  if (!plugins) return;

  const targets = pluginTargetAgents(source);
  const agents = await pickAgents(targets, "choose destination agent(s)");
  if (!agents) return;

  const preview = await runPluginAdd({ plugins, agents, apply: false });
  if (preview.sourceError) {
    log.error(`can't read claude-code (the source): ${preview.sourceError}`);
    return;
  }
  if (preview.notFound.length) log.warn(`not installed on claude-code: ${preview.notFound.join(", ")}`);
  printPluginAddPreview(preview);
  if (!pluginAddHasWork(preview)) {
    log.success("nothing to do.");
    return;
  }

  if (!(await confirmYes("apply plugin sync? native agents get plugins; non-plugin agents get derived skills/MCPs."))) return;
  const s = spinner();
  s.start("Syncing plugins...");
  const applied = await runPluginAdd({
    plugins,
    agents,
    apply: true,
    onProgress: (label, i, total) => s.message(`${label}  (${i}/${total})`),
  }).catch((err) => {
    s.stop("Plugin sync failed.");
    throw err;
  });
  s.stop("Plugin sync applied.");
  printPluginAddApplied(applied);
}

async function mirrorPluginsFromSource() {
  const source = await pickOne<AgentId>(
    "mirror plugins from which source agent?",
    pluginAdapters.map((a) => ({ value: a.id, label: a.id })),
  );
  if (!source) return;

  const preview = await runMirror({ from: source, apply: false, provision: true });
  if (!mirrorHasChanges(preview)) {
    log.success("nothing to do - every reachable target already has the source plugin content.");
    return;
  }
  printMirrorPreview(preview);
  if (!(await confirmYes(`apply mirror from ${source} to every reachable agent?`))) return;

  const s = spinner();
  s.start("Mirroring plugins...");
  const applied = await runMirror({
    from: source,
    apply: true,
    provision: true,
    onProgress: (label, i, total) => s.message(`${label}  (${i}/${total})`),
  }).catch((err) => {
    s.stop("Mirror failed.");
    throw err;
  });
  s.stop("Mirror applied.");
  printMirrorApplied(applied);
}

async function removePlugins() {
  const reads = await listPlugins();
  const names = dedupe(reads.flatMap((r) => (r.error ? [] : r.plugins.map((p) => p.name)))).sort();
  if (names.length === 0) {
    log.info("no plugins installed on claude-code or codex to uninstall.");
    return;
  }

  const plugins = await pickManyPaged("choose plugin(s) to remove", names.map((n) => ({ value: n, label: n })));
  if (!plugins) return;

  const agentChoices = dedupe([...pluginAdapters.map((a) => a.id), ...skillCohort()]);
  const agents = await pickAgents(agentChoices, "remove from which agents?", agentChoices);
  if (!agents) return;

  const preview = await runPluginUninstall({ plugins, agents, apply: false });
  if (!uninstallHasChanges(preview)) {
    log.success("nothing to do - none of those plugins are installed on the chosen agents.");
    return;
  }
  const nativeHits = preview.native.filter((t) => t.present).map((t) => `${t.agent}:${t.plugin}`);
  if (nativeHits.length) log.info(`native plugin uninstall: ${nativeHits.join(", ")}`);
  if (preview.skills.names.length && preview.skills.agents.length) {
    log.info(`remove ${preview.skills.names.length} surfaced skill(s) from ${preview.skills.agents.length} agent(s): ${preview.skills.names.join(", ")}`);
  }
  if (preview.skills.kept.length) log.info(`keeping (still provided by another plugin): ${preview.skills.kept.join(", ")}`);
  if (preview.claudeReadError && preview.skillScope.length) {
    log.warn(`couldn't read Claude's plugins (${preview.claudeReadError}) - surfaced skills on ${preview.skillScope.join(", ")} can't be resolved and will be left in place`);
  }

  if (!(await confirmYes("apply? this uninstalls plugins and removes their surfaced skills."))) return;

  const s = spinner();
  s.start("Removing plugins...");
  const applied = await runPluginUninstall({
    plugins,
    agents,
    apply: true,
    onProgress: (label, i, total) => s.message(`${label}  (${i}/${total})`),
  }).catch((err) => {
    s.stop("Remove failed.");
    throw err;
  });
  s.stop("Remove applied.");

  let removed = 0;
  let failed = 0;
  for (const res of applied.nativeResults ?? []) {
    if (res.status === "uninstalled") removed += 1;
    else if (res.status === "failed") failed += 1;
  }
  if (applied.skillResult) {
    if (applied.skillResult.status === "removed") removed += applied.skillResult.skills.length;
    else if (applied.skillResult.status === "failed") failed += 1;
  }
  if (applied.claudeReadError && applied.skillScope.length) {
    const who = applied.requiredSkillAgents.length ? applied.requiredSkillAgents : applied.skillScope;
    log.warn(`claude unreadable (${applied.claudeReadError}) - surfaced skills on ${who.join(", ")} couldn't be resolved${applied.requiredSkillAgents.length ? " and were NOT removed" : " (native uninstall still applied)"}`);
  }
  if (failed > 0) log.error(`${removed} removed, ${failed} failed - run \`syncthis plugin rm\` for detail`);
  else log.success(`remove complete: ${removed} removed.`);
}

async function addSkillsFromRepo() {
  const repoRaw = await text({
    message: "skill repo(s) to add (comma-separated)",
    placeholder: "owner/repo, owner/other",
  });
  if (isCancel(repoRaw)) stopFlow();
  const repos = dedupe(String(repoRaw).split(",").map((s) => s.trim()).filter(Boolean)).sort();
  if (repos.length === 0) stopFlow("no repos given.");

  const agents = await pickAgents(skillTargetAgents(), "add these skills to which agents?");
  if (!agents) return;

  log.info(`will run ${repos.length} repo add(s): ${formatSkillAddTargets(agents)}`);
  if (!(await confirmYes("apply skill add?"))) return;

  const s = spinner();
  s.start("Adding skills...");
  const results = await addSkillRepos(repos, agents).catch((err) => {
    s.stop("Add failed.");
    throw err;
  });
  s.stop("Done.");
  const failed = results.filter((r) => r.status === "failed");
  const added = results.filter((r) => r.status === "added").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  for (const f of failed) log.error(`${f.repo}: ${f.message ?? "failed"}`);
  if (failed.length) log.error(`${added} added, ${skipped} skipped, ${failed.length} failed`);
  else log.success(`skills add complete: ${added} added${skipped ? `, ${skipped} skipped` : ""}.`);
}

async function syncPluginDerivedSkills() {
  const agents = await pickAgents(skillCohort(), "sync plugin-derived skills to which agents?", skillCohort());
  if (!agents) return;

  const preview = await addSkillsFromPlugins({ dryRun: true, agents, force: true });
  if (!preview.ran) {
    log.info(preview.message ?? "no plugin-derived skills found.");
    return;
  }
  const wouldAdd = preview.results.filter((r) => r.status === "added").length;
  const skipped = preview.results.filter((r) => r.status === "skipped").length;
  log.info(`plugin-derived skills: ${preview.sources.length} source repo(s), ${wouldAdd} would add, ${skipped} already synced.`);
  if (!(await confirmYes(`sync plugin-derived skills to ${agents.length} agent(s)?`))) return;

  const s = spinner();
  s.start("Syncing plugin-derived skills...");
  const applied = await addSkillsFromPlugins({
    agents,
    force: true,
    onProgress: (repo, i, total) => s.message(`${repo}  (${i}/${total})`),
  }).catch((err) => {
    s.stop("Skill sync failed.");
    throw err;
  });
  s.stop("Done.");
  const added = applied.results.filter((r) => r.status === "added").length;
  const failed = applied.results.filter((r) => r.status === "failed").length;
  const already = applied.results.filter((r) => r.status === "skipped").length;
  if (failed) log.error(`${added} added, ${already} skipped, ${failed} failed`);
  else log.success(`plugin-derived skills synced: ${added} added, ${already} skipped.`);
}

async function removeSkills() {
  const installed = await listInstalledSkills();
  if (!installed || installed.length === 0) {
    log.info("no installed skills found (or `npx skills list` unavailable).");
    return;
  }
  const skills = await pickManyPaged(
    "choose skill(s) to remove",
    installed.map((s) => ({ value: s.name, label: s.name, hint: s.agents.join(", ") })),
  );
  if (!skills) return;

  const agents = await pickAgents(skillTargetAgents(), "remove from which agents?");
  if (!agents) return;
  if (!(await confirmYes(`remove ${skills.length} skill(s) from ${agents.length} agent(s)?`))) return;

  const s = spinner();
  s.start("Removing skills...");
  const r = await removeSkillNames(skills, agents).catch((err) => {
    s.stop("Remove failed.");
    throw err;
  });
  s.stop("Done.");
  if (r.status === "failed") log.error(r.message ?? "failed");
  else log.success(`removed ${r.skills.length} skill(s) from ${r.agents.length} agent(s)`);
}

async function syncSelectedMcps() {
  const source = await pickOne<AgentId>("MCP source agent", listAgentIds().map((id) => ({ value: id, label: id })));
  if (!source) return;

  const adapter = findAdapter(source);
  if (!adapter) throw new Error(`unknown MCP source agent: ${source}`);
  const read = await adapter.read();
  if (read.error) {
    log.error(`can't read ${source}: ${read.error}`);
    return;
  }
  const names = Object.keys(read.servers).sort();
  if (names.length === 0) {
    log.info(`${source} has no MCP servers configured.`);
    return;
  }

  const servers = await pickManyPaged("choose MCP server(s) to sync", names.map((n) => ({ value: n, label: n })));
  if (!servers) return;

  const destinations = await pickAgents(listAgentIds().filter((id) => id !== source), "choose destination agent(s)");
  if (!destinations) return;

  const preview = await runSelectiveMcpSync({ from: source, to: destinations, names: servers, apply: false });
  printMcpSyncPreview(preview);
  if (!hasMcpSyncChanges(preview)) {
    log.success("nothing to do - selected MCPs are already present or only conflict.");
    return;
  }
  if (!(await confirmYes("apply MCP sync? existing conflicting servers stay untouched."))) return;

  const s = spinner();
  s.start("Syncing selected MCPs...");
  const applied = await runSelectiveMcpSync({ from: source, to: destinations, names: servers, apply: true }).catch((err) => {
    s.stop("MCP sync failed.");
    throw err;
  });
  s.stop("Done.");
  printMcpSyncApplied(applied);
}

async function removeMcps() {
  const doc = await runDoctor();
  const names = doc.coverage.map((c) => c.name).sort();
  if (names.length === 0) {
    log.info("no MCP servers configured in any agent.");
    return;
  }
  const servers = await pickManyPaged("choose MCP server(s) to remove", names.map((n) => ({ value: n, label: n })));
  if (!servers) return;

  const agents = await pickAgents(listAgentIds(), "remove from which agents?");
  if (!agents) return;

  let willChange = false;
  for (const name of servers) {
    const preview = await runRemove({ name, agents, apply: false });
    const hits = preview.writes.filter((w) => w.status === "synced").map((w) => w.agent);
    if (hits.length) {
      willChange = true;
      log.info(`- ${name}: remove from ${hits.join(", ")}`);
    } else {
      log.info(`- ${name}: not present on the chosen agents`);
    }
  }
  if (!willChange) {
    log.success("nothing to do - none of those servers are on the chosen agents.");
    return;
  }
  if (!(await confirmYes(`remove ${servers.length} server(s) from ${agents.length} agent(s)?`))) return;

  const s = spinner();
  s.start("Removing MCPs...");
  let changed = 0;
  let failed = 0;
  try {
    for (const name of servers) {
      const r = await runRemove({ name, agents, apply: true });
      for (const w of r.writes) {
        if (w.status === "failed") failed += 1;
        else if (w.status === "synced") changed += 1;
      }
    }
  } catch (err) {
    s.stop("Remove failed.");
    throw err;
  }
  s.stop("Done.");
  if (failed) log.error(`${changed} write(s), ${failed} failed`);
  else log.success(`removed (${changed} write(s)) across ${agents.length} agent(s)`);
}

function printPluginAddPreview(report: PluginAddReport) {
  if (report.installs.length) log.info(`native plugin installs: ${report.installs.length}`);
  if (report.cursor?.repos.length) log.info(`cursor: ${report.cursor.repos.length} repo push(es) via npx plugins`);
  if (report.skills.length) log.info(`skills fallback: ${report.skills.length} repo add(s) via npx skills`);
  const mcpAdds = report.mcp.reduce((sum, r) => sum + r.added.length, 0);
  const mcpConflicts = report.mcp.reduce((sum, r) => sum + r.conflicts.length, 0);
  if (mcpAdds || mcpConflicts) log.info(`plugin MCP lift: ${mcpAdds} add(s), ${mcpConflicts} conflict(s) left untouched`);
}

function printPluginAddApplied(report: PluginAddReport) {
  let ok = 0;
  let failed = 0;
  for (const ins of report.installs) ins.status === "failed" ? (failed += 1) : (ok += 1);
  for (const sk of report.skills) sk.status === "failed" ? (failed += 1) : (ok += 1);
  for (const c of report.cursor?.results ?? []) c.status === "failed" ? (failed += 1) : (ok += 1);
  for (const m of report.mcp) {
    if (m.status === "failed") failed += 1;
    else if (m.added.length) ok += 1;
  }
  if (failed) log.error(`${ok} action(s) ok, ${failed} failed - run \`syncthis add plugin\` for detail`);
  else log.success(`plugin sync complete: ${ok} action(s).`);
}

function printMirrorPreview(report: MirrorReport) {
  for (const t of report.targets) {
    if (t.unsupportedReason) {
      log.info(`${t.to}: ${t.unsupportedReason}`);
      continue;
    }
    if (t.diff?.add.length) log.info(`${t.to}: +${t.diff.add.length} plugin(s)`);
  }
  if (report.cursor.supported && report.cursor.repos.length) {
    log.info(`cursor: +${report.cursor.repos.length} repo push(es) via npx plugins`);
  }
  if (report.skillCohort.supported && (report.skillCohort.report?.sources.length ?? 0) > 0) {
    log.info(`skills: ${report.skillCohort.report!.sources.length} source repo(s) to ${report.skillCohort.agents.length} non-plugin agent(s)`);
  }
  if (report.mcpCohort.supported && report.mcpCohort.servers.length > 0) {
    log.info(`mcp: ${report.mcpCohort.servers.length} bundled server(s) to ${report.mcpCohort.agents.length} non-plugin agent(s)`);
  }
}

function printMirrorApplied(report: MirrorReport) {
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const t of report.targets) {
    for (const i of t.installs ?? []) {
      if (i.status === "failed") failed += 1;
      else if (i.status === "installed") ok += 1;
      else skipped += 1;
    }
    for (const sf of t.skillsFallback ?? []) {
      if (sf.status === "failed") failed += 1;
      else if (sf.status === "added") ok += 1;
      else skipped += 1;
    }
  }
  for (const res of report.cursor.results) (res.status === "failed" ? (failed += 1) : (ok += 1));
  for (const res of report.skillCohort.report?.results ?? []) {
    if (res.status === "failed") failed += 1;
    else if (res.status === "added") ok += 1;
    else skipped += 1;
  }
  for (const res of report.mcpCohort.results ?? []) {
    if (res.status === "failed") failed += 1;
    else ok += res.added.length;
  }
  if (failed) log.error(`mirror complete with problems: ${ok} added, ${skipped} skipped, ${failed} failed`);
  else log.success(`mirror complete: ${ok} added${skipped ? `, ${skipped} skipped` : ""}.`);
}

function printMcpSyncPreview(report: SelectiveMcpReport) {
  if (report.notFound.length) log.warn(`not found on ${report.from}: ${report.notFound.join(", ")}`);
  for (const t of report.targets) {
    if (t.toRead.error) {
      log.error(`${t.to}: ${t.toRead.error}`);
      continue;
    }
    if (t.add.length) log.info(`${t.to}: +${t.add.join(", ")}`);
    if (t.conflicts.length) log.warn(`${t.to}: conflict(s) left untouched: ${t.conflicts.join(", ")}`);
  }
}

function printMcpSyncApplied(report: SelectiveMcpReport) {
  const added = report.targets.reduce((sum, t) => sum + t.add.length, 0);
  const failed = report.targets.filter((t) => t.write?.status === "failed").length;
  const conflicts = report.targets.reduce((sum, t) => sum + t.conflicts.length, 0);
  if (failed) log.error(`${added} MCP add(s), ${conflicts} conflict(s), ${failed} failed write(s)`);
  else log.success(`MCP sync complete: ${added} add(s), ${conflicts} conflict(s) left untouched.`);
}

function hasMcpSyncChanges(report: SelectiveMcpReport): boolean {
  return report.targets.some((t) => t.add.length > 0);
}

async function pickOne<T extends string>(
  message: string,
  options: Array<MenuOption<T>>,
  initialValue?: T,
): Promise<T | null> {
  const clean = dedupeOptions(options);
  if (clean.length === 0) {
    log.info("nothing to choose.");
    return null;
  }
  const raw = await select({
    message,
    options: clean as any,
    initialValue,
    maxItems: MAX_MENU_ITEMS,
  });
  if (isCancel(raw)) {
    stopFlow();
  }
  return raw as T;
}

async function pickManyPaged<T extends string>(
  message: string,
  options: Array<MenuOption<T>>,
  initialValues: T[] = [],
): Promise<T[] | null> {
  const clean = dedupeOptions(options);
  if (clean.length === 0) {
    log.info("nothing to choose.");
    return null;
  }

  const selected = new Set(initialValues.filter((v) => clean.some((o) => o.value === v)));
  let cursor = "done";
  while (true) {
    const rows: Array<MenuOption<string>> = [
      { value: "done", label: `Done (${selected.size} selected)` },
      { value: "all", label: selected.size === clean.length ? "Clear all" : "Select all" },
      ...clean.map((o, i) => ({
        value: `item:${i}`,
        label: `${selected.has(o.value) ? "[x]" : "[ ]"} ${o.label}`,
        hint: o.hint,
      })),
      { value: "cancel", label: "Cancel" },
    ];

    const raw = await select({
      message: `${message} (enter toggles; choose Done to continue)`,
      options: rows,
      initialValue: cursor,
      maxItems: MAX_MENU_ITEMS,
    });
    if (isCancel(raw) || raw === "cancel") {
      stopFlow();
    }
    if (raw === "done") {
      if (selected.size === 0) {
        log.warn("choose at least one item.");
        continue;
      }
      return clean.filter((o) => selected.has(o.value)).map((o) => o.value);
    }
    if (raw === "all") {
      if (selected.size === clean.length) selected.clear();
      else for (const o of clean) selected.add(o.value);
      cursor = "done";
      continue;
    }
    const idx = Number(String(raw).replace("item:", ""));
    const item = clean[idx];
    if (!item) continue;
    if (selected.has(item.value)) selected.delete(item.value);
    else selected.add(item.value);
    cursor = String(raw);
  }
}

async function pickAgents(known: AgentId[], message: string, initial?: AgentId[]): Promise<AgentId[] | null> {
  return pickManyPaged(message, known.map((a) => ({ value: a, label: a })), initial);
}

async function confirmYes(message: string): Promise<boolean> {
  const c = await pickOne<"no" | "yes">(message, [
    { value: "no", label: "No" },
    { value: "yes", label: "Yes" },
  ]);
  if (c !== "yes") {
    stopFlow();
  }
  return true;
}

function stopFlow(message = "aborted."): never {
  cancel(message);
  throw new FlowCancel(message);
}

function pluginOptions(plugins: PluginRecord[]): Array<MenuOption<string>> {
  const groups = new Map<string, PluginRecord[]>();
  for (const p of plugins) groups.set(p.name, [...(groups.get(p.name) ?? []), p]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, records]) => ({
      value: name,
      label: name,
      hint: records.length > 1 ? `${records.length} installed entries` : records[0]?.marketplace,
    }));
}

function pluginTargetAgents(source: AgentId): AgentId[] {
  return dedupe<AgentId>([...pluginAdapters.map((a) => a.id), "cursor", ...skillCohort()]).filter((a) => a !== source);
}

function skillTargetAgents(): AgentId[] {
  return dedupe<AgentId>([...listAgentIds(), "pi"]);
}

function formatSkillAddTargets(agents: AgentId[]): string {
  return agents.map((a) => `-a ${a}`).join(" ");
}

function dedupe<T extends string>(items: T[]): T[] {
  return [...new Set(items)];
}

function dedupeOptions<T extends string>(options: Array<MenuOption<T>>): Array<MenuOption<T>> {
  const out: Array<MenuOption<T>> = [];
  const seen = new Set<T>();
  for (const option of options) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    out.push(option);
  }
  return out;
}
