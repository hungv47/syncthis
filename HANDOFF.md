# Handoff: Cross-Agent Sync — Phases 1–3 Shipped

**Last session:** 2026-05-27 · shipped at commit `fe2a0bc` on `main` · package still `0.3.0` (version not bumped — see "before next release" below).

Companion docs:
- [`plan-cross-agent-sync.md`](./plan-cross-agent-sync.md) — the full plan with §7 resolved decisions (gitignored; lives only on this machine).
- [`agent-configs.md`](./agent-configs.md) — reference map of agent storage formats (untracked).
- [`CLAUDE.md`](./CLAUDE.md) — sacred constraints. Re-read before any work below the API.

---

## What shipped in `fe2a0bc`

Three new commands + default-on auto-repair, closing the canonical "installed but not surfaced" gap.

| Command | What |
|---|---|
| `syncthis status [--detailed] [--json]` | Plugin × agent × stage matrix with reason text per silent failure |
| `syncthis fix [<plugin>] [--dry-run]` | Repair detected silent failures (idempotent, `.syncthis.bak` on first patch) |
| `syncthis mirror <primary> [--remove-stale] [--yes] [--dry-run]` | Destructive primary→all plugin sync |
| `syncthis sync` | Now runs auto-repair by default; `--no-repair` opts out |

**New modules** (all under `src/plugins/`):
- `discovery.ts` — per-agent lifecycle stage detector (registered / loaded / surfaced + `failureTags`)
- `status.ts` — matrix builder; `hasSilentFailures()` excludes intentionally-disabled (matches CLI/TUI semantics)
- `fixers.ts` — `codex-flatten-skills` (symlink aliases) + `codex-inject-interface` (synthesize manifest from skills)
- `mirror.ts` — primary→all with the safety guard that refuses `--remove-stale` if primary read errored or reports zero plugins

**Adapter changes:**
- Added `installPlugin?` to `PluginAdapter` interface (types.ts)
- Implemented on `claude.ts` (delegates to `claude plugin install`) and `codex.ts` (delegates to `codex plugin add`)
- `opencode.ts` does NOT implement `installPlugin` — unreachable via the kind-mismatch guard until a second npm-kind adapter lands

**TUI refresh** (`src/tui.ts`): picker now lists status / fix / mirror / plugin list / plugin doctor / fan-out, each branch prints a useful summary (was just "done.").

**Welcome screen** (`src/welcome.tsx`): version sourced from `package.json` (was hard-coded `0.2.0`).

**Help text** (`bin/syncthis.ts` HELP block): documents the auto-repair behavior under `what sync does` step 5.

---

## Test + typecheck status

- `bun test` → **150/150 passing** across 11 files
- `bun tsc --noEmit` → **clean**
- New test files: `tests/{discovery,status,fixers,mirror,plugin-install}.test.ts` (51 new tests)
- Round-trip test (apply → revert via `.syncthis.bak` → reapply) is in place for `codex-flatten-skills` per the sacred §10 requirement

---

## Phase map (plan §6)

| Phase | Status | Notes |
|---|---|---|
| Phase 0 — Research sprint (`research/failure-modes.md`) | **NOT DONE** | Was deferred. Discovery heuristics are working empirically against the live `~/.codex/plugins/cache` layout but not formally documented or matrix-tested. |
| Phase 1 — Observability | **DONE** | `syncthis status` ships |
| Phase 2 — Sync (`syncthis mirror`) | **DONE** | Covers claude↔codex; opencode/cursor have read-only adapter slots |
| Phase 3 — Auto-repair (`syncthis fix`, default-on) | **DONE** | Two fixers; default-on per §7 #2 |
| Phase 4 — Open the loop | **NOT STARTED** | Upstream bug reports, schema publication, evaluate Option D |

---

## Known limits — bring honest framing to any "does it work?" question

