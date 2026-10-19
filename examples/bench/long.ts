import type { Expected, Scenario, Turn } from './scenario.js';

const REPORTS = ['billing', 'usage', 'audit', 'inventory', 'payroll', 'sales', 'support', 'traffic', 'error', 'signup'];
const FORMATS = ['CSV', 'JSON', 'XML', 'YAML', 'Parquet', 'HTML', 'Markdown', 'TSV', 'PDF', 'Avro'];
const LIMITS = ['in under one second', 'for up to a year of data', 'with a dry run option', 'with gzip compression', 'with a header row'];
const PER_TURN = 10;

export function longScenario(size: number): Scenario {
  const turns: Turn[] = [];
  const plan: string[] = ['# Report exports', ''];
  const statements: { text: string; verdict: Expected }[] = [];
  for (let index = 0; index < size; index += 1) {
    const report = REPORTS[index % REPORTS.length];
    const format = FORMATS[Math.floor(index / REPORTS.length) % FORMATS.length];
    const limit = LIMITS[Math.floor(index / (REPORTS.length * FORMATS.length)) % LIMITS.length];
    const text = `The ${report} report must export ${format} ${limit}.`;
    const slot = index % 20;
    const verdict: Expected = slot < 16 ? 'reflected' : slot < 19 ? 'missing' : 'contradicted';
    if (verdict === 'reflected') plan.push(`- Add ${format} export to the ${report} report, ${limit}.`);
    if (verdict === 'contradicted') plan.push(`- Leave ${format} export out of the ${report} report entirely.`);
    statements.push({ text, verdict });
    if (index % PER_TURN === 0) turns.push({ user: '' });
    const turn = turns[turns.length - 1] as { user: string };
    turn.user += `${turn.user ? '\n' : ''}- ${text}`;
  }
  return {
    name: `long-${size}`,
    about: `${size} generated export rules: 80% reflected, 15% missing, 5% contradicted`,
    turns,
    plan: plan.join('\n'),
    expect: { statements },
  };
}
