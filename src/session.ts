import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SessionState {
  clearLine: number;
  approvedLine: number;
  revisions: number;
  lastPlanFilePath?: string;
}

function fileFor(dataDir: string, folder: string, sessionId: string, extension: string): string {
  return join(dataDir, folder, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.${extension}`);
}

function statePath(dataDir: string, sessionId: string): string {
  return fileFor(dataDir, 'sessions', sessionId, 'json');
}

export function loadState(dataDir: string, sessionId: string): SessionState {
  const empty: SessionState = { clearLine: 0, approvedLine: 0, revisions: 0 };
  try {
    const saved = JSON.parse(readFileSync(statePath(dataDir, sessionId), 'utf8')) as Partial<SessionState>;
    return { ...empty, ...saved };
  } catch {
    return empty;
  }
}

export function saveState(dataDir: string, sessionId: string, state: SessionState): void {
  const path = statePath(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

export function saveReport(dataDir: string, sessionId: string, markdown: string): string {
  const path = fileFor(dataDir, 'reports', sessionId, 'md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${markdown}\n`);
  return path;
}
