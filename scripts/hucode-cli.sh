#!/usr/bin/env bash
#
# Copyright (c) Hucode contributors. All rights reserved.
# Licensed under the MIT License. See LICENSE.txt in the project root for license information.

set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)

cd "$ROOT"
node build/hucode/run-with-mixin.js --quality stable -- ./scripts/code-cli.sh "$@"
