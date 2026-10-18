import { PROVIDERS, type Config } from './config.js';
import { jevClient, type JevAsker } from './jev.js';
import { review, type ReviewResult } from './review.js';
import { toStatements } from './statements.js';
import { collectSources, readTranscript } from './transcript.js';

export interface RunInput {
  plan: string;
  transcriptPath: string;
  windowStart: number;
  config: Config;
  asker?: JevAsker;
  reverse?: boolean;
}

export type RunOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'reviewed'; result: ReviewResult; overLimit: number };

export async function runReview(input: RunInput): Promise<RunOutcome> {
  const { config } = input;
  const asker =
    input.asker ??
    (config.apiKey
      ? jevClient({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl })
      : undefined);
  if (!asker) {
    const { label, keyVar } = PROVIDERS[config.provider];
    return {
      kind: 'skipped',
      reason: `no ${label} API key is set; add ${keyVar} to the "env" section of ~/.claude/settings.json and restart Claude Code`,
    };
  }
  if (!input.plan.trim()) return { kind: 'skipped', reason: 'the plan is empty' };
  try {
    const records = readTranscript(input.transcriptPath).slice(input.windowStart);
    const { statements, skipped } = toStatements(collectSources(records), config.maxStatements);
    if (statements.length === 0) {
      return {
        kind: 'skipped',
        reason: 'the user has said nothing to check since the last approved plan or /clear',
      };
    }
    const result = await review(input.plan, statements, asker, {
      minConfidence: config.minConfidence,
      reverse: input.reverse ?? false,
      maxPlanItems: config.maxStatements,
    });
    return { kind: 'reviewed', result, overLimit: skipped };
  } catch (error) {
    return { kind: 'skipped', reason: error instanceof Error ? error.message : String(error) };
  }
}
