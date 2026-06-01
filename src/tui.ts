import { intro, outro, select, multiselect, text, isCancel, cancel, log, note, spinner } from "@clack/prompts";
import { listAgentIds, runDirectional, runSync, runSkillsOnly, runRemove } from "./sync.ts";
import { runDoctor } from "./doctor.ts";
import { runMirror, mirrorHasChanges } from "./plugins/mirror.ts";
import { listPlugins, pluginAdapters } from "./plugins/index.ts";
import { buildPluginOverview } from "./plugins/overview.ts";
import { runPluginUninstall, uninstallHasChanges } from "./plugins/uninstall.ts";
import { runPluginAdd, pluginAddHasWork } from "./plugins/add.ts";
import { addSkillRepos, removeSkillNames, listInstalledSkills, skillCohort } from "./skills.ts";
import type { AgentId } from "./types.ts";

type PickerChoice =
  | "sync"
  | "mcp"
  | "skills"
  | "mirror"
  | "manage"
  | "directional"
  | "doctor"
  | "plugin-list"
  | "plugin-uninstall"
  | "quit";

export async function showInteractivePicker(): Promise<void> {
  intro("syncthis");

  note(
    "Copies your MCP servers, skills, and plugins between your AI coding agents\n" +
      "(Claude Code, Cursor, Codex, and 8 more).\n" +
      "It only ever ADDS — it never deletes, and asks before overwriting anything.",
    "what is this?",
  );

  const options: Array<{ value: PickerChoice; label: string; hint?: string }> = [
    { value: "sync", label: "Sync everything  (recommended)", hint: "share MCP servers + skills across every agent — only adds" },
    { value: "mirror", label: "Copy plugins across agents", hint: "install one agent's plugins on the others; the rest get the skills — only adds" },
    { value: "manage", label: "Add or remove capabilities", hint: "pick specific plugins / skills / MCP servers + agents to add or remove" },
    { value: "mcp", label: "MCP servers only", hint: "share MCP servers, skip the skills step" },
    { value: "skills", label: "Skills only", hint: "refresh skills via npx skills update" },
    { value: "directional", label: "Copy MCP from one agent to another  (advanced)", hint: "overwrites the destination — shows a diff, asks first" },
    { value: "doctor", label: "Check for problems", hint: "coverage + conflicts (read-only)" },
    { value: "plugin-list", label: "List installed plugins", hint: "overview across every agent (read-only)" },
    { value: "plugin-uninstall", label: "Uninstall plugins", hint: "remove plugin(s) + their surfaced skills from agents you pick" },
    { value: "quit", label: "Quit", hint: "" },
  ];
  const choice = (await select({
    message: "What do you want to do? (↑↓ to move, enter to pick)",
    initialValue: "sync" as PickerChoice,
    options,
  })) as PickerChoice | symbol;

  if (isCancel(choice) || choice === "quit") {
    cancel("aborted — nothing was changed.");
    return;
  }

  try {
    switch (choice) {
      case "sync":
        await doSync({ skipSkills: false });
        break;
      case "mcp":
        await doSync({ skipSkills: true });
        break;
      case "skills":
        await doSkills();
        break;
      case "mirror":
        await doMirror();
        break;
      case "manage":
        await doManage();
        break;
      case "directional":
        await doDirectional();
        break;
      case "doctor":
        await doDoctor();
        break;
      case "plugin-list":
        await doPluginList();
        break;
      case "plugin-uninstall":
        await doPluginUninstall();
        break;
    }
  } catch (err) {
    cancel(err instanceof Error ? err.message : String(err));
    return;
  }

  outro("Done. Re-run `syncthis` anytime, or `syncthis help` for the full command list.");
}

