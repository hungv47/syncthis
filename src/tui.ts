import { intro, outro, select, isCancel, cancel, log, note, spinner } from "@clack/prompts";
import { listAgentIds, runDirectional, runSync, runSkillsOnly } from "./sync.ts";
import { runDoctor } from "./doctor.ts";
import { runMirror, mirrorHasChanges } from "./plugins/mirror.ts";
import { listPlugins, pluginAdapters } from "./plugins/index.ts";
import type { AgentId } from "./types.ts";

type PickerChoice =
  | "sync"
  | "mcp"
  | "skills"
  | "mirror"
  | "directional"
  | "doctor"
  | "plugin-list"
  | "quit";

export async function showInteractivePicker(): Promise<void> {
  intro("syncthis");

  note(
    "Shares your MCP servers + skills across every AI coding agent you use.\n" +
      "It reads what each agent already has — it doesn't install anything new.\n" +
      "Anything that overwrites or deletes always asks you first.",
    "what is this?",
  );

  const options: Array<{ value: PickerChoice; label: string; hint?: string }> = [
    { value: "sync", label: "Sync everything  (recommended)", hint: "share MCP servers + skills across all agents — only adds, never deletes" },
    { value: "mcp", label: "Sync MCP servers only", hint: "same as sync, but skip the skills step" },
    { value: "skills", label: "Update skills only", hint: "refresh skills via npx skills update -y" },
    { value: "mirror", label: "Copy plugins between agents", hint: "claude ↔ codex, and push to cursor — shows a preview, asks before writing" },
    { value: "directional", label: "Copy MCP servers from one agent to another", hint: "overwrites the destination — shows a diff, asks before writing" },
    { value: "doctor", label: "Check for problems", hint: "which servers each agent has + conflicts (read-only)" },
    { value: "plugin-list", label: "List installed plugins", hint: "what's installed per agent (read-only)" },
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
    message: "which agent is the primary (source of truth)?",
    options: pluginAgents,
  });
  if (isCancel(primaryRaw)) {
    cancel("aborted.");
    return;
  }
  const primary = primaryRaw as AgentId;

  const staleRaw = await select({
    message: "also uninstall plugins not in primary? (--remove-stale)",
    options: [
      { value: "no", label: "no — additive only (install missing)" },
      { value: "yes", label: "yes — also remove what primary doesn't have (destructive)" },
    ],
  });
  if (isCancel(staleRaw)) {
    cancel("aborted.");
    return;
  }
  const removeStale = staleRaw === "yes";

  const provisionRaw = await select({
    message: "provision missing marketplaces on the target? (--provision)",
    options: [
      { value: "no", label: "no — install only what the target can already resolve" },
      { value: "yes", label: "yes — register missing marketplaces via npx plugins (network, slower)" },
    ],
  });
  if (isCancel(provisionRaw)) {
    cancel("aborted.");
    return;
  }
  const provision = provisionRaw === "yes";

  const preview = await runMirror({ from: primary, apply: false, removeStale });
  if (!mirrorHasChanges(preview)) {
    log.success("nothing to do — all targets already match primary.");
    return;
  }
  for (const t of preview.targets) {
    if (t.unsupportedReason) {
      log.info(`${t.to}: ${t.unsupportedReason}`);
      continue;
    }
    if (!t.diff) continue;
    const adds = t.diff.add.length;
    const rms = t.diff.remove.length;
    if (adds || rms) log.info(`${t.to}: +${adds} -${rms}`);
  }
  const confirm = await select({
    message: `apply mirror from ${primary} → all?`,
    options: [
      { value: "no", label: "no" },
      { value: "yes", label: "yes — write changes" },
    ],
  });
  if (isCancel(confirm) || confirm === "no") {
    cancel("aborted.");
    return;
  }
  const applied = await runMirror({ from: primary, apply: true, removeStale, provision });
  let installed = 0;
  let skipped = 0;
  let failed = 0;
  for (const t of applied.targets) {
    for (const i of t.installs ?? []) {
      if (i.status === "failed") failed += 1;
      else if (i.status === "skipped") skipped += 1;
      else if (i.status === "installed") installed += 1;
    }
    for (const r of t.removes ?? []) if (r.status === "failed") failed += 1;
  }
  const summary = [
    `${installed} installed`,
    skipped ? `${skipped} skipped` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(", ");
  // Skips (no Codex marketplace / ambiguous) are expected, not errors. Only a
  // real install error makes this a failure worth flagging loudly.
  if (failed > 0) log.error(`${summary} — run \`syncthis mirror ${primary}\` for detail`);
  else log.success(`mirror complete: ${summary}.`);
  if (skipped > 0) log.info("some skipped plugins are skills bundles — run `syncthis run` to sync those as skills.");
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
  const reads = await listPlugins();
  for (const r of reads) {
    if (r.error) log.error(`${r.agent}: ${r.error}`);
    else if (!r.exists) log.info(`${r.agent}: no config`);
    else log.success(`${r.agent}: ${r.plugins.length} plugin(s)`);
  }
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
