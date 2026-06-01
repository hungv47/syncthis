# Capabilities plan — cross-agent install / remove

Status: Phase 1 implemented. Phases 2–3 planned. Decision-locked 2026-06-01.

## Goal

Kill the friction of replicating capabilities across coding agents. A user with
plugins + MCP servers + skills on Claude should reach the same content on Codex,
OpenCode, and every other agent with one command — without reinstalling each piece
by hand.

## Mental model

A capability is a bundle. A **plugin** is the richest bundle; it decomposes into:

| Part | Portable to | Mechanism |
|---|---|---|
| Skills | all 55+ agents | `npx skills add` |
| MCP servers (`.mcp.json` / manifest `mcpServers`) | any MCP-capable agent | native syncthis adapters |
| Hooks, slash-commands, subagents, LSP, monitors, themes | Claude-only | not portable |

So "make my plugins reachable everywhere" = install natively where supported
(Claude/Codex/Cursor), and for the other 8 agents decompose into skills + MCP
servers and install those.

## Locked decisions

1. **MCP engine = native adapters.** syncthis keeps writing MCP config directly to
   all 11 agents (zero-dep, broadest coverage). mcpm is *not* the writer — it lacks
   Kimi/Antigravity/Copilot/OpenClaw/Hermes and needs Python. mcpm is only a future
   optional *registry resolver* for `add mcp <name>` (Phase 4).
2. **Scope = full installer/remover**, built in phases.
3. **Plugins stay additive-only.** `add` covers all three types; `remove` covers
   **MCP + skills only**. There is no plugin-uninstall path anywhere — that remains
   each agent's own CLI (`claude/codex plugin uninstall`). (Sacred element #1.)

## Command surface (target)

```
syncthis mirror <primary> [--to a,b | --all]      # replicate MCPs + skills + decomposed plugins
syncthis add <repo|name> [--mcp|--skill|--plugin] [--to … | --all]
syncthis remove <name> [--mcp|--skill] [--all] [--dry-run] [--yes]
```

Shared flags: `--to`, `--all`, `--dry-run`, `--yes`.

## Phases

### Phase 1 — plugin → MCP decomposition ✅ (this change)

The gap that completes the replication case. `mirror` now also lifts each plugin's
bundled MCP servers into the 8 non-plugin agents' own MCP config.

- `src/plugins/mcp.ts` — `resolvePluginMcpServers(plugins)`: reads each installed
  plugin's `.mcp.json` + manifest `mcpServers`, resolves `${CLAUDE_PLUGIN_ROOT}` →
  install dir, skips servers that still need a Claude-only var, dedups across plugins.
- `src/plugins/mirror.ts` — `pushPluginMcpToCohort()`: additive, conflict-safe write
  via the existing MCP adapters (sacred conflict policy: a name present with a
  different config is left untouched and reported, never overwritten).
- Cohort = `skillCohort()` (the 8 non-plugin agents); Claude primary only.
- Tests: `tests/plugin-mcp-decompose.test.ts` (resolution) + new cases in
  `tests/mirror.test.ts` (wiring, additive + conflict apply).

**Known limitation:** a lifted server points at Claude's plugin cache dir, so it
breaks if the plugin is later uninstalled from Claude (cache pruned ~7 days after).
Acceptable for v1; revisit if it bites.

### Phase 2 — `add <repo|name>` installer verb

Type auto-detect: a repo with a plugin manifest → plugin; with only `SKILL.md` /
`skills/` → skill; a bare name → mcp. Wraps `npx plugins add --target …` (+ plugin
decomposition for the non-plugin cohort, reusing Phase 1), `npx skills add`, and
native MCP write. Targets via `--to` or `--all`.

### Phase 3 — `remove <name>` verb (MCP + skills)

MCP removal already exists (`runRemove`). Add skills removal via
`npx skills remove <skill> -a <agent> -y`, same rails as MCP rm (explicit `--all`
scope, diff, confirm, `--dry-run`). **No plugin removal.**

### Phase 4 (optional) — mcpm registry source

`add mcp <name>` with no local match → resolve from mcpm's registry, then write via
native adapters. Only affects users who have mcpm installed.

## CLAUDE.md follow-ups (later phases)

- When `add` lands (Phase 2), revise the "Not an MCP server installer" line to
  "cross-agent capability installer (native engine)".
- Keep the plugin-additive-only sacred element intact.