async function doSync(opts: { skipSkills?: boolean }) {
  const s = spinner();
  s.start(opts.skipSkills ? "Syncing MCP servers across agents…" : "Syncing MCP servers + skills across agents…");
  const r = await runSync({
    skipSkills: opts.skipSkills,
    onPluginSkillProgress: (repo, i, total) => s.message(`adding plugin skills to other agents… ${i}/${total} (${repo})`),
  });
  s.stop("Sync complete.");

  const names = new Set<string>();
  for (const read of r.reads) for (const n of Object.keys(read.servers)) names.add(n);
  log.success(`Shared ${names.size} MCP server(s) across ${r.reads.length} agents.`);
  if (r.conflicts.length) log.warn(`${r.conflicts.length} conflict(s) left untouched — run "Check for problems" (doctor) for detail.`);
  const failed = r.writes.filter((w) => w.status === "failed");
  if (failed.length) log.error(`${failed.length} agent(s) couldn't be written.`);

  if (r.pluginSkills?.ran) {
    const added = r.pluginSkills.results.filter((x) => x.status === "added").length;
    const skipped = r.pluginSkills.results.filter((x) => x.status === "skipped").length;
    const psFailed = r.pluginSkills.results.filter((x) => x.status === "failed").length;
    if (added || psFailed) {
      const parts = [`${added} added`, skipped ? `${skipped} already synced` : "", psFailed ? `${psFailed} failed` : ""].filter(Boolean);
      log.info(`Plugin skills → ${r.pluginSkills.agents.length} non-plugin agents: ${parts.join(", ")}.`);
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

async function doMirror() {
  const pluginAgents = pluginAdapters.map((a) => ({ value: a.id, label: a.id }));
  const primaryRaw = await select({
    message: "which agent is the source of truth (primary)?",
    options: pluginAgents,
  });
  if (isCancel(primaryRaw)) {
    cancel("aborted.");
    return;
  }
  const primary = primaryRaw as AgentId;

  // Provisioning is always on — registering missing marketplaces and falling
  // unloadable bundles back to skills is the whole point. No extra question.
  const provision = true;

  const preview = await runMirror({ from: primary, apply: false, provision });
  if (!mirrorHasChanges(preview)) {
    log.success("nothing to do — every agent already has the primary's plugin content.");
    return;
  }
  for (const t of preview.targets) {
    if (t.unsupportedReason) {
      log.info(`${t.to}: ${t.unsupportedReason}`);
      continue;
    }
    if (t.diff && t.diff.add.length) log.info(`${t.to}: +${t.diff.add.length} plugin(s)`);
  }
  if (preview.cursor.supported && preview.cursor.repos.length) {
    log.info(`cursor: +${preview.cursor.repos.length} repo(s) (npx plugins; additive)`);
  }
  const sc = preview.skillCohort;
  if (sc.supported && (sc.report?.sources.length ?? 0) > 0) {
    log.info(`skills → ${sc.agents.length} non-plugin agents: ${sc.report!.sources.length} source repo(s)`);
  }
  const mc = preview.mcpCohort;
  if (mc.supported && mc.servers.length > 0) {
    log.info(`mcp → ${mc.agents.length} non-plugin agents: ${mc.servers.length} bundled server(s) (additive)`);
  }
  const confirm = await select({
    message: `apply mirror from ${primary} → every other agent? (additive — never uninstalls)`,
    options: [
      { value: "no", label: "no" },
      { value: "yes", label: "yes — write changes" },
    ],
  });
  if (isCancel(confirm) || confirm === "no") {
    cancel("aborted.");
    return;
  }
  const s = spinner();
  s.start("Mirroring — installing plugins + adding skills via npx (network; can take a few minutes)…");
  // Stop the spinner on EVERY path — a throw would otherwise leave its render
  // interval running, clobbering the cancel() error line and keeping the loop alive.
  const applied = await runMirror({
    from: primary,
    apply: true,
    provision,
    onProgress: (label, i, total) => s.message(`${label}  (${i}/${total})`),
  }).catch((err) => {
    s.stop("Mirror failed.");
    throw err;
  });
  s.stop("Mirror applied.");

  let added = 0;
  let covered = 0;
  let skipped = 0;
  let failed = 0;
  for (const t of applied.targets) {
    for (const i of t.installs ?? []) {
      if (i.status === "failed") failed += 1;
      else if (i.status === "installed") added += 1;
      else if (i.status === "skipped") {
        if (i.skillsFallbackRepo) continue; // counted as a skills add below
        else if (i.coveredBy) covered += 1;
        else skipped += 1;
      }
    }
    for (const sf of t.skillsFallback ?? []) {
      if (sf.status === "failed") failed += 1;
      else if (sf.status === "added") added += 1;
      else skipped += 1; // "skipped" — bundle had no skills (matches the CLI tally)
    }
  }
  for (const res of applied.cursor.results) (res.status === "failed" ? (failed += 1) : (added += 1));
  if (!applied.cursor.supported && applied.cursor.reason) skipped += 1;
  if (!applied.skillCohort.supported && applied.skillCohort.reason) skipped += 1;
  for (const res of applied.skillCohort.report?.results ?? []) {
    if (res.status === "failed") failed += 1;
    else if (res.status === "added") added += 1;
  }
  if (!applied.mcpCohort.supported && applied.mcpCohort.reason) skipped += 1;
  for (const res of applied.mcpCohort.results ?? []) {
    if (res.status === "failed") failed += 1;
    else added += res.added.length; // count lifted servers, not agents
  }

  const summary = [
    `${added} added`,
    covered ? `${covered} already covered` : "",
    skipped ? `${skipped} skipped` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(", ");
  // Skips/covered are expected, not errors. Only a real CLI error fails loudly.
  if (failed > 0) log.error(`${summary} — run \`syncthis mirror ${primary}\` for detail`);
  else log.success(`mirror complete: ${summary}.`);
}

async function doDoctor() {
  const r = await runDoctor();
  const errors = r.reads.filter((rd) => rd.error).length;
  const missing = r.reads.filter((rd) => !rd.exists && !rd.error).length;
  const ok = r.reads.length - errors - missing;
  log.success(`${ok} agent(s) readable, ${missing} missing, ${errors} error(s)`);
  if (r.conflicts.length) log.warn(`${r.conflicts.length} conflict(s) — run \`syncthis doctor\` for detail`);
  if (r.unmanaged.length) log.info(`${r.unmanaged.length} unmanaged MCP config(s) detected`);
}

async function doPluginList() {
  const o = await buildPluginOverview();
  for (const r of o.native) {
    if (r.error) log.error(`${r.agent}: ${r.error}`);
    else if (!r.exists) log.info(`${r.agent}: no config`);
    else log.success(`${r.agent}: ${r.plugins.length} plugin(s) — ${r.plugins.map((p) => p.name).join(", ") || "none"}`);
  }
  log.info("cursor: write-only plugin target — not readable");
  if (!o.skillsReadable) {
    log.warn("plugin-derived skills: `npx skills list` unavailable");
    return;
  }
  if (o.derivedRepos.length === 0) {
    log.info("plugin-derived skills: none surfaced yet (run the mirror)");
    return;
  }
  const lines = o.derived.map((d) => `${d.agent}: ${d.skills.length}`).join("  ");
  log.info(`plugin-derived skills (from ${o.derivedRepos.join(", ")}):\n${lines}`);
}

async function doPluginUninstall() {
  // Candidate plugins = the native plugins installed on the plugin-capable agents.
  const reads = await listPlugins();
  const names = [...new Set(reads.flatMap((r) => (r.error ? [] : r.plugins.map((p) => p.name))))].sort();
  if (names.length === 0) {
    log.info("no plugins installed on claude-code or codex to uninstall.");
    return;
  }
  const pickedRaw = await multiselect({
    message: "which plugin(s) to uninstall? (space to toggle, enter to confirm)",
    options: names.map((n) => ({ value: n, label: n })),
    required: true,
  });
  if (isCancel(pickedRaw)) return cancel("aborted.");
  const plugins = pickedRaw as string[];

  // Actionable agents: the plugin-capable agents (native uninstall) + the skill
  // cohort (surfaced-skill removal). Cursor can't be uninstalled, so it's omitted.
  const agentChoices = [...new Set([...pluginAdapters.map((a) => a.id), ...skillCohort()])];
  const agentsRaw = await multiselect({
    message: "uninstall from which agents? (default: all)",
    options: agentChoices.map((a) => ({ value: a, label: a })),
    initialValues: agentChoices,
    required: true,
  });
  if (isCancel(agentsRaw)) return cancel("aborted.");
  const agents = agentsRaw as AgentId[];

  const preview = await runPluginUninstall({ plugins, agents, apply: false });
  if (!uninstallHasChanges(preview)) {
    log.success("nothing to do — none of those plugins are installed on the chosen agents.");
    return;
  }
  const nativeHits = preview.native.filter((t) => t.present).map((t) => `${t.agent}:${t.plugin}`);
  if (nativeHits.length) log.info(`native plugin uninstall: ${nativeHits.join(", ")}`);
  if (preview.skills.names.length && preview.skills.agents.length) {
    log.info(`remove ${preview.skills.names.length} surfaced skill(s) from ${preview.skills.agents.length} agent(s): ${preview.skills.names.join(", ")}`);
  }
  if (preview.skills.kept.length) log.info(`keeping (still provided by another plugin): ${preview.skills.kept.join(", ")}`);
  if (preview.claudeReadError && preview.skillScope.length) {
    log.warn(`couldn't read Claude's plugins (${preview.claudeReadError}) — surfaced skills on ${preview.skillScope.join(", ")} can't be resolved and will be left in place`);
  }

  const confirm = await select({
    message: "apply? this uninstalls plugins and removes their surfaced skills.",
    options: [
      { value: "no", label: "no" },
      { value: "yes", label: "yes — uninstall" },
    ],
  });
  if (isCancel(confirm) || confirm === "no") return cancel("aborted.");

  const s = spinner();
  s.start("Uninstalling…");
  const applied = await runPluginUninstall({
    plugins,
    agents,
    apply: true,
    onProgress: (label, i, total) => s.message(`${label}  (${i}/${total})`),
  }).catch((err) => {
    s.stop("Uninstall failed.");
    throw err;
  });
  s.stop("Uninstall applied.");

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
    log.warn(`claude unreadable (${applied.claudeReadError}) — surfaced skills on ${who.join(", ")} couldn't be resolved${applied.requiredSkillAgents.length ? " and were NOT removed" : " (native uninstall still applied)"}`);
  }
  if (failed > 0) log.error(`${removed} removed, ${failed} failed — run \`syncthis plugin rm\` for detail`);
  else log.success(`uninstall complete: ${removed} removed.`);
}

async function doDirectional() {
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
  if (preview.fromRead.error) throw new Error(`cannot read ${from}: ${preview.fromRead.error}`);
  if (preview.toRead.error) throw new Error(`cannot read ${to}: ${preview.toRead.error}`);
  log.info(`diff: +${preview.diff.add.length}  ~${preview.diff.overwrite.length}  -${preview.diff.remove.length}`);
  if (preview.diff.add.length === 0 && preview.diff.overwrite.length === 0 && preview.diff.remove.length === 0) {
    log.success("nothing to do.");
    return;
  }

  const confirm = await select({
    message: "apply?",
    options: [
      { value: "no", label: "no" },
      { value: "yes", label: `yes — write to ${to}` },
    ],
  });
  if (isCancel(confirm) || confirm === "no") return cancel("aborted.");

  await runDirectional({ from, to, apply: true });
  log.success(`wrote to ${to}`);
}

// Pick a set of agents (checkbox). Returns null on cancel (caller should return).
async function pickAgents(known: AgentId[], message: string, initial?: AgentId[]): Promise<AgentId[] | null> {
  const raw = await multiselect({
    message,
    options: known.map((a) => ({ value: a, label: a })),
    initialValues: initial,
    required: true,
  });
  if (isCancel(raw)) {
    cancel("aborted.");
    return null;
  }
  return raw as AgentId[];
}

async function confirmYes(message: string): Promise<boolean> {
  const c = await select({
    message,
    options: [
      { value: "no", label: "no" },
      { value: "yes", label: "yes" },
    ],
  });
  if (isCancel(c) || c === "no") {
    cancel("aborted.");
    return false;
  }
  return true;
}

// Unified add/remove control surface: capability → operation → items → agents.
async function doManage() {
  const capRaw = await select({
    message: "manage which capability?",
    options: [
      { value: "skill", label: "Skills", hint: "add a repo's skills, or remove installed skills" },
      { value: "plugin", label: "Plugins", hint: "add a plugin to chosen agents, or uninstall" },
      { value: "mcp", label: "MCP servers", hint: "remove a server from chosen agents (add an MCP via your agent's own CLI, then Sync)" },
    ],
  });
  if (isCancel(capRaw)) return cancel("aborted.");
  const cap = capRaw as "skill" | "plugin" | "mcp";

  const ops =
    cap === "mcp"
      ? [{ value: "remove", label: "Remove" }]
      : [
          { value: "add", label: "Add" },
          { value: "remove", label: "Remove" },
        ];
  const opRaw = await select({ message: `${cap}: add or remove?`, options: ops });
  if (isCancel(opRaw)) return cancel("aborted.");
  const op = opRaw as "add" | "remove";

  if (cap === "skill") return op === "add" ? manageSkillAdd() : manageSkillRemove();
  if (cap === "plugin") return op === "add" ? managePluginAdd() : doPluginUninstall();
  return manageMcpRemove();
}

async function manageSkillAdd() {
  const repoRaw = await text({
    message: "skill repo(s) to add (comma-separated, e.g. vercel-labs/agent-skills)",
    placeholder: "owner/repo, owner/other",
  });
  if (isCancel(repoRaw)) return cancel("aborted.");
  const repos = String(repoRaw).split(",").map((s) => s.trim()).filter(Boolean);
  if (repos.length === 0) return cancel("no repos given.");
  const agents = await pickAgents([...listAgentIds(), "pi"], "add these skills to which agents?");
  if (!agents) return;
  const s = spinner();
  s.start("npx skills add…");
  const results = await addSkillRepos(repos, agents).catch((e) => {
    s.stop("Add failed.");
    throw e;
  });
  s.stop("Done.");
  const failed = results.filter((r) => r.status === "failed");
  const added = results.length - failed.length;
  for (const f of failed) log.error(`${f.repo}: ${f.message ?? "failed"}`);
  if (failed.length) log.error(`${added} repo(s) added, ${failed.length} failed`);
  else log.success(`added ${added} repo(s) to ${agents.length} agent(s)`);
}

async function manageSkillRemove() {
  const installed = await listInstalledSkills();
  if (!installed || installed.length === 0) {
    log.info("no installed skills found (or `npx skills list` unavailable).");
    return;
  }
  const namesRaw = await multiselect({
    message: "remove which skill(s)?",
    options: installed.map((s) => ({ value: s.name, label: s.name, hint: s.agents.join(", ") })),
    required: true,
  });
  if (isCancel(namesRaw)) return cancel("aborted.");
  const names = namesRaw as string[];
  const agents = await pickAgents([...listAgentIds(), "pi"], "remove from which agents?");
  if (!agents) return;
  if (!(await confirmYes(`remove ${names.length} skill(s) from ${agents.length} agent(s)?`))) return;
  const s = spinner();
  s.start("npx skills remove…");
  const r = await removeSkillNames(names, agents).catch((e) => {
    s.stop("Remove failed.");
    throw e;
  });
  s.stop("Done.");
  if (r.status === "failed") log.error(r.message ?? "failed");
  else log.success(`removed ${r.skills.length} skill(s) from ${r.agents.length} agent(s)`);
}

async function managePluginAdd() {
  const reads = await listPlugins();
  const names = [...new Set(reads.flatMap((r) => (r.error ? [] : r.plugins.map((p) => p.name))))].sort();
  if (names.length === 0) {
    log.info("no plugins installed on claude-code/codex to add from.");
    return;
  }
  const pickRaw = await multiselect({
    message: "add which plugin(s)? (source: claude-code)",
    options: names.map((n) => ({ value: n, label: n })),
    required: true,
  });
  if (isCancel(pickRaw)) return cancel("aborted.");
  const plugins = pickRaw as string[];
  // Targets = every actionable agent except the source.
  const targets = [...new Set<AgentId>([...pluginAdapters.map((a) => a.id), "cursor", ...skillCohort()])].filter((a) => a !== "claude-code");
  const agents = await pickAgents(targets, "add to which agents?");
  if (!agents) return;
  const preview = await runPluginAdd({ plugins, agents, apply: false });
  if (preview.sourceError) {
    log.error(`can't read claude-code (the source): ${preview.sourceError}`);
    return;
  }
  if (preview.notFound.length) log.warn(`not installed on claude-code (the source): ${preview.notFound.join(", ")}`);
  if (!pluginAddHasWork(preview)) {
    log.success("nothing to do.");
    return;
  }
  if (!(await confirmYes("apply? installs via native CLIs + npx (network), may register Codex marketplaces."))) return;
  const s = spinner();
  s.start("Adding…");
  const applied = await runPluginAdd({
    plugins,
    agents,
    apply: true,
    onProgress: (label, i, total) => s.message(`${label}  (${i}/${total})`),
  }).catch((e) => {
    s.stop("Add failed.");
    throw e;
  });
  s.stop("Done.");
  if (applied.sourceError) {
    log.error(`couldn't read claude-code (the source) during apply: ${applied.sourceError}`);
    return;
  }
  let ok = 0;
  let failed = 0;
  for (const ins of applied.installs) ins.status === "failed" ? (failed += 1) : (ok += 1);
  for (const sk of applied.skills) sk.status === "failed" ? (failed += 1) : (ok += 1);
  for (const c of applied.cursor?.results ?? []) c.status === "failed" ? (failed += 1) : (ok += 1);
  for (const m of applied.mcp) {
    if (m.status === "failed") failed += 1;
    else if (m.added.length) ok += 1;
  }
  if (failed) log.error(`${ok} action(s) ok, ${failed} failed — run \`syncthis add plugin\` for detail`);
  else log.success(`add complete: ${ok} action(s).`);
}

async function manageMcpRemove() {
  const doc = await runDoctor();
  const names = doc.coverage.map((c) => c.name);
  if (names.length === 0) {
    log.info("no MCP servers configured in any agent.");
    return;
  }
  const pickRaw = await multiselect({
    message: "remove which MCP server(s)?",
    options: names.map((n) => ({ value: n, label: n })),
    required: true,
  });
  if (isCancel(pickRaw)) return cancel("aborted.");
  const servers = pickRaw as string[];
  const agents = await pickAgents(listAgentIds(), "remove from which agents?");
  if (!agents) return;
  if (!(await confirmYes(`remove ${servers.length} server(s) from ${agents.length} agent(s)?`))) return;
  const s = spinner();
  s.start("Removing…");
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
  } catch (e) {
    s.stop("Remove failed.");
    throw e;
  }
  s.stop("Done.");
  if (failed) log.error(`${changed} write(s), ${failed} failed`);
  else log.success(`removed (${changed} write(s)) across ${agents.length} agent(s)`);
}
