import { choiceAnswer, noulAnswer, type JevAsker, type JevQuestions } from './jev.js';
import type { Statement } from './statements.js';
import { abridge, estimateTokens } from './tokens.js';
import type { SourceKind } from './transcript.js';

export const KINDS = ['requirement', 'constraint', 'decision', 'assumption', 'preference'] as const;
export type Kind = (typeof KINDS)[number];

const CRITERIA: Record<string, string> = {
  requirement: 'Something the user wants built or delivered',
  constraint: 'A limit or rule the work must respect',
  decision: 'A choice the user made between alternatives, including answers to questions',
  assumption: 'Something the user stated as true that the plan should rely on',
  preference: 'A softer wish about style, naming, tooling or approach',
  superseded: 'The user later reversed or replaced this statement',
  not_actionable: 'A question, thanks, process remark or background with nothing for a plan to reflect',
};
const CHOICES = Object.keys(CRITERIA);

const CLASSIFY_CONTEXT =
  'A user and a coding assistant are preparing an implementation plan. `turns` lists, oldest first, what the user said, split into numbered statements. `said_before_by_assistant` is there only to explain what the user was replying to; it is never a statement to classify. Each question asks what kind of statement one id is.';
const VERIFY_CONTEXT =
  'An implementation plan is being checked against what the user said while it was prepared. `plan` is the plan, or one part of it when `plan_part` is present. `turns` lists statements the user made; `said_before_by_assistant` only explains what the user was replying to. Each question asks whether the plan text shown here reflects, or conflicts with, one statement. Judge only from the plan text shown.';

const CLASSIFY_CONTEXT_CHARS = [2000, 800, 300, 0] as const;
const VERIFY_CONTEXT_CHARS = 800;
const REQUEST_OVERHEAD_TOKENS = 20;

export interface ReviewOptions {
  minConfidence: number;
  maxRequestTokens: number;
  maxPlanTokens: number;
}

export const DEFAULT_REVIEW_OPTIONS: ReviewOptions = {
  minConfidence: 0.8,
  maxRequestTokens: 30_000,
  maxPlanTokens: 16_000,
};

export interface Item extends Statement {
  kind: Kind;
  kindConfidence: number;
}

export type Status = 'reflected' | 'missing' | 'contradicted';

export interface Score {
  covered: number;
  contradicted: number;
}

export interface Verdict extends Item, Score {
  status: Status;
  confidence: number;
  conclusive: boolean;
  actionable: boolean;
}

export interface ReviewResult {
  verdicts: Verdict[];
  statements: number;
  ignored: number;
  requests: number;
  planParts: number;
}

interface Turn {
  source: SourceKind;
  said_before_by_assistant?: string;
  from_document?: string;
  statements: { id: string; text: string; kind?: Kind }[];
}

function turnsFor(statements: readonly (Statement | Item)[], contextChars: number): Turn[] {
  const turns = new Map<number, Turn>();
  for (const statement of statements) {
    let turn = turns.get(statement.turn);
    if (!turn) {
      turn = { source: statement.source, statements: [] };
      if (statement.context && contextChars > 0) {
        const head = Math.floor(contextChars / 4);
        turn.said_before_by_assistant = abridge(statement.context, head, contextChars - head);
      }
      if (statement.label) turn.from_document = statement.label;
      turns.set(statement.turn, turn);
    }
    turn.statements.push({
      id: statement.id,
      text: statement.text,
      ...('kind' in statement ? { kind: statement.kind } : {}),
    });
  }
  return [...turns.values()];
}

export function pack<T>(items: readonly T[], cost: (item: T) => number, budget: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    const tokens = cost(item);
    if (tokens > budget) {
      throw new Error(`one item needs ~${tokens} tokens but only ${budget} are free in a request`);
    }
    if (current.length > 0 && used + tokens > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function splitPlan(plan: string, maxTokens: number): string[] {
  const parts: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim()) parts.push(current.trim());
    current = '';
  };
  for (const paragraph of plan.split(/\n{2,}/)) {
    // estimateTokens never exceeds one token per character, so a slice of
    // maxTokens characters always fits.
    const pieces =
      estimateTokens(paragraph) > maxTokens
        ? (paragraph.match(new RegExp(`[\\s\\S]{1,${maxTokens}}`, 'g')) ?? [])
        : [paragraph];
    for (const piece of pieces) {
      const joined = current ? `${current}\n\n${piece}` : piece;
      if (current && estimateTokens(joined) > maxTokens) {
        flush();
        current = piece;
      } else current = joined;
    }
  }
  flush();
  return parts;
}

function classifyQuestion(statement: Statement): JevQuestions {
  return {
    [`kind_${statement.id}`]: {
      type: 'choice',
      instructions: `What kind of statement is ${statement.id}? Judge it as the user meant it`,
      criteria: CRITERIA,
    },
  };
}

