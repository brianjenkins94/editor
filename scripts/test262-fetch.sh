#!/usr/bin/env bash
# Fetch the pinned test262 checkout (harness + test/language only) into vendor/test262 (gitignored).
set -euo pipefail
PIN="419d3e0a"
ROOT="$(cd "$(dirname "$0")/.." && pwd)/vendor/test262"
rm -rf "$ROOT"
git clone -q --filter=blob:none --sparse https://github.com/tc39/test262 "$ROOT"
git -C "$ROOT" sparse-checkout set harness test/language
git -C "$ROOT" checkout -q "$PIN"
rm -rf "$ROOT/.git"
echo "test262 @ $PIN → $ROOT ($(find "$ROOT/test/language" -name '*.js' | wc -l | tr -d ' ') tests)"
