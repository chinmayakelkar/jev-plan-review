import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { handleHook, main, type HookInput, type HookOutput } from '../src/hook.js';
import { loadState } from '../src/session.js';
import { DENY_MARKER, REPORT_MARKER } from '../src/transcript.js';
import {
  assistantText,
  fakeJev,
  human,
  tempDir,
  toolResult,
  toolUse,
  writeTranscript,
  type Seen,
} from './helpers.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: 'k',
    provider: 'typesafe',
    baseUrl: 'https://jev.invalid/systemone',
    model: 'jev-latest',
    minConfidence: 0.8,
    autoReview: true,
    maxRevisions: 2,
    maxStatements: 150,
    showInconclusive: true,
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
const unsure = () => fakeJev({ covered: () => 0.35 });
const toClaude = (output: HookOutput | undefined): string =>
  output?.hookSpecificOutput?.additionalContext ?? output?.hookSpecificOutput?.permissionDecisionReason ?? '';

describe('handleHook when nothing is sure enough to send back', () => {
  it('gives Claude the table, saves the report, and lets the plan through', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const settings = config();
    const output = await handleHook(preToolUse(path), settings, unsure());
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(output?.systemMessage).toBeUndefined();

    const reportPath = join(settings.dataDir, 'reports', 'sess.md');
    const context = toClaude(output);
    expect(context.startsWith(`${REPORT_MARKER} An automatic check of this plan`)).toBe(true);
    expect(context).toContain('Change the plan because of it only if the user asks.');
    expect(context).toContain('NO   65%  requirement  Add a CSV export command too.  [missing, unsure]');
    expect(context).toContain(`Full report: ${reportPath}`);
    expect(readFileSync(reportPath, 'utf8')).toContain(
      '| 1 | requirement | Add a CSV export command too. | NO | 65% | missing, unsure |',
    );
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

describe('handleHook sending the plan back', () => {
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
    expect(toClaude(third)).toContain('[missing]');
    expect(toClaude(third)).toContain('Still open after 2 revisions');
    expect(third?.systemMessage).toBeUndefined();

    const fourth = await handleHook(preToolUse(path), settings, missing());
    expect(fourth?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(toClaude(fourth)).toContain('Still open after 2 revisions');
  });

  it('keeps counting when the user speaks but the plan is the same one', async () => {
    const records = [human('Add a CSV export command too.')];
    const path = writeTranscript(records);
    const settings = config();
    await handleHook(preToolUse(path), settings, missing());
    await handleHook(preToolUse(path), settings, missing());

    writeTranscript([...records, human('Also write the output in UTC.')], path);
    const output = await handleHook(preToolUse(path), settings, missing());
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('starts counting again for a new plan file', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const settings = config();
    const plan = 'Store data in SQLite.';
    const first = { tool_input: { plan, planFilePath: 'plans/first.md' } };
    await handleHook(preToolUse(path, first), settings, missing());
    await handleHook(preToolUse(path, first), settings, missing());

    const second = { tool_input: { plan, planFilePath: 'plans/second.md' } };
    const output = await handleHook(preToolUse(path, second), settings, missing());
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain('revision 1 of 2');
  });

  it('sends the plan back as many times as max_revisions allows', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const settings = config({ maxRevisions: 3 });
    await handleHook(preToolUse(path), settings, missing());
    await handleHook(preToolUse(path), settings, missing());
    const third = await handleHook(preToolUse(path), settings, missing());
    expect(third?.hookSpecificOutput?.permissionDecisionReason).toContain('revision 3 of 3');
    const fourth = await handleHook(preToolUse(path), settings, missing());
    expect(fourth?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(toClaude(fourth)).toContain('Still open after 3 revisions');
  });

  it('keeps counting while only Claude has been working since the send-back', async () => {
    const records = [human('Add a CSV export command too.')];
    const path = writeTranscript(records);
    const settings = config();
    const first = await handleHook(preToolUse(path), settings, missing());

    writeTranscript(
      [
        ...records,
        toolUse('t1', 'ExitPlanMode'),
        toolResult('t1', first?.hookSpecificOutput?.permissionDecisionReason ?? '', { isError: true }),
        assistantText('The plan now adds a CSV export command for every report.'),
      ],
      path,
    );
    const output = await handleHook(preToolUse(path), settings, missing());
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain('revision 2 of 2');
  });

  it('does not act when Jev is less sure than the minimum', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const output = await handleHook(preToolUse(path), config(), unsure());
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(toClaude(output)).toContain('[missing, unsure]');
  });

  it('hides what Jev was unsure of when show_inconclusive is off', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const settings = config({ showInconclusive: false });
    const output = await handleHook(preToolUse(path), settings, unsure());
    const hidden = '1 inconclusive item(s) are hidden; show_inconclusive is off.';
    expect(toClaude(output)).toContain(hidden);
    expect(toClaude(output)).not.toContain('Add a CSV export');
    const report = readFileSync(join(settings.dataDir, 'reports', 'sess.md'), 'utf8');
    expect(report).toContain(hidden);
    expect(report).not.toContain('Add a CSV export');
  });

  it('lets a fully reflected plan through', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const output = await handleHook(preToolUse(path), config(), fakeJev());
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(toClaude(output)).toContain('1 of 1 items reflected');
  });
});

