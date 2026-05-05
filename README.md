# syncthis

![syncthis](./assets/banners/syncthis.png)

**Keep your AI tools in sync.**

A sync layer for MCP servers and skills across Claude Code, Cursor, Codex, and Gemini CLI. Install MCPs and skills with whatever tool you prefer — `mcpm`, `claude mcp add`, `npx skills add` from [vercel-labs/skills](https://github.com/vercel-labs/skills) — then run `syncthis sync` to mirror them everywhere.

## What syncthis is — and isn't

| | |
|---|---|
| ✅ syncs MCP server configs across Claude Code, Cursor, Codex, Gemini CLI | ❌ installs MCP servers (use `mcpm`, `claude mcp add`, etc.) |
| ✅ propagates user-authored skills between Claude and Cursor | ❌ installs skills from registries (use `npx skills add`) |
| ✅ runs `npx skills update -y` so registry-installed skills stay fresh | ❌ removes servers (use your installer's removal mode) |

## Install

```bash
bun install -g syncthis
```

## How it works

```bash
# 1. install MCP servers / skills with your preferred tool
mcpm install github
npx skills add vercel-labs/agent-skills --skill frontend-design

# 2. mirror everything to every agent
syncthis sync
```

That's it. No config file, no source-of-truth to maintain.

## What `syncthis sync` does

1. **Reads** MCP servers from each agent's config:
    - Claude Code  `~/.claude/.mcp.json`
    - Cursor  `~/.cursor/mcp.json`
    - Codex  `~/.codex/config.toml`
    - Gemini CLI  `~/.gemini/settings.json`
2. **Computes the union.** Any server present in any agent gets propagated to every agent.
3. **Detects conflicts.** If the same server name has different configs in different agents (e.g., different env vars), syncthis leaves each agent's own version untouched and reports the conflict. You resolve manually by editing one of the agent files (or via your installer) and re-running sync.
4. **Propagates skills** between Claude (`~/.claude/skills/<name>/SKILL.md`) and Cursor (`~/.cursor/rules/<name>.mdc`). Skills present in one agent but not the other are mirrored across with translated frontmatter. Skills present in both are left alone (and flagged if they've diverged).
5. **Refreshes registry-installed skills** by running `npx skills update -y`.

Every target file is backed up to `<file>.syncthis.bak` on the first write so you can recover if something goes wrong.

## Commands

```
syncthis sync [--dry-run] [--no-skills]
syncthis doctor
syncthis help
```

`--dry-run` prints what would change without writing.
`--no-skills` skips the skill propagation + `npx skills update` phase.
`syncthis doctor` shows per-server coverage across agents and any conflicts. Exits non-zero if conflicts are present.

## Conflict example

```
$ syncthis sync
read 3 server name(s) across 4 agent(s); 2 synced, 1 conflict(s)
  ✓ claude-code   ~/.claude/.mcp.json
  ✓ cursor        ~/.cursor/mcp.json
  ✓ codex         ~/.codex/config.toml
  ✓ gemini-cli    ~/.gemini/settings.json

1 conflict(s) — left each agent's own copy untouched:
  ~ github
      in claude-code
      in cursor
  resolve by deleting the version you don't want, then re-run sync.
```

## Removing a server

syncthis intentionally has no `remove` command. Removal goes through your installer:

- `mcpm remove github` (depending on which agent it targets)
- Edit the agent file directly

If a server still exists in any agent after removal, the next `syncthis sync` will re-propagate it to the others. To remove a server everywhere, delete it from every agent — or use your installer's "remove from all" mode if it has one.

## Skills caveat

For skills, the canonical store is **Claude** (`~/.claude/skills/<name>/SKILL.md`). When syncthis propagates Claude → Cursor, it generates a `.mdc` file with translated frontmatter. If you edit the Cursor `.mdc` directly, the next sync will detect the divergence and leave both alone (flagged as `diverged`). Edit Claude's copy if you want changes propagated.

## License

MIT
