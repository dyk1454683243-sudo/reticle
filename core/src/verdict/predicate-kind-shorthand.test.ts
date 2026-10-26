import { describe, expect, it } from 'vitest';
import { PredicateSchema, predicateAliasesUsed } from '../index.js';

/**
 * A predicate with no `kind`, where its keys name exactly one kind.
 *
 * Real agents wrote `expect: { text: "Count is 1" }` and `expect: { allOf: [...] }`. Both were
 * refused, each cost one call, and each agent then wrote the same thing with `kind`. The shorthand
 * now parses to the explicit predicate. Where the keys fit more than one kind, it is refused.
 */
describe('a predicate with no kind', () => {
  const same = (shorthand: unknown, explicit: unknown): void => {
    expect(PredicateSchema.parse(shorthand)).toEqual(PredicateSchema.parse(explicit));
  };

  it('reads `text` as a text predicate', () => {
    same({ text: 'Count is 1' }, { kind: 'text', contains: 'Count is 1' });
    same(
      { text: 'Saved', scope: '#dialog' },
      { kind: 'text', contains: 'Saved', scope: '#dialog' },
    );
  });

  it('reads `allOf`, `anyOf` and `not` as that combinator, and its members the same way', () => {
    same(
      { allOf: [{ text: 'Count is 1' }, { pathname: '/done' }] },
      {
        kind: 'allOf',
        predicates: [
          { kind: 'text', contains: 'Count is 1' },
          { kind: 'route', pathname: '/done' },
        ],
      },
    );
    same(
      { anyOf: [{ text: 'a' }, { quietMs: 200 }] },
      {
        kind: 'anyOf',
        predicates: [
          { kind: 'text', contains: 'a' },
          { kind: 'settled', quietMs: 200 },
        ],
      },
    );
    same(
      { not: { text: 'Error' } },
      { kind: 'not', predicate: { kind: 'text', contains: 'Error' } },
    );
  });

  it('reads keys that only one kind takes as that kind', () => {
    same({ testid: 'receipt' }, { kind: 'element', query: { testid: 'receipt' } });
    same({ urlContains: '/api', status: 200 }, { kind: 'net', urlContains: '/api', status: 200 });
    same(
      { name: 'order:placed', dataMatches: { id: 1 } },
      { kind: 'signal', name: 'order:placed', dataMatches: { id: 1 } },
    );
    same({ pathname: '/done' }, { kind: 'route', pathname: '/done' });
    same(
      { store: 'cart', path: 'items', equals: 1 },
      { kind: 'state', store: 'cart', path: 'items', equals: 1 },
    );
    same({ quietMs: 200 }, { kind: 'settled', quietMs: 200 });
  });

  it('says the kind was inferred', () => {
    expect(predicateAliasesUsed({ allOf: [{ text: 'a' }] })).toEqual([
      '(no kind) → kind: "allOf"',
      'allOf.allOf → predicates',
      '(no kind) → kind: "text"',
      'text.text → contains',
    ]);
  });

  it('refuses keys that fit more than one kind, or none, and names the keys and the kinds', () => {
    for (const written of [
      { name: 'x' },
      { path: 'items' },
      { contains: 'x' },
      { urlContains: '/api' },
      {},
      { text: 'x', role: 'button' },
      { text: 'x', allOf: [] },
      { foo: 1 },
    ]) {
      const got = PredicateSchema.safeParse(written);
      expect(got.success, JSON.stringify(written)).toBe(false);
    }
    const got = PredicateSchema.safeParse({ name: 'x' });
    const said = got.success ? '' : got.error.issues.map((i) => i.message).join('\n');
    expect(said).toMatch(/`name`/);
    expect(said).toMatch(/signal/);
    expect(said).toMatch(/animation/);
  });

  it('leaves an explicit kind as it is', () => {
    expect(PredicateSchema.safeParse({ kind: 'route', text: 'x' }).success).toBe(false);
    expect(predicateAliasesUsed({ kind: 'text', contains: 'a' })).toEqual([]);
  });
});
