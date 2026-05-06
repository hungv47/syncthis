# CLAUDE.md

Guidance for Claude Code working in this repo. Mirrored to `AGENTS.md` for Codex / other agents.

## What this is

`syncthis` is a CLI that mirrors **MCP server configs** and **user-authored skills** across four AI coding agents: Claude Code, Cursor, Codex, Gemini CLI. It is a sync layer, not an installer — it reads each agent's existing config, computes the union, writes the union back, and reports conflicts. Distribution: npm package `@hungv47/syncthis`.

## Stack

- **Runtime:** Bun (engines `bun >=1.0.0`). Single-package, no workspaces.
- **Language:** TypeScript 5, `module: ESNext`, no bundler.
- **Sole runtime dep:** `smol-toml` — for Codex's `~/.codex/config.toml` (round-trip TOML I/O).
- **Tests:** `bun:test`. Run with `bun test`.
- **Bin entry:** `bin/syncthis.mjs` — Node `.mjs` shim that spawns `bun bin/syncthis.ts`. The shim exists because npm's bin-map handling on some shells munges paths starting with `./` and refuses `.ts` extensions; a `.mjs` shim sidesteps both.

## Layout

```
src/
  adapters/
    claude.ts       → ~/.claude.json (top-level mcpServers)
    cursor.ts       → ~/.cursor/mcp.json
    codex.ts        → ~/.codex/config.toml (TOML)
    gemini.ts       → ~/.gemini/settings.json
    json-mcp.ts     → shared JSON adapter factory (used by Claude, Cursor, Gemini)
    index.ts        → adapter registry
  sync.ts           → core: read all → compute union → write back, conflict policy
  skills.ts         → Claude ↔ Cursor skill propagation (SKILL.md ↔ .mdc)
  doctor.ts         → coverage + conflict report
  types.ts          → shared types
bin/
  syncthis.ts       → CLI entrypoint (parsed by bun)
  syncthis.mjs      → npm bin shim (spawns bun on the .ts entry)
tests/
  sync.test.ts      → 28 tests (union, conflicts, TOML/JSON round-trip, backups, dry-run, idempotence)
  skills.test.ts    → 8 tests (Claude↔Cursor propagation, divergence, path-traversal rejection)
.deepsec/           → self-contained deepsec scanner config (its own package.json + lockfile)
```

## Commands

```
syncthis sync [--dry-run] [--no-skills]
syncthis doctor
syncthis help
```

`sync` does, in order: read all 4 agent configs → compute union (any server present in any agent propagates to every agent) → detect conflicts → write back where safe → propagate skills (Claude SKILL.md ↔ Cursor .mdc) unless `--no-skills` → run `npx -y skills update -y` to refresh registry-installed skills.

`doctor` prints per-server coverage across agents and any conflicts. Exits non-zero if conflicts present.

## Sacred elements — do not change without explicit approval

1. **No `remove` command.** Removal goes through the user's installer (`mcpm remove`, etc.) or by editing the agent file directly. Adding a `remove` command would create a footgun (surprise deletion across 4 agents).
2. **`.syncthis.bak` backup on first write.** Every target file gets a backup the first time syncthis writes to it. Tests assert this. Don't change the contract or the suffix.
3. **Conflict policy: leave each agent's own copy untouched.** If the same server name has different configs in different agents (different env, command, args), syncthis does NOT pick a winner — it leaves each agent's existing version alone and reports the conflict. The user resolves by deleting the version they don't want and re-running sync.
4. **Secret-bearing files clamped to `0600`.** Any agent file written by syncthis that may contain API keys/tokens has its permissions clamped on write. Don't relax this.
5. **Skills canonical store is Claude.** When propagating Claude → Cursor, generate the `.mdc` with translated frontmatter. If the user edits the Cursor `.mdc` directly, the next sync must detect divergence and leave both alone (flagged `diverged`). Don't make Cursor authoritative.
6. **Path-traversal rejection in skills propagation.** Tests assert this. Skill names with `..`, absolute paths, or shell metacharacters must be rejected before any filesystem write.

## Distribution

- **npm:** `@hungv47/syncthis` (current: `0.1.2`). Bump in `package.json` and tag a release; no automated publish pipeline yet.
- **Install:** `bun install -g @hungv47/syncthis` or `npm install -g @hungv47/syncthis`.
- **The `.mjs` bin shim is intentional** — see Stack note above. Don't try to point `bin` directly at a `.ts` file or a path with leading `./`.

## Deepsec integration

`.deepsec/` is a self-contained sub-package (its own `package.json`, `pnpm-workspace.yaml`, `bun.lock`) configuring [deepsec](https://npmjs.com/package/deepsec) — an AI-powered vulnerability scanner — to scan the parent syncthis repo. It is dev tooling, not part of the published CLI. Do not bundle it.

## Testing

```bash
bun test                  # full suite (sync.test.ts + skills.test.ts)
bun test sync             # just sync logic
bun test skills           # just skills propagation
```

Always run tests before bumping the version. The conflict-policy and path-traversal tests are non-negotiable.

## What this repo is NOT

- Not an MCP server installer. Use `mcpm`, `claude mcp add`, etc. — syncthis only mirrors what's already installed.
- Not a skills registry / installer. `npx skills add` from the registry handles installation; syncthis only propagates user-authored skills between Claude and Cursor and refreshes the registry.
- Not a config source-of-truth. There is no `syncthis.json`. The agents themselves are the source of truth; syncthis just keeps them in agreement.
