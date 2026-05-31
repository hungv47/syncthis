# Changelog

All notable changes to `@hungv47/syncthis` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## [0.9.4] — 2026-05-31

### Fixed
- **Plugin mirror now fails fast when the primary can't be read.** Direct `runMirror()` callers now get an error instead of a report that could look like an empty primary with nothing to mirror. CLI and TUI callers use the same core guard, so the behavior is consistent across entrypoints.

### Changed
- **Plugin-bundled skill discovery is faster on large plugin sets.** Local marketplace filesystem probes now run in parallel, and the already-synced guard overlaps its installed-skill probe with repo SKILL.md scans. `npx skills add` still runs sequentially to avoid races in shared skill directories.

## [0.9.3] — 2026-05-30

### Changed
- **Refreshed the welcome banner.** The subtitle now reads "MCP servers, skills & plugins" (plugins were missing). Command descriptions are tightened so every row fits on one line — previously the `mirror` row wrapped and garbled (`$syncthis mirror` / `<primary>`) on narrow terminals because its description overflowed the command column. `mcp` and `skills` are now separate rows (they're distinct commands), and `mirror` is surfaced second as a headline command. No command behavior changed — banner copy only.

## [0.9.2] — 2026-05-30

### Fixed
- **`mirror` apply no longer looks frozen.** A full mirror runs many sequential `npx`/`codex` network calls (codex installs + cursor pushes + skill adds) — for a large plugin set that's 100+ ops over several minutes, and the apply printed nothing until it finished, so it looked hung. `runMirror` now takes an `onProgress` callback: the TUI shows a live spinner (`codex: <plugin> (12/28)`, `cursor: <repo> (5/41)`, `skills: <repo> (3/33)`) and the CLI streams per-item progress lines. Added an up-front "this hits the network, can take a few minutes" note. No behavior change — additive and idempotent as before, so it's always safe to interrupt and re-run.

## [0.9.1] — 2026-05-30

### Fixed
- **Welcome banner no longer errors with "Font file for the font 'block' could not be found."** The banner used `ink-big-text`, whose `cfonts` engine loads its font via a runtime `require("../fonts/block.json")` — a path the single-file `bun build` bundle can't resolve, so every node-bundled install (0.7.0–0.9.0) printed the cfonts error instead of the wordmark. The "syncthis" wordmark is now a static, pre-rendered string in `welcome.tsx` (gradient preserved), with no runtime font dependency. Dropped `ink-big-text`/`cfonts` from the bundle. Also refreshed the banner's stale `mirror` command description.

## [0.9.0] — 2026-05-29

`mirror` now propagates a primary's plugin content to **every** other agent, can't fail on multi-plugin marketplaces, and can never uninstall.

### Added
- **`mirror` reaches the 8 non-plugin agents too.** After installing plugins on Codex and pushing to Cursor, a Claude-primary mirror now adds the primary's plugin-bundled skills to the non-plugin agents (gemini, kimi, opencode, …) via `npx skills add` — the same surface `run` uses, now driven by `mirror`. One command makes a plugin's content reachable everywhere: native plugin where loadable, skills everywhere else. The preview and summary show all three target groups (codex, cursor, skills→agents) — previously the TUI showed only Codex.

### Fixed
- **Multi-plugin marketplaces no longer fail the mirror.** Marketplaces like `browserbase`, `expo`, and `anthropics/skills` alias one bundle under several plugin names whose `plugin.json` name differs from the entry name. Claude tolerates this; Codex hard-rejects it (`plugin.json name X does not match marketplace plugin name Y`). The mirror was reporting these as hard failures. Now the canonical plugin installs, and each alias is recognized as **covered by the same bundle** (no error, no duplicate skills add).
- **`github.com-*` plugins now reach Codex.** A plugin Claude named from a URL install (`github.com-garrytan-gstack`) never matched the repo's real plugin name (`gstack`). Provisioning installs it under the real name; the mirror detects the bundle landed (install-set diff) and marks it covered, falling back to skills only for genuinely skills-only repos — so no flat-vs-namespaced skill duplication on Codex.
- **No skill duplication on re-runs / alias-only primaries.** The alias name-mismatch path now recognizes its canonical plugin being present (already installed from a prior run, or installed by this run's provision) and marks the alias `covered` instead of re-adding the bundle's skills flat. The mirror also seeds its covered-repo set from plugins already on the target. Without this, a second `mirror` (canonical already installed, only the unloadable alias left to sync) re-added the bundle's namespaced skills as flat skills every run.
- **Plugin-list reads no longer time out silently.** `claude`/`codex plugin list` reads were on the 15s default timeout; a cold CLI start could exceed it, yielding an empty primary that looked like "nothing to mirror". Reads now get 60s, installs 180s, and a failed primary read aborts loudly instead of silently no-op'ing.

### Changed
- **Provisioning is on by default** (was `--provision`). Mirror registers missing marketplaces and falls unloadable bundles back to skills automatically — pass `--no-provision` for an offline/local run. The TUI no longer asks about it.
- **`mirror` is additive only — `--remove-stale` is removed.** There is no longer any plugin-uninstall path anywhere in syncthis (the `removePlugin` adapter method and the destructive mirror prompt are gone), so a mirror can never wipe an agent's plugins.
- TUI simplified: clearer one-line brief, shorter labels, and the mirror flow drops the remove-stale and provision questions.

## [0.8.0] — 2026-05-29

Close the Codex coverage gap for skills-only plugin bundles.

### Added
- **`mirror <primary> --provision` now falls back to skills on Codex.** A plugin that's a skills-only bundle (or a multi-plugin-repo snapshot defect) can't load as a Codex *plugin*, so previously it reached Codex through no path at all — `run`'s skills pass deliberately excludes the plugin cohort. Under `--provision`, after the native install is skipped, the mirror now adds the bundle's skills to Codex via `npx skills add <repo> -a codex`, shown as a fallback row. Safe from duplication: it only fires for bundles Codex couldn't load as a plugin, so there's nothing to collide with. No new command or flag — it rides on the existing `--provision`.

### Changed
- The post-mirror skip tip now points at `--provision` (which can bring skills-only bundles to Codex as skills) instead of `syncthis run` (whose skills pass never targets Codex). The provisioned-but-unloadable skip message reflects the skills fallback.

## [0.7.0] — 2026-05-29

Pre-launch hardening: runs on Node without Bun, idempotent for every transport, crash-safe writes.

### Fixed
- **SSE/streamable-http servers now converge.** Agents that can't store a transport subtype (Hermes, Windsurf, Copilot, OpenCode) read a URL server back as `http`, so a second `sync` saw `sse`-vs-`http` for the same name and raised a permanent conflict the user could never resolve. Transport subtype is now excluded from the conflict identity (the URL is the identity), so sync stays at zero conflicts across repeated runs while transport-capable agents keep their original `type`.
- **Config writes are atomic.** Writes go to a sibling temp file clamped to `0600` and are `rename`d over the target, so a crash / `ENOSPC` mid-write can no longer truncate an agent's config into an empty `{}`. This also fixes a permission bug where a pre-existing `0400` file became unwritable and bricked the next sync.
- `readLine()` no longer hangs forever on EOF-without-newline (Ctrl-D / closed pipe) at a destructive confirmation prompt — EOF now aborts safely.
- A malformed `~/.claude/plugins/known_marketplaces.json` no longer crashes the whole `sync`; the skills pass treats it as "no sources" and continues.
- Windsurf adapter preserves unknown per-server fields on rewrite (matching the other adapters' previous-merge), so a re-sync no longer drops Windsurf-specific keys.
- A bad CLI flag now exits `2` (usage error) instead of `1`, matching every other usage-error path.

### Changed
- **Runs on Node ≥18 — no Bun required.** The CLI is bundled with `bun build --target=node` into a single self-contained `dist/syncthis.mjs` (Node shebang). `npx @hungv47/syncthis run` now works for Node-only users; the prior `.mjs` shim that hard-spawned `bun` (exit 127 without it) is gone. Bun is still the dev runtime.
- Subprocess and file I/O moved from `Bun.*` APIs to `node:child_process` / `node:fs` so the bundle is portable.
- Timed-out shell-outs report `timed out after Ns` instead of a confusing negative/`-15` exit; the Codex `--provision` re-read failure is now reported as a failure with its cause, not a benign skip.

### Removed
- Dropped `react-devtools-core` (a 15 MB dependency that was never imported at runtime) and moved all runtime deps to `devDependencies` — they're bundled in. The published tarball is now 4 files (~470 KB) and installs zero transitive deps.

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
