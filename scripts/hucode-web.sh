#!/usr/bin/env bash

set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)

cd "$ROOT"
node build/hucode/run-with-mixin.js --quality stable -- ./scripts/code-web.sh "$@"
