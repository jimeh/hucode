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
