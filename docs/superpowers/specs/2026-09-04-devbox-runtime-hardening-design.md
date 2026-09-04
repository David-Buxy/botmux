# DevBox Runtime Hardening Design

## Context

The current Botmux 3.18.14 installation on the DevBox was started from a Codex
session owned by the legacy bridge systemd cgroup. When that bridge unit was
stopped with `KillMode=control-group`, the detached Botmux processes were killed
with it. The Botmux user unit had been enabled, but `autostart enable` deliberately
does not start the unit, so no independent systemd-owned process replaced the
killed fleet.

The target DevBox is Linux x64 with glibc 2.36 and Node.js 22, but it does not
have Bun. The fork inherits upstream build and release workflows, including
upstream-author guards, macOS signing, and npm Trusted Publishing. Those release
jobs are unsuitable for the fork unchanged.

## Goals

- Build a reproducible Linux x64 Botmux binary in GitHub Actions using Bun 1.4.0.
- Publish fork builds under a tag namespace that cannot trigger the inherited
  upstream `v*` release workflow.
- Deploy an exact, checksum-pinned fork build to the DevBox without installing
  Bun or changing the machine's Node.js installation.
- Ensure activation is owned by the user systemd manager, not by the legacy
  bridge or the Botmux process being replaced.
- Preserve the previous working binary and automatically restore it when a
  machine-verifiable deployment check fails.
- Make the `enabled` but `inactive` autostart state explicit and provide an
  opt-in systemd start path.

## Non-goals

- Publishing a renamed npm package.
- Publishing macOS, Windows, ARM, or musl fork artifacts in the first iteration.
- Changing Botmux session, routing, Feishu event, credential, or multi-Agent
  behavior.
- Copying credentials or runtime state into GitHub Actions or the repository.
- Automatically enabling the legacy bridge as a fallback; doing so could create
  duplicate event consumers and remains an explicit operator action.

## Architecture

### 1. Fork release lane

Add `.github/workflows/fork-linux-release.yml` with two paths:

- Pull requests and branch pushes continue to use the inherited `ci.yml`.
- A tag matching `fork-v*` builds and publishes one Linux x64 prerelease asset.

The release version is the tag with the `fork-v` prefix removed. For example,
`fork-v3.18.14-buxy.1` bakes the valid semver `3.18.14-buxy.1` into the binary.
The workflow reuses `scripts/build-linux-glibc-baseline.sh` so the fork artifact
has the same glibc compatibility floor and smoke checks as upstream CI. It emits:

- `botmux-linux-x64`
- `botmux-linux-x64.sha256`

The workflow has no npm publication, macOS signing, or access to runtime bot
credentials. Build jobs use `contents: read`; only the final prerelease job uses
`contents: write`. The inherited upstream release workflow matches only `v*`, so
the `fork-v*` namespace keeps both release lanes disjoint.

### 2. Fail-closed DevBox deployer

Add `scripts/deploy-fork-release.sh`. It requires an exact
`BOTMUX_VERSION=fork-v...`; `latest` is rejected. The repository can be overridden
for tests, but defaults to `David-Buxy/botmux`.

The deployer performs this sequence:

1. Refuse to run when `/proc/$$/cgroup` identifies the legacy bridge or Botmux
   service. Operators run it from an independent SSH session or deploy unit.
2. Download the exact Linux x64 binary and checksum to a staging file on the
   destination filesystem.
3. Require the checksum asset and verify it; a missing checksum is a hard error.
4. Execute the staged binary with `--version` and require the expected baked
   version before changing the active installation.
5. Preserve the current `~/.botmux/bin/botmux` as a versioned rollback artifact.
6. Atomically replace the active binary.
7. Run `systemctl --user daemon-reload` and restart `botmux.service`, so the new
   fleet is created by the user systemd manager.
8. Require `systemctl --user is-active botmux.service` and `botmux status` to
   succeed. On failure, restore the saved binary and restart the unit.

The script reports the rollback artifact path and never deletes previous
artifacts. A later cleanup change, if needed, is outside this iteration.

### 3. Explicit autostart activation

Extend the CLI with:

```text
botmux autostart enable --now
```

On Linux this changes the registration command from `systemctl --user enable` to
`systemctl --user enable --now`, making activation explicit and placing the
startup in the systemd user manager's cgroup. Plain `autostart enable` retains its
existing no-start behavior. The first iteration rejects `--now` on unsupported
platform paths rather than silently ignoring it.

`botmux autostart status` continues to print the raw systemd states and adds a
clear warning when the unit is enabled but inactive, including the exact recovery
command `systemctl --user start botmux.service`.

## Interfaces and files

- `.github/workflows/fork-linux-release.yml`: fork-only Linux x64 prerelease.
- `scripts/deploy-fork-release.sh`: pinned, checksum-required deploy and rollback.
- `src/autostart.ts`: Linux `--now` behavior and enabled/inactive diagnostic.
- `src/cli.ts`: parse and validate `autostart enable --now`.
- `test/autostart-enable-now.test.ts`: behavior tests for systemd arguments and
  inactive-state guidance.
- `test/deploy-fork-release.test.ts`: runs the real deploy script with temporary
  fake release assets and fake system commands; verifies success and rollback.
- `README.md` and `README.en.md`: fork development and DevBox canary runbook.

## Testing strategy

Production behavior follows red-green-refactor:

- Autostart tests fail when `--now` does not add systemd activation or when the
  enabled/inactive warning is absent.
- Deployer tests execute the real shell script. They prove that a valid checksum
  activates a staged binary, a missing or mismatched checksum preserves the old
  binary, and a failed systemd health check restores the old binary.
- Existing unit tests, full build, script type checking, binary verification, and
  the Linux x64 smoke build remain required before publishing.
- The workflow YAML is configuration rather than runtime code. It is validated by
  YAML parsing, GitHub Actions syntax review, and a real Actions build before any
  DevBox cutover.

## Canary and acceptance sequence

1. Push the feature branch and require fork CI to pass.
2. Create a `fork-v3.18.14-buxy.1` prerelease and verify both assets exist.
3. Record the currently installed binary path, version, service state, and backup
   hash on the DevBox.
4. Run the deployer from an independent SSH session.
5. Verify the new version, active user unit, `botmux status`, dashboard listener,
   and absence of the legacy bridge process.
6. Send a real Feishu `@ping`, continue one existing topic, and create one new
   topic. These are operator-visible integration checks and are not inferred from
   process health.
7. Restart the systemd user unit and repeat the process and Feishu checks.

The canary is accepted only when all machine checks and the real Feishu checks
pass. Machine-check failure triggers automatic binary rollback. A failed Feishu
check triggers an explicit operator decision between restoring the previous
Botmux binary and re-enabling the legacy bridge.

## Safety and rollback

- No secret values are printed, copied, committed, or moved.
- No deployment uses an unpinned `latest` URL.
- No active binary is replaced before checksum and executable probes pass.
- No legacy bridge and Botmux service run concurrently during acceptance.
- The previous binary remains on disk and is restored on machine-check failure.
- Git history is preserved: changes stay on `codex/devbox-runtime-hardening`, and
  `master` remains available for upstream synchronization.
