# DevBox Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fork-built Linux x64 Botmux binary that safely activates the existing `botmux-codex` Feishu bot through user systemd and rolls back on failed machine health checks.

**Architecture:** Keep Bun and release construction in GitHub Actions, publish fork-only `fork-v*` prereleases, and deploy one exact checksum-pinned asset to the DevBox. Runtime activation is delegated to the systemd user manager so the fleet cannot inherit the legacy bridge cgroup. Existing Feishu credentials, bot configuration, session data, and Codex working directory remain in place.

**Tech Stack:** TypeScript, Vitest, POSIX shell, Bun 1.4.0, GitHub Actions, user systemd, Feishu long-connection events.

**Spec:** `docs/superpowers/specs/2026-09-04-devbox-runtime-hardening-design.md`

## Global Constraints

- DevBox target is Linux x64 with glibc 2.36 and Node.js 22; do not install Bun there.
- Fork releases use `fork-v<valid-semver>`; the first release is `fork-v3.18.14-buxy.1`.
- Never read, print, copy, or commit `larkAppSecret`, tokens, cookies, or authentication caches.
- Do not run the legacy bridge and Botmux concurrently.
- Do not delete rollback artifacts.
- Target Feishu chat is `oc_642609e0d6a9e8cf26a02da3673feba9`; existing configuration already allows it.
- Plain `botmux autostart enable` must retain its current register-only semantics.

---

### Task 1: Autostart activation and diagnostics

**Files:**
- Create: `src/cli/autostart-args.ts`
- Create: `test/autostart-enable-now.test.ts`
- Modify: `src/autostart.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `parseAutostartEnableArgs(args: string[]): { startNow: boolean }`
- Produces: `systemdEnableArgs(startNow: boolean): string[]`
- Produces: `linuxInactiveServiceHint(enabled: string, active: string): string | null`
- Changes: `enableAutostart(opts, { startNow?: boolean })`; the second argument remains optional.

- [ ] **Step 1: Write failing argument and behavior tests**

```ts
expect(parseAutostartEnableArgs([])).toEqual({ startNow: false });
expect(parseAutostartEnableArgs(['--now'])).toEqual({ startNow: true });
expect(() => parseAutostartEnableArgs(['--later'])).toThrow('未知参数');
expect(systemdEnableArgs(false)).toEqual(['--user', 'enable', 'botmux.service']);
expect(systemdEnableArgs(true)).toEqual(['--user', 'enable', '--now', 'botmux.service']);
expect(linuxInactiveServiceHint('enabled', 'inactive')).toContain('systemctl --user start botmux.service');
expect(linuxInactiveServiceHint('enabled', 'active')).toBeNull();
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run --project unit test/autostart-enable-now.test.ts`

Expected: FAIL because the parser and pure systemd helpers do not exist.

- [ ] **Step 3: Implement the minimal parser and helpers**

`parseAutostartEnableArgs` accepts only one optional `--now`. `enableLinux` calls `spawnSync('systemctl', systemdEnableArgs(startNow))`. `statusLinux` passes trimmed command output into `linuxInactiveServiceHint` and prints the returned warning. Non-Linux paths reject `--now` explicitly; no flag preserves all existing behavior.

- [ ] **Step 4: Run focused and neighboring tests**

Run: `npx vitest run --project unit test/autostart-enable-now.test.ts test/autostart-standalone-path.test.ts`

Expected: PASS with no failures.

- [ ] **Step 5: Commit**

```bash
git add src/cli/autostart-args.ts src/autostart.ts src/cli.ts test/autostart-enable-now.test.ts
git commit -m "feat: add explicit systemd autostart activation"
```

### Task 2: Fail-closed fork release deployer

**Files:**
- Create: `scripts/deploy-fork-release.sh`
- Create: `test/deploy-fork-release.test.ts`

**Interfaces:**
- Requires: `BOTMUX_VERSION=fork-v<semver>`.
- Optional: `BOTMUX_REPO` defaults to `David-Buxy/botmux`.
- Optional: `BOTMUX_INSTALL_DIR` defaults to `$HOME/.botmux/bin`.
- Test-only: `BOTMUX_CGROUP_FILE` overrides `/proc/$$/cgroup`.
- Produces: a timestamped `botmux.rollback-*` file beside the active binary.

- [ ] **Step 1: Write a real-script integration harness and failing tests**

The harness executes the real shell script with temporary fake `curl`, `systemctl`, and candidate binaries. Literal fixtures cover:

```text
valid checksum + matching version + active service + online status -> new binary active
missing checksum -> old binary unchanged
mismatched checksum -> old binary unchanged
candidate version mismatch -> old binary unchanged
cgroup containing lark-channel-bridge or botmux.service -> refusal before download
systemd restart or health failure -> old binary restored and restarted
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run --project unit test/deploy-fork-release.test.ts`

Expected: FAIL because `scripts/deploy-fork-release.sh` does not exist.

- [ ] **Step 3: Implement the minimal deployer**

The script uses `set -eu`, rejects empty/`latest`/non-`fork-v*` versions, downloads both assets, requires SHA-256 verification, probes the staged binary with `--version`, copies the active binary to a rollback path, atomically renames the candidate, restarts `botmux.service`, checks `systemctl --user is-active --quiet`, and requires `botmux status` to contain a live supervisor and an `online` row. A trap restores and restarts the rollback binary after any post-swap failure.

- [ ] **Step 4: Run focused tests and POSIX syntax check**

Run: `npx vitest run --project unit test/deploy-fork-release.test.ts`

Run: `sh -n scripts/deploy-fork-release.sh`

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-fork-release.sh test/deploy-fork-release.test.ts
git commit -m "feat: add rollback-safe fork deployer"
```

