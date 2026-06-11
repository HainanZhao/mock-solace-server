import { DirectMessage } from '../smf/messages/trmsg.js';
import { Queue } from './queue.js';
import { TopicTrie } from './topic-matcher.js';

/** Anything that can receive a routed direct message. */
export interface Subscriber {
  /** Returns false if the message was discarded (e.g. backpressure). */
  deliver(message: DirectMessage): boolean;
  readonly subscriberId: string;
}

export class MessageVpn {
  readonly trie = new TopicTrie<Subscriber>();
  readonly queues = new Map<string, Queue>();

  constructor(readonly name: string) {}
}
