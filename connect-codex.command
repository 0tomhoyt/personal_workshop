#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
node scripts/configure-codex.mjs --config "${1:-$PWD/providers.json}"