### Task 3: Fork-only Linux release workflow

**Files:**
- Create: `.github/workflows/fork-linux-release.yml`

**Interfaces:**
- `workflow_dispatch`: build and upload a seven-day Actions artifact; never create a Release.
- `push.tags: ['fork-v*']`: build and create a GitHub prerelease with the binary and checksum.
- Version: `${GITHUB_REF_NAME#fork-v}` must pass `npm version` before build.

- [ ] **Step 1: Add the workflow configuration**

Use Node 22 and Bun 1.4.0. Invoke `scripts/build-linux-glibc-baseline.sh bun-linux-x64 dist-bin/botmux-linux-x64 "$VERSION"`, generate `dist-bin/botmux-linux-x64.sha256`, upload both as an Actions artifact, and on a tag use `gh release create "$GITHUB_REF_NAME" ... --prerelease --verify-tag` with job-level `contents: write`.

- [ ] **Step 2: Validate the workflow without publishing**

Run: parse the YAML locally with the repository's installed YAML dependency.

Expected: one workflow object with `workflow_dispatch`, `push.tags == ['fork-v*']`, build permissions read-only, and release permissions write-only.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/fork-linux-release.yml
git commit -m "ci: add fork-only linux prerelease"
```

### Task 4: Full local verification and GitHub integration

**Files:** no new production files.

- [ ] **Step 1: Install exact dependencies locally**

Run: `npx --yes bun@1.4.0 install --frozen-lockfile`

- [ ] **Step 2: Run complete verification**

Run: `npx --yes bun@1.4.0 run test`

Run: `npx --yes bun@1.4.0 run build`

Run: `npx --yes bun@1.4.0 run verify:binary`

Expected: all exit 0.

- [ ] **Step 3: Push branch, open PR, and wait for CI**

Push `codex/devbox-runtime-hardening`, open a PR into `David-Buxy/botmux:master`, and require every existing CI check to succeed before merge.

- [ ] **Step 4: Merge and verify workflow dispatch**

Merge only after CI success. Trigger `fork-linux-release.yml` manually on `master`, wait for success, and inspect that both artifact files exist.

- [ ] **Step 5: Tag and publish the first fork prerelease**

Create annotated tag `fork-v3.18.14-buxy.1` on the verified merge commit and push it. Wait for the release workflow and verify the public prerelease contains only `botmux-linux-x64` and `botmux-linux-x64.sha256`.

### Task 5: Feishu preflight, DevBox canary, and rollback proof

**Files:** no repository changes.

- [ ] **Step 1: Record the DevBox rollback baseline**

Record installed version, binary SHA-256, `botmux.service` state, legacy bridge state, and absence/presence of Botmux processes without printing config secrets.

- [ ] **Step 2: Reconcile Feishu Open Platform configuration**

Run `botmux setup configure botmux-codex --json` from the independent SSH session. Complete user QR confirmation if requested. Require bot capability, long-connection mode, `im.message.receive_v1`, card callback, and published app version to report ready.

- [ ] **Step 3: Deploy the exact prerelease**

Run `BOTMUX_VERSION=fork-v3.18.14-buxy.1 scripts/deploy-fork-release.sh` from an independent SSH session. Require checksum confirmation, baked version match, `botmux.service` active, supervisor online, `botmux-codex` online, and no legacy bridge process.

- [ ] **Step 4: Run real Feishu acceptance in the fixed group**

In chat `oc_642609e0d6a9e8cf26a02da3673feba9`: top-level @ creates a topic and first session; a reply in that topic preserves context; a second top-level @ creates another session; restarting `botmux.service` and replying in the first topic resumes its session.

- [ ] **Step 5: Observe and conclude**

Observe service state and logs for 15 minutes. Accept only with one active Botmux consumer, no legacy bridge, no repeated WebSocket reconnects, and successful Feishu replies. On machine-health failure the deployer restores the old binary automatically. On Feishu-only failure restore the old Botmux binary first; re-enable the legacy bridge only by explicit operator action.
