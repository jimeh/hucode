#!/usr/bin/env bash
#
# Copyright (c) Hucode contributors. All rights reserved.
# Licensed under the MIT License. See LICENSE.txt in the project root for license information.

set -euo pipefail

user_data_dir="$(mktemp -d)"
extensions_dir="$(mktemp -d)"
log_file="$(mktemp)"
debug_port=19287
launcher_pid=""

cleanup() {
	pkill -TERM -f -- "--user-data-dir=$user_data_dir" 2>/dev/null || true
	if [ -n "$launcher_pid" ]; then
		for _ in $(seq 1 50); do
			if ! kill -0 "$launcher_pid" 2>/dev/null; then
				break
			fi
			sleep 0.1
		done
		pkill -KILL -f -- "--user-data-dir=$user_data_dir" 2>/dev/null || true
		kill "$launcher_pid" 2>/dev/null || true
		wait "$launcher_pid" 2>/dev/null || true
	fi
	rm -rf "$user_data_dir" "$extensions_dir" "$log_file" || true
}
trap cleanup EXIT

dbus-run-session -- xvfb-run -a hucode \
	--disable-gpu \
	--extensions-dir="$extensions_dir" \
	--no-sandbox \
	--remote-debugging-port="$debug_port" \
	--user-data-dir="$user_data_dir" \
	--wait >"$log_file" 2>&1 &
launcher_pid="$!"

for _ in $(seq 1 120); do
	if targets="$(curl -fsS "http://127.0.0.1:$debug_port/json/list")"; then
		if ! omni_count="$(jq '[.[] | select(
			.type == "page" and
			(.url | contains("/vs/hucode/electron-browser/omni.html"))
		)] | length' <<<"$targets" 2>/dev/null)"; then
			sleep 1
			continue
		fi
		if ! identity_count="$(jq '[.[] | select(
			.type == "page" and
			(.url | contains("/vs/hucode/electron-browser/omni.html")) and
			(.title | contains("Hucode"))
		)] | length' <<<"$targets" 2>/dev/null)"; then
			sleep 1
			continue
		fi
		if [ "$omni_count" -eq 1 ] && [ "$identity_count" -eq 1 ]; then
			echo "Packaged Hucode launched one Omni window with Hucode identity."
			exit 0
		fi
	fi
	sleep 1
done

echo "Packaged Hucode did not launch the expected Omni window." >&2
cat "$log_file" >&2
exit 1
