/**
 * Topic trie implementing Solace subscription wildcard semantics:
 * - '/' separates levels
 * - '*' as a whole level matches exactly one level
 * - 'abc*' (trailing '*' within a level) matches one level with prefix 'abc'
 * - '>' as the entire final level matches one or more remaining levels
 * See docs/protocol-notes.md §9.
 */

class TrieNode<S> {
  exact = new Map<string, TrieNode<S>>();
  /** Prefix-wildcard children; bare '*' is stored under key ''. */
  prefixes = new Map<string, TrieNode<S>>();
  endHere = new Set<S>();
  gtHere = new Set<S>();

  isEmpty(): boolean {
    return (
      this.exact.size === 0 &&
      this.prefixes.size === 0 &&
      this.endHere.size === 0 &&
      this.gtHere.size === 0
    );
  }
}

export class InvalidSubscriptionError extends Error {}

function splitLevels(topic: string): string[] {
  return topic.split('/');
}

/**
 * Validates a subscription per broker rules: '>' only as the entire final
 * level; '*' only at the end of a level. Empty levels are rejected (except
 * that real brokers also reject these).
 */
export function validateSubscription(sub: string): void {
  if (sub.length === 0) throw new InvalidSubscriptionError('empty subscription');
  const levels = splitLevels(sub);
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    if (level.length === 0) throw new InvalidSubscriptionError(`empty level in "${sub}"`);
    if (level === '>') {
      if (i !== levels.length - 1) {
        throw new InvalidSubscriptionError(`'>' must be the final level in "${sub}"`);
      }
      continue;
    }
    const starIdx = level.indexOf('*');
    if (starIdx !== -1 && starIdx !== level.length - 1) {
      throw new InvalidSubscriptionError(`'*' must end a level in "${sub}"`);
    }
    if (level.includes('>')) {
      throw new InvalidSubscriptionError(`'>' must be alone in a level in "${sub}"`);
    }
  }
}

export class TopicTrie<S> {
  private root = new TrieNode<S>();
  private count = 0;

  /** Number of (subscription, subscriber) entries currently stored. */
  get size(): number {
    return this.count;
  }

  add(subscription: string, subscriber: S): void {
    validateSubscription(subscription);
    const levels = splitLevels(subscription);
    let node = this.root;
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]!;
      if (level === '>' && i === levels.length - 1) {
        if (!node.gtHere.has(subscriber)) {
          node.gtHere.add(subscriber);
          this.count++;
        }
        return;
      }
      if (level.endsWith('*')) {
        const key = level.slice(0, -1);
        let child = node.prefixes.get(key);
        if (!child) {
          child = new TrieNode<S>();
          node.prefixes.set(key, child);
        }
        node = child;
      } else {
        let child = node.exact.get(level);
        if (!child) {
          child = new TrieNode<S>();
          node.exact.set(level, child);
        }
        node = child;
      }
    }
    if (!node.endHere.has(subscriber)) {
      node.endHere.add(subscriber);
      this.count++;
    }
  }

  /** Removes one subscription entry. Returns true if it existed. */
  remove(subscription: string, subscriber: S): boolean {
    validateSubscription(subscription);
    const levels = splitLevels(subscription);
    return this.removeWalk(this.root, levels, 0, subscriber);
  }

  private removeWalk(node: TrieNode<S>, levels: string[], i: number, subscriber: S): boolean {
    if (i === levels.length) {
      if (node.endHere.delete(subscriber)) {
        this.count--;
        return true;
      }
      return false;
    }
    const level = levels[i]!;
    if (level === '>' && i === levels.length - 1) {
      if (node.gtHere.delete(subscriber)) {
        this.count--;
        return true;
      }
      return false;
    }
    let map: Map<string, TrieNode<S>>;
    let key: string;
    if (level.endsWith('*')) {
      map = node.prefixes;
      key = level.slice(0, -1);
    } else {
      map = node.exact;
      key = level;
    }
    const child = map.get(key);
    if (!child) return false;
    const removed = this.removeWalk(child, levels, i + 1, subscriber);
    if (removed && child.isEmpty()) map.delete(key);
    return removed;
  }

  /** Removes every subscription entry held by `subscriber`. */
  removeAll(subscriber: S): void {
    const prune = (node: TrieNode<S>): void => {
      if (node.endHere.delete(subscriber)) this.count--;
      if (node.gtHere.delete(subscriber)) this.count--;
      for (const [k, child] of node.exact) {
        prune(child);
        if (child.isEmpty()) node.exact.delete(k);
      }
      for (const [k, child] of node.prefixes) {
        prune(child);
        if (child.isEmpty()) node.prefixes.delete(k);
      }
    };
    prune(this.root);
  }

  /** Returns the distinct subscribers matching a published (literal) topic. */
  match(topic: string): Set<S> {
    const out = new Set<S>();
    const levels = splitLevels(topic);
    this.matchWalk(this.root, levels, 0, out);
    return out;
  }

  private matchWalk(node: TrieNode<S>, levels: string[], i: number, out: Set<S>): void {
    if (i < levels.length) {
      // '>' below this node matches one or more remaining levels.
      for (const s of node.gtHere) out.add(s);
    } else {
      for (const s of node.endHere) out.add(s);
      return;
    }
    const level = levels[i]!;
    const exactChild = node.exact.get(level);
    if (exactChild) this.matchWalk(exactChild, levels, i + 1, out);
    for (const [prefix, child] of node.prefixes) {
      if (level.startsWith(prefix)) this.matchWalk(child, levels, i + 1, out);
    }
  }
}
