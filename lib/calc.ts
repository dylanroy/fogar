/** Deterministic arithmetic for the ask bar. Small language models cannot do 18% of 240; a parser can. */
export interface CalcResult { expression: string; value: number; display: string }

const FILLER = /^(what\s+is|what's|whats|calculate|compute|how\s+much\s+is|solve|eval(uate)?|=)\s*/i;

export function tryCalculate(input: string): CalcResult | null {
  let text = input.trim().replace(FILLER, '').replace(/[?=]+\s*$/, '').trim();
  if (!text || !/\d/.test(text)) return null;
  // "18% of 240", "18 percent of 240"
  const pct = text.match(/^([\d.,]+)\s*(%|percent)\s+of\s+([\d.,]+)$/i);
  if (pct) {
    const a = num(pct[1]!); const b = num(pct[3]!);
    if (a === null || b === null) return null;
    return finish(`${pct[1]}% of ${pct[3]}`, (a / 100) * b);
  }
  // "240 plus 15% tip" style is out of scope; plain expressions only
  text = text.replace(/×|x(?=\s*\d)|(?<=\d\s*)x/gi, '*').replace(/÷/g, '/').replace(/\^/g, '**').replace(/,/g, '');
  if (!/^[\d\s+\-*/%().]+$/.test(text) || !/[+\-*/%]|\*\*/.test(text.replace(/^-/, ''))) return null;
  try {
    const value = evaluate(text);
    if (!Number.isFinite(value)) return null;
    return finish(input.trim().replace(FILLER, '').replace(/[?=]+\s*$/, '').trim(), value);
  } catch {
    return null;
  }
}

function num(s: string): number | null { const n = Number(s.replace(/,/g, '')); return Number.isFinite(n) ? n : null; }

function finish(expression: string, value: number): CalcResult {
  const rounded = Math.abs(value) >= 1e15 ? value : Number(value.toPrecision(12));
  const display = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(rounded);
  return { expression, value: rounded, display };
}

// Tiny recursive-descent evaluator: + - * / % ** parentheses, unary minus. No eval, no Function.
function evaluate(src: string): number {
  let i = 0;
  const peek = () => src[i];
  const skip = () => { while (src[i] === ' ') i++; };
  const parseNumber = (): number => {
    skip();
    const m = src.slice(i).match(/^\d*\.?\d+/);
    if (!m) throw new Error('number expected');
    i += m[0].length; return Number(m[0]);
  };
  const parsePrimary = (): number => {
    skip();
    if (peek() === '(') { i++; const v = parseExpr(); skip(); if (src[i] !== ')') throw new Error(') expected'); i++; return v; }
    if (peek() === '-') { i++; return -parsePrimary(); }
    if (peek() === '+') { i++; return parsePrimary(); }
    return parseNumber();
  };
  const parsePower = (): number => {
    const base = parsePrimary(); skip();
    if (src.startsWith('**', i)) { i += 2; return Math.pow(base, parsePower()); }
    return base;
  };
  const parseTerm = (): number => {
    let v = parsePower();
    for (;;) {
      skip(); const c = peek();
      if (c === '*' && !src.startsWith('**', i)) { i++; v *= parsePower(); }
      else if (c === '/') { i++; v /= parsePower(); }
      else if (c === '%') { i++; v %= parsePower(); }
      else return v;
    }
  };
  const parseExpr = (): number => {
    let v = parseTerm();
    for (;;) {
      skip(); const c = peek();
      if (c === '+') { i++; v += parseTerm(); }
      else if (c === '-') { i++; v -= parseTerm(); }
      else return v;
    }
  };
  const v = parseExpr(); skip();
  if (i < src.length) throw new Error('trailing input');
  return v;
}
