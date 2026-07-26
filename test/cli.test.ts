import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sendFilesToSlackMock, startGatewayMock } = vi.hoisted(() => ({
  sendFilesToSlackMock: vi.fn(),
  startGatewayMock: vi.fn(),
}));

vi.mock('../src/slack/send.js', () => ({
  sendFilesToSlack: sendFilesToSlackMock,
}));

vi.mock('../src/index.js', () => ({
  startGateway: startGatewayMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'HOME', 'PI_CWD', 'PI_TAG_SLACK_CONFIG', 'SESSIONS_DIR'];

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('formatHelpText', () => {
  it('mentions the primary distribution commands, send usage, and cwd registration option', async () => {
    vi.resetModules();
    const { formatHelpText } = await import('../src/cli/index.js');
    const help = formatHelpText();

    expect(help).toContain('pi-tag-slack setup');
    expect(help).toContain('pi-tag-slack start');
    expect(help).toContain('pi-tag-slack status');
    expect(help).toContain('pi-tag-slack register');
    expect(help).toContain('pi-tag-slack daemon install');
    expect(help).toContain(
      'pi-tag-slack send --channel <jid> [--thread <slack-ts>] [--text <message>] [--file <path> ...]',
    );
    expect(help).toContain('sl:C0123456789');
    expect(help).toContain('--cwd <path>');
  });
});

describe('start command', () => {
  it('does not report ESM-only pi-ai as a missing peer dependency', async () => {
    process.env.PI_TAG_SLACK_CONFIG = resolve('package.json');
    startGatewayMock.mockResolvedValue(undefined);

    vi.resetModules();
    const { main } = await import('../src/cli/index.js');

    await expect(main(['start'])).resolves.toBe(0);
    expect(startGatewayMock).toHaveBeenCalledOnce();
  });
});

describe('send command', () => {
  it('allows text-only sends and normalizes the channel id', async () => {
    sendFilesToSlackMock.mockResolvedValue({ sentFiles: 0 });

    vi.resetModules();
    const { main } = await import('../src/cli/index.js');
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    await expect(main(['send', '--channel', 'C0123456789', '--text', 'hello'])).resolves.toBe(0);
    expect(sendFilesToSlackMock).toHaveBeenCalledWith({
      channelJid: 'sl:C0123456789',
      text: 'hello',
      files: [],
    });
    expect(logged.join('\n')).toContain('Sent message to sl:C0123456789');
  });

  it('rejects send requests with neither text nor files', async () => {
    vi.resetModules();
    const { main } = await import('../src/cli/index.js');

    await expect(main(['send', '--channel', 'C0123456789'])).rejects.toThrow(
      'At least one of --text or --file is required.',
    );
    expect(sendFilesToSlackMock).not.toHaveBeenCalled();
  });
});

describe('register command cwd support', () => {
  it('stores a per-channel cwd override and shows it in channel listings', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-tag-slack-cli-'));
    tempDirs.push(tempDir);

    process.env.DB_PATH = resolve(tempDir, 'gateway.db');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.PI_CWD = '/global/project';

    vi.resetModules();
    const { main } = await import('../src/cli/index.js');
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    await expect(
      main(['register', 'C0123456789', 'my-workspace #general', '--cwd', '/workspace/project']),
    ).resolves.toBe(0);
    expect(logged.join('\n')).toContain('Working directory: /workspace/project (channel override)');

    const db = await import('../src/db.js');
    db.initDb();
    try {
      expect(db.getChannel('sl:C0123456789')).toMatchObject({
        jid: 'sl:C0123456789',
        cwdOverride: '/workspace/project',
      });
    } finally {
      db.closeDb();
    }

    logged.length = 0;
    await expect(main(['channels'])).resolves.toBe(0);
    expect(logged.join('\n')).toContain('cwd=/workspace/project (channel)');
  });
});
