import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSelectableModels, parsePiModelList } from '../src/agent/model-catalog.js';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}));

const models = [
  {
    provider: 'test',
    id: 'alpha',
    name: 'Alpha',
    reasoning: false,
  },
  {
    provider: 'test',
    id: 'beta',
    name: 'Beta',
    reasoning: true,
  },
  {
    provider: 'other',
    id: 'gamma',
    name: 'Gamma',
    reasoning: true,
  },
] as Model<any>[];

const defaultCliOutput = `provider  model  context  max-out  thinking  images
other    gamma  128K     16K      yes       no
test     alpha  128K     16K      no        no
test     beta   128K     16K      yes       no
`;

function mockPiCatalog(enabledModels?: string[], cliOutput = defaultCliOutput): void {
  const runtime = {
    getAvailable: vi.fn(async () => models),
  } as unknown as ModelRuntime;

  spawnSyncMock.mockReturnValue({ status: 0, stdout: cliOutput, stderr: '' });
  vi.spyOn(ModelRuntime, 'create').mockResolvedValue(runtime);
  vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory({ enabledModels }));
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
});

describe('listSelectableModels', () => {
  it('returns every available model when enabledModels is not configured', async () => {
    mockPiCatalog();

    const result = await listSelectableModels({ forceRefresh: true, cwd: '/tmp/project' });

    expect(result.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha', 'test/beta']);
    expect(SettingsManager.create).toHaveBeenCalledWith('/tmp/project');
  });

  it('uses pi enabledModels semantics and preserves configured order', async () => {
    mockPiCatalog(['other/gamma', 'test/alpha']);

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha']);
  });

  it('supports the same glob patterns as pi scoped models', async () => {
    mockPiCatalog(['test/*']);

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/alpha', 'test/beta']);
  });

  it('uses the configured pi binary as the authoritative model source', async () => {
    mockPiCatalog(
      ['test/delta'],
      `${defaultCliOutput}test     delta  256K     32K      yes       yes\n`,
    );

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/delta']);
  });

  it('falls back to the SDK catalog when pi --list-models fails', async () => {
    mockPiCatalog(['test/beta']);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'failed' });

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/beta']);
  });

  it('keeps a successful empty pi catalog empty instead of falling back', async () => {
    mockPiCatalog(undefined, 'provider  model  context  max-out  thinking  images\n');

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result).toEqual([]);
  });
});

describe('parsePiModelList', () => {
  it('parses pi --list-models table output', () => {
    expect(parsePiModelList(defaultCliOutput)).toEqual([
      expect.objectContaining({ ref: 'other/gamma', reasoning: true }),
      expect.objectContaining({ ref: 'test/alpha', reasoning: false }),
      expect.objectContaining({ ref: 'test/beta', reasoning: true }),
    ]);
  });
});
