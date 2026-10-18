import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSources, DENY_MARKER, latestPlanModePlan, readTranscript, REPORT_MARKER } from '../src/transcript.js';
import {
  assistantText,
  fileAttachment,
  human,
  tempDir,
  toolResult,
  toolUse,
  writeTranscript,
} from './helpers.js';

describe('readTranscript', () => {
  it('keeps one entry per non-empty line, even when a line is not JSON', () => {
    const path = join(tempDir(), 't.jsonl');
    writeFileSync(path, `${JSON.stringify(human('one'))}\n\n{"type":"us\n${JSON.stringify(human('two'))}\n`);
    const records = readTranscript(path);
    expect(records).toHaveLength(3);
    expect(records[1]).toEqual({});
  });

  it('returns nothing for a missing file', () => {
    expect(readTranscript(join(tempDir(), 'absent.jsonl'))).toEqual([]);
  });
});

describe('collectSources', () => {
  it('collects what the human typed, with the assistant text before it as context', () => {
    const sources = collectSources([
      human('Build a CLI. <system-reminder>ignore me</system-reminder>'),
      assistantText('Which database should it use?'),
      human('Use Postgres.'),
    ]);
    expect(sources).toEqual([
      { kind: 'prompt', text: 'Build a CLI.' },
      { kind: 'prompt', text: 'Use Postgres.', context: 'Which database should it use?' },
    ]);
  });

  it('skips records that are not the human speaking', () => {
    const sources = collectSources([
      human('meta text', { isMeta: true }),
      human('subagent prompt', { isSidechain: true }),
      human('from a teammate', { origin: { kind: 'peer' } }),
      human('<local-command-stdout>Kept model</local-command-stdout>'),
      human('[Request interrupted by user]'),
      { type: 'user', message: { content: [{ type: 'text', text: 'typed as blocks' }] } },
    ]);
    expect(sources).toEqual([{ kind: 'prompt', text: 'typed as blocks' }]);
  });

  it('keeps the arguments of a slash command and drops the command itself', () => {
    const sources = collectSources([
      human(
        '<command-message>brainstorm</command-message>\n<command-name>/brainstorm</command-name>\n<command-args>The export must be CSV.</command-args>',
      ),
      human('<command-name>/model</command-name>\n<command-args></command-args>'),
    ]);
    expect(sources).toEqual([{ kind: 'prompt', text: 'The export must be CSV.' }]);
  });

  it('drops the arguments of this plugin’s own commands', () => {
    const sources = collectSources([
      human(
        '<command-message>jev-plan-review:settings</command-message>\n<command-name>/jev-plan-review:settings</command-name>\n<command-args>min_confidence 90</command-args>',
      ),
      human(
        '<command-message>jev-plan-review:review</command-message>\n<command-name>/jev-plan-review:review</command-name>\n<command-args>--since-clear</command-args>',
      ),
    ]);
    expect(sources).toEqual([]);
  });

  it('turns AskUserQuestion answers into self-contained statements', () => {
    const sources = collectSources([
      toolUse('t1', 'AskUserQuestion'),
      toolResult('t1', 'The user answered…', {
        toolUseResult: {
          answers: { 'Which runtime?': 'Node 18+', 'Block or advise?': 'Advise' },
          annotations: { 'Block or advise?': { notes: 'blocking feels intrusive' } },
        },
      }),
    ]);
    expect(sources).toEqual([
      { kind: 'answer', text: 'Asked: "Which runtime?" — the user answered: "Node 18+"' },
      {
        kind: 'answer',
        text: 'Asked: "Block or advise?" — the user answered: "Advise" (note: blocking feels intrusive)',
      },
    ]);
  });

  it('keeps feedback from a rejected plan and nothing else', () => {
    const sources = collectSources([
      toolUse('p1', 'ExitPlanMode'),
      toolResult('p1', `${DENY_MARKER} The plan leaves out… the user said: nothing really`, { isError: true }),
      toolUse('p2', 'ExitPlanMode'),
      toolResult('p2', "The user doesn't want to proceed with this tool use.", { isError: true }),
      toolUse('p3', 'ExitPlanMode'),
      toolResult(
        'p3',
        "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\nUse UTC, not local time.",
        { isError: true },
      ),
      toolUse('p4', 'ExitPlanMode'),
      toolResult('p4', 'User has approved your plan. the user said: go'),
      toolUse('b1', 'Bash'),
      toolResult('b1', 'the user said: this is command output', { isError: true }),
    ]);
    expect(sources).toEqual([{ kind: 'plan_feedback', text: 'Use UTC, not local time.' }]);
  });

  it('never reads the plugin’s own report back as the user’s words', () => {
    const sources = collectSources([
      human(`${REPORT_MARKER} This plan was checked.\nNO   93%  decision     Use Postgres for storage`),
      toolUse('p1', 'ExitPlanMode'),
      toolResult(
        'p1',
        `The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\nUse UTC, not local time.\n<system-reminder>${REPORT_MARKER} wrapped copy</system-reminder>\n${REPORT_MARKER} bare copy\nNO   93%  decision     Use Postgres for storage`,
        { isError: true },
      ),
    ]);
    expect(sources).toEqual([{ kind: 'plan_feedback', text: 'Use UTC, not local time.' }]);
  });

  it('counts an attached file only when the human mentioned it with @', () => {
    const sources = collectSources([
      human('Follow @docs/spec.md and @"my notes/todo.md", please.'),
      fileAttachment('D:\\proj\\docs\\spec.md', 'Spec text.', 'docs\\spec.md'),
      fileAttachment('D:\\proj\\my notes\\todo.md', 'Todo text.'),
      fileAttachment('D:\\proj\\src\\other.ts', 'Not mentioned.'),
    ]);
    expect(sources.filter((source) => source.kind === 'document')).toEqual([
      { kind: 'document', text: 'Spec text.', label: 'docs\\spec.md' },
      { kind: 'document', text: 'Todo text.', label: 'D:\\proj\\my notes\\todo.md' },
    ]);
  });

  it('never counts CLAUDE.md, even when mentioned', () => {
    const sources = collectSources([
      human('Read @CLAUDE.md and @CLAUDE.local.md first.'),
      fileAttachment('D:\\proj\\CLAUDE.md', 'Project rules.'),
      fileAttachment('D:\\proj\\CLAUDE.local.md', 'Local rules.'),
    ]);
    expect(sources.filter((source) => source.kind === 'document')).toEqual([]);
  });

  it('collects a prompt typed while Claude was working, once', () => {
    const queued = {
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: 'Also add tests.', origin: { kind: 'human' } },
    };
    const sources = collectSources([queued, human('Also add tests.')]);
    expect(sources).toEqual([{ kind: 'prompt', text: 'Also add tests.' }]);
  });
});

