#!/usr/bin/env bash

set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)

cd "$ROOT"

args=()
has_connection_token_arg=0

for arg in "$@"; do
	case "$arg" in
		--connection-token|--connection-token=*|--without-connection-token)
			has_connection_token_arg=1
			;;
	esac
done

if [[ "$has_connection_token_arg" == "0" ]]; then
	args+=(--without-connection-token)
fi

args+=("$@")

node build/hucode/run-with-mixin.js --quality stable -- ./scripts/code-server.sh "${args[@]}"
