import { choiceAnswer, noulAnswer } from './jev.js';
import { splitText } from './statements.js';
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
    about_tools: 'An instruction or answer about Claude Code, this plugin or the assistant itself, such as their settings, commands or permissions, not about the work being planned',
};
const CHOICES = Object.keys(CRITERIA);
const CLASSIFY_CONTEXT = 'A user and a coding assistant are preparing an implementation plan. `turns` lists, oldest first, what the user said, split into numbered statements. `said_before_by_assistant` is there only to explain what the user was replying to; it is never a statement to classify. `during_command`, when present, names the slash command the user was running when they said it. Each question asks what kind of statement one id is.';
const VERIFY_CONTEXT = 'An implementation plan is being checked against what the user said while it was prepared. `plan` is the plan, or one part of it when `plan_part` is present. `turns` lists statements the user made; `said_before_by_assistant` only explains what the user was replying to. Each question asks whether the plan text shown here reflects, or conflicts with, one statement. Judge only from the plan text shown.';
export const PLAN_KINDS = ['requirement', 'constraint', 'decision', 'assumption'];
const PLAN_CRITERIA = {
    requirement: 'Something the plan says will be built or delivered',
    constraint: 'A limit or rule the plan says the work will respect',
    decision: 'A choice the plan makes between alternatives, such as a tool, library, format, design or scope',
    assumption: 'Something the plan takes as true without showing it',
    routine: 'A mechanical step any competent engineer would take, such as reading code, running tests, building, formatting or committing',
    not_actionable: 'A heading, summary, context or restatement with nothing decided',
};
const PLAN_CHOICES = Object.keys(PLAN_CRITERIA);
const PLAN_CLASSIFY_CONTEXT = 'An implementation plan has been split into numbered items. `plan_items` lists some of them. Each question asks what kind of item one id is.';
const REVERSE_CONTEXT = 'An implementation plan is being checked for things the user never said. `turns` lists statements the user made, or one part of them when `turns_part` is present; `said_before_by_assistant` only explains what the user was replying to. `plan_items` lists items from the plan. Each question asks whether the user asked for or agreed to one plan item.';
const CLASSIFY_CONTEXT_CHARS = [2000, 800, 300, 0];
const VERIFY_CONTEXT_CHARS = 800;
const REQUEST_OVERHEAD_TOKENS = 20;
export const DEFAULT_REVIEW_OPTIONS = {
    minConfidence: 0.8,
    maxRequestTokens: 30_000,
    maxPlanTokens: 16_000,
    reverse: false,
    maxPlanItems: 150,
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
            if (statement.command)
                turn.during_command = statement.command;
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
function judgeKind(answer, kinds, minConfidence) {
    const { choice, confidence, probabilities } = answer;
    const real = kinds.filter((kind) => kind in probabilities);
    const isReal = kinds.includes(choice);
    const summed = Object.keys(probabilities).length > 0
        ? real.reduce((sum, kind) => sum + probabilities[kind], 0)
        : isReal
            ? confidence
            : 1 - confidence;
    // Rounded so that a sum such as 0.7 + 0.1 still meets a threshold of 0.8.
    const chance = Math.min(1, Math.round(summed * 1e6) / 1e6);
    if (chance < 0.5)
        return undefined;
    const kind = isReal ? choice : [...real].sort((a, b) => probabilities[b] - probabilities[a])[0];
    if (chance < minConfidence || kind === undefined)
        return { unclear: chance };
    return { kind };
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
    for (const { statement, ...answer } of answered.flat()) {
        const judged = judgeKind(answer, KINDS, options.minConfidence);
        if (!judged)
            continue;
        if ('unclear' in judged)
            unclear.push({ ...statement, confidence: judged.unclear });
        else
            items.push({ ...statement, kind: judged.kind });
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
export function planItems(plan, max) {
    const texts = splitText(plan, 3);
    return {
        items: texts.slice(0, max).map((text, index) => ({ id: `p${index + 1}`, text })),
        skipped: Math.max(0, texts.length - max),
    };
}
function planKindQuestion(item) {
    return {
        [`kind_${item.id}`]: {
            type: 'choice',
            instructions: `What kind of item is ${item.id}? Judge it as the plan means it`,
            criteria: PLAN_CRITERIA,
        },
    };
}
function askedQuestion(item) {
    return {
        [`asked_${item.id}`]: {
            type: 'noul',
            instructions: `The user asked for, agreed to, or stated plan item ${item.id}. A choice the plan made on its own, however sensible, does not count`,
        },
    };
}
async function checkPlan(plan, statements, asker, options) {
    const { items: all, skipped } = planItems(plan, options.maxPlanItems);
    const classifyBudget = options.maxRequestTokens - tokensOf({ context: PLAN_CLASSIFY_CONTEXT, plan_items: [] }) - REQUEST_OVERHEAD_TOKENS;
    const answered = await Promise.all(pack(all, (item) => tokensOf(item) + tokensOf(planKindQuestion(item)), classifyBudget).map(async (batch) => {
        const questions = Object.assign({}, ...batch.map(planKindQuestion));
        const { answers } = await asker.ask({ context: PLAN_CLASSIFY_CONTEXT, plan_items: batch }, questions);
        return batch.map((item) => ({ item, ...choiceAnswer(answers, `kind_${item.id}`, PLAN_CHOICES) }));
    }));
    const kinds = new Map();
    const unclear = [];
    for (const { item, ...answer } of answered.flat()) {
        const judged = judgeKind(answer, PLAN_KINDS, options.minConfidence);
        if (!judged)
            continue;
        if ('unclear' in judged)
            unclear.push({ ...item, confidence: judged.unclear });
        else
            kinds.set(item.id, judged.kind);
    }
    const checked = all.filter((item) => kinds.has(item.id));
    const asked = new Map(checked.map((item) => [item.id, 0]));
    if (checked.length > 0 && statements.length > 0) {
        const parts = pack(statements, (s) => tokensOf(turnsFor([s], VERIFY_CONTEXT_CHARS)), options.maxPlanTokens);
        await Promise.all(parts.flatMap((part, index) => {
            const base = {
                context: REVERSE_CONTEXT,
                turns: turnsFor(part, VERIFY_CONTEXT_CHARS),
                plan_items: [],
                ...(parts.length > 1 ? { turns_part: `${index + 1} of ${parts.length}` } : {}),
            };
            const budget = options.maxRequestTokens - tokensOf(base) - REQUEST_OVERHEAD_TOKENS;
            return pack(checked, (item) => tokensOf(item) + tokensOf(askedQuestion(item)), budget).map(async (batch) => {
                const questions = Object.assign({}, ...batch.map(askedQuestion));
                const { answers } = await asker.ask({ ...base, plan_items: batch }, questions);
                for (const item of batch) {
                    asked.set(item.id, Math.max(asked.get(item.id) ?? 0, noulAnswer(answers, `asked_${item.id}`)));
                }
            });
        }));
    }
    const items = checked.flatMap((item) => {
        const score = asked.get(item.id) ?? 0;
        if (score >= 0.5)
            return [];
        const confidence = 1 - score;
        return [
            { ...item, kind: kinds.get(item.id), asked: score, confidence, conclusive: confidence >= options.minConfidence },
        ];
    });
    return { items, unclear, checked: checked.length, overLimit: skipped };
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
    const compared = new Set([...items, ...unclear].map((statement) => statement.id));
    let fromPlan;
    let reverseError;
    if (resolved.reverse) {
        try {
            fromPlan = await checkPlan(plan, statements.filter((statement) => compared.has(statement.id)), counted, resolved);
        }
        catch (error) {
            reverseError = error instanceof Error ? error.message : String(error);
        }
    }
    return {
        verdicts,
        unclear,
        statements: statements.length,
        ignored: statements.length - items.length - unclear.length,
        requests,
        planParts: parts.length,
        usage,
        elapsedMs: Date.now() - started,
        ...(fromPlan ? { fromPlan } : {}),
        ...(reverseError ? { reverseError } : {}),
    };
}