const fixture = 'tests/fixtures/real-session.jsonl';

describe('collectSources and text Claude Code wrote', () => {
  it('never reads a compaction summary as the user’s words', () => {
    const summary = human('The user wants every module written in Rust from now on.', {
      origin: undefined,
      isCompactSummary: true,
    });
    expect(collectSources([summary])).toEqual([]);
  });

  it('never reads shell output or a task notice as the user’s words', () => {
    const records = [
      '<bash-input>npm run build the whole project</bash-input>',
      '<bash-stdout>The build must never fail again here.</bash-stdout>',
      '<task-notification>The agent must always finish its work.</task-notification>',
    ].map((text) => human(text, { origin: undefined }));
    expect(collectSources(records)).toEqual([]);
  });
});

describe('a real captured session', () => {
  it.skipIf(!existsSync(fixture))('yields the prompt, the mentioned file and the rejection feedback', () => {
    const sources = collectSources(readTranscript(fixture));
    expect(sources.map((source) => source.kind)).toEqual(
      expect.arrayContaining(['prompt', 'plan_feedback', 'document']),
    );
    expect(sources.find((source) => source.kind === 'prompt')?.text).toBe(
      'Plan a tiny script that exports reports. See @notes.md',
    );
    expect(sources.find((source) => source.kind === 'plan_feedback')?.text).toBe(
      'add a --help flag',
    );
    expect(sources.find((source) => source.kind === 'document')?.text.trim()).toBe(
      'The export must be CSV, never Excel.',
    );
    expect(sources.some((source) => source.text.includes(DENY_MARKER))).toBe(false);
    expect(sources.some((source) => source.text.includes('probe context for Claude'))).toBe(false);
  });
});

describe('latestPlanModePlan', () => {
  it('takes the last ExitPlanMode plan, preferring the plan file while it exists', () => {
    const file = join(tempDir(), 'plan.md');
    writeFileSync(file, 'Edited plan.');
    expect(latestPlanModePlan([
      toolUse('p1', 'ExitPlanMode', { plan: 'First plan.' }),
      toolUse('p2', 'ExitPlanMode', { plan: 'Second plan.', planFilePath: file }),
    ])).toBe('Edited plan.');
  });

  it('falls back to the plan text when the plan file is gone', () => {
    expect(latestPlanModePlan([
      toolUse('p1', 'ExitPlanMode', { plan: 'Kept plan.', planFilePath: join(tempDir(), 'gone.md') }),
    ])).toBe('Kept plan.');
  });

  it('reads the plan file named in a plan_mode record when ExitPlanMode has no input', () => {
    const file = join(tempDir(), 'plan.md');
    writeFileSync(file, '# Plan A');
    expect(latestPlanModePlan([
      { type: 'attachment', attachment: { type: 'plan_mode', planFilePath: file } },
      toolUse('t1', 'ExitPlanMode', {}),
    ])).toBe('# Plan A');
  });

  it('prefers the newer ExitPlanMode plan over an older plan_mode record', () => {
    const file = join(tempDir(), 'plan.md');
    writeFileSync(file, '# Old');
    expect(latestPlanModePlan([
      { type: 'attachment', attachment: { type: 'plan_mode', planFilePath: file } },
      toolUse('t1', 'ExitPlanMode', { plan: '# New' }),
    ])).toBe('# New');
  });

  it('skips a plan_mode record whose file does not exist', () => {
    expect(latestPlanModePlan([
      { type: 'attachment', attachment: { type: 'plan_mode', planFilePath: join(tempDir(), 'gone.md') } },
    ])).toBeUndefined();
  });

  it('ignores plan_mode records from subagents', () => {
    const file = join(tempDir(), 'plan.md');
    writeFileSync(file, '# Sub');
    expect(latestPlanModePlan([
      { type: 'attachment', attachment: { type: 'plan_mode', planFilePath: file, isSubAgent: true } },
    ])).toBeUndefined();
  });

  it('ignores plans made by subagents and finds nothing when there is none', () => {
    const sidechain = { ...toolUse('p1', 'ExitPlanMode', { plan: 'Subagent plan.' }), isSidechain: true };
    expect(latestPlanModePlan([sidechain])).toBeUndefined();
    expect(latestPlanModePlan([human('Hello there.')])).toBeUndefined();
  });
});
