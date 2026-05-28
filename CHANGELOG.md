# Changelog

All notable changes to `@hungv47/syncthis` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## [0.5.0] — 2026-05-28

Minimal-tool refactor. syncthis now does exactly three things: cross-agent **MCP union sync** (its unique value — nothing upstream does it), **plugin mirror** between the two agents with a native install CLI (Claude ↔ Codex), and **skills** delegated to `npx skills update -y`.

### Removed
- `syncthis status` and the plugin lifecycle/observability layer (`discovery.ts`, `status.ts`). It was built to surface "installed-but-not-surfaced" silent failures, but 0.4.0 already established those failure modes were fictional (Codex's loader recurses + follows symlinks). With nothing left to surface, `status` only re-printed `plugin list` — so it's gone.
- `syncthis plugin rm`, `syncthis plugin doctor`, and all `syncthis marketplace` commands, plus `--purge`. Uninstalling is each agent's own concern (`claude plugin uninstall`, `codex plugin remove`); it isn't a sync responsibility.
- Cursor and OpenCode dropped from the plugin cohort. Cursor has no install CLI and OpenCode plugins are npm modules — neither can be a mirror target, so they only produced "cannot be pushed" / "kind mismatch" noise.

### Changed
- `syncthis mirror` now targets only Claude ↔ Codex and reports a clean diff (no unmirrorable-target noise).
- `syncthis plugin list` remains as the single read-only plugin command.
- Net ~1,000 lines deleted across `src/` and `tests/`.

## [0.4.0] — 2026-05-28

Plugin observability and mirror across Claude Code, Codex, Cursor, and OpenCode.

### Added
- `syncthis status [--detailed] [--json]` — plugin × agent × stage matrix (registered / loaded / surfaced) with a reason for each genuine silent failure (missing cache dir, disabled, missing manifest). `--detailed` exposes the per-agent source tag; `--json` is machine-readable. The Codex lifecycle is modeled on Codex's real loader (`codex-rs/core-skills/src/loader.rs`): read `.codex-plugin/plugin.json`, take its `skills` field as a root, recursively scan (depth ≤ 6, following symlinks) for `SKILL.md`.
- `syncthis mirror <primary> [--remove-stale] [--yes] [--dry-run]` — destructive primary→all plugin sync. Refuses `kind` mismatches (bundle ↛ npm), skips agents with no native install path (Cursor) without overpromising in the preview, and guards `--remove-stale` against a primary that read-errored or reports zero plugins.

### Changed
- Welcome screen reads its version from `package.json` (was hard-coded).
- Interactive TUI picker now offers status / mirror / plugin list / plugin doctor / fan-out, each printing a useful summary.

### Note
- An earlier in-development build of this release shipped a plugin "auto-repair" (`syncthis fix`, default-on) targeting Codex "nested skills won't surface" and "missing interface block" failure modes. Reading Codex's actual loader showed both modes are fictional — Codex recurses into the skills root and follows symlinks — so the fixers and default-on repair were removed before release rather than ship false-positive repairs.

## [0.3.0] — 2026

- Plugin + marketplace sync, inspection, and removal across Claude Code, Codex, Cursor, and OpenCode.
- README/package description lead with `npx`.

## [0.2.0] — 2025

- 11-agent MCP sync, MCP-only focus, interactive TUI.
- `0.2.1`: extracted shared canonical-JSON adapter factories.

## [0.1.2] — 2025

- Secret-bearing files clamped to `0600` on write; refreshed `.syncthis.bak` backups.
