#!/usr/bin/env bash
# Deterministic mock of `syncthis run` output for the README demo (assets/demo.svg).
# Mirrors the format produced by printSync() in bin/syncthis.ts. If that format
# changes, regenerate the SVG: cd assets && vhs demo.tape

set -e

GREEN=$'\033[32m'
YELLOW=$'\033[33m'
DIM=$'\033[2m'
RESET=$'\033[0m'

ok() {
  printf '  %s✓%s %-14s %s%s%s\n' "$GREEN" "$RESET" "$1" "$DIM" "$2" "$RESET"
}

sleep 0.25
printf '%sread 5 server name(s) across 11 agent(s); 4 synced, 1 conflict(s)%s\n' "$DIM" "$RESET"

ROWS=(
  "claude-code|~/.claude.json"
  "cursor|~/.cursor/mcp.json"
  "codex|~/.codex/config.toml"
  "gemini-cli|~/.gemini/settings.json"
  "kimi-cli|~/.kimi/mcp.json"
  "antigravity|~/.gemini/antigravity/mcp_config.json"
  "github-copilot|~/.copilot/mcp-config.json"
  "windsurf|~/.codeium/windsurf/mcp_config.json"
  "opencode|~/.config/opencode/opencode.json"
  "openclaw|~/.openclaw/openclaw.json"
  "hermes-agent|~/.hermes/config.yaml"
)

for row in "${ROWS[@]}"; do
  ok "${row%%|*}" "${row##*|}"
  sleep 0.08
done

sleep 0.3
printf '\n%s1 conflict(s) — left each agent'"'"'s own copy untouched:%s\n' "$YELLOW" "$RESET"
printf '  %s~%s github\n' "$YELLOW" "$RESET"
printf '      %sin claude-code%s\n' "$DIM" "$RESET"
printf '      %sin cursor%s\n' "$DIM" "$RESET"
printf '  %sresolve by deleting the version you don'"'"'t want, then re-run sync.%s\n' "$DIM" "$RESET"

sleep 0.4
ok "skills" "npx skills update -y"
sleep 0.5
