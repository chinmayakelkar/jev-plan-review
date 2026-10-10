import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { handleHook, type HookInput } from '../src/hook.js';
import { loadState } from '../src/session.js';
import { DENY_MARKER, REPORT_MARKER } from '../src/transcript.js';
import { fakeJev, human, tempDir, writeTranscript, type Seen } from './helpers.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: 'k',
    provider: 'typesafe',
    baseUrl: 'https://jev.invalid/systemone',
    model: 'jev-latest',
    minConfidence: 0.8,
    autoReview: true,
    revise: true,
    shareWithClaude: true,
    dataDir: tempDir(),
    ...overrides,
  };
}

function preToolUse(transcriptPath: string, extra: Partial<HookInput> = {}): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess',
    transcript_path: transcriptPath,
    tool_input: { plan: 'Store data in SQLite.' },
    ...extra,
  };
}

const missing = () => fakeJev({ covered: () => 0.05 });

describe('handleHook with revise off', () => {
  it('shows the table to the user, shares it with Claude, and never blocks', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const settings = config({ revise: false });
    const output = await handleHook(preToolUse(path), settings, missing());
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(output?.systemMessage).toContain('jev-plan-review: 0 of 1 items reflected in the plan, 1 missing');
    expect(output?.systemMessage).toContain('NO   95%  requirement  Add a CSV export command too.  [missing]');

    const reportPath = join(settings.dataDir, 'reports', 'sess.md');
    const context = output?.hookSpecificOutput?.additionalContext ?? '';
    expect(context.startsWith(REPORT_MARKER)).toBe(true);
    expect(context).toContain('NO   95%  requirement  Add a CSV export command too.  [missing]');
    expect(context).toContain(`Full report: ${reportPath}`);
    expect(readFileSync(reportPath, 'utf8')).toContain(
      '| 1 | requirement | Add a CSV export command too. | NO | 95% | missing |',
    );
  });

  it('keeps the report from Claude when sharing is off', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const output = await handleHook(
      preToolUse(path),
      config({ revise: false, shareWithClaude: false }),
      missing(),
    );
    expect(output?.hookSpecificOutput).toBeUndefined();
    expect(output?.systemMessage).toContain('[missing]');
  });
});

describe('handleHook with automatic review off', () => {
  it('asks Jev nothing at plan time, but remembers the plan file for the command', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const seen: Seen[] = [];
    const settings = config({ autoReview: false });
    const output = await handleHook(
      preToolUse(path, { tool_input: { plan: 'A plan.', planFilePath: 'plans/p.md' } }),
      settings,
      fakeJev({}, seen),
    );
    expect(output).toBeUndefined();
    expect(seen).toEqual([]);
    expect(loadState(settings.dataDir, 'sess').lastPlanFilePath).toBe('plans/p.md');
  });
});

describe('handleHook with revise on', () => {
  it('sends the plan back twice, then lets it through with the open items marked', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const settings = config();

    const first = await handleHook(preToolUse(path), settings, missing());
    expect(first?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(first?.hookSpecificOutput?.permissionDecisionReason?.startsWith(DENY_MARKER)).toBe(true);
    expect(first?.hookSpecificOutput?.permissionDecisionReason).toContain('revision 1 of 2');
    expect(first?.hookSpecificOutput?.additionalContext).toBeUndefined();
    expect(first?.systemMessage).toContain('revision 1 of 2');

    const second = await handleHook(preToolUse(path), settings, missing());
    expect(second?.hookSpecificOutput?.permissionDecisionReason).toContain('revision 2 of 2');

    const third = await handleHook(preToolUse(path), settings, missing());
    expect(third?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(third?.hookSpecificOutput?.additionalContext).toContain('[missing]');
    expect(third?.systemMessage).toContain('Still open after 2 revisions');
    expect(third?.systemMessage).toContain('[missing]');

    const fourth = await handleHook(preToolUse(path), settings, missing());
    expect(fourth?.hookSpecificOutput?.permissionDecisionReason).toContain('revision 1 of 2');
  });

  it('does not act when Jev is less sure than the minimum', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const output = await handleHook(preToolUse(path), config(), fakeJev({ covered: () => 0.35 }));
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(output?.systemMessage).toContain('[missing, unsure]');
  });

  it('lets a fully reflected plan through', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const output = await handleHook(preToolUse(path), config(), fakeJev());
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(output?.systemMessage).toContain('1 of 1 items reflected');
  });
});

describe('handleHook when things go wrong', () => {
  it('steps aside when Jev fails', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const failing = {
      ask: async () => {
        throw new Error('Jev request failed (503): busy');
      },
    };
    const output = await handleHook(preToolUse(path), config(), failing);
    expect(output).toEqual({ systemMessage: 'jev-plan-review: skipped — Jev request failed (503): busy' });
  });

  it('steps aside without a key', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const output = await handleHook(preToolUse(path), config({ apiKey: undefined }));
    expect(output?.hookSpecificOutput).toBeUndefined();
    expect(output?.systemMessage).toContain('skipped — no TypeSafe API key');
    expect(output?.systemMessage).toContain('/jev-plan-review:settings');
  });

  it('ignores subagents and unknown events', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    expect(await handleHook(preToolUse(path, { agent_id: 'a1' }), config(), missing())).toBeUndefined();
    expect(await handleHook(preToolUse(path, { hook_event_name: 'Stop' }), config(), missing())).toBeUndefined();
  });
});

describe('handleHook window tracking', () => {
  it('forgets what was said before an approved plan', async () => {
    const path = writeTranscript([human('Use SQLite for the storage layer.')]);
    const settings = config({ revise: false });
    await handleHook({ hook_event_name: 'PostToolUse', session_id: 'sess', transcript_path: path }, settings);
    expect(loadState(settings.dataDir, 'sess')).toMatchObject({ approvedLine: 1, revisions: 0 });

    writeTranscript([human('Use SQLite for the storage layer.'), human('Add a CSV export command too.')], path);
    const output = await handleHook(preToolUse(path), settings, missing());
    expect(output?.systemMessage).toContain('Add a CSV export');
    expect(output?.systemMessage).not.toContain('SQLite');
  });

  it('forgets what was said before /clear, and only on /clear', async () => {
    const path = writeTranscript([human('Use SQLite for the storage layer.')]);
    const settings = config({ revise: false });
    await handleHook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'sess', transcript_path: path }, settings);
    expect(loadState(settings.dataDir, 'sess').clearLine).toBe(0);
    await handleHook({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sess', transcript_path: path }, settings);
    expect(loadState(settings.dataDir, 'sess')).toEqual({ clearLine: 1, approvedLine: 0, revisions: 0 });
  });

  it('remembers the plan file and reads it when the plan text is not passed', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const planFile = join(tempDir(), 'plan.md');
    writeFileSync(planFile, 'Add a CSV export command.');
    const settings = config({ revise: false });
    const output = await handleHook(
      preToolUse(path, { tool_input: { planFilePath: planFile } }),
      settings,
      fakeJev({ covered: (_id, plan) => (plan.includes('CSV export') ? 0.9 : 0.1) }),
    );
    expect(output?.systemMessage).toContain('1 of 1 items reflected');
    expect(loadState(settings.dataDir, 'sess').lastPlanFilePath).toBe(planFile);
  });
});
