const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

// No tokenizer; scaled up because Jev counts about a fifth more tokens than this estimate.
export const TOKEN_SCALE = 1.25;

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens * TOKEN_SCALE);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  const end = tail > 0 ? text.slice(-tail) : '';
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${end}`;
}
