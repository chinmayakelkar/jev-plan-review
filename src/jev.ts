export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export type JevQuestion = NoulQuestion | ChoiceQuestion;
export type JevQuestions = Record<string, JevQuestion>;
export type JevAnswers = Record<string, unknown>;

export interface JevResponse {
  answers: JevAnswers;
}

export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

function answerObject(answers: JevAnswers, name: string): Record<string, unknown> {
  const answer = answers[name];
  if (answer === null || typeof answer !== 'object') {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer as Record<string, unknown>;
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

export function noulAnswer(answers: JevAnswers, name: string): number {
  const { noul } = answerObject(answers, name);
  if (!isProbability(noul)) throw new Error(`Invalid Jev answer for ${name}`);
  return noul;
}

export function choiceAnswer(
  answers: JevAnswers,
  name: string,
  allowed: readonly string[],
): { choice: string; confidence: number } {
  const { choice, confidence, probabilities } = answerObject(answers, name);
  if (typeof choice !== 'string' || !allowed.includes(choice)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  if (isProbability(confidence)) return { choice, confidence };
  const fallback =
    probabilities !== null && typeof probabilities === 'object'
      ? (probabilities as Record<string, unknown>)[choice]
      : undefined;
  if (!isProbability(fallback)) throw new Error(`Invalid Jev answer for ${name}`);
  return { choice, confidence: fallback };
}

export function jevClient(options: JevClientOptions): JevAsker {
  const fetcher = options.fetch ?? fetch;
  return {
    async ask(state, questions) {
      const response = await fetcher(options.baseUrl ?? SYSTEM_ONE_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: options.model ?? DEFAULT_MODEL, state, questions }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    },
  };
}
