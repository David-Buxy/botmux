import { describe, expect, it } from 'vitest';
import {
  linuxInactiveServiceHint,
  systemdEnableArgs,
} from '../src/autostart.js';
import { parseAutostartEnableArgs } from '../src/cli/autostart-args.js';

describe('autostart enable --now', () => {
  it('preserves the historical no-argument behavior', () => {
    expect(parseAutostartEnableArgs([])).toEqual({ startNow: false });
    expect(systemdEnableArgs(false)).toEqual(['--user', 'enable', 'botmux.service']);
  });

  it('adds systemd --now only when explicitly requested', () => {
    expect(parseAutostartEnableArgs(['--now'])).toEqual({ startNow: true });
    expect(systemdEnableArgs(true)).toEqual([
      '--user',
      'enable',
      '--now',
      'botmux.service',
    ]);
  });

  it('rejects unknown or duplicate enable arguments', () => {
    expect(() => parseAutostartEnableArgs(['--force'])).toThrow('未知参数: --force');
    expect(() => parseAutostartEnableArgs(['--now', '--now'])).toThrow('重复参数: --now');
  });
});

describe('Linux inactive autostart diagnosis', () => {
  it('shows an exact recovery command only when enabled but inactive', () => {
    expect(linuxInactiveServiceHint('enabled', 'inactive')).toContain(
      'systemctl --user start botmux.service',
    );
    expect(linuxInactiveServiceHint('enabled', 'active')).toBeNull();
    expect(linuxInactiveServiceHint('disabled', 'inactive')).toBeNull();
  });
});
