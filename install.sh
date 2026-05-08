#!/usr/bin/env bash
set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
CYAN='\033[36m'
RESET='\033[0m'

info()  { echo -e "${BOLD}${GREEN}✓${RESET} $1"; }
warn()  { echo -e "${BOLD}${YELLOW}⚠${RESET} $1"; }
fail()  { echo -e "${BOLD}${RED}✗${RESET} $1"; }
step()  { echo -e "\n${BOLD}── $1 ──${RESET}"; }

ask() {
  local prompt="$1" default="${2:-y}"
  local yn
  if [ "$default" = "y" ]; then
    printf "${CYAN}?${RESET} ${prompt} ${DIM}[Y/n]${RESET} "
  else
    printf "${CYAN}?${RESET} ${prompt} ${DIM}[y/N]${RESET} "
  fi
  read -r yn
  yn="${yn:-$default}"
  [[ "$yn" =~ ^[Yy] ]]
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo -e "${BOLD}reharness${RESET} — deterministic multi-agent pipeline framework"
echo -e "${DIM}https://github.com/bes-dev/reharness${RESET}\n"

# ── CLI ──

if ask "Install CLI (reharness + reharness-mcp)?"; then
  step "Installing CLI"
  cd "$SCRIPT_DIR"
  npm install --silent 2>/dev/null
  npm run build --silent 2>/dev/null
  npm link --silent 2>/dev/null

  if command -v reharness &>/dev/null; then
    info "reharness: $(which reharness)"
  else
    fail "CLI install failed. Try: cd $SCRIPT_DIR && npm link"
  fi

  if command -v reharness-mcp &>/dev/null; then
    info "reharness-mcp: $(which reharness-mcp)"
  else
    warn "reharness-mcp not in PATH (may need shell restart)"
  fi
else
  warn "Skipping CLI"
fi

# ── Claude Code Skills ──

if ask "Install Claude Code skills (/reharness-generate, /reharness-evolve)?"; then
  step "Installing Claude Code skills"
  CLAUDE_SKILLS="${HOME}/.claude/skills"
  mkdir -p "$CLAUDE_SKILLS"

  for skill_dir in "$SCRIPT_DIR"/integrations/claude-code/skills/*/; do
    skill_name="$(basename "$skill_dir")"
    target="$CLAUDE_SKILLS/$skill_name"
    if [ -L "$target" ]; then
      rm "$target"
    elif [ -d "$target" ]; then
      warn "$skill_name exists (not a symlink), skipping"
      continue
    fi
    ln -s "$skill_dir" "$target"
    info "skill: /$skill_name"
  done
else
  warn "Skipping Claude Code skills"
fi

# ── MCP Server ──

if ask "Configure MCP server for Claude Code / Cursor?"; then
  step "Configuring MCP server"
  MCP_CONFIG="${HOME}/.claude/mcp.json"

  if [ -f "$MCP_CONFIG" ]; then
    if grep -q '"reharness"' "$MCP_CONFIG" 2>/dev/null; then
      info "Already configured in $MCP_CONFIG"
    else
      warn "Config exists but reharness not in it. Add manually:"
      echo -e "  ${DIM}\"reharness\": { \"command\": \"reharness-mcp\" }${RESET}"
    fi
  else
    mkdir -p "$(dirname "$MCP_CONFIG")"
    cat > "$MCP_CONFIG" <<'EOF'
{
  "mcpServers": {
    "reharness": {
      "command": "reharness-mcp"
    }
  }
}
EOF
    info "Created $MCP_CONFIG"
  fi
else
  warn "Skipping MCP server"
fi

# ── Pi Agent ──

if [ -d "${HOME}/.pi/agent" ]; then
  if ask "Add reharness tool to Pi agent system prompt?"; then
    step "Configuring Pi agent"
    PI_PROMPT="${HOME}/.pi/agent/system-prompt.md"
    MARKER="# reharness Tool"

    if [ -f "$PI_PROMPT" ] && grep -q "$MARKER" "$PI_PROMPT" 2>/dev/null; then
      info "Already in Pi system prompt"
    else
      echo "" >> "$PI_PROMPT"
      cat "$SCRIPT_DIR/integrations/pi/reharness-tool.md" >> "$PI_PROMPT"
      info "Updated $PI_PROMPT"
    fi
  else
    warn "Skipping Pi integration"
  fi
fi

# ── Summary ──

step "Done"
echo ""
echo -e "Run ${BOLD}reharness --help${RESET} to get started."
echo ""
