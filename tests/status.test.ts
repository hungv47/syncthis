import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusReport, cellGlyph } from "../src/plugins/status.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-status-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = workDir;
  // Disable claude/codex CLI lookups so we don't accidentally probe the host.
  const emptyBin = join(workDir, "no-bin");
  await mkdir(emptyBin, { recursive: true });
  process.env.PATH = emptyBin;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

async function installFakeClaude(plugins: { id: string; enabled?: boolean; installPath?: string }[]) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, "claude-list.json");
  await writeFile(listFile, JSON.stringify(plugins));
  const script = `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then echo "[]"; exit 0; fi
exit 0
`;
  const p = join(binDir, "claude");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function writeCodexConfig(content: string) {
  await mkdir(join(workDir, ".codex"), { recursive: true });
  await writeFile(join(workDir, ".codex", "config.toml"), content);
}

async function seedCodexCache(name: string, mkt: string, layout: { nested: string[]; flat: string[]; interface: boolean }) {
  const cache = join(workDir, ".codex", "plugins", "cache", mkt, name, "deadbeef");
  await mkdir(join(cache, "skills"), { recursive: true });
  for (const n of layout.nested) {
    const [cat, skill] = n.split("/");
    await mkdir(join(cache, "skills", cat!, skill!), { recursive: true });
    await writeFile(join(cache, "skills", cat!, skill!, "SKILL.md"), `# ${skill}`);
  }
  for (const f of layout.flat) {
    await mkdir(join(cache, "skills", f), { recursive: true });
    await writeFile(join(cache, "skills", f, "SKILL.md"), `# ${f}`);
  }
  await writeFile(
    join(cache, "plugin.json"),
    JSON.stringify(layout.interface ? { interface: { skills: [] } } : {}, null, 2),
  );
}

describe("buildStatusReport", () => {
  test("builds a row per plugin × cell per agent", async () => {
    const claudePluginDir = join(workDir, "claude-plugins", "forsvn-skills");
    await mkdir(join(claudePluginDir, "skills", "research", "web"), { recursive: true });
    await writeFile(join(claudePluginDir, "skills", "research", "web", "SKILL.md"), "# web");
    await installFakeClaude([{ id: "forsvn-skills@plugins-cli", enabled: true, installPath: claudePluginDir }]);
    await writeCodexConfig(`
[plugins."forsvn-skills@plugins-cli"]
enabled = true
`);
    await seedCodexCache("forsvn-skills", "plugins-cli", {
      nested: ["research/web"],
      flat: [],
      interface: true,
    });

    const report = await buildStatusReport();
    const row = report.rows.find((r) => r.name === "forsvn-skills");
    expect(row).toBeDefined();
    const claudeCell = row!.cells.find((c) => c.agent === "claude-code")!;
    const codexCell = row!.cells.find((c) => c.agent === "codex")!;
    expect(cellGlyph(claudeCell)).toBe("surfaced");
    expect(cellGlyph(codexCell)).toBe("silent");
    expect(codexCell.report!.failureTags).toContain("codex-nested-skills");
  });

  test("plugins not installed in an agent get an absent cell", async () => {
    await installFakeClaude([{ id: "only-claude", enabled: true, installPath: workDir }]);
    const report = await buildStatusReport();
    const row = report.rows.find((r) => r.name === "only-claude");
    expect(row).toBeDefined();
    const codexCell = row!.cells.find((c) => c.agent === "codex")!;
    expect(cellGlyph(codexCell)).toBe("absent");
  });
});
