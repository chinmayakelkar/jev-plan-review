import { choiceAnswer, noulAnswer } from './jev.js';
import { abridge, estimateTokens, TOKEN_SCALE } from './tokens.js';
export const KINDS = ['requirement', 'constraint', 'decision', 'assumption', 'preference'];
const CRITERIA = {
    requirement: 'Something the user wants built or delivered',
    constraint: 'A limit or rule the work must respect',
    decision: 'A choice the user made between alternatives, including answers to questions',
    assumption: 'Something the user stated as true that the plan should rely on',
    preference: 'A softer wish about style, naming, tooling or approach',
    superseded: 'A later statement by the user reverses or replaces this one. A statement that itself changes an earlier one is not superseded',
    not_actionable: 'A question, thanks, process remark or background with nothing for a plan to reflect',
};
const CHOICES = Object.keys(CRITERIA);
const CLASSIFY_CONTEXT = 'A user and a coding assistant are preparing an implementation plan. `turns` lists, oldest first, what the user said, split into numbered statements. `said_before_by_assistant` is there only to explain what the user was replying to; it is never a statement to classify. Each question asks what kind of statement one id is.';
const VERIFY_CONTEXT = 'An implementation plan is being checked against what the user said while it was prepared. `plan` is the plan, or one part of it when `plan_part` is present. `turns` lists statements the user made; `said_before_by_assistant` only explains what the user was replying to. Each question asks whether the plan text shown here reflects, or conflicts with, one statement. Judge only from the plan text shown.';
const CLASSIFY_CONTEXT_CHARS = [2000, 800, 300, 0];
const VERIFY_CONTEXT_CHARS = 800;
const REQUEST_OVERHEAD_TOKENS = 20;
export const DEFAULT_REVIEW_OPTIONS = {
    minConfidence: 0.8,
    maxRequestTokens: 30_000,
    maxPlanTokens: 16_000,
};
function turnsFor(statements, contextChars) {
    const turns = new Map();
    for (const statement of statements) {
        let turn = turns.get(statement.turn);
        if (!turn) {
            turn = { source: statement.source, statements: [] };
            if (statement.context && contextChars > 0) {
                const head = Math.floor(contextChars / 4);
                turn.said_before_by_assistant = abridge(statement.context, head, contextChars - head);
            }
            if (statement.label)
                turn.from_document = statement.label;
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
export function pack(items, cost, budget) {
    const batches = [];
    let current = [];
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
    if (current.length > 0)
        batches.push(current);
    return batches;
}
export function splitPlan(plan, maxTokens) {
    const parts = [];
    let current = '';
    const flush = () => {
        if (current.trim())
            parts.push(current.trim());
        current = '';
    };
    for (const paragraph of plan.split(/\n{2,}/)) {
        // estimateTokens never exceeds TOKEN_SCALE tokens per character, so a slice
        // of maxTokens / TOKEN_SCALE characters always fits.
        const chars = Math.max(1, Math.floor(maxTokens / TOKEN_SCALE));
        const pieces = estimateTokens(paragraph) > maxTokens
            ? (paragraph.match(new RegExp(`[\\s\\S]{1,${chars}}`, 'g')) ?? [])
            : [paragraph];
        for (const piece of pieces) {
            const joined = current ? `${current}\n\n${piece}` : piece;
            if (current && estimateTokens(joined) > maxTokens) {
                flush();
                current = piece;
            }
            else
                current = joined;
        }
    }
    flush();
    return parts;
}
function classifyQuestion(statement) {
    return {
        [`kind_${statement.id}`]: {
            type: 'choice',
            instructions: `What kind of statement is ${statement.id}? Judge it as the user meant it`,
            criteria: CRITERIA,
        },
    };
}
function verifyQuestions(item) {
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
function tokensOf(value) {
    return estimateTokens(JSON.stringify(value));
}
function isKind(choice) {
    return KINDS.includes(choice);
}
async function classify(statements, asker, options) {
    if (statements.length === 0)
        return { items: [], unclear: [] };
    const limit = Math.floor(options.maxRequestTokens * 0.8);
    let state = {};
    let stateTokens = Infinity;
    for (const chars of CLASSIFY_CONTEXT_CHARS) {
        state = { context: CLASSIFY_CONTEXT, turns: turnsFor(statements, chars) };
        stateTokens = tokensOf(state);
        if (stateTokens <= limit)
            break;
    }
    if (stateTokens > limit) {
        throw new Error(`the conversation is too long to check (~${stateTokens} tokens)`);
    }
    const batches = pack(statements, (statement) => tokensOf(classifyQuestion(statement)), options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS);
    const answered = await Promise.all(batches.map(async (batch) => {
        const questions = Object.assign({}, ...batch.map(classifyQuestion));
        const { answers } = await asker.ask(state, questions);
        return batch.map((statement) => ({
            statement,
            ...choiceAnswer(answers, `kind_${statement.id}`, CHOICES),
        }));
    }));
    const items = [];
    const unclear = [];
    for (const { statement, choice, confidence, probabilities } of answered.flat()) {
        const real = KINDS.filter((kind) => kind in probabilities);
        const summed = Object.keys(probabilities).length > 0
            ? real.reduce((sum, kind) => sum + probabilities[kind], 0)
            : isKind(choice)
                ? confidence
                : 1 - confidence;
        // Rounded so that a sum such as 0.7 + 0.1 still meets a threshold of 0.8.
        const chance = Math.min(1, Math.round(summed * 1e6) / 1e6);
        if (chance < 0.5)
            continue;
        const kind = isKind(choice)
            ? choice
            : [...real].sort((a, b) => probabilities[b] - probabilities[a])[0];
        if (chance < options.minConfidence || kind === undefined) {
            unclear.push({ ...statement, confidence: chance });
            continue;
        }
        items.push({ ...statement, kind });
    }
    return { items, unclear };
}
async function verify(parts, items, asker, options) {
    const scores = new Map(items.map((item) => [item.id, { covered: 0, contradicted: 0 }]));
    if (items.length === 0)
        return scores;
    const cost = (item) => tokensOf(turnsFor([item], VERIFY_CONTEXT_CHARS)) + tokensOf(verifyQuestions(item));
    await Promise.all(parts.flatMap((part, index) => {
        const base = {
            context: VERIFY_CONTEXT,
            plan: part,
            ...(parts.length > 1 ? { plan_part: `${index + 1} of ${parts.length}` } : {}),
        };
        const budget = options.maxRequestTokens - tokensOf(base) - REQUEST_OVERHEAD_TOKENS;
        return pack(items, cost, budget).map(async (batch) => {
            const questions = Object.assign({}, ...batch.map(verifyQuestions));
            const { answers } = await asker.ask({ ...base, turns: turnsFor(batch, VERIFY_CONTEXT_CHARS) }, questions);
            for (const item of batch) {
                const score = scores.get(item.id);
                if (!score)
                    continue;
                score.covered = Math.max(score.covered, noulAnswer(answers, `covered_${item.id}`));
                score.contradicted = Math.max(score.contradicted, noulAnswer(answers, `contradicted_${item.id}`));
            }
        });
    }));
    return scores;
}
export function decide(item, score, minConfidence) {
    const contradicted = score.contradicted >= 0.5;
    const reflected = !contradicted && score.covered >= 0.5;
    const status = contradicted ? 'contradicted' : reflected ? 'reflected' : 'missing';
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
export async function review(plan, statements, asker, options = {}) {
    const resolved = { ...DEFAULT_REVIEW_OPTIONS, ...options };
    const started = Date.now();
    let requests = 0;
    const usage = { inputTokens: 0, outputTokens: 0 };
    const count = (value) => (typeof value === 'number' && value >= 0 ? value : 0);
    const counted = {
        async ask(state, questions) {
            requests += 1;
            const response = await asker.ask(state, questions);
            usage.inputTokens += count(response.usage?.input_tokens);
            usage.outputTokens += count(response.usage?.output_tokens);
            return response;
        },
    };
    const { items, unclear } = await classify(statements, counted, resolved);
    const parts = splitPlan(plan, resolved.maxPlanTokens);
    const scores = await verify(parts, items, counted, resolved);
    const verdicts = items.map((item) => decide(item, scores.get(item.id) ?? { covered: 0, contradicted: 0 }, resolved.minConfidence));
    return {
        verdicts,
        unclear,
        statements: statements.length,
        ignored: statements.length - items.length - unclear.length,
        requests,
        planParts: parts.length,
        usage,
        elapsedMs: Date.now() - started,
    };
}