function verifyQuestions(item: Item): JevQuestions {
  return {
    [`covered_${item.id}`]: {
      type: 'noul',
      instructions: `The plan reflects statement ${item.id}: someone following the plan would end up honouring it, whether the plan says so directly or through its steps`,
    },
    [`contradicted_${item.id}`]: {
      type: 'noul',
      instructions: `The plan conflicts with statement ${item.id}: following the plan would go against what the user said`,
    },
  };
}

function tokensOf(value: unknown): number {
  return estimateTokens(JSON.stringify(value));
}

async function classify(
  statements: readonly Statement[],
  asker: JevAsker,
  options: ReviewOptions,
): Promise<Item[]> {
  if (statements.length === 0) return [];
  const limit = Math.floor(options.maxRequestTokens * 0.8);
  let state: object = {};
  let stateTokens = Infinity;
  for (const chars of CLASSIFY_CONTEXT_CHARS) {
    state = { context: CLASSIFY_CONTEXT, turns: turnsFor(statements, chars) };
    stateTokens = tokensOf(state);
    if (stateTokens <= limit) break;
  }
  if (stateTokens > limit) {
    throw new Error(`the conversation is too long to check (~${stateTokens} tokens)`);
  }
  const batches = pack(
    statements,
    (statement) => tokensOf(classifyQuestion(statement)),
    options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS,
  );
  const answered = await Promise.all(
    batches.map(async (batch) => {
      const questions: JevQuestions = Object.assign({}, ...batch.map(classifyQuestion));
      const { answers } = await asker.ask(state, questions);
      return batch.map((statement) => ({
        statement,
        ...choiceAnswer(answers, `kind_${statement.id}`, CHOICES),
      }));
    }),
  );
  return answered
    .flat()
    .filter((entry) => (KINDS as readonly string[]).includes(entry.choice))
    .map((entry) => ({
      ...entry.statement,
      kind: entry.choice as Kind,
      kindConfidence: entry.confidence,
    }));
}

async function verify(
  parts: readonly string[],
  items: readonly Item[],
  asker: JevAsker,
  options: ReviewOptions,
): Promise<Map<string, Score>> {
  const scores = new Map<string, Score>(
    items.map((item) => [item.id, { covered: 0, contradicted: 0 }]),
  );
  if (items.length === 0) return scores;
  const cost = (item: Item): number =>
    tokensOf(turnsFor([item], VERIFY_CONTEXT_CHARS)) + tokensOf(verifyQuestions(item));
  await Promise.all(
    parts.flatMap((part, index) => {
      const base = {
        context: VERIFY_CONTEXT,
        plan: part,
        ...(parts.length > 1 ? { plan_part: `${index + 1} of ${parts.length}` } : {}),
      };
      const budget = options.maxRequestTokens - tokensOf(base) - REQUEST_OVERHEAD_TOKENS;
      return pack(items, cost, budget).map(async (batch) => {
        const questions: JevQuestions = Object.assign({}, ...batch.map(verifyQuestions));
        const { answers } = await asker.ask(
          { ...base, turns: turnsFor(batch, VERIFY_CONTEXT_CHARS) },
          questions,
        );
        for (const item of batch) {
          const score = scores.get(item.id);
          if (!score) continue;
          score.covered = Math.max(score.covered, noulAnswer(answers, `covered_${item.id}`));
          score.contradicted = Math.max(
            score.contradicted,
            noulAnswer(answers, `contradicted_${item.id}`),
          );
        }
      });
    }),
  );
  return scores;
}

export function decide(item: Item, score: Score, minConfidence: number): Verdict {
  const contradicted = score.contradicted >= 0.5;
  const reflected = !contradicted && score.covered >= 0.5;
  const status: Status = contradicted ? 'contradicted' : reflected ? 'reflected' : 'missing';
  const confidence = contradicted ? score.contradicted : reflected ? score.covered : 1 - score.covered;
  const conclusive = confidence >= minConfidence;
  return {
    ...item,
    ...score,
    status,
    confidence,
    conclusive,
    actionable: conclusive && status !== 'reflected',
  };
}

export async function review(
  plan: string,
  statements: readonly Statement[],
  asker: JevAsker,
  options: Partial<ReviewOptions> = {},
): Promise<ReviewResult> {
  const resolved = { ...DEFAULT_REVIEW_OPTIONS, ...options };
  let requests = 0;
  const counted: JevAsker = {
    ask(state, questions) {
      requests += 1;
      return asker.ask(state, questions);
    },
  };
  const items = await classify(statements, counted, resolved);
  const parts = splitPlan(plan, resolved.maxPlanTokens);
  const scores = await verify(parts, items, counted, resolved);
  const verdicts = items.map((item) =>
    decide(item, scores.get(item.id) ?? { covered: 0, contradicted: 0 }, resolved.minConfidence),
  );
  return {
    verdicts,
    statements: statements.length,
    ignored: statements.length - items.length,
    requests,
    planParts: parts.length,
  };
}
