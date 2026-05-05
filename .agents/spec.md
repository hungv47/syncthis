---
skill: discover
version: 2
date: 2026-05-05
status: done
---

# syncthis Specification

## Problem Statement

MCP servers and skills are duplicated across AI coding agents (Claude Code, Cursor, Codex, Gemini CLI). Each agent stores them in a different file with a different format. Installing or removing requires editing N files manually, and configs drift over time.

Existing tools solve **installation**: `mcpm` and `claude mcp add` for MCP servers, `npx skills add` ([vercel-labs/skills](https://github.com/vercel-labs/skills)) for skills. None of them solve cross-agent **synchronization**: install in one agent, propagate to all.

That gap is syncthis's wedge.

## Decided Approach

Pure sync layer, no installer. Lightweight Bun-installable CLI with two real commands: `sync` and `doctor`. No source-of-truth file — agents themselves are the source.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | sync only | Installers (mcpm, Vercel skills) already exist; syncthis fills the cross-agent gap they don't address |
| Source model | cross-pollinate | Read all agents, compute union, write union to all. No central source-of-truth file |
| Conflict resolution | preserve each agent's own version, report | Refuses to overwrite when two agents disagree on the same server name; user resolves manually |
| Targets (v1) | Claude Code, Cursor, Codex, Gemini CLI | Author's actual stack |
| Skill propagation | Claude ↔ Cursor cross-pollinate | The gap `npx skills update` doesn't fill (user-authored skills, not registry-managed) |
| Registry skill refresh | `npx skills update -y` | Delegates to vercel-labs/skills for skills it manages |
| Backups | `<file>.syncthis.bak` once on first write | Recovery path; never overwritten on subsequent syncs |
| File permissions | 0600 on create, preserve existing | MCP env blocks contain secrets (GITHUB_TOKEN, etc.) |
| Symlinks | refuse to follow at target or backup path | Prevents TOCTOU hijack on `<file>.syncthis.bak` |
| Skill name validation | `^[\w.-]+$` | Path traversal defense in skill propagation |
| Distribution | Bun-installable CLI | `bun install -g syncthis` (or scoped equivalent) |

## Cross-pollinate algorithm (`runSync`)

1. **Read** MCP servers from each agent in parallel.
2. **Compute union** by canonical-JSON match of nested objects (`env`, `headers` honored). Agents that disagree on a name → conflict; that name does not enter the union.
3. **Per-agent final config** = union ∪ (this agent's own copy of any conflict name). Conflicts are preserved per-agent, not overwritten.
4. **Write** each agent's final config (skips disk write + backup if content matches existing — true no-op idempotency).
5. **Skill propagation** between Claude (`~/.claude/skills/<name>/SKILL.md`) and Cursor (`~/.cursor/rules/<name>.mdc`) with frontmatter translation. Skills present in only one agent → mirrored. Skills present in both with diverging bodies → flagged, left alone.
6. **Run `npx skills update -y`** to refresh registry-installed skills.

## Adapter targets

| Agent | Path | Format |
|-------|------|--------|
| Claude Code | `~/.claude/.mcp.json` | JSON, top-level `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | JSON, top-level `mcpServers` |
| Codex | `~/.codex/config.toml` | TOML, `[mcp_servers.<name>]` blocks |
| Gemini CLI | `~/.gemini/settings.json` | JSON, top-level `mcpServers` (preserves `security` etc.) |

Codex TOML preserves `[tui]`, `[projects.*]` and other non-MCP sections. Gemini `settings.json` preserves all keys except `mcpServers`. SSE transport (`type: "sse"`) is persisted explicitly in TOML to survive round-trip.

## Failure Conditions

Any of these = not done:
- Sync silently overwrites a server's config when it differs across agents (must detect via deep canonical match and report as conflict).
- Skill name from frontmatter unsanitized → path traversal.
- Frontmatter quoting fails on newlines → injection of body content into mirrored agent.
- Symlink at target or `.syncthis.bak` followed → file write to attacker-chosen path.
- Corrupt config file in any agent kills the entire sync (must isolate per-adapter).
- First-write creates secret-bearing config files at world-readable mode.
- `npx skills update` failure crashes the whole sync (must soft-fail and report).

## Out of Scope

- Installer behavior: no `add`, `remove`, `install`, `uninstall`. Use `mcpm`, `claude mcp add`, `npx skills add`.
- Skill CRUD commands. Use `npx skills` (vercel-labs/skills).
- Source-of-truth config file. Agents are the source.
- Hosted backend / team configs / web UI.
- Windsurf, Kiro, VS Code, OpenCode adapters (drop-in additions later if needed).
- Atomic writes via temp+rename (single-user CLI; lockfile complexity not justified yet).
- Prototype-pollution sanitize on parsed JSON (theoretical, no confirmed exploit path through current code).

## Implementation Notes

- Bun runtime; `node:util` `parseArgs` for CLI args; `smol-toml` for Codex.
- Lazy-imported per command — `syncthis help` doesn't load adapters or TOML.
- Adapters expose `read()` and `write()` (no source-config dependency).
- `canonical()` uses recursive `sortKeys` (NOT `JSON.stringify`'s replacer arg, which is a property allowlist not a key sorter).
- Tests cover env-only conflict, SSE round-trip through TOML, corrupt-file isolation, path-traversal frontmatter rejection.

## Status

DONE. 31/31 tests pass; tsc clean. Verified on real machine through cross-pollinate, conflict, and cleanup flows. Reviewed via `/fresh-eyes` (3 specialist reviewers; 9 issues fixed across security/correctness/performance).
