import { intro, outro, select, isCancel, cancel, log } from "@clack/prompts";
import { listAgentIds, runDirectional, runSync, runSkillsOnly } from "./sync.ts";
import { runDoctor } from "./doctor.ts";
import { buildStatusReport, cellGlyph } from "./plugins/status.ts";
import { runFixers } from "./plugins/fixers.ts";
import { runMirror, mirrorHasChanges } from "./plugins/mirror.ts";
import { listPlugins, runPluginDoctor } from "./plugin-doctor.ts";
import { pluginAdapters } from "./plugins/index.ts";
import type { AgentId } from "./types.ts";

type PickerChoice =
  | "sync"
  | "mcp"
  | "skills"
  | "status"
  | "fix"
  | "mirror"
  | "directional"
  | "doctor"
  | "plugin-list"
  | "plugin-doctor"
  | "quit";

export async function showInteractivePicker(): Promise<void> {
  intro("syncthis");

  const choice = (await select({
    message: "what do you want to do?",
    options: [
      { value: "sync", label: "sync — MCP union + skills + auto-repair (all agents)" },
      { value: "mcp", label: "mcp — MCP union only (no skills, no repair)" },
      { value: "skills", label: "skills — `npx skills update -y`" },
      { value: "status", label: "status — plugin × agent matrix (find silent failures)" },
      { value: "fix", label: "fix — repair silent-failure plugin installs" },
      { value: "mirror", label: "mirror — destructive plugin push from one primary → all" },
      { value: "directional", label: "directional — one-way MCP mirror between two agents" },
      { value: "doctor", label: "doctor — MCP coverage + conflicts" },
      { value: "plugin-list", label: "plugin list — what's installed per agent" },
      { value: "plugin-doctor", label: "plugin doctor — plugin/marketplace coverage" },
      { value: "quit", label: "quit" },
    ],
  })) as PickerChoice | symbol;

  if (isCancel(choice) || choice === "quit") {
    cancel("aborted.");
    return;
  }

  try {
    switch (choice) {
      case "sync":
        await doSync({ skipSkills: false });
        break;
      case "mcp":
        await doSync({ skipSkills: true, skipRepair: true });
        break;
      case "skills":
        await doSkills();
        break;
      case "status":
        await doStatus();
        break;
      case "fix":
        await doFix();
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
      case "plugin-doctor":
        await doPluginDoctor();
        break;
    }
  } catch (err) {
    cancel(err instanceof Error ? err.message : String(err));
    return;
  }

  outro("done. run `syncthis help` for non-interactive commands.");
}

async function doSync(opts: { skipSkills?: boolean; skipRepair?: boolean }) {
  const r = await runSync({ skipSkills: opts.skipSkills });
  const names = new Set<string>();
  for (const read of r.reads) for (const n of Object.keys(read.servers)) names.add(n);
  log.success(`${names.size} server name(s) across ${r.reads.length} agent(s)`);
  if (r.conflicts.length) log.warn(`${r.conflicts.length} conflict(s) — left untouched, see \`syncthis doctor\``);
  const failed = r.writes.filter((w) => w.status === "failed");
  if (failed.length) log.error(`${failed.length} adapter write(s) failed`);

  if (r.skills) {
    if (!r.skills.ran) log.info(`skills: ${r.skills.message ?? "skipped"}`);
    else if (r.skills.ok) log.success("skills: npx skills update -y");
    else log.error(`skills: ${r.skills.message ?? "failed"}`);
  }

  if (!opts.skipRepair) {
    const fixed = await runFixers({ dryRun: false });
    const applied = fixed.filter((f) => f.applied);
    if (applied.length) log.success(`auto-repair: applied ${applied.length} fix(es) — run \`syncthis fix --dry-run\` for detail`);
  }
}

async function doSkills() {
  const r = await runSkillsOnly();
  if (r.ok) log.success("skills: npx skills update -y");
  else log.error(`skills: ${r.message ?? "failed"}`);
}

async function doStatus() {
  const report = await buildStatusReport();
  if (report.rows.length === 0) {
    log.info("no plugins installed in any tracked agent.");
    return;
  }
  let silent = 0;
  let ok = 0;
  for (const row of report.rows) {
    for (const c of row.cells) {
      const g = cellGlyph(c);
      if (g === "silent" || g === "error") silent += 1;
      else if (g === "surfaced") ok += 1;
    }
  }
  log.success(`${ok} plugin/agent pair(s) surfacing`);
  if (silent > 0) {
    log.warn(`${silent} silent failure(s) — run \`syncthis status\` for the full matrix`);
    log.info("tip: \`syncthis fix\` will attempt to repair them.");
  } else {
    log.success("no silent failures detected.");
  }
}

async function doFix() {
  const preview = await runFixers({ dryRun: true });
  const wouldApply = preview.filter((r) => !r.noop);
  if (wouldApply.length === 0) {
    log.success("nothing to fix.");
    return;
  }
  for (const f of wouldApply) {
    log.info(`${f.fixer} → ${f.plugin} (${f.agent}): ${f.message}`);
  }
  const confirm = await select({
    message: `apply ${wouldApply.length} fix(es)?`,
    options: [
      { value: "no", label: "no" },
      { value: "yes", label: `yes — patch ${wouldApply.length}` },
    ],
  });
  if (isCancel(confirm) || confirm === "no") {
    cancel("aborted.");
    return;
  }
  const applied = await runFixers({ dryRun: false });
  const ok = applied.filter((r) => r.applied).length;
  const fail = applied.filter((r) => !r.applied && !r.noop).length;
  if (ok) log.success(`applied ${ok} fix(es)`);
  if (fail) log.error(`${fail} fix(es) failed`);
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
  const applied = await runMirror({ from: primary, apply: true, removeStale });
  let failed = 0;
  for (const t of applied.targets) {
    for (const i of t.installs ?? []) if (i.status === "failed") failed += 1;
    for (const r of t.removes ?? []) if (r.status === "failed") failed += 1;
  }
  if (failed > 0) log.error(`${failed} install/remove(s) failed — run \`syncthis mirror ${primary}\` for detail`);
  else log.success("mirror complete.");
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

async function doPluginDoctor() {
  const r = await runPluginDoctor();
  const bundle = r.pluginCoverage.bundle.length;
  const npm = r.pluginCoverage.npm.length;
  log.success(`${bundle} bundle plugin(s), ${npm} npm plugin(s) tracked`);
  if (r.marketplaceConflicts.length) {
    log.warn(`${r.marketplaceConflicts.length} marketplace conflict(s) — run \`syncthis plugin doctor\` for detail`);
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
