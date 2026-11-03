#!/usr/bin/env bash
# Fetch TypeScript's own compiler test cases (tests/cases/{compiler,conformance}) at the tag matching
# tsval's `typescript` dependency into vendor/typescript-cases (gitignored). Apache-2.0: LICENSE.txt and
# ThirdPartyNoticeText.txt travel with them.
set -euo pipefail
PIN="v5.9.3"
ROOT="$(cd "$(dirname "$0")/.." && pwd)/vendor/typescript-cases"
rm -rf "$ROOT"
git clone -q --filter=blob:none --sparse --depth 1 --branch "$PIN" https://github.com/microsoft/TypeScript "$ROOT"
git -C "$ROOT" sparse-checkout set --no-cone /tests/cases/compiler /tests/cases/conformance /LICENSE.txt /ThirdPartyNoticeText.txt
rm -rf "$ROOT/.git"
echo "TypeScript @ $PIN → $ROOT ($(find "$ROOT/tests/cases" -name '*.ts' | wc -l | tr -d ' ') .ts files)"