1. **Plugin coverage is 4 of 11 agents.** Only `claude-code`, `codex`, `cursor`, `opencode` have plugin adapters. The other 7 (gemini, kimi, antigravity, copilot, windsurf, openclaw, hermes) need adapter scaffolding before they can participate in `status`/`fix`/`mirror`.
2. **`mirror` blocks kind mismatches.** `bundle` (claude/codex/cursor) cannot mirror to `npm` (opencode). Intentional — see `src/plugins/mirror.ts` `kind mismatch` branch.
3. **Cursor is read-only in `mirror`.** No native `cursor plugin install` CLI; mirror skips with `unsupportedReason`. To fix: write a Cursor plugin adapter `installPlugin` that writes directly to `~/.cursor/plugins/<scope>/<owner>/<name>/`.
4. **No plugin union `sync`.** Plugins only have `mirror` (primary→all), not the additive-union sync that MCP has. Adding it is a real design call (which agent's version wins on conflict?) — defer unless asked.
5. **Codex cache walker assumes `<owner>/<plugin>/<sha>/` layout** and skill location `skills/` (not `skill-data/`). Live `~/.codex` testing showed this mostly works but Phase 0 needs to formally catalog the variations (e.g. `googleworkspace-cli` cache uses `<owner>/<repo-prefixed-name>/<sha>/`).
6. **Discovery doesn't read `enabled` from per-project Claude scopes.** It uses the bare `enabled` field reported by `claude plugin list --json` (top-level scope only). Per-project disables aren't surfaced.
7. **No telemetry yet.** §7 #4 spec'd `SYNCTHIS_TELEMETRY=on` env-var opt-in; not implemented.

---

## Resolved decisions (do not relitigate — see plan §7)

1. `sync` is the default; `mirror` is the explicit opt-in subcommand
2. **Auto-repair is default-on**, `--no-repair` opts out. This was explicitly chosen against the autoreview engine's later suggestion to flip it.
3. Codex `name@source` hidden by default, `--detailed` exposes it
4. Telemetry: env-var opt-in only, no flag, no prompt
5. MCP coverage: deepen the 11 first; plugins outranks any MCP-adapter expansion in v1
6. `syncthis fix` writes into the agent's own cache, no overlay

---

## Autoreview history (this branch)

Two rounds against `fe2a0bc`'s diff — both engines (Codex and Claude) hit usage caps before a clean closeout, so there is no green "0 findings" run on record. All findings raised across both rounds **were addressed** (commits rolled into `fe2a0bc`):

| Round | Engine | Findings | Status |
|---|---|---|---|
| 1 | Claude (Codex out until May 31) | 5 | All addressed |
| 2 | Claude | 3 | All addressed |
| 3 | Claude | — | Cap hit, not run |

Recommended on resumption: re-run `autoreview --mode commit --commit fe2a0bc --engine codex` once credits reset (May 31 for Codex, daily for Claude) to get a clean exit-0 on record before bumping the package version.

---

## Where to pick up next

**Immediate (before next release):**
1. Bump `package.json` version (`0.3.0 → 0.4.0` — these are net-new commands, minor bump)
2. Update README to document `status`, `fix`, `mirror`
3. Add a CHANGELOG entry calling out **default-on auto-repair** so upgraders aren't surprised
4. Re-run autoreview to closeout-clean and tag the release

**Phase 0 catch-up (high value before extending discovery):**
- Build `syncthis/research/failure-matrix.md` per plan §8 — install 5 representative plugins (forsvn-skills, impeccable, brave-search-skills, vercel/vercel-plugin, Nutlope/hallmark) across all 11 agents, record per (plugin × agent) what registers / loads / surfaces. The empirical doc drives the next round of fixers.

**Plugin-coverage expansion (in priority order):**
1. **Gemini CLI** — has plugin concept (`~/.gemini/`), would unlock fan-out to 5 agents
2. **Kimi / Antigravity** — both already have MCP adapters using `json-mcp.ts` factory; plugin adapters would parallel that
3. **Copilot / Windsurf / OpenClaw / Hermes** — defer; less user demand

For each new adapter: implement `read()` + `removePlugin?` first (so it participates in `status` / `plugin list`); add `installPlugin?` second (so it becomes a viable `mirror` target).

**Concrete cleanup tasks:**
- `bin/syncthis.ts` has grown to ~900 lines and now mixes data orchestration with rendering. Extract a `src/render.ts` so `bin/` and `src/tui.ts` share glyphs and row formatters (currently TUI prints terser summaries and points users to the CLI for detail — fine for now, but won't scale).
- `src/plugins/discovery.ts`'s `findSkillManifests` has a hardcoded `depth > 4` guard. Phase 0 should pin the real maximum depth across observed plugins.
- Add `--json` to `syncthis fix` and `syncthis mirror` for scriptable use (already on `status`).

**Deferred (do not start without user OK):**
- Plugin union `sync` (additive, like MCP) — needs design decision on conflict policy
- Telemetry implementation
- Phase 4 (upstream bug reports, schema publication)
- "Option D" — becoming the installer. Plan explicitly says re-evaluate only after A/B/C operate well for 6+ months.

---

## Local-only state worth knowing

- `plan-cross-agent-sync.md` (gitignored via `PLAN-*.md` case-insensitive match on macOS) — keep editing freely; it persists on this machine only.
- `agent-configs.md` untracked at session start, untouched by this session.
- `.deepsec/` sub-package is dev tooling; do not bundle.

---

## How to resume in a new session

Open this file, then read in order:
1. `CLAUDE.md` (sacred constraints)
2. `plan-cross-agent-sync.md` §7 (resolved decisions) and §10 (sacred constraints carried forward)
3. This file's "Where to pick up next" section
4. Recent commits: `git log --oneline fe2a0bc^..`

Then run `bun test && bun tsc --noEmit` to confirm baseline before touching anything.
