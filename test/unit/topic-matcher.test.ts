import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  InvalidSubscriptionError,
  TopicTrie,
  validateSubscription,
} from '../../src/broker/topic-matcher.js';

/** Brute-force reference matcher implementing the documented semantics. */
function refMatches(subscription: string, topic: string): boolean {
  const subLevels = subscription.split('/');
  const topicLevels = topic.split('/');
  for (let i = 0; i < subLevels.length; i++) {
    const sub = subLevels[i]!;
    if (sub === '>' && i === subLevels.length - 1) {
      return topicLevels.length > i; // one or more remaining levels
    }
    if (i >= topicLevels.length) return false;
    const level = topicLevels[i]!;
    if (sub.endsWith('*')) {
      if (!level.startsWith(sub.slice(0, -1))) return false;
    } else if (sub !== level) {
      return false;
    }
  }
  return topicLevels.length === subLevels.length;
}

describe('validateSubscription', () => {
  it.each(['a', 'a/b/c', '*', 'a/*/c', 'a/ab*', '>', 'a/>', '#P2P/v:r/x/>'])(
    'accepts %s',
    (sub) => {
      expect(() => validateSubscription(sub)).not.toThrow();
    },
  );

  it.each(['', 'a//b', 'a/', '/a', 'a/>/b', 'a/b>', 'a/*b/c', 'a/>x'])(
    'rejects %s',
    (sub) => {
      expect(() => validateSubscription(sub)).toThrow(InvalidSubscriptionError);
    },
  );
});

describe('TopicTrie semantics', () => {
  function trieOf(...subs: string[]): TopicTrie<string> {
    const trie = new TopicTrie<string>();
    for (const s of subs) trie.add(s, s);
    return trie;
  }

  it('matches exact topics', () => {
    const trie = trieOf('a/b/c');
    expect(trie.match('a/b/c')).toEqual(new Set(['a/b/c']));
    expect(trie.match('a/b')).toEqual(new Set());
    expect(trie.match('a/b/c/d')).toEqual(new Set());
  });

  it("'*' matches exactly one level", () => {
    const trie = trieOf('a/*/c', 'a/*');
    expect(trie.match('a/b/c')).toEqual(new Set(['a/*/c']));
    expect(trie.match('a/x')).toEqual(new Set(['a/*']));
    expect(trie.match('a')).toEqual(new Set());
    expect(trie.match('a/x/y/z')).toEqual(new Set());
  });

  it("'abc*' prefix-matches one level", () => {
    const trie = trieOf('animals/red*/wild');
    expect(trie.match('animals/red/wild')).toEqual(new Set(['animals/red*/wild']));
    expect(trie.match('animals/reddish/wild')).toEqual(new Set(['animals/red*/wild']));
    expect(trie.match('animals/blue/wild')).toEqual(new Set());
  });

  it("trailing '>' matches one or more levels but not the parent", () => {
    const trie = trieOf('animals/domestic/>');
    expect(trie.match('animals/domestic')).toEqual(new Set());
    expect(trie.match('animals/domestic/cats')).toEqual(new Set(['animals/domestic/>']));
    expect(trie.match('animals/domestic/dogs/beagles')).toEqual(
      new Set(['animals/domestic/>']),
    );
  });

  it('bare > matches everything with at least one level', () => {
    const trie = trieOf('>');
    expect(trie.match('a')).toEqual(new Set(['>']));
    expect(trie.match('a/b/c')).toEqual(new Set(['>']));
  });

  it('dedups a subscriber matching via multiple subscriptions', () => {
    const trie = new TopicTrie<string>();
    trie.add('a/>', 'subscriber');
    trie.add('a/*/c', 'subscriber');
    expect(trie.match('a/b/c')).toEqual(new Set(['subscriber']));
  });

  it('remove and removeAll prune correctly', () => {
    const trie = new TopicTrie<string>();
    trie.add('a/b', 's1');
    trie.add('a/b', 's2');
    trie.add('a/>', 's1');
    expect(trie.size).toBe(3);
    expect(trie.remove('a/b', 's1')).toBe(true);
    expect(trie.remove('a/b', 's1')).toBe(false);
    expect(trie.match('a/b')).toEqual(new Set(['s2', 's1']));
    trie.removeAll('s1');
    expect(trie.match('a/b/c')).toEqual(new Set());
    expect(trie.match('a/b')).toEqual(new Set(['s2']));
    expect(trie.size).toBe(1);
  });
});

describe('TopicTrie property tests vs reference matcher', () => {
  const levelArb = fc.stringMatching(/^[a-c]{1,3}$/);
  const subLevelArb = fc.oneof(
    { weight: 4, arbitrary: levelArb },
    { weight: 1, arbitrary: fc.constant('*') },
    { weight: 1, arbitrary: levelArb.map((s) => `${s}*`) },
  );
  const topicArb = fc.array(levelArb, { minLength: 1, maxLength: 5 }).map((l) => l.join('/'));
  const subscriptionArb = fc
    .tuple(
      fc.array(subLevelArb, { minLength: 0, maxLength: 4 }),
      fc.oneof(
        { weight: 1, arbitrary: fc.constant('>') },
        { weight: 2, arbitrary: subLevelArb },
      ),
    )
    .map(([head, last]) => [...head, last].join('/'));

  it('trie.match agrees with the reference for random subscription sets', () => {
    fc.assert(
      fc.property(
        fc.array(subscriptionArb, { minLength: 1, maxLength: 15 }),
        topicArb,
        (subs, topic) => {
          const trie = new TopicTrie<string>();
          for (const s of subs) trie.add(s, s);
          const expected = new Set(subs.filter((s) => refMatches(s, topic)));
          expect(trie.match(topic)).toEqual(expected);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('remove restores prior matching behavior', () => {
    fc.assert(
      fc.property(
        fc.array(subscriptionArb, { minLength: 2, maxLength: 10 }),
        fc.nat(),
        topicArb,
        (subs, removeIdxSeed, topic) => {
          const removeIdx = removeIdxSeed % subs.length;
          const trie = new TopicTrie<string>();
          subs.forEach((s, i) => trie.add(s, `sub-${i}`));
          trie.remove(subs[removeIdx]!, `sub-${removeIdx}`);
          const expected = new Set(
            subs
              .map((s, i) => [s, `sub-${i}`] as const)
              .filter(([s, id]) => id !== `sub-${removeIdx}` && refMatches(s, topic))
              .map(([, id]) => id),
          );
          expect(trie.match(topic)).toEqual(expected);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
