import { intro, outro, select, multiselect, isCancel, cancel, log, note, spinner } from "@clack/prompts";
import { listAgentIds, runDirectional, runSync, runSkillsOnly } from "./sync.ts";
import { runDoctor } from "./doctor.ts";
import { runMirror, mirrorHasChanges } from "./plugins/mirror.ts";
import { listPlugins, pluginAdapters } from "./plugins/index.ts";
import { buildPluginOverview } from "./plugins/overview.ts";
import { runPluginUninstall, uninstallHasChanges } from "./plugins/uninstall.ts";
import { skillCohort } from "./skills.ts";
import type { AgentId } from "./types.ts";

type PickerChoice =
  | "sync"
  | "mcp"
  | "skills"
  | "mirror"
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
