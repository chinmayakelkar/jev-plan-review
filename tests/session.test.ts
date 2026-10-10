import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadState, saveReport, saveState } from '../src/session.js';
import { tempDir } from './helpers.js';

describe('session state', () => {
  it('starts empty', () => {
    expect(loadState(tempDir(), 'abc')).toEqual({ clearLine: 0, approvedLine: 0, revisions: 0 });
  });

  it('saves and loads per session', () => {
    const dir = tempDir();
    saveState(dir, 'abc', { clearLine: 3, approvedLine: 9, revisions: 1, lastPlanFilePath: 'p.md' });
    expect(loadState(dir, 'abc')).toEqual({ clearLine: 3, approvedLine: 9, revisions: 1, lastPlanFilePath: 'p.md' });
    expect(loadState(dir, 'other')).toEqual({ clearLine: 0, approvedLine: 0, revisions: 0 });
  });

  it('keeps an odd session id inside the data directory', () => {
    const dir = tempDir();
    saveState(dir, '../../escape', { clearLine: 1, approvedLine: 0, revisions: 0 });
    expect(existsSync(join(dir, 'sessions', '______escape.json'))).toBe(true);
  });

  it('saves the latest report for a session and returns where it is', () => {
    const dir = tempDir();
    const path = saveReport(dir, 'abc', '| # | Kind |');
    expect(path).toBe(join(dir, 'reports', 'abc.md'));
    saveReport(dir, 'abc', 'newer report');
    expect(readFileSync(path, 'utf8')).toBe('newer report\n');
  });
});
