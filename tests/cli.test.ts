import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/config.js';
import { saveState } from '../src/session.js';
import type { TranscriptRecord } from '../src/transcript.js';
import { fakeJev, human, tempDir, toolResult, toolUse, writeTranscript, type Seen } from './helpers.js';

function setup(
  records: readonly TranscriptRecord[] = [human('Use SQLite for the storage layer.'), human('Add a CSV export command too.')],
) {
  const claude = tempDir();
  const project = join(claude, 'projects', 'D--proj');
  mkdirSync(project, { recursive: true });
  writeTranscript(records, join(project, 'sess.jsonl'));
  const dataDir = tempDir();
  const plan = join(tempDir(), 'plan.md');
  writeFileSync(plan, 'Store data in SQLite. Add CSV export.');
  const env = { CLAUDE_CONFIG_DIR: claude, TYPESAFE_API_KEY: 'k' };
  return { env, dataDir, plan };
}

describe('runCli', () => {
  it('prints the coverage table for a plan file', async () => {
    const { env, dataDir, plan } = setup();
    const { code, output } = await runCli(['--session', 'sess', '--data-dir', dataDir, '--plan', plan], env, fakeJev());
    expect(code).toBe(0);
    expect(output).toContain('jev-plan-review: 2 of 2 items reflected in the plan');
    expect(output).toContain('| 1 | requirement | Use SQLite for the storage layer. | YES | 95% |  |');
  });

  it('saves the report and says where', async () => {
    const { env, dataDir, plan } = setup();
    const { output } = await runCli(['--session', 'sess', '--data-dir', dataDir, '--plan', plan], env, fakeJev());
    const path = join(dataDir, 'reports', 'sess.md');
    expect(readFileSync(path, 'utf8')).toContain('2 of 2 items reflected');
    expect(output.trimEnd().split('\n').at(-1)).toBe(`Full report: ${path}`);
  });

  it('accepts the plan as a bare path and names it', async () => {
    const { env, dataDir, plan } = setup();
    const { code, output } = await runCli(['--session', 'sess', '--data-dir', dataDir, plan], env, fakeJev());
    expect(code).toBe(0);
    expect(output.split('\n')[0]).toBe(`Plan checked: ${plan}`);
  });

  it('falls back to the latest plan-mode plan in the transcript', async () => {
    const { env, dataDir } = setup([
      human('Use SQLite for the storage layer.'),
      toolUse('p1', 'ExitPlanMode', { plan: 'Store data in SQLite.' }),
    ]);
    const { output } = await runCli(['--session', 'sess', '--data-dir', dataDir], env, fakeJev());
    expect(output.split('\n')[0]).toBe('Plan checked: the latest plan-mode plan');
    expect(output).toContain('1 of 1 items reflected');
  });

  it('finds a plan-mode plan the user pressed Esc on', async () => {
    const planFile = join(tempDir(), 'plan.md');
    writeFileSync(planFile, 'Store data in SQLite.');
    const { env, dataDir } = setup([
      human('Use SQLite for the storage layer.'),
      { type: 'attachment', attachment: { type: 'plan_mode', planFilePath: planFile } },
      toolUse('t1', 'ExitPlanMode', {}),
      toolResult('t1', 'rejected', { isError: true, toolUseResult: 'User rejected tool use' }),
    ]);
    const { output } = await runCli(['--session', 'sess', '--data-dir', dataDir], env, fakeJev());
    expect(output.split('\n')[0]).toBe('Plan checked: the latest plan-mode plan');
    expect(output).toContain('1 of 1 items reflected');
  });

  it('reads a passed-in plan from stdin, unchanged', async () => {
    const { env, dataDir } = setup();
    const seen: Seen[] = [];
    const text = 'Store data in SQLite under $HOME.\r\nRun `export` for CSV.';
    const { output } = await runCli(['--session', 'sess', '--data-dir', dataDir, '--plan', '-'], env, fakeJev({}, seen), () => text);
    expect(output.split('\n')[0]).toBe('Plan checked: the plan Claude passed in');
    expect(seen.some((call) => (call.state as { plan?: string }).plan === text)).toBe(true);
  });

  it('says so when the plan path cannot be read', async () => {
    const { env, dataDir, plan } = setup();
    const { code, output } = await runCli(['--session', 'sess', '--data-dir', dataDir, '--plan', dirname(plan)], env, fakeJev());
    expect(code).toBe(1);
    expect(output).toMatch(/^Could not read the plan: /);
  });

  it('says so when stdin cannot be read', async () => {
    const { env, dataDir } = setup();
    const { code, output } = await runCli(['--session', 'sess', '--data-dir', dataDir, '--plan', '-'], env, fakeJev(), () => {
      throw new Error('stdin closed');
    });
    expect(code).toBe(1);
    expect(output).toBe('Could not read the plan: stdin closed');
  });

  it('still prints the report when it cannot be saved', async () => {
    const { env, dataDir, plan } = setup();
    writeFileSync(join(dataDir, 'reports'), 'in the way');
    const { code, output } = await runCli(['--session', 'sess', '--data-dir', dataDir, '--plan', plan], env, fakeJev());
    expect(code).toBe(0);
    expect(output).toContain('2 of 2 items reflected');
    expect(output.trimEnd().split('\n').at(-1)).toMatch(/^The report could not be saved: /);
    expect(output).not.toContain('Full report:');
  });

  it('stops when no plan is found', async () => {
    const { env, dataDir } = setup();
    const { code, output } = await runCli(['--session', 'sess', '--data-dir', dataDir], env, fakeJev());
    expect(code).toBe(1);
    expect(output).toContain('No plan found');
  });

  it('checks only what came after an approved plan unless told otherwise', async () => {
    const { env, dataDir, plan } = setup();
    saveState(dataDir, 'sess', { clearLine: 1, approvedLine: 2, revisions: 0 });

    const windowed = await runCli(['--session', 'sess', '--data-dir', dataDir, '--plan', plan], env, fakeJev());
    expect(windowed.code).toBe(0);
    expect(windowed.output).toContain('skipped — the user has said nothing to check');
    expect(windowed.output).toContain('--since-clear');

    const sinceClear = await runCli(
      ['--session', 'sess', '--data-dir', dataDir, '--plan', plan, '--since-clear'],
      env,
      fakeJev(),
    );
    expect(sinceClear.output).toContain('1 of 1 items reflected');
    expect(sinceClear.output).toContain('Add a CSV export command too.');
  });

  it('uses the saved confidence threshold', async () => {
    const { env, dataDir, plan } = setup();
    const unsure = fakeJev({ covered: () => 0.35 });
    const base = ['--session', 'sess', '--data-dir', dataDir, '--plan', plan];

    expect((await runCli(base, env, unsure)).output).toContain('| NO | 65% | missing, unsure |');

    saveSettings(dataDir, { ...DEFAULT_SETTINGS, min_confidence: 60 });
    expect((await runCli(base, env, unsure)).output).toContain('| NO | 65% | missing |');
  });

  it('hides what Jev was unsure of when show_inconclusive is off', async () => {
    const { env, dataDir, plan } = setup();
    saveSettings(dataDir, { ...DEFAULT_SETTINGS, show_inconclusive: false });
    const { output } = await runCli(
      ['--session', 'sess', '--data-dir', dataDir, '--plan', plan],
      env,
      fakeJev({ covered: () => 0.35 }),
    );
    expect(output).toContain('2 inconclusive item(s) are hidden; show_inconclusive is off.');
    expect(output).not.toContain('| NO |');
  });

  it('explains what is wrong when it cannot run', async () => {
    const { env, dataDir, plan } = setup();
    expect((await runCli([], env)).output).toContain('usage:');
    expect((await runCli(['--session', '${CLAUDE_SESSION_ID}'], env)).code).toBe(1);
    expect((await runCli(['--session', 'sess', '--data-dir', dataDir], env)).output).toContain('No plan found');
    expect((await runCli(['--session', 'sess', '--data-dir', dataDir, '--plan', 'absent.md'], env)).output).toContain(
      'Plan file not found: absent.md',
    );
    expect((await runCli(['--session', 'nope', '--data-dir', dataDir, '--plan', plan], env)).output).toContain(
      'No transcript found for session nope',
    );
  });
});

