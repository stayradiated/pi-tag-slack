import { spawnSync } from 'node:child_process';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { minimatch } from 'minimatch';
import { config } from '../config.js';
import { THINKING_LEVELS, type ThinkingLevel } from '../types.js';
import { supportsModelXhigh } from './pi-ai-compat.js';
import { resolvePiSpawn } from './pi-spawn.js';

const CACHE_TTL_MS = 30_000;

export interface AvailableModelInfo {
  ref: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  supportsXhigh: boolean;
}

interface ModelCache {
  loadedAt: number;
  cwd: string;
  models: AvailableModelInfo[];
  fromPiCli: boolean;
}

const cacheByCwd = new Map<string, ModelCache>();

export interface ModelListOptions {
  forceRefresh?: boolean;
  allowStale?: boolean;
  cwd?: string;
}

export function listAvailableModels(options?: ModelListOptions): AvailableModelInfo[] {
  return loadModelCatalog(
    options?.forceRefresh ?? false,
    options?.cwd ?? process.cwd(),
    options?.allowStale ?? false,
  ).models;
}

export function hasCachedModelCatalog(cwd: string): boolean {
  return cacheByCwd.has(cwd);
}

/**
 * Return the models exposed by pi's configured enabledModels scope.
 * An absent or empty scope preserves the existing all-available-models behavior.
 */
export async function listSelectableModels(
  options?: ModelListOptions,
): Promise<AvailableModelInfo[]> {
  const cwd = options?.cwd ?? process.cwd();
  const catalog = loadModelCatalog(
    options?.forceRefresh ?? false,
    cwd,
    options?.allowStale ?? false,
  );
  const models = catalog.fromPiCli ? catalog.models : await loadSdkModelCatalog();
  const settingsManager = SettingsManager.create(cwd);
  const patterns = settingsManager.getEnabledModels();

  if (!patterns?.length) {
    return models;
  }

  return resolveEnabledModelScope(patterns, models);
}

export function resolveModelReference(
  ref: string,
  models = listAvailableModels(),
): AvailableModelInfo | undefined {
  const raw = ref.trim();
  if (!raw) return undefined;

  const lower = raw.toLowerCase();
  const normalized = normalize(raw);

  // 1) Exact canonical ref
  let match = models.find((m) => m.ref.toLowerCase() === lower);
  if (match) return match;

  // 2) Exact id / exact name
  match = models.find((m) => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower);
  if (match) return match;

  // 3) Exact normalized match (handles 4.6 vs 4-6)
  match = models.find(
    (m) =>
      normalize(m.ref) === normalized ||
      normalize(m.id) === normalized ||
      normalize(m.name) === normalized,
  );
  if (match) return match;

  // 4) Partial normalized match
  const partialMatches = models.filter(
    (m) =>
      normalize(m.ref).includes(normalized) ||
      normalize(m.id).includes(normalized) ||
      normalize(m.name).includes(normalized),
  );

  if (partialMatches.length === 0) return undefined;

  // Prefer exact startsWith on canonical ref, otherwise the first sorted match.
  partialMatches.sort(
    (a, b) => scoreModelMatch(b, raw) - scoreModelMatch(a, raw) || a.ref.localeCompare(b.ref),
  );
  return partialMatches[0];
}

