# syncthis

[![npm](https://img.shields.io/npm/v/@hungv47/syncthis?color=cb3837&label=npm&logo=npm&logoColor=white)](https://www.npmjs.com/package/@hungv47/syncthis)
[![site](https://img.shields.io/badge/site-syncthis.forsvn.com-2ea44f)](https://syncthis.forsvn.com)
[![license](https://img.shields.io/npm/l/@hungv47/syncthis)](./LICENSE)

![syncthis](./assets/banners/syncthis.png)

![syncthis run mirroring MCP servers across 11 agents](./assets/demo.gif)

**One CLI to keep MCP servers, plugins, and marketplaces synced across your AI coding agents.**

You install MCPs and plugins with whatever tool you already use — `mcpm`, `claude mcp add`, `claude plugin install`, `npx plugins add`, and so on. syncthis is the sync layer on top: read every agent's config, compute the union, write it back, and report conflicts.

Supported agents: **Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Kimi CLI, Windsurf, Antigravity, GitHub Copilot CLI, OpenClaw, Hermes** — 11 in total for MCP sync. The new plugin/marketplace surface (v0.3) covers Claude Code, Codex, Cursor, and OpenCode. Skills are delegated to [`vercel-labs/skills`](https://github.com/vercel-labs/skills), which handles 55 agents.

## Quick start

No install required — run it on demand:

```bash
npx @hungv47/syncthis run
```

That mirrors MCP servers across every detected agent, then refreshes skills via `npx skills update -y`. Add `--dry-run` to preview without writing.

If you'd rather have `syncthis` on your `PATH`:

```bash
bun install -g @hungv47/syncthis
# or
npm install -g @hungv47/syncthis
```

After global install, drop the `npx @hungv47/syncthis` prefix — every command below works as `syncthis <cmd>` instead.

## What syncthis is — and isn't

| | |
|---|---|
| ✅ syncs MCP server configs across 11 coding agents | ❌ installs MCP servers (use `mcpm`, `claude mcp add`, etc.) |
| ✅ refreshes skills via `npx skills update -y` | ❌ installs skills from registries (use `npx skills add`) |
| ✅ supports one-way mirror and fan-out from one agent | ❌ starts desktop-owned MCP servers like Paper/Pencil |
| ✅ removes one MCP server across every supported agent | ❌ treats legacy/unmanaged MCP files as source of truth |
| ✅ removes plugins and marketplaces across Claude / Codex / Cursor / OpenCode | ❌ installs plugins (use `npx plugins add`, `claude plugin install`, etc.) |

## How it works

```bash
# 1. install MCP servers / skills / plugins with your preferred tool
mcpm install github
npx skills add vercel-labs/agent-skills --skill frontend-design
claude plugin install vercel-plugin@plugins-cli

# 2. mirror MCP servers + refresh skills across every agent
syncthis run
```

No config file, no source-of-truth to maintain. Each agent's own config is the truth; syncthis just keeps them in agreement.

For removals, do not rely on union sync — it is additive only. Use the explicit `rm` commands (see below); otherwise a server or plugin that still exists in one agent will be re-propagated to the others on the next `run`.

## Commands

```
syncthis                              # interactive picker (or HELP if non-TTY)
syncthis run    [--dry-run] [--no-skills]   # MCP + skills (alias for sync)
syncthis sync   [--dry-run] [--no-skills]   # same as run
syncthis mcp    [--dry-run]                 # MCP only
syncthis skills                             # skills only — `npx skills update -y`
syncthis <from> <to> [--yes] [--dry-run]    # one-way mirror MCP from one agent to another
syncthis from <agent> --all [--yes] [--dry-run] # mirror one agent to every other agent
syncthis rm <server> --all [--yes] [--dry-run]  # remove one MCP server everywhere
syncthis doctor                             # coverage + conflict report

# Plugin and marketplace inspection / removal (Claude, Codex, Cursor, OpenCode)
syncthis plugin list                        # list installed plugins per agent
syncthis plugin doctor                      # plugin + marketplace coverage report
syncthis plugin rm <name> --all [--yes] [--dry-run] [--purge]
syncthis plugin rm --marketplace <name> --all [--yes] [--dry-run] [--purge]
syncthis marketplace list                   # list registered marketplaces per agent
syncthis marketplace rm <name> --all [--yes] [--dry-run] [--purge]
syncthis help
```

`--dry-run` prints what would change without writing.
`--no-skills` skips the skills update phase.
`--all` is required for fan-out and remove-all commands.
`--yes` skips the confirmation prompt for destructive commands.
`--purge` (plugin / marketplace rm) also sweeps on-disk cache dirs the agent leaves behind.
`--marketplace <name>` (plugin rm) removes every plugin that came from a marketplace.

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

To fan out one clean source to every other supported agent:

```bash
syncthis from antigravity --all --dry-run
syncthis from antigravity --all --yes
```

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

Use the explicit remove command:

```bash
syncthis rm executor --all --dry-run
syncthis rm executor --all --yes
```

`syncthis run` is a union sync. If `executor` still exists in one agent, union sync will re-propagate it. `syncthis rm` avoids that by deleting the named server from every supported agent in one pass.

## Plugins and marketplaces

syncthis can inspect and remove plugins (and their source marketplaces) across **Claude Code, Codex, Cursor, and OpenCode**. Installation is left to each agent's native tool (`claude plugin install`, `codex plugin add`, `npx plugins add`, `opencode plugin <module>`).

```bash
# See what's installed where
syncthis plugin list
syncthis plugin doctor
syncthis marketplace list

# Remove one plugin everywhere (handles per-agent marketplace suffix mismatches)
syncthis plugin rm vercel-plugin --all --dry-run
syncthis plugin rm vercel-plugin --all --yes

# Remove every plugin that came from a marketplace, in one pass
syncthis plugin rm --marketplace knowledge-work-plugins --all --yes --purge

# Drop a marketplace registration entirely + sweep its on-disk cache
syncthis marketplace rm knowledge-work-plugins --all --yes --purge
```

`--purge` also `rm -rf`'s the on-disk cache directories the agent leaves behind after a registration-only uninstall (Claude leaves `~/.claude/plugins/cache/<marketplace>/<plugin>/`, Codex leaves `~/.codex/plugins/cache/<source>/<plugin>/`). Containment-checked with `realpath` — refuses to delete anything outside the agent's plugins tree.

**Scope notes:**
- **Cursor** has no native plugin/marketplace CLI, so syncthis works file-level on `~/.cursor/plugins/`.
- **OpenCode** plugins are npm runtime modules listed in `opencode.json`'s `plugin` array, NOT GitHub-bundle plugins like the other three. They live in their own cohort — `plugin list` shows them, removal works on the npm-name, but they never cross-mirror into Claude/Codex/Cursor.
- The other 7 supported agents (Gemini, Kimi, Hermes, Windsurf, Antigravity, Copilot, OpenClaw) stay in MCP-sync and skills scope only — they have no GitHub-bundle plugin surface for syncthis to manage.

## Desktop-owned servers

Paper and Pencil can be desktop-owned: the config may be synced, but the server only responds when the desktop client starts it. syncthis only syncs config; it does not launch those apps.

## Unmanaged MCP files

`syncthis doctor` warns when known side files contain MCP servers that syncthis does not write, such as VS Code user MCP config or the legacy `~/.config/mcp/servers.json`. Treat those as app-owned or legacy files, not the canonical source for coding-agent sync.

## Skills

Skills are handled entirely by [`npx skills`](https://github.com/vercel-labs/skills) (Vercel Labs). syncthis runs `npx skills update -y` as part of `run`/`sync` to refresh registry-installed skills. For installing skills, use `npx skills add <repo>` directly. See [skills.sh](https://skills.sh) for the registry.

## License

MIT
