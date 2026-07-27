import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

const CONFIG_ENV_KEYS = ['HOME', 'PATH', 'PATH_PREPEND', 'PI_TAG_SLACK_CONFIG'];

afterEach(() => {
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('commandEnv', () => {
  it('prepends configured directories and removes duplicate PATH entries', async () => {
    process.env.HOME = '/tmp/pi-tag-slack-command-env-home';
    process.env.PATH_PREPEND = '~/tools:/opt/tools';

    const { commandEnv, commandPath } = await import('../src/command-env.js');
    const env = commandEnv({ PATH: '/opt/tools:/usr/bin' });

    expect(env.PATH).toBe('/tmp/pi-tag-slack-command-env-home/tools:/opt/tools:/usr/bin');
    expect(commandPath({ PATH: '/opt/tools:/usr/bin' })).toBe(env.PATH);
  });
});