export async function autocompleteModels(
  query: string,
  limit = 25,
  options?: ModelListOptions,
): Promise<AvailableModelInfo[]> {
  const models = await listSelectableModels(options);
  const trimmed = query.trim();
  if (!trimmed) {
    return models.slice(0, limit);
  }

  const normalized = normalize(trimmed);
  return models
    .filter(
      (m) =>
        normalize(m.ref).includes(normalized) ||
        normalize(m.id).includes(normalized) ||
        normalize(m.name).includes(normalized),
    )
    .sort(
      (a, b) =>
        scoreModelMatch(b, trimmed) - scoreModelMatch(a, trimmed) || a.ref.localeCompare(b.ref),
    )
    .slice(0, limit);
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export interface ThinkingResolution {
  requested: ThinkingLevel;
  effective: ThinkingLevel;
  adjusted: boolean;
  reason?: 'non_reasoning' | 'xhigh_to_high';
}

export function resolveThinkingForModel(
  model: AvailableModelInfo | undefined,
  desired: ThinkingLevel,
): ThinkingResolution {
  if (!model) {
    return { requested: desired, effective: desired, adjusted: false };
  }

  if (!model.reasoning && desired !== 'off') {
    return {
      requested: desired,
      effective: 'off',
      adjusted: true,
      reason: 'non_reasoning',
    };
  }

  if (desired === 'xhigh' && !model.supportsXhigh) {
    return {
      requested: desired,
      effective: 'high',
      adjusted: true,
      reason: 'xhigh_to_high',
    };
  }

  return { requested: desired, effective: desired, adjusted: false };
}

export function toModelChoiceName(model: AvailableModelInfo): string {
  const label = model.name && model.name !== model.id ? `${model.ref} — ${model.name}` : model.ref;
  return label.length > 100 ? `${label.slice(0, 97)}...` : label;
}

function resolveEnabledModelScope(
  patterns: string[],
  models: AvailableModelInfo[],
): AvailableModelInfo[] {
  const scopedModels: AvailableModelInfo[] = [];

  for (const pattern of patterns) {
    if (hasGlobCharacters(pattern)) {
      const globPattern = stripThinkingLevel(pattern);
      const matches = models.filter((model) =>
        [`${model.provider}/${model.id}`, model.id].some((ref) =>
          minimatch(ref, globPattern, { nocase: true }),
        ),
      );

      for (const model of matches) {
        addUniqueModel(scopedModels, model);
      }
      continue;
    }

    const model = resolveScopePattern(pattern, models);
    if (model) {
      addUniqueModel(scopedModels, model);
    }
  }

  return scopedModels;
}

function resolveScopePattern(
  pattern: string,
  models: AvailableModelInfo[],
): AvailableModelInfo | undefined {
  const exact = findExactScopeMatch(pattern, models);
  if (exact) return exact;

  const partialMatches = models.filter(
    (model) =>
      model.id.toLowerCase().includes(pattern.toLowerCase()) ||
      model.name?.toLowerCase().includes(pattern.toLowerCase()),
  );
  if (partialMatches.length > 0) {
    const aliases = partialMatches.filter((model) => !/-\d{8}$/.test(model.id));
    return (aliases.length > 0 ? aliases : partialMatches).sort((a, b) =>
      b.id.localeCompare(a.id),
    )[0];
  }

  const colonIndex = pattern.lastIndexOf(':');
  if (colonIndex !== -1) {
    return resolveScopePattern(pattern.slice(0, colonIndex), models);
  }

  return undefined;
}

function findExactScopeMatch(
  pattern: string,
  models: AvailableModelInfo[],
): AvailableModelInfo | undefined {
  const normalized = pattern.trim().toLowerCase();
  const canonicalMatches = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;

  const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function stripThinkingLevel(pattern: string): string {
  const colonIndex = pattern.lastIndexOf(':');
  if (colonIndex === -1) return pattern;

  const suffix = pattern.slice(colonIndex + 1);
  return [...THINKING_LEVELS, 'max'].includes(suffix as ThinkingLevel | 'max')
    ? pattern.slice(0, colonIndex)
    : pattern;
}

function hasGlobCharacters(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?') || pattern.includes('[');
}

function addUniqueModel(models: AvailableModelInfo[], candidate: AvailableModelInfo): void {
  if (!models.some((model) => model.provider === candidate.provider && model.id === candidate.id)) {
    models.push(candidate);
  }
}

function loadModelCatalog(forceRefresh: boolean, cwd: string, allowStale: boolean): ModelCache {
  const now = Date.now();
  const cached = cacheByCwd.get(cwd);

  if (!forceRefresh && cached && (allowStale || now - cached.loadedAt < CACHE_TTL_MS)) {
    return cached;
  }

  const cliModels = listModelsFromPiCli(config.piBin, cwd);
  const refreshed = {
    loadedAt: now,
    cwd,
    models: (cliModels ?? []).sort((a, b) => a.ref.localeCompare(b.ref)),
    fromPiCli: cliModels !== undefined,
  };
  cacheByCwd.set(cwd, refreshed);
  return refreshed;
}

function listModelsFromPiCli(piBin: string, cwd: string): AvailableModelInfo[] | undefined {
  const { bin, args } = resolvePiSpawn(piBin, ['--list-models']);
  const result = spawnSync(bin, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error || result.status !== 0 || !result.stdout) {
    return undefined;
  }

  return parsePiModelList(result.stdout);
}

export function parsePiModelList(output: string): AvailableModelInfo[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(/\s+/);
  const providerIndex = headers.indexOf('provider');
  const modelIndex = headers.indexOf('model');
  const thinkingIndex = headers.indexOf('thinking');
  if (providerIndex === -1 || modelIndex === -1 || thinkingIndex === -1) return [];

  return lines.slice(1).flatMap((line) => {
    const columns = line.split(/\s+/);
    const provider = columns[providerIndex];
    const id = columns[modelIndex];
    if (!provider || !id) return [];

    const reasoning = columns[thinkingIndex]?.toLowerCase() === 'yes';
    return [
      {
        ref: `${provider}/${id}`,
        provider,
        id,
        name: id,
        reasoning,
        // The text table exposes only yes/no thinking support. Let pi perform
        // model-specific clamping for CLI-only models unknown to the bundled SDK.
        supportsXhigh: reasoning,
      },
    ];
  });
}

async function loadSdkModelCatalog(): Promise<AvailableModelInfo[]> {
  const runtime = await ModelRuntime.create();
  return (await runtime.getAvailable()).map(toAvailableModelInfo);
}

function toAvailableModelInfo(model: Model<any>): AvailableModelInfo {
  return {
    ref: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    supportsXhigh: supportsModelXhigh(model),
  };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function scoreModelMatch(model: AvailableModelInfo, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  const normalizedQuery = normalize(rawQuery);
  if (!query) return 0;

  let score = 0;
  if (model.ref.toLowerCase() === query) score += 1000;
  if (model.id.toLowerCase() === query) score += 900;
  if (model.name.toLowerCase() === query) score += 800;
  if (normalize(model.ref) === normalizedQuery) score += 700;
  if (normalize(model.id) === normalizedQuery) score += 650;
  if (normalize(model.name) === normalizedQuery) score += 600;
  if (model.ref.toLowerCase().startsWith(query)) score += 500;
  if (model.id.toLowerCase().startsWith(query)) score += 450;
  if (model.name.toLowerCase().startsWith(query)) score += 400;
  if (normalize(model.ref).includes(normalizedQuery)) score += 100;
  if (normalize(model.id).includes(normalizedQuery)) score += 80;
  if (normalize(model.name).includes(normalizedQuery)) score += 60;
  return score;
}
