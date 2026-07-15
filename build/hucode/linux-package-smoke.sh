#!/usr/bin/env bash

set -euo pipefail

user_data_dir="$(mktemp -d)"
extensions_dir="$(mktemp -d)"
log_file="$(mktemp)"
debug_port=19287

cleanup() {
	pkill -f -- "--user-data-dir=$user_data_dir" 2>/dev/null || true
	rm -rf "$user_data_dir" "$extensions_dir" "$log_file"
}
trap cleanup EXIT

dbus-run-session -- xvfb-run -a hucode \
	--disable-gpu \
	--extensions-dir="$extensions_dir" \
	--no-sandbox \
	--remote-debugging-port="$debug_port" \
	--user-data-dir="$user_data_dir" \
	--wait >"$log_file" 2>&1 &

for _ in $(seq 1 120); do
	if targets="$(curl -fsS "http://127.0.0.1:$debug_port/json/list")"; then
		omni_count="$(jq '[.[] | select(
			.type == "page" and
			(.url | contains("/vs/hucode/electron-browser/omni.html"))
		)] | length' <<<"$targets")"
		identity_count="$(jq '[.[] | select(
			.type == "page" and
			(.url | contains("/vs/hucode/electron-browser/omni.html")) and
			(.title | contains("Hucode"))
		)] | length' <<<"$targets")"
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
