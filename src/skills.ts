import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expandHome, readText, writeText } from "./io.ts";

const CLAUDE_DIR = "~/.claude/skills";
const CURSOR_DIR = "~/.cursor/rules";

const SAFE_NAME = /^[\w.-]+$/;
function assertSafeName(name: string, source: string): void {
  if (!name || name === "." || name === ".." || !SAFE_NAME.test(name)) {
    throw new Error(`syncthis: refusing unsafe skill name from ${source}: ${JSON.stringify(name)}`);
  }
}

type Frontmatter = Record<string, string>;
type Skill = {
  name: string;
  description: string;
  body: string;
  source: "claude" | "cursor";
};

export type SkillSyncReport = {
  claudeOnly: string[];
  cursorOnly: string[];
  shared: string[];
  diverged: { name: string }[];
  created: { name: string; from: "claude" | "cursor"; to: "claude" | "cursor"; path: string }[];
};

function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { fm: {}, body: text };
  }
  const offset = text.startsWith("---\r\n") ? 5 : 4;
  const rest = text.slice(offset);
  const m = /\r?\n---\r?\n?/.exec(rest);
  if (!m) return { fm: {}, body: text };
  const fmText = rest.slice(0, m.index);
  const body = rest.slice(m.index + m[0].length);
  const fm: Frontmatter = {};
  for (const line of fmText.split(/\r?\n/)) {
    const kv = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]!] = stripQuotes(kv[2]!.trim());
  }
  return { fm, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function emitFrontmatter(fm: Record<string, string>, body: string): string {
  const lines = Object.entries(fm).map(([k, v]) => {
    const needsQuote = /[\n\r\t:#`{}\[\]&*?|<>=!%"']/.test(v) || /^\s|\s$/.test(v) || v === "";
    return `${k}: ${needsQuote ? JSON.stringify(v) : v}`;
  });
  const trailing = body.endsWith("\n") ? "" : "\n";
  return `---\n${lines.join("\n")}\n---\n\n${body}${trailing}`;
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function scanClaudeSkills(): Promise<Skill[]> {
  const dir = expandHome(CLAUDE_DIR);
  const entries = (await listDir(dir)).filter((n) => !n.startsWith("."));
  const reads = await Promise.all(
    entries.map(async (name): Promise<Skill | null> => {
      try {
        assertSafeName(name, "claude skills dir");
        const text = await readText(join(dir, name, "SKILL.md"));
        if (!text) return null;
        const { fm, body } = parseFrontmatter(text);
        const finalName = fm.name || name;
        assertSafeName(finalName, `claude SKILL.md frontmatter (dir=${name})`);
        return { name: finalName, description: fm.description || "", body, source: "claude" };
      } catch {
        return null;
      }
    }),
  );
  return reads.filter((s): s is Skill => s !== null);
}

async function scanCursorRules(): Promise<Skill[]> {
  const dir = expandHome(CURSOR_DIR);
  const entries = (await listDir(dir)).filter((n) => n.endsWith(".mdc"));
  const reads = await Promise.all(
    entries.map(async (fname): Promise<Skill | null> => {
      try {
        const text = await readText(join(dir, fname));
        if (!text) return null;
        const name = fname.slice(0, -4);
        assertSafeName(name, "cursor rules filename");
        const { fm, body } = parseFrontmatter(text);
        return { name, description: fm.description || "", body, source: "cursor" };
      } catch {
        return null;
      }
    }),
  );
  return reads.filter((s): s is Skill => s !== null);
}

async function writeClaudeSkill(skill: Skill): Promise<string> {
  const dir = join(expandHome(CLAUDE_DIR), skill.name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  await writeText(path, emitFrontmatter({ name: skill.name, description: skill.description }, skill.body));
  return path;
}

async function writeCursorRule(skill: Skill): Promise<string> {
  const path = join(expandHome(CURSOR_DIR), `${skill.name}.mdc`);
  await writeText(path, emitFrontmatter({ description: skill.description }, skill.body));
  return path;
}

const WRITERS = {
  claude: writeClaudeSkill,
  cursor: writeCursorRule,
} as const;

export async function syncSkills(opts: { dryRun?: boolean } = {}): Promise<SkillSyncReport> {
  const [claude, cursor] = await Promise.all([scanClaudeSkills(), scanCursorRules()]);
  const claudeMap = new Map(claude.map((s) => [s.name, s]));
  const cursorMap = new Map(cursor.map((s) => [s.name, s]));

  const report: SkillSyncReport = {
    claudeOnly: [],
    cursorOnly: [],
    shared: [],
    diverged: [],
    created: [],
  };

  async function propagate(skill: Skill, to: "claude" | "cursor") {
    const path = opts.dryRun ? "(dry-run)" : await WRITERS[to](skill);
    report.created.push({ name: skill.name, from: skill.source, to, path });
  }

  for (const name of new Set([...claudeMap.keys(), ...cursorMap.keys()])) {
    const c = claudeMap.get(name);
    const r = cursorMap.get(name);
    if (c && r) {
      report.shared.push(name);
      if (c.body.trim() !== r.body.trim()) report.diverged.push({ name });
    } else if (c) {
      report.claudeOnly.push(name);
      await propagate(c, "cursor");
    } else if (r) {
      report.cursorOnly.push(name);
      await propagate(r, "claude");
    }
  }
  return report;
}
