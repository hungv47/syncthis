# syncthis

## What this codebase does

`@hungv47/syncthis` is a local-only CLI (Bun/TypeScript) that mirrors MCP
server configs and user-authored skills across four coding agents:
Claude Code, Cursor, Codex, and Gemini CLI. It mutates user-scope
dotfiles in `$HOME` (`~/.claude.json`, `~/.cursor/mcp.json`,
`~/.codex/config.toml`, `~/.gemini/settings.json`) and skill dirs
(`~/.claude/skills/`, `~/.cursor/rules/`). No server, no network
listener, no database, no multi-tenant surface. Run as the human
developer on their own machine.

## Auth shape

There is no in-process auth model — the trust boundary is filesystem
permissions on the developer's home directory. Relevant primitives:

- `writeRestrictive` (`src/io.ts`) — every write goes through this; new
  files land at mode `0o600`, existing files keep their existing mode
  ANDed with `0o600`. MCP configs frequently embed API keys in `env`,
  so this is the secret-protection backstop.
- `backupIfExists` — copies `<file>` to `<file>.syncthis.bak` before
  the first overwrite and `chmod`s the backup to `0o600`. Backups must
  inherit the secret-bearing classification.
- `isSymlink` guard — `writeJson` / `writeText` / `backupIfExists`
  refuse to follow a symlink at the target path. Any new write helper
  must keep this guard or the symlink check is bypassed.
- `assertSafeName` + `SAFE_NAME = /^[\w.-]+$/` (`src/skills.ts`) —
  validates skill directory/file names before they're joined into
  `~/.claude/skills/<name>/SKILL.md` or `~/.cursor/rules/<name>.mdc`.
- `expandHome` — only expands a leading `~` or `~/`; does not expand
  `$VAR` or arbitrary env. All user-supplied paths flow through this.

## Threat model

Primary: leaking API keys carried inside MCP `env` blocks via a
world-readable backup, log line, or symlink-redirected write. Secondary:
a hostile skill name or symlinked dotfile causing writes outside the
intended target (`~/.claude/skills/<name>/` or the four agent config
files). Tertiary: the supply chain of `npx -y skills update -y`, which
is intentional and out of scope for this scanner. Not in scope: network
attackers, multi-user systems, privilege escalation — this is a
single-user dev tool.

## Project-specific patterns to flag

- **New write paths that bypass `writeJson` / `writeText`.** Anything
  that writes to a config or backup path without going through
  `src/io.ts` loses the symlink guard and the `0o600` clamp. Direct
  `Bun.write` / `node:fs` writes to a user dotfile are a finding.
- **Skill names or path segments joined without `assertSafeName`.**
  Any new code that takes a skill name (frontmatter `name`, filename,
  CLI arg) and `join`s it into a directory path must call
  `assertSafeName` first. Missing call = directory traversal risk.
- **Logging or echoing MCP server config.** `McpServer` may carry
  `env: { OPENAI_API_KEY: "sk-…" }` etc. `console.log` of a server
  object, including in error messages or doctor/sync output, leaks
  secrets.
- **New `Bun.spawn` / `Bun.$` call sites.** Today the ONLY child
  process is `spawn(["npx", "-y", "skills", "update", "-y"])` in
  `runSkillsUpdate` — argv array, all literals. A new spawn that
  interpolates a string (file path, server name, skill name) into a
  shell or argv is a command-injection finding.
- **Adapter `write()` that doesn't preserve unknown keys.** Each
  adapter reads the existing config, updates `mcpServers` /
  `mcp_servers`, and spreads the rest unchanged. A `write` that
  emits only the synced shape would clobber unrelated user settings
  in `~/.claude.json` or `~/.codex/config.toml`.

## Known false-positives

- `~/.claude.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml`,
  `~/.gemini/settings.json`, `~/.claude/skills/`, `~/.cursor/rules/` —
  reading and writing these is the product, not path traversal.
- `spawn(["npx", "-y", "skills", "update", "-y"])` in
  `src/sync.ts` — `-y` is intentional; this is the whole point of the
  `skills` refresh phase.
- `chmod 0o600` and the `mode & 0o600` mask in `writeRestrictive` —
  intentionally restrictive on secret-bearing files; not overly tight.
- `tests/*.test.ts` use `Bun.file` / `mkdtemp` style temp paths and
  fake home dirs — fixtures, not real user-dotfile mutation.
- `.syncthis.bak` files reappearing on every first write — by design;
  the `backupIfExists` swallows `ENOENT` and otherwise always copies.
