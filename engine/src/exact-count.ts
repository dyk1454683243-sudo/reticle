import type { EvalResult } from './question/predicate/predicate-eval-kit.js';

/**
 * Exact cardinality, once, for every channel that can count its matches.
 *
 * `net` and `signal` are the same assertion over different evidence — "this happened EXACTLY n
 * times" — and the interesting half is the same on both: an over-count is `decided`, because a
 * window only accumulates and a count cannot come back down, so waiting out the rest of the budget
 * to report a double-fire buys nothing but latency.
 *
 * `noun` names the population in prose ("network call(s)", "signal(s)"), `filter` is the matcher as
 * applied, and `assertion` is the oracle that judged it.
 */
export function evalExactCount(args: {
  matched: number;
  want: number;
  noun: string;
  filter: string;
  assertion: string;
}): EvalResult {
  const { matched, want, noun, filter, assertion } = args;
  if (matched === want) {
    return { pass: true, evidence: { matched } };
  }
  return {
    pass: false,
    ...(matched > want ? { decided: true } : {}),
    failureReason: `expected ${String(want)} ${noun} matching ${filter}, saw ${String(matched)}`,
    observed: `${String(matched)} matching ${noun}`,
    expected: `exactly ${String(want)} matching ${filter}`,
    assertion,
  };
}
