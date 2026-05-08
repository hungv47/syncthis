# syncthis

[![npm](https://img.shields.io/npm/v/@hungv47/syncthis?color=cb3837&label=npm&logo=npm&logoColor=white)](https://www.npmjs.com/package/@hungv47/syncthis)
[![site](https://img.shields.io/badge/site-syncthis.forsvn.com-2ea44f)](https://syncthis.forsvn.com)
[![license](https://img.shields.io/npm/l/@hungv47/syncthis)](./LICENSE)

![syncthis](./assets/banners/syncthis.png)

![syncthis run mirroring MCP servers across 11 agents](./assets/demo.gif)

**Keep your AI coding agents in sync.**

A sync layer for MCP server configs across 11 AI coding agents — **Claude Code, Cursor, Codex, Gemini CLI, Kimi CLI, OpenCode, OpenClaw, Hermes, Windsurf, Antigravity, GitHub Copilot CLI**. Install MCPs with whatever tool you prefer — `mcpm`, `claude mcp add`, etc. — then run `syncthis run` to mirror them everywhere.

For skills, syncthis delegates to [`vercel-labs/skills`](https://github.com/vercel-labs/skills), which supports 55 agents.

## What syncthis is — and isn't

| | |
|---|---|
| ✅ syncs MCP server configs across 11 coding agents | ❌ installs MCP servers (use `mcpm`, `claude mcp add`, etc.) |
| ✅ refreshes skills via `npx skills update -y` | ❌ installs skills from registries (use `npx skills add`) |
| ✅ supports one-way mirror between any two agents | ❌ removes servers (use your installer's removal mode) |

## Install

```bash
bun install -g @hungv47/syncthis
# or
npm install -g @hungv47/syncthis
```

## How it works

```bash
# 1. install MCP servers / skills with your preferred tool
mcpm install github
npx skills add vercel-labs/agent-skills --skill frontend-design

# 2. mirror everything to every agent
syncthis run
```

That's it. No config file, no source-of-truth to maintain.

## Commands

```
syncthis                              # interactive picker (or HELP if non-TTY)
syncthis run    [--dry-run] [--no-skills]   # MCP + skills (alias for sync)
syncthis sync   [--dry-run] [--no-skills]   # same as run
syncthis mcp    [--dry-run]                 # MCP only
syncthis skills                             # skills only — `npx skills update -y`
syncthis <from> <to> [--yes] [--dry-run]    # one-way mirror MCP from one agent to another
syncthis doctor                             # coverage + conflict report
syncthis help
```

`--dry-run` prints what would change without writing.
`--no-skills` skips the skills update phase.
`--yes` skips the confirmation prompt for directional sync.

## Supported agents

| Agent | Config file |
|---|---|
| `claude-code` | `~/.claude.json` (merges top-level + every `projects.*.mcpServers` scope) |
| `cursor` | `~/.cursor/mcp.json` |
| `codex` | `~/.codex/config.toml` |
| `gemini-cli` | `~/.gemini/settings.json` |
| `kimi-cli` | `~/.kimi/mcp.json` |
| `antigravity` | `~/.gemini/antigravity/mcp_config.json` |
| `github-copilot` | `~/.copilot/mcp-config.json` (override via `$COPILOT_HOME`) |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| `opencode` | `~/.config/opencode/opencode.json` |
| `openclaw` | `~/.openclaw/openclaw.json` (override via `$OPENCLAW_CONFIG_PATH`) |
| `hermes-agent` | `~/.hermes/config.yaml` |

## What `syncthis run` does

1. **Reads** MCP servers from each agent's config. For Claude, merges top-level + every per-project scope.
2. **Computes the union.** Any server present in any agent gets propagated to every agent.
3. **Detects conflicts.** If the same server name has different configs across agents, syncthis leaves each agent's own version untouched and reports the conflict — you resolve manually.
4. **Refreshes skills** by running `npx skills update -y`. Skills sync is delegated to `vercel-labs/skills`, which handles 55 agents.

Every target file is backed up to `<file>.syncthis.bak` on the first write so you can recover if something goes wrong.

## Directional sync

```bash
syncthis claude-code codex --dry-run
```

Mirrors MCP servers from `claude-code` to `codex` (one-way, destructive). Shows a diff and asks for confirmation before writing — pass `--yes` to skip the prompt. The conflict policy of the union sync does NOT apply here: this is an explicit overwrite of `to`'s config with `from`'s.

## Conflict example (union sync)

```
$ syncthis run
read 3 server name(s) across 11 agent(s); 2 synced, 1 conflict(s)
  ✓ claude-code     ~/.claude.json
  ✓ cursor          ~/.cursor/mcp.json
  ...

1 conflict(s) — left each agent's own copy untouched:
  ~ github
      in claude-code
      in cursor
  resolve by deleting the version you don't want, then re-run sync.
```

## Removing a server

syncthis intentionally has no `remove` command. Removal goes through your installer (`mcpm remove`, `claude mcp remove`, etc.) or by editing the agent file directly. If a server still exists in any agent after removal, the next `syncthis run` will re-propagate it to the others.

To remove a server everywhere at once, delete it from every agent — or use your installer's "remove from all" mode.

## Skills

Skills are handled entirely by [`npx skills`](https://github.com/vercel-labs/skills) (Vercel Labs). syncthis runs `npx skills update -y` as part of `run`/`sync` to refresh registry-installed skills. For installing skills, use `npx skills add <repo>` directly. See [skills.sh](https://skills.sh) for the registry.

## License

MIT
