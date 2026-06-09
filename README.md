# syncthis

[![npm](https://img.shields.io/npm/v/@hungv47/syncthis?color=cb3837&label=npm&logo=npm&logoColor=white)](https://www.npmjs.com/package/@hungv47/syncthis)
[![site](https://img.shields.io/badge/site-syncthis.forsvn.com-2ea44f)](https://syncthis.forsvn.com)
[![license](https://img.shields.io/npm/l/@hungv47/syncthis)](./LICENSE)

![syncthis](./assets/banners/syncthis.png)

![syncthis mcp sync — union MCP servers across every agent](./docs/demos/out/mcp-sync.gif)

**One CLI to keep MCP servers in sync across your AI coding agents — plus plugin and skills propagation.**

Every coding agent stores its MCP servers in its own file, its own format, its own path. Add a server to Claude Code and the other eleven don't know it exists — so you wire up the same server, by hand, again and again. syncthis reads all of them, computes the union, and writes it back: **one command puts every server in every agent.** Nothing else does cross-agent MCP sync — that's why it exists.

You install MCPs, plugins, and skills with whatever tool you already use — `mcpm`, `claude mcp add`, `claude plugin install`, `npx plugins add`, `npx skills add`, and so on. syncthis is the sync layer on top. It does three things and nothing more:

- **MCP servers** — union sync across all 12 agents: read every agent's config, compute the union, write it back, report conflicts. *(Nothing upstream does cross-agent MCP sync — this is syncthis's reason to exist.)*
- **Plugins** — add one, a few, or all Claude-installed plugins to chosen agents, additively (never uninstalls). **Codex** gets native plugins (missing marketplaces auto-registered); **Cursor** is pushed by source repo via `npx plugins add --target cursor`; the **non-plugin agents** get the bundled skills via `npx skills add` **and** the bundled MCP servers, lifted into their own MCP config (additive, conflicts left untouched). Anything a target can't load as a plugin falls back to skills. `mirror` remains as a batch shortcut for every installed plugin.
- **Skills** — delegated entirely to [`vercel-labs/skills`](https://github.com/vercel-labs/skills) (`npx skills update -y`), which handles 55 agents.

Supported agents for MCP sync: **Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Kimi CLI, Windsurf, Antigravity, GitHub Copilot CLI, OpenClaw, Hermes, Goose** — 12 in total.

> Union sync writes the merged set to **every** supported agent — including ones you haven't installed yet — so your servers are already in place the moment you start using a new agent. It's additive and reversible by design (see [Safe by design](#safe-by-design)); `--dry-run` previews any command.

## Quick start

No install required — run it on demand:

```bash
npx @hungv47/syncthis run
```

That mirrors MCP servers across every detected agent, then refreshes skills via `npx skills update -y`. Add `--dry-run` to preview without writing.

> syncthis ships as a single self-contained bundle that runs on **Node ≥18 — no Bun required to use it**. (Bun is only needed to hack on the source.)

If you'd rather have `syncthis` on your `PATH`:

```bash
bun install -g @hungv47/syncthis
# or
npm install -g @hungv47/syncthis
```

After global install, drop the `npx @hungv47/syncthis` prefix — every command below works as `syncthis <cmd>` instead.

## Demos

Reproducible recordings (regenerate with `docs/demos/build.sh` — see [`docs/demos/`](./docs/demos/)).

**Directional mirror — preview, then apply with the backup safety net**

![syncthis mcp directional mirror with dry-run then confirm](./docs/demos/out/mcp-directional.gif)

**Interactive picker — guided, three-noun walk-through**

![syncthis interactive picker walk-through](./docs/demos/out/interactive.gif)

**The command list**

![syncthis help — noun-first command list](./docs/demos/out/help.gif)

## What syncthis is — and isn't

| | |
|---|---|
| ✅ syncs MCP server configs across 12 coding agents | ❌ installs MCP servers (use `mcpm`, `claude mcp add`, etc.) |
| ✅ refreshes skills via `npx skills update -y` | ❌ installs skills from registries (use `npx skills add`) |
| ✅ supports one-way mirror and fan-out from one agent | ❌ starts desktop-owned MCP servers like Paper/Pencil |
| ✅ removes one MCP server across every supported agent | ❌ treats legacy/unmanaged MCP files as source of truth |
| ✅ propagates selected plugin content to chosen agents (plugins on Codex/Cursor; skills on the rest) | ❌ installs plugins from scratch (use `npx plugins add`, `claude plugin install`, etc.) |
| ✅ shows a cross-agent plugin overview (`plugin list`) | ❌ acts as a plugin source-of-truth — each agent's own config is the truth |
| ✅ uninstalls a plugin everywhere — native plugin + surfaced skills (`plugin rm`, guarded) | ❌ deletes anything implicitly — removal only via the guarded `rm` / `plugin rm` commands |

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

For removals, do not rely on union sync — it is additive only. Use the explicit `rm` / `plugin rm` commands (see below); otherwise a server or plugin that still exists in one agent will be re-propagated to the others on the next `run`.

## Commands

```
syncthis                              # interactive picker (or HELP if non-TTY)
syncthis run    [--dry-run] [--no-skills]   # MCP + skills (alias for sync)
syncthis sync   [--dry-run] [--no-skills]   # same as run
syncthis mcp    [--dry-run]                 # MCP only — skip skills update
syncthis skills                             # skills only — `npx skills update -y`
syncthis update [--dry-run]                 # update syncthis itself to latest
syncthis version                            # print the installed syncthis version
syncthis <from> <to> [--yes] [--dry-run]    # one-way mirror MCP from one agent to another
syncthis from <agent> --all [--yes] [--dry-run] # mirror one agent to every other agent
syncthis rm <server> --all [--yes] [--dry-run]  # remove one MCP server everywhere
syncthis doctor                             # MCP coverage + conflict report

# Plugins → chosen agents (Codex/Cursor as plugins; non-plugin agents get skills + bundled MCPs). Additive.
syncthis add plugin <name…> --agents <a,b,c> | --all [--dry-run]  # source = claude-code
syncthis mirror <primary> [--no-provision] [--yes] [--dry-run] # batch shortcut: every plugin from primary
syncthis plugin list                        # cross-agent plugin overview (read-only)
syncthis plugin rm <plugin…> [--all | --agents <a,b,c>] [--yes] [--dry-run] [--keep-data]
                                            # guarded uninstall: native plugin (claude/codex) + surfaced skills (rest)

# Selective add / remove — pick the exact items + agents
syncthis add skill  <repo…>   --agents <a,b,c> | --all [--dry-run]
syncthis rm  skill  <name…>   --agents <a,b,c> | --all [--yes] [--dry-run]
syncthis rm  mcp    <server…> --agents <a,b,c> | --all [--yes] [--dry-run]
syncthis rm  plugin <name…>   …             # alias of `plugin rm`
# (no `add mcp` — syncthis mirrors MCP servers, it doesn't install them)
syncthis help
```

`--dry-run` prints what would change without writing.
`--no-skills` skips the skills update phase.
`--no-provision` (mirror) skips registering missing Codex marketplaces and the Codex skills-fallback — Codex installs only the plugins it can already resolve. (The Cursor push and the non-plugin-agent skills push still run; those are the mirror's payload, not provisioning.) By default mirror provisions: it registers a plugin's source marketplace on the target (`npx plugins add` — hits the network), and adds bundles a target can't load as plugins as skills (`npx skills add`).
`--all` is required for fan-out and remove-all commands.
`--yes` skips the confirmation prompt for destructive commands.
`syncthis update` runs the global latest install command (`npm install -g @hungv47/syncthis@latest`, or Bun's global install when the current executable comes from Bun).

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
| `goose` | `~/.config/goose/config.yaml` (YAML `extensions`; built-ins preserved) |

Skills additionally reach **`pi`** (badlogic/pi-mono), which ships without native MCP by design — so it's a skills-only target (no MCP adapter).

## What `syncthis run` does

1. **Reads** MCP servers from each agent's config. For Claude, merges top-level + every per-project scope.
2. **Computes the union.** Any server present in any agent gets propagated to every agent.
3. **Detects conflicts.** If the same server name has different configs across agents, syncthis leaves each agent's own version untouched and reports the conflict — you resolve manually.
4. **Refreshes skills** by running `npx skills update -y`. Skills sync is delegated to `vercel-labs/skills`, which handles 55 agents.

### Safe by design

syncthis writes to files that hold your whole agent config — often with API keys — so every write is defensive:

- **Additive — never deletes.** `run`/`sync` only ever adds servers. Deletion is opt-in and explicit (`syncthis rm`), always with a diff and confirmation.
- **Never picks a winner.** If the same server name has different configs across agents, syncthis leaves each agent's own copy untouched and reports the conflict for you to resolve. It won't silently overwrite your config with another agent's.
- **Backed up on first write.** Each target file is copied to `<file>.syncthis.bak` the first time syncthis touches it, so the original is always recoverable.
- **Atomic + `0600`.** Writes go to a temp file and are atomically renamed into place (a crash can't truncate your config), clamped to owner-only `0600` since they can carry secrets.
- **Idempotent.** Re-running converges — including SSE/HTTP servers — instead of churning or raising phantom conflicts.
- **Agent compatibility is explicit.** If a target agent can't safely load a synced server,
  syncthis keeps the server in that agent's config but writes the safe agent-specific
  state and reports a compatibility adjustment. Example: opencode remotes that would
  corrupt its TUI with schema warnings are written as `enabled: false`.
- **Preview anything** with `--dry-run`; destructive commands refuse to run unattended without `--yes`.

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
read 3 server name(s) across 12 agent(s); 2 synced, 1 conflict(s)
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

## Plugins

Plugins aren't config records like MCP servers — they're installed artifact bundles with per-agent identity and install mechanics. The plugin sync flow makes one, a few, or all Claude-installed plugins reachable on chosen destination agents, by the best mechanism each has, and **additively — it never uninstalls**. `mirror` is the batch shortcut for every installed plugin:

- **Codex** consumes plugins natively (`codex plugin add`). syncthis installs each missing plugin and, by default, registers any marketplace Codex lacks first.
- **Cursor** has no list CLI, so it's a **write-only** target: pushed by source repo (`npx plugins add <repo> --target cursor`), additive, from a Claude primary only.
- **The non-plugin agents** can't load plugins at all — so a Claude-primary mirror gives them the plugins' bundled **skills** via `npx skills add`, **and** the plugins' bundled **MCP servers**, decomposed and lifted into each agent's own MCP config (additive; `${CLAUDE_PLUGIN_ROOT}` resolved to the install dir; a name already present with a different config is left untouched). The plugin cohort already gets those servers by installing the plugin; Pi is skills-only, so it receives skills but no MCP lift.

```bash
# See what's installed where (read-only): native plugins on Claude/Codex,
# plus the plugin-derived skills surfaced on every non-plugin agent.
syncthis plugin list

# Add selected Claude plugins to chosen agents
syncthis add plugin forsvn-skills --agents codex,opencode --dry-run
syncthis add plugin forsvn-skills --agents codex,opencode

# Batch every installed plugin from one primary to every other agent
syncthis mirror claude-code --dry-run
syncthis mirror claude-code --yes
syncthis mirror claude-code --no-provision --yes   # skip Codex marketplace registration + Codex skills-fallback

# Uninstall a plugin everywhere — native plugin (claude/codex) AND its surfaced skills
syncthis plugin rm forsvn-skills --all --dry-run   # preview the diff first
syncthis plugin rm forsvn-skills --all --yes
syncthis plugin rm forsvn-skills --agents codex,opencode,gemini-cli --yes
```

`add plugin` lets you choose exact plugins and agents. `mirror` shows a diff and prompts for confirmation unless you pass `--yes`; it only ever **adds** every plugin from the primary — it can never wipe an agent's plugins. Removal is a separate, explicit command (`plugin rm`, below). Installs delegate to each target's native CLI; nothing is written directly to a plugin cache.

### Uninstalling — `plugin rm`

`plugin rm <plugin…>` is the only plugin-removal path (sync and mirror never remove). For each named plugin it uninstalls the native plugin from the scoped plugin-capable agents (`claude plugin uninstall`, `codex plugin remove`) **and** removes that plugin's surfaced skills from the scoped non-plugin agents (`npx skills remove`) — including Codex when the mirror surfaced them there via the skills fallback. It's guarded like MCP `rm`: an explicit scope (`--all` or `--agents <a,b,c>`), a diff before any write, TTY-confirm or `--yes`, and `--dry-run`. Each argument is `name` (every installed instance) or `name@marketplace` (one instance). A skill another still-installed plugin record also provides is **kept** (no collateral removal); `--keep-data` preserves Claude's plugin data dir. Cursor is write-only and can't be uninstalled. The interactive picker offers the same flow with plugin and agent checkboxes.

`mirror` reads the target's **real** install state (e.g. `codex plugin list`), not just what's registered in config — so it installs exactly what's missing and resolves each plugin to the target's own `<name>@<marketplace>` automatically.

**Provisioning is on by default.** When Codex doesn't yet have a plugin's marketplace, syncthis registers its source repo (`npx plugins add <owner/repo> --target codex`, repo from the primary's marketplace list) and installs it — which also installs the repo's canonical plugin. Pass `--no-provision` to skip that registration and the Codex skills-fallback — Codex then installs only the plugins it can already resolve. (It's not a fully offline switch: the Cursor and non-plugin-agent skills pushes still run.)

**Anything Codex can't load as a plugin becomes skills.** Two cases land here:

- **Multi-plugin marketplaces.** Marketplaces like `browserbase`, `expo`, and `anthropics/skills` alias one bundle under several plugin names whose `plugin.json` name differs from the entry name. Claude installs every alias; Codex rejects the mismatch. syncthis installs the canonical plugin and marks each alias **covered** (its content is already there) — no error, no duplicate.
- **Skills-only bundles.** Some "plugins" are really skill collections Codex's loader can't expose. After provisioning, syncthis adds the bundle's skills to Codex via `npx skills add <repo> -a codex` (a fallback row) — but only when no plugin from that repo already landed, so a plugin's namespaced skills are never duplicated as flat ones.

Skipped plugins (no resolvable marketplace under `--no-provision`, or ambiguous) are reported with a reason, not a failure — the run only exits non-zero on a genuine install error.

Installing plugins in the first place is left to the native tools (`claude plugin install`, `codex plugin add`, `npx plugins add`). Uninstalling is too (`claude plugin uninstall`, `codex plugin remove`) — syncthis never removes a plugin.

## Desktop-owned servers

Paper and Pencil can be desktop-owned: the config may be synced, but the server only responds when the desktop client starts it. syncthis only syncs config; it does not launch those apps.

## Unmanaged MCP files

`syncthis doctor` warns when known side files contain MCP servers that syncthis does not write, such as VS Code user MCP config or the legacy `~/.config/mcp/servers.json`. Treat those as app-owned or legacy files, not the canonical source for coding-agent sync.

## Skills

Skills are handled entirely by [`npx skills`](https://github.com/vercel-labs/skills) (Vercel Labs). syncthis runs `npx skills update -y` as part of `run`/`sync` to refresh registry-installed skills. For installing skills, use `npx skills add <repo>` directly. See [skills.sh](https://skills.sh) for the registry.

## Troubleshooting

Run `syncthis doctor` first — it reports each agent's config status, per-server coverage, conflicts, and any unmanaged side files, and exits non-zero if conflicts exist.

| Symptom | Cause | Fix |
|---|---|---|
| `N conflict(s) — left each agent's own copy untouched` | The same server name has different configs in different agents. syncthis won't choose for you. | `syncthis doctor` shows where each version lives. Delete the one you don't want (in that agent's config), then re-run `syncthis run`. |
| A server you removed keeps coming back | Union sync is additive — if the server still exists in *any* agent, it re-propagates. | Remove it everywhere in one pass: `syncthis rm <server> --all --dry-run`, review, then `--yes`. |
| `refusing destructive write without --yes` (exit 2) | A destructive command (`<from> <to>`, `from --all`, `rm`, `mirror`) was run non-interactively (CI, pipe) with no TTY to confirm at. | Add `--yes` to confirm in non-interactive contexts, or run it in a terminal. |
| `cannot read source <agent>: …` | The source agent's config is missing or malformed, so a directional sync would look like "delete everything." | syncthis bails before writing. Fix or create that agent's config, or sync from a different source. |
| `target is a symlink, refusing to write through it` | The agent config (or its `.syncthis.bak`) is a symlink. | Intentional — syncthis won't clobber a symlink. Replace it with a regular file if you want syncthis to manage it. |
| `mirror` reports plugins as `skipped` | The target can't resolve that plugin's marketplace — only happens with `--no-provision`, or on an ambiguous marketplace. Skips are expected, not failures. | Drop `--no-provision` (the default): mirror registers the marketplace, and adds bundles a target can't load as plugins as skills via `npx skills add`. |
| `mirror` reports plugins as `covered` | The bundle is already on the target as a plugin under its canonical name (a multi-plugin marketplace alias, or a URL-named plugin). | Nothing to do — `covered` means the content is present; it isn't re-added as skills (no duplication). |
| `… CLI not found on PATH` during `mirror`/`plugin list` | The agent's own CLI (`claude`, `codex`, `npx plugins`) isn't installed. | Install that agent's CLI; syncthis drives plugins through it, it doesn't bundle one. |
| Skills step says it failed or timed out | `npx skills` hit the network and was slow/unavailable. | Non-fatal — MCP sync still completed. Re-run `syncthis skills` later, or `syncthis run --no-skills` to skip it. |

syncthis honors `NO_COLOR` (disable ANSI), and `$COPILOT_HOME` / `$OPENCLAW_CONFIG_PATH` to relocate those two agents' configs (must resolve under `$HOME`).

## License

MIT
