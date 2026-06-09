import { describe, expect, test } from "bun:test";
import { COMMANDS } from "../src/welcome.tsx";

// Guards the first-run welcome banner against drifting back to a pre-0.15 grammar.
// The 0.15.0 noun-first refactor updated help/tui/CLAUDE.md but left this banner on
// the legacy spelling (`add plugin`, bare `mcp`/`skills`, `<from> <to>`, `rm <server>`,
// `plugin list`); it shipped a release behind before anyone noticed. These assertions
// make that class of drift a failing test, not a screenshot.

// Legacy/alias forms that must never appear in an advertised banner row.
const LEGACY_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "add plugin (→ plugins add)", re: /\badd plugin\b/ },
  { label: "plugin list (→ plugins list)", re: /\bplugin list\b/ },
  { label: "bare `mcp` (→ mcp sync)", re: /^syncthis mcp$/ },
  { label: "bare `skills` (→ skills update)", re: /^syncthis skills$/ },
  { label: "directional without `mcp` (→ mcp <from> <to>)", re: /^syncthis <from> <to>$/ },
  { label: "bare `rm` (→ mcp rm)", re: /^syncthis rm\b/ },
];

describe("welcome banner command list", () => {
  test("every row is a `syncthis …` command", () => {
    for (const { cmd } of COMMANDS) {
      expect(cmd.startsWith("syncthis ")).toBe(true);
    }
  });

  test("no row uses a legacy/pre-noun-first grammar", () => {
    const offenders: string[] = [];
    for (const { cmd } of COMMANDS) {
      for (const { label, re } of LEGACY_PATTERNS) {
        if (re.test(cmd)) offenders.push(`${cmd}  —  ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("noun verbs use the canonical noun-first form", () => {
    // Any row that mentions a noun must spell it noun-first: `<noun> <verb>`,
    // never bare or verb-first.
    for (const { cmd } of COMMANDS) {
      const words = cmd.split(/\s+/); // ["syncthis", noun?, verb?, ...]
      const noun = words[1];
      if (noun === "plugins") {
        expect(words.length).toBeGreaterThan(2);
        expect(["add", "list", "mirror", "rm"]).toContain(words[2]!);
      }
      if (noun === "skills") {
        expect(words.length).toBeGreaterThan(2);
        expect(["add", "update", "from-plugins", "rm"]).toContain(words[2]!);
      }
      // `mcp` may be a verb noun (`mcp sync`/`mcp rm`) or directional
      // (`mcp <from> <to>`) — both keep `mcp` as the second token, which the
      // bare-`mcp` legacy guard above already enforces.
    }
  });
});