describe('runCli settings', () => {
  it('shows the defaults and says when the key is not set', async () => {
    const dataDir = tempDir();
    const { code, output } = await runCli(['settings', '--data-dir', dataDir], { CLAUDE_CONFIG_DIR: tempDir() });
    expect(code).toBe(0);
    expect(output).toMatch(/provider\s+typesafe/);
    expect(output).toMatch(/min_confidence\s+80/);
    expect(output).toMatch(/auto_review\s+on/);
    expect(output).not.toMatch(/revise\s/);
    expect(output).not.toContain('share_with_claude');
    expect(output).toMatch(/max_revisions\s+2/);
    expect(output).toMatch(/max_statements\s+150/);
    expect(output).toMatch(/show_inconclusive\s+on/);
    expect(output).toMatch(/reverse_plan_check\s+on/);
    expect(output).toMatch(/model\s+jev-latest/);
    expect(output).toContain('TYPESAFE_API_KEY is not set');
    expect(output).toContain('Do not paste the key into the chat');
  });

  it('changes several settings at once and keeps them', async () => {
    const dataDir = tempDir();
    const env = { CLAUDE_CONFIG_DIR: tempDir(), OPENROUTER_API_KEY: 'or-key' };
    const { code, output } = await runCli(
      ['settings', '--data-dir', dataDir, '--set', 'provider=openrouter', '--set', 'min_confidence=90', '--set', 'auto_review=off'],
      env,
    );
    expect(code).toBe(0);
    expect(output).toMatch(/provider\s+openrouter/);
    expect(output).toMatch(/auto_review\s+off/);
    expect(output).toContain('OPENROUTER_API_KEY is set');
    expect(output).not.toContain('or-key');
    expect(loadSettings(dataDir)).toEqual({
      ...DEFAULT_SETTINGS,
      provider: 'openrouter',
      min_confidence: 90,
      auto_review: false,
    });
  });

  it('finds the key in settings.json too', async () => {
    const claude = tempDir();
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ env: { TYPESAFE_API_KEY: 'k' } }));
    const { output } = await runCli(['settings', '--data-dir', tempDir()], { CLAUDE_CONFIG_DIR: claude });
    expect(output).toContain('TYPESAFE_API_KEY is set');
  });

  it('changes nothing when one value is bad', async () => {
    const dataDir = tempDir();
    const env = { CLAUDE_CONFIG_DIR: tempDir() };
    const bad = await runCli(
      ['settings', '--data-dir', dataDir, '--set', 'auto_review=off', '--set', 'min_confidence=20'],
      env,
    );
    expect(bad).toEqual({
      code: 1,
      output: 'Nothing was changed: min_confidence must be a number from 50 to 100',
    });
    expect(loadSettings(dataDir).auto_review).toBe(true);

    const shapeless = await runCli(['settings', '--data-dir', dataDir, '--set', 'auto_review'], env);
    expect(shapeless.output).toBe('Nothing was changed: expected <name>=<value>, got "auto_review"');
  });

  it('refuses the removed settings and changes nothing', async () => {
    const dataDir = tempDir();
    const env = { CLAUDE_CONFIG_DIR: tempDir() };
    for (const name of ['revise', 'share_with_claude']) {
      const { code, output } = await runCli(['settings', '--data-dir', dataDir, '--set', `${name}=off`], env);
      expect(code).toBe(1);
      expect(output).toBe(
        `Nothing was changed: unknown setting ${name}; the settings are ${Object.keys(DEFAULT_SETTINGS).join(', ')}`,
      );
    }
    expect(loadSettings(dataDir)).toEqual(DEFAULT_SETTINGS);
  });

  it('shows the reverse section', async () => {
    const { env, dataDir, plan } = setup();
    const { output } = await runCli(['--session', 'sess', '--data-dir', dataDir, '--plan', plan], env, fakeJev({ asked: () => 0.05 }));
    expect(output).toContain('## In the plan, not from you');
    expect(output).toContain('Store data in SQLite.');
  });

  it('leaves out the reverse section when reverse_plan_check is off', async () => {
    const { env, dataDir, plan } = setup();
    saveSettings(dataDir, { ...DEFAULT_SETTINGS, reverse_plan_check: false });
    const seen: Seen[] = [];
    const { output } = await runCli(['--session', 'sess', '--data-dir', dataDir, '--plan', plan], env, fakeJev({ asked: () => 0.05 }, seen));
    expect(output).not.toContain('In the plan, not from you');
    expect(seen.flatMap((call) => call.questions).some((name) => name.startsWith('asked_'))).toBe(false);
  });

  it('reports a plan with only routine steps as fully traced', async () => {
    const { env, dataDir } = setup();
    const routine = join(tempDir(), 'routine.md');
    writeFileSync(routine, '# Plan\n\n```\ncode\n```\n\n- Run the tests.');
    const { output } = await runCli(
      ['--session', 'sess', '--data-dir', dataDir, '--plan', routine],
      env,
      fakeJev({ kind: (id) => (id.startsWith('p') ? 'routine' : 'requirement') }),
    );
    expect(output).toContain('Everything the plan decides traces back to what you said.');
  });
});
