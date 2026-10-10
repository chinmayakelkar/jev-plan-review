import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JevAsker } from '../src/jev.js';
import type { TranscriptRecord } from '../src/transcript.js';

export function human(text: string, extra: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return { type: 'user', origin: { kind: 'human' }, message: { content: text }, ...extra };
}

export function assistantText(text: string): TranscriptRecord {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

export function toolUse(id: string, name: string): TranscriptRecord {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name }] } };
}

export function toolResult(
  id: string,
  content: string,
  extra: { isError?: boolean; toolUseResult?: unknown } = {},
): TranscriptRecord {
  return {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: id, content, ...(extra.isError ? { is_error: true } : {}) },
      ],
    },
    ...(extra.toolUseResult !== undefined ? { toolUseResult: extra.toolUseResult } : {}),
  };
}

export function fileAttachment(path: string, content: string, displayPath = path): TranscriptRecord {
  return {
    type: 'attachment',
    attachment: {
      type: 'file',
      filename: path,
      displayPath,
      content: { type: 'text', file: { content } },
    },
  };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jpr-'));
}

export function writeTranscript(records: readonly TranscriptRecord[], path?: string): string {
  const target = path ?? join(tempDir(), 'session.jsonl');
  writeFileSync(target, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return target;
}

export type Seen = { state: unknown; questions: string[] };

export interface Script {
  kind?: (id: string) => string;
  covered?: (id: string, plan: string) => number;
  contradicted?: (id: string, plan: string) => number;
}

export function fakeJev(script: Script = {}, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions) {
      seen.push({ state, questions: Object.keys(questions) });
      const plan =
        typeof state === 'object' && 'plan' in state ? String((state as { plan: unknown }).plan) : '';
      const answers = Object.fromEntries(
        Object.keys(questions).map((name) => {
          const split = name.indexOf('_');
          const type = name.slice(0, split);
          const id = name.slice(split + 1);
          if (type === 'kind') {
            return [name, { choice: script.kind?.(id) ?? 'requirement', confidence: 0.9 }];
          }
          if (type === 'covered') return [name, { noul: script.covered?.(id, plan) ?? 0.95 }];
          return [name, { noul: script.contradicted?.(id, plan) ?? 0.02 }];
        }),
      );
      return { answers };
    },
  };
}
