#!/usr/bin/env bash
set -euo pipefail

BOLD='\033[1m'; DIM='\033[2m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'

info() { echo -e "${BOLD}${GREEN}✓${RESET} $1"; }
fail() { echo -e "${BOLD}${RED}✗${RESET} $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo -e "${BOLD}reharness${RESET} — conversational AI workflow compiler\n"

cd "$SCRIPT_DIR"
npm install --silent
npm run build --silent
npm link --silent

if command -v reharness &>/dev/null; then
  info "reharness: $(which reharness)"
  echo ""
  echo -e "Run ${BOLD}reharness --help${RESET} to get started."
else
  fail "Install failed. Try: cd $SCRIPT_DIR && npm link"
  exit 1
fi
