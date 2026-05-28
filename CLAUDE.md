# CLAUDE.md

Guidance for Claude Code working in this repo. Mirrored to `AGENTS.md` for Codex / other agents.

## What this is

`syncthis` is a CLI that mirrors **MCP server configs** across 11 AI coding agents:
**Claude Code, Cursor, Codex, Gemini CLI, Kimi CLI, OpenCode, OpenClaw, Hermes, Windsurf, Antigravity, GitHub Copilot CLI**.

It is a sync layer, not an installer — it reads each agent's existing config, computes the union, writes the union back, and reports conflicts.

It does exactly three things, deliberately kept minimal:
- **MCP servers** — cross-agent union sync (the unique core; no upstream tool does this).
- **Plugins** — `mirror` one agent's plugins onto another, limited to the two agents with a native install CLI: **Claude Code ↔ Codex**. Plus read-only `plugin list`. Plugins are installed artifact bundles, not portable config records, so the cohort can't be widened without an install CLI per agent.
- **Skills** — delegated entirely to [`vercel-labs/skills`](https://github.com/vercel-labs/skills) (`npx skills`), which supports 55 agents. syncthis just shells out to `npx skills update -y` after MCP sync.

A v0.4 plugin observability layer (`status`) and removal subsystem (`plugin rm` / `marketplace rm`) were removed in 0.5 — the observability premise (Codex silently drops nested-skill plugins) turned out fictional, and uninstalling is each agent's own concern. Don't reintroduce them without a concrete, verified need.

Distribution: npm package `@hungv47/syncthis`.

## Stack

- **Runtime:** Bun (engines `bun >=1.0.0`). Single-package, no workspaces.
- **Language:** TypeScript 5, `module: ESNext`, no bundler.
- **Runtime deps:** `smol-toml` (Codex TOML), `js-yaml` (Hermes YAML), `json5` (OpenClaw JSON5), `@clack/prompts` (TUI).
- **Tests:** `bun:test`. Run with `bun test`.
- **Bin entry:** `bin/syncthis.mjs` — Node `.mjs` shim that spawns `bun bin/syncthis.ts`. The shim exists because npm's bin-map handling on some shells munges paths starting with `./` and refuses `.ts` extensions; a `.mjs` shim sidesteps both.

## Layout

```
src/
  adapters/
    claude.ts         → ~/.claude.json (merges top-level + every projects.*.mcpServers scope)
    cursor.ts         → ~/.cursor/mcp.json (canonical factory)
    codex.ts          → ~/.codex/config.toml (TOML)
    gemini.ts         → ~/.gemini/settings.json (canonical factory)
    kimi.ts           → ~/.kimi/mcp.json (canonical factory)
    antigravity.ts    → ~/.gemini/antigravity/mcp_config.json (canonical factory)
    copilot.ts        → ~/.copilot/mcp-config.json (type-tagged: local | http)
    windsurf.ts       → ~/.codeium/windsurf/mcp_config.json (canonical-ish; serverUrl rename)
    opencode.ts       → ~/.config/opencode/opencode.json (most divergent: `mcp` key, command-as-array, `environment`)
    openclaw.ts       → ~/.openclaw/openclaw.json (JSON5; nested `mcp.servers`; transport field)
    hermes.ts         → ~/.hermes/config.yaml (YAML; mcp_servers snake_case)
    json-mcp.ts       → shared canonical JSON adapter factory (Cursor, Gemini, Kimi, Antigravity)
    text-mcp.ts       → shared text-format adapter factory
    index.ts          → MCP adapter registry (all 11)
  plugins/            → plugin layer (claude ↔ codex only)
    claude.ts         → read (claude plugin list --json) + installPlugin + removePlugin
    codex.ts          → read (codex plugin list, installed-only) + installPlugin (resolves bare name → name@marketplace) + removePlugin
    mirror.ts         → primary → other plugin agent: diff installs/removes, --remove-stale guard
    shell.ts          → run() subprocess helper, parsePluginId, isSafeIdentifier
    types.ts          → PluginAdapter interface + records
    index.ts          → plugin cohort registry ([claude, codex]) + listPlugins()
  sync.ts             → core: read all → compute union → write back, plus runDirectional / runFanOut / runRemove
  doctor.ts           → MCP coverage + conflict report
  tui.ts              → interactive picker (@clack/prompts)
  welcome.tsx         → first-run ink banner
  io.ts               → readJson/writeJson/readText/writeText, 0600 perms, .syncthis.bak
  types.ts            → shared MCP types (AgentId union)
bin/
  syncthis.ts         → CLI entrypoint (parsed by bun)
  syncthis.mjs        → npm bin shim (spawns bun on the .ts entry)
tests/                → sync, adapters, mirror, plugin-adapters, plugin-install
.deepsec/             → self-contained deepsec scanner config (its own package.json + lockfile)
```

## Commands

```
syncthis                                 # interactive picker (or HELP if non-TTY)
syncthis run    [--dry-run] [--no-skills]    # MCP union + skills (alias for sync)
syncthis sync   [--dry-run] [--no-skills]
syncthis mcp    [--dry-run]                  # MCP only
syncthis skills                              # skills only — `npx skills update -y`
syncthis <from> <to> [--yes] [--dry-run]     # one-way MCP mirror A → B
syncthis from <agent> --all [--yes] [--dry-run]   # fan one agent out to all others
syncthis rm <server> --all [--yes] [--dry-run]    # remove one MCP server everywhere
syncthis doctor                              # MCP coverage + conflicts
syncthis mirror <primary> [--provision] [--remove-stale] [--yes] [--dry-run]  # plugin mirror (claude ↔ codex)
syncthis plugin list                         # read-only plugin inventory
syncthis help
```

`run`/`sync` does, in order: read all 11 agent configs (for Claude, merging top-level + every per-project scope) → compute union (any server present in any agent propagates to every agent) → detect conflicts → write back where safe → run `npx skills update -y` unless `--no-skills`.

`<from> <to>` is a destructive one-way MCP mirror: overwrites `to`'s servers with `from`'s. Shows a diff and prompts for confirmation; `--yes` skips the prompt.

`mirror <primary>` is the plugin equivalent: installs the primary's plugins onto the other plugin-capable agent via its native CLI; `--remove-stale` also uninstalls what the primary lacks. Diff + confirm or `--yes`. `--provision` (opt-in) registers a plugin's source marketplace on the target before installing — Codex shells `npx plugins add <owner/repo> --target codex` (repo resolved from the primary's `marketplace list`), then `codex plugin add <name>@<marketplace>`. Skills-only bundles and multi-plugin-repo non-primary plugins still can't be installed as Codex plugins (the former sync via `npx skills`; the latter is an upstream snapshot defect) — both are reported as `skipped`, not failed.

`doctor` prints per-server coverage across agents and any conflicts. Exits non-zero if conflicts present.

## Sacred elements — do not change without explicit approval

1. **Removal is allowed only with explicit rails.** Union `sync` never deletes — it is purely additive. The MCP removal command (`syncthis rm`) must require (a) an explicit scope flag (`--all`), (b) a diff printed before any write, (c) interactive confirmation in TTY or `--yes` in non-interactive mode, and (d) `--dry-run` available to preview. The plugin `mirror --remove-stale` path follows the same diff + confirm rule and refuses to run when the primary read-errored or reports zero plugins (which would otherwise wipe the target). There is no implicit deletion anywhere in the tool.
2. **`.syncthis.bak` backup on first write.** Every target file gets a backup the first time syncthis writes to it. Tests assert this. Don't change the contract or the suffix.
3. **Conflict policy (union sync): leave each agent's own copy untouched.** If the same server name has different configs in different agents (different env, command, args), `run`/`sync` does NOT pick a winner — it leaves each agent's existing version alone and reports the conflict. The user resolves by deleting the version they don't want and re-running sync.
4. **Secret-bearing files clamped to `0600`.** Any agent file written by syncthis that may contain API keys/tokens has its permissions clamped on write. Don't relax this. Applies to all 11 adapters.
5. **Directional sync requires explicit confirmation.** `<from> <to>` is destructive (overwrites `to`). It must show a diff and prompt OR require `--yes` in non-interactive contexts. Never silently overwrite.
6. **Claude per-project scope merge on read, top-level on write.** Claude stores MCP servers in two places: top-level `mcpServers` (user scope) and `projects.<path>.mcpServers` (per-project scope, the default for `claude mcp add`). The adapter reads both and merges; writes go to top-level only, leaving project scopes untouched so Claude's per-project behavior is preserved.

## Distribution

- **npm:** `@hungv47/syncthis` (current: `0.5.0`). Bump in `package.json` and tag a release; no automated publish pipeline yet.
- **Install:** `bun install -g @hungv47/syncthis` or `npm install -g @hungv47/syncthis`.
- **The `.mjs` bin shim is intentional** — see Stack note above. Don't try to point `bin` directly at a `.ts` file or a path with leading `./`.

## Deepsec integration

`.deepsec/` is a self-contained sub-package (its own `package.json`, `pnpm-workspace.yaml`, `bun.lock`) configuring [deepsec](https://npmjs.com/package/deepsec) — an AI-powered vulnerability scanner — to scan the parent syncthis repo. It is dev tooling, not part of the published CLI. Do not bundle it.

## Testing

```bash
bun test                  # full suite
bun tsc --noEmit          # typecheck
```

Always run tests AND typecheck before bumping the version. Sacred elements (conflict policy, 0600 perms, .syncthis.bak, Claude per-project merge, directional confirmation) are non-negotiable.

## What this repo is NOT

- Not an MCP server installer. Use `mcpm`, `claude mcp add`, etc. — syncthis only mirrors what's already installed.
- Not a skills tool. Skills are entirely delegated to `vercel-labs/skills` (`npx skills`). syncthis used to have a handcrafted Claude↔Cursor skill propagator; it was retired in 0.2 because the upstream is better and covers 55 agents.
- Not a config source-of-truth. There is no `syncthis.json`. The agents themselves are the source of truth; syncthis just keeps them in agreement.
