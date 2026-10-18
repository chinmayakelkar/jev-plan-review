import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, SYSTEM_ONE_URL } from './jev.js';

export const PROVIDERS = {
  typesafe: { label: 'TypeSafe', url: SYSTEM_ONE_URL, keyVar: 'TYPESAFE_API_KEY' },
  openrouter: {
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/systemone',
    keyVar: 'OPENROUTER_API_KEY',
  },
} as const;

export type Provider = keyof typeof PROVIDERS;

export interface Settings {
  provider: Provider;
  min_confidence: number;
  auto_review: boolean;
  max_revisions: number;
  max_statements: number;
  show_inconclusive: boolean;
  reverse_plan_check: boolean;
  model: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'typesafe',
  min_confidence: 80,
  auto_review: true,
  max_revisions: 2,
  max_statements: 150,
  show_inconclusive: true,
  reverse_plan_check: true,
  model: DEFAULT_MODEL,
};

export interface Config {
  apiKey?: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  minConfidence: number;
  autoReview: boolean;
  maxRevisions: number;
  maxStatements: number;
  showInconclusive: boolean;
  reverseCheck: boolean;
  dataDir: string;
  settingsFile?: string;
  optionProblems?: string[];
}

export type Env = Record<string, unknown>;

export function given(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && !trimmed.startsWith('${') ? trimmed : undefined;
}

function toggle(key: string, value: string): boolean {
  if (['on', 'true', 'yes'].includes(value)) return true;
  if (['off', 'false', 'no'].includes(value)) return false;
  throw new Error(`${key} must be on or off`);
}

export function withSetting(settings: Settings, key: string, raw: unknown): Settings {
  const text = String(raw).trim();
  const value = text.toLowerCase();
  switch (key) {
    case 'provider':
      if (value !== 'typesafe' && value !== 'openrouter') {
        throw new Error('provider must be typesafe or openrouter');
      }
      return { ...settings, provider: value };
    case 'min_confidence': {
      const percent = Number(value.replace(/%$/, '') || NaN);
      if (!(percent >= 50 && percent <= 100)) {
        throw new Error('min_confidence must be a number from 50 to 100');
      }
      return { ...settings, min_confidence: percent };
    }
    case 'auto_review':
    case 'show_inconclusive':
    case 'reverse_plan_check':
      return { ...settings, [key]: toggle(key, value) };
    case 'max_revisions':
    case 'max_statements': {
      const count = Number(value || NaN);
      if (!(Number.isInteger(count) && count >= 1)) {
        throw new Error(`${key} must be a whole number, 1 or more`);
      }
      return { ...settings, [key]: count };
    }
    case 'model':
      if (!text) throw new Error('model must not be empty');
      return { ...settings, model: text };
    default:
      throw new Error(
        `unknown setting ${key}; the settings are ${Object.keys(DEFAULT_SETTINGS).join(', ')}`,
      );
  }
}

export const OPTION_PREFIX = 'CLAUDE_PLUGIN_OPTION_';

function shown(value: unknown): string {
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
}

export function readOptions(env: Env): { settings: Settings; problems: string[] } {
  let settings = DEFAULT_SETTINGS;
  const problems: string[] = [];
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = given(env[OPTION_PREFIX + key.toUpperCase()]);
    if (value === undefined) continue;
    try {
      settings = withSetting(settings, key, value);
    } catch (error) {
      problems.push(`${error instanceof Error ? error.message : String(error)}; used ${shown(DEFAULT_SETTINGS[key])}`);
    }
  }
  return { settings, problems };
}

export function optionNote(problems: readonly string[]): string {
  return `${problems.join('; ')}; fix it in /config`;
}

export function claudeDir(env: Env): string {
  return given(env.CLAUDE_CONFIG_DIR) ?? join(homedir(), '.claude');
}

export function readSettingsEnv(env: Env): Env {
  const path = join(claudeDir(env), 'settings.json');
  if (!existsSync(path)) return {};
  try {
    const settings = JSON.parse(readFileSync(path, 'utf8')) as { env?: unknown };
    return settings.env !== null && typeof settings.env === 'object' ? (settings.env as Env) : {};
  } catch {
    return {};
  }
}

export function resolveDataDir(env: Env, override?: string): string {
  return given(override) ?? given(env.CLAUDE_PLUGIN_DATA) ?? join(tmpdir(), 'jev-plan-review');
}

export function resolveConfig(env: Env, settingsEnv: Env = {}, dataDir?: string): Config {
  const dir = resolveDataDir(env, dataDir);
  const { settings, problems } = readOptions(env);
  const configDir = given(env.CLAUDE_CONFIG_DIR);
  const { url, keyVar } = PROVIDERS[settings.provider];
  const apiKey = given(env[keyVar]) ?? given(settingsEnv[keyVar]);
  return {
    ...(apiKey ? { apiKey } : {}),
    provider: settings.provider,
    baseUrl: url,
    model: settings.model,
    minConfidence: settings.min_confidence / 100,
    autoReview: settings.auto_review,
    maxRevisions: settings.max_revisions,
    maxStatements: settings.max_statements,
    showInconclusive: settings.show_inconclusive,
    reverseCheck: settings.reverse_plan_check,
    dataDir: dir,
    settingsFile: configDir ? join(configDir, 'settings.json') : '~/.claude/settings.json',
    ...(problems.length ? { optionProblems: problems } : {}),
  };
}
