import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptRecord } from '../../src/transcript.js';
import { assistantText, fileAttachment, human, toolResult, toolUse, writeTranscript } from '../../tests/helpers.js';

export type Turn = { assistant: string } | { user: string } | { ask: { question: string; answer: string } } | { file: string };

export type Expected = 'reflected' | 'missing' | 'contradicted' | 'set_aside';

export interface Scenario {
  name: string;
  about: string;
  files?: Record<string, string>;
  turns: Turn[];
  plan: string;
  expect: { statements: { text: string; verdict: Expected }[]; notFromUser?: string[]; fromUser?: string[] };
}

export function loadScenarios(dir: string, names?: string[]): Scenario[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Scenario)
    .filter((scenario) => !names?.length || names.includes(scenario.name));
}

export function buildTranscript(scenario: Scenario): string {
  const records: TranscriptRecord[] = scenario.turns.flatMap((turn, index): TranscriptRecord[] => {
    if ('assistant' in turn) return [assistantText(turn.assistant)];
    if ('user' in turn) return [human(turn.user)];
    if ('file' in turn) return [fileAttachment(turn.file, scenario.files?.[turn.file] ?? '')];
    const id = `ask${index}`;
    return [
      toolUse(id, 'AskUserQuestion'),
      toolResult(id, 'answered', { toolUseResult: { answers: { [turn.ask.question]: turn.ask.answer } } }),
    ];
  });
  return writeTranscript(records);
}
