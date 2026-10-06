# Host environment recovery

Read this reference only when the upgrade host lacks Git LFS or needs a
headless Linux runtime smoke.

## Git LFS unavailable

Read the Git LFS rule in `AGENTS.md` before using this fallback. If checkout,
reset, rebase, or push fails because the host lacks `git-lfs`, first verify that
the upgrade's new commits do not add or modify LFS-managed content. When the
operation only needs historical pointer text, run it with LFS filters disabled:

```sh
git \
	-c filter.lfs.process= \
	-c filter.lfs.smudge= \
	-c filter.lfs.clean=cat \
	-c filter.lfs.required=false \
	<command>
```

For a push under the same condition, also set `GIT_LFS_SKIP_PUSH=1`. Do not use
this fallback when the new commits contain an LFS payload. Install `git-lfs`
and publish the object instead.

## Headless Linux Electron suites

Build the upstream-named Electron runtime, resolve the generated Hucode suite
inventory, and pass every resolved suite to the Electron runner:

```sh
npm run electron
bash -lc '
set -euo pipefail
mapfile -t suites < <(node build/hucode/test-suites.ts --runner electron)
((${#suites[@]} > 0)) || { echo "No Hucode Electron suites resolved" >&2; exit 1; }
env \
	-u ELECTRON_RUN_AS_NODE \
	-u VSCODE_ESM_ENTRYPOINT \
	-u VSCODE_CWD \
	-u VSCODE_NLS_CONFIG \
	VSCODE_SKIP_PRELAUNCH=1 \
	ELECTRON_DISABLE_SANDBOX=1 \
	xvfb-run -a ./scripts/test.sh "${suites[@]/#/--run=}"
'
```

This unsandboxed fallback is for local Electron unit suites only. Never reuse
`ELECTRON_DISABLE_SANDBOX=1` for the packaged Linux Omni lifecycle smoke. That
smoke must restore `chrome-sandbox` ownership and mode and run sandboxed, as the
release workflow does, because unsandboxed runs have produced false lifecycle
results in CI.

`.build/electron` holds one binary named after the active product: `code-oss`
after `npm run electron`, which `./scripts/test.sh` needs, and `hucode` after
the mixin-wrapped build below, which `./scripts/hucode.sh` needs. Rebuild it
when moving between the unit suites and a launch or smoke.

## Headless Linux launch

After `npm run hucode:compile`, use a bounded launch of the compiled output:

```sh
timeout --signal=TERM 60s env \
	-u ELECTRON_RUN_AS_NODE \
	-u VSCODE_CODE_CACHE_PATH \
	-u VSCODE_CRASH_REPORTER_PROCESS_TYPE \
	-u VSCODE_CWD \
	-u VSCODE_ESM_ENTRYPOINT \
	-u VSCODE_HANDLES_UNCAUGHT_ERRORS \
	-u VSCODE_IPC_HOOK \
	-u VSCODE_NLS_CONFIG \
	-u VSCODE_PID \
	VSCODE_SKIP_PRELAUNCH=1 \
	ELECTRON_DISABLE_SANDBOX=1 \
	xvfb-run -a npm run hucode:run
```

Exit 124 is expected only when the timeout stops an otherwise settled app.
Inspect the log before accepting it. Wrapper exit messages after `SIGTERM` and
GPU/Xvfb warnings can be environmental, but new workbench `ERR` lines are not.

Pass `--user-data-dir`, `--shared-data-dir`, and `--extensions-dir` with
temporary paths after `npm run hucode:run --` so the launch cannot read or
write the host's real Hucode profile, then read `main.log`,
`window1/renderer.log`, and `sharedprocess.log` under the temporary
user-data `logs/` directory.

## Local Linux Omni lifecycle smoke

The dev Electron's `chrome-sandbox` is not root-owned on a development host, so
the local lifecycle smoke has to run unsandboxed. Build the Hucode-branded
runtime first:

```sh
node build/hucode/run-with-mixin.js --quality stable -- npm run electron
VSCODE_SKIP_PRELAUNCH=1 ELECTRON_DISABLE_SANDBOX=1 \
	dbus-run-session -- xvfb-run -a \
	npm run hucode:smoke:linux-omni -- \
	--executable ./scripts/hucode.sh \
	--timeout-ms 300000
```

Clear the inherited extension-host variables listed above as well. A pass here
is local evidence for bootstrap and service wiring only. The sandboxed
lifecycle result still comes from CI, for the reason given under the Electron
suites.
