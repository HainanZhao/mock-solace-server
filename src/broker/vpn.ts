import { TopicTrie } from './topic-matcher.js';

/** Anything that can receive a routed direct message frame. */
export interface Subscriber {
  /** Returns false if the message was discarded (e.g. backpressure). */
  deliver(frame: Buffer, topic: string): boolean;
  readonly subscriberId: string;
}

export class MessageVpn {
  readonly trie = new TopicTrie<Subscriber>();

  constructor(readonly name: string) {}
}
