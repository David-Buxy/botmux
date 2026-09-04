import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/deploy-fork-release.sh');
const VERSION = 'fork-v3.18.14-buxy.1';
const BINARY_VERSION = '3.18.14-buxy.1';

describe('deploy-fork-release.sh', () => {
  let root: string;
  let installDir: string;
  let releaseDir: string;
  let fakeBin: string;
  let cgroupFile: string;
  let systemctlLog: string;
  let activeBinary: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-fork-deploy-'));
    installDir = join(root, 'install');
    releaseDir = join(root, 'release');
    fakeBin = join(root, 'fake-bin');
    cgroupFile = join(root, 'cgroup');
    systemctlLog = join(root, 'systemctl.log');
    activeBinary = join(installDir, 'botmux');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(releaseDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(cgroupFile, '0::/user.slice/user-1000.slice/session-9.scope\n');
    writeExecutable(activeBinary, oldBinary());
    writeExecutable(join(fakeBin, 'curl'), fakeCurl());
    writeExecutable(join(fakeBin, 'systemctl'), fakeSystemctl());
    writeCandidate(BINARY_VERSION);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('deploys a pinned, checksummed release and keeps a rollback binary', () => {
    const result = runDeploy();

    expect(result.status, result.output).toBe(0);
    expect(readFileSync(activeBinary, 'utf8')).toContain('CANDIDATE_BINARY');
    expect(readdirSync(installDir).some((name) => name.startsWith('botmux.rollback-'))).toBe(true);
    expect(readFileSync(systemctlLog, 'utf8')).toContain('--user restart botmux.service');
  });

  it('rejects an unpinned version before downloading anything', () => {
    const result = runDeploy({ BOTMUX_VERSION: 'latest' });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('固定版本');
    expect(readFileSync(activeBinary, 'utf8')).toContain('OLD_BINARY');
  });

  it('refuses a release with a missing checksum', () => {
    const result = runDeploy({ TEST_MISSING_CHECKSUM: '1' });

    expect(result.status).not.toBe(0);
    expect(readFileSync(activeBinary, 'utf8')).toContain('OLD_BINARY');
  });

  it('refuses a release with an incorrect checksum', () => {
    writeFileSync(join(releaseDir, 'botmux-linux-x64.sha256'), `${'0'.repeat(64)}  botmux-linux-x64\n`);
    const result = runDeploy();

    expect(result.status).not.toBe(0);
    expect(readFileSync(activeBinary, 'utf8')).toContain('OLD_BINARY');
  });

  it('refuses a binary whose reported version does not match the tag', () => {
    writeCandidate('3.18.14-buxy.2');
    const result = runDeploy();

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('版本不匹配');
    expect(readFileSync(activeBinary, 'utf8')).toContain('OLD_BINARY');
  });

  it('refuses to run inside the old bridge or botmux service cgroup', () => {
    writeFileSync(cgroupFile, '0::/user.slice/lark-channel-bridge.bot.codex.service\n');
    const result = runDeploy();

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('独立 SSH');
    expect(readFileSync(activeBinary, 'utf8')).toContain('OLD_BINARY');
  });

  it('restores and restarts the old binary when systemd restart fails', () => {
    const result = runDeploy({ TEST_FAIL_FIRST_RESTART: '1' });

    expect(result.status).not.toBe(0);
    expect(readFileSync(activeBinary, 'utf8')).toContain('OLD_BINARY');
    expect(readFileSync(systemctlLog, 'utf8').match(/--user restart botmux\.service/g)).toHaveLength(2);
  });

  it('restores the old binary when the post-start health check fails', () => {
    const result = runDeploy({ TEST_BAD_HEALTH: '1' });

    expect(result.status).not.toBe(0);
    expect(readFileSync(activeBinary, 'utf8')).toContain('OLD_BINARY');
    expect(readFileSync(systemctlLog, 'utf8').match(/--user restart botmux\.service/g)).toHaveLength(2);
  });

  function runDeploy(overrides: NodeJS.ProcessEnv = {}) {
    const result = spawnSync('bash', [SCRIPT], {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        HOME: join(root, 'home'),
        BOTMUX_VERSION: VERSION,
        BOTMUX_REPO: 'David-Buxy/botmux',
        BOTMUX_INSTALL_DIR: installDir,
        BOTMUX_CGROUP_FILE: cgroupFile,
        TEST_RELEASE_DIR: releaseDir,
        TEST_SYSTEMCTL_LOG: systemctlLog,
        TEST_SYSTEMCTL_STATE: join(root, 'systemctl.state'),
        ...overrides,
      },
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  }

  function writeCandidate(version: string): void {
    const asset = join(releaseDir, 'botmux-linux-x64');
    writeExecutable(asset, candidateBinary(version));
    const digest = createHash('sha256').update(readFileSync(asset)).digest('hex');
    writeFileSync(join(releaseDir, 'botmux-linux-x64.sha256'), `${digest}  botmux-linux-x64\n`);
  }
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function oldBinary(): string {
  return `#!/bin/sh
# OLD_BINARY
if [ "\${1:-}" = "--version" ]; then echo "3.18.14"; exit 0; fi
if [ "\${1:-}" = "status" ]; then printf 'supervisor 在线\\nbotmux-codex online\\n'; exit 0; fi
exit 0
`;
}

function candidateBinary(version: string): string {
  return `#!/bin/sh
# CANDIDATE_BINARY
if [ "\${1:-}" = "--version" ]; then echo "${version}"; exit 0; fi
if [ "\${1:-}" = "status" ]; then
  if [ "\${TEST_BAD_HEALTH:-}" = "1" ]; then echo "supervisor offline"; else printf 'supervisor 在线\\nbotmux-codex online\\n'; fi
  exit 0
fi
exit 0
`;
}

function fakeCurl(): string {
  return `#!/bin/sh
set -eu
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
name="\${url##*/}"
if [ "\${TEST_MISSING_CHECKSUM:-}" = "1" ] && [ "$name" = "botmux-linux-x64.sha256" ]; then exit 22; fi
cp "$TEST_RELEASE_DIR/$name" "$out"
`;
}

function fakeSystemctl(): string {
  return `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$TEST_SYSTEMCTL_LOG"
if [ "$*" = "--user restart botmux.service" ] && [ "\${TEST_FAIL_FIRST_RESTART:-}" = "1" ]; then
  count=0
  if [ -f "$TEST_SYSTEMCTL_STATE" ]; then count="$(cat "$TEST_SYSTEMCTL_STATE")"; fi
  count=$((count + 1))
  printf '%s' "$count" > "$TEST_SYSTEMCTL_STATE"
  if [ "$count" -eq 1 ]; then exit 1; fi
fi
if [ "$*" = "--user is-active --quiet botmux.service" ]; then exit 0; fi
exit 0
`;
}