describe('handleHook when things go wrong', () => {
  it('steps aside when Jev fails, and tells Claude the check was skipped', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const failing = {
      ask: async () => {
        throw new Error('Jev request failed (503): busy');
      },
    };
    const output = await handleHook(preToolUse(path), config(), failing);
    expect(output).toEqual({
      systemMessage: 'jev-plan-review: skipped — Jev request failed (503): busy',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `${REPORT_MARKER} The automatic check of this plan was skipped: Jev request failed (503): busy`,
      },
    });
  });

  it('steps aside when Jev gives a malformed answer, and tells Claude the check was skipped', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const output = await handleHook(preToolUse(path), config(), { ask: async () => ({ answers: {} }) });
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(output?.systemMessage).toContain('jev-plan-review: skipped — Invalid Jev answer');
    expect(toClaude(output)).toContain(`${REPORT_MARKER} The automatic check of this plan was skipped: Invalid Jev answer`);
  });

  it('tells Claude the check was skipped when the hook input cannot be read', async () => {
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', { value: Readable.from(['not json']), configurable: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await main();
      const output = JSON.parse(String(write.mock.calls[0][0])) as HookOutput;
      expect(output.systemMessage).toContain('jev-plan-review: skipped — ');
      expect(toClaude(output)).toContain(`${REPORT_MARKER} The automatic check of this plan was skipped: `);
    } finally {
      write.mockRestore();
      Object.defineProperty(process, 'stdin', stdin);
    }
  });

  it('steps aside without a key', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const output = await handleHook(preToolUse(path), config({ apiKey: undefined }));
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(toClaude(output)).toContain('was skipped: no TypeSafe API key');
    expect(output?.systemMessage).toContain('skipped — no TypeSafe API key');
    expect(output?.systemMessage).toContain('/jev-plan-review:settings');
  });

  it('reviews but sends nothing back when the settings file could not be read', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const broken = config({ settingsBroken: true });
    const reviewed = await handleHook(preToolUse(path), broken, missing());
    expect(reviewed?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(toClaude(reviewed)).toContain('settings.json could not be read');
    expect(toClaude(reviewed)).toContain('[missing]');
    const skipped = await handleHook(preToolUse(path), { ...broken, apiKey: undefined });
    expect(skipped?.systemMessage).toContain('settings.json could not be read');
    expect(toClaude(skipped)).toContain('settings.json could not be read');
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
    const settings = config();
    await handleHook({ hook_event_name: 'PostToolUse', session_id: 'sess', transcript_path: path }, settings);
    expect(loadState(settings.dataDir, 'sess')).toMatchObject({ approvedLine: 1, revisions: 0 });

    writeTranscript([human('Use SQLite for the storage layer.'), human('Add a CSV export command too.')], path);
    const output = await handleHook(preToolUse(path), settings, missing());
    expect(toClaude(output)).toContain('Add a CSV export');
    expect(toClaude(output)).not.toContain('SQLite');
  });

  it('forgets what was said before /clear, and only on /clear', async () => {
    const path = writeTranscript([human('Use SQLite for the storage layer.')]);
    const settings = config();
    await handleHook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'sess', transcript_path: path }, settings);
    expect(loadState(settings.dataDir, 'sess').clearLine).toBe(0);
    await handleHook({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sess', transcript_path: path }, settings);
    expect(loadState(settings.dataDir, 'sess')).toEqual({ clearLine: 1, approvedLine: 0, revisions: 0 });
  });

  it('remembers the plan file and reads it when the plan text is not passed', async () => {
    const path = writeTranscript([human('Add a CSV export command too.')]);
    const planFile = join(tempDir(), 'plan.md');
    writeFileSync(planFile, 'Add a CSV export command.');
    const settings = config();
    const output = await handleHook(
      preToolUse(path, { tool_input: { planFilePath: planFile } }),
      settings,
      fakeJev({ covered: (_id, plan) => (plan.includes('CSV export') ? 0.9 : 0.1) }),
    );
    expect(toClaude(output)).toContain('1 of 1 items reflected');
    expect(loadState(settings.dataDir, 'sess').lastPlanFilePath).toBe(planFile);
  });
});
