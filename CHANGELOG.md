# Changelog

All notable changes to `@hungv47/syncthis` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## [0.6.0] — 2026-05-28

Make the Claude → Codex plugin mirror actually install everything it can, and be honest about what it can't.

### Added
- `syncthis mirror <primary> --provision` (opt-in) — when Codex has no registered marketplace for one of the primary's plugins, syncthis registers the plugin's source repo for you (`npx plugins add <owner/repo> --target codex`, repo resolved from the primary's marketplace list) and then installs it natively. Turns "not available in Codex" plugins into installed ones in a single command. Off by default so plain `mirror` stays fast and local; also offered as a prompt in the interactive picker.
- After a mirror with skips, a one-line hint that skipped **skills-only bundles** sync via `syncthis run` (`npx skills`), not the plugin mirror — so nothing looks lost.

### Changed
- Plugins the target genuinely can't install are now reported as **skipped** with a reason, not **failed**. Only a real install error counts as a failure (non-zero exit). Three distinct skip reasons: provisioned-but-unresolvable (a skills-only bundle, or an upstream multi-plugin-repo snapshot defect), no-usable-source-repo, and no-`--provision`. Summary reads `N installed · M skipped · K failed`.

### Security
- `--provision` validates the `owner/repo` slug before shelling out: rejects leading dashes (CLI option injection), `..` traversal, URLs, and shell metacharacters; subprocess args are passed array-style (no shell). `marketplaceSources()` tolerates malformed CLI JSON instead of aborting the run.

## [0.5.2] — 2026-05-28

### Changed
- `syncthis mirror` reports a plugin the target can't resolve as **skipped** (with a reason) instead of **failed** — a run no longer looks broken when a plugin's marketplace simply isn't available on the target. Only genuine install errors exit non-zero.

## [0.5.1] — 2026-05-28

Codex plugin sync now reflects reality.

### Fixed
- The Codex adapter read install state from `~/.codex/config.toml`, which records plugins merely *registered* out-of-band — so syncthis over-reported Codex (≈50 "installed" vs ~4 actually loaded) and `mirror` skipped plugins as already-present that Codex couldn't use. It now reads true install state from `codex plugin list`, so both `plugin list` and `mirror` reflect what Codex actually has.
- `codex plugin add` rejects a bare plugin name. `mirror` now resolves the target's own `<name>@<marketplace>` from Codex's snapshot (preferring `plugins-cli` when a name is ambiguous), so installs land instead of erroring.

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
