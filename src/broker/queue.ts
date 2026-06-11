import { DirectMessage } from '../smf/messages/trmsg.js';
import type { Subscriber } from './vpn.js';

export interface StoredMessage {
  /** Monotonic id; doubles as the AD message id once flows deliver it. */
  msgId: number;
  topic: string;
  /** The original publisher frame. */
  raw: Buffer;
  payload: Buffer;
  spooledAt: number;
  redelivered: boolean;
}

export interface QueueProperties {
  accessType: 'exclusive' | 'non-exclusive';
  ingressEnabled: boolean;
  egressEnabled: boolean;
  maxMsgSpoolUsageMb: number;
  permission: string;
}

export const defaultQueueProperties: QueueProperties = {
  accessType: 'exclusive',
  ingressEnabled: true,
  egressEnabled: true,
  maxMsgSpoolUsageMb: 1500,
  permission: 'consume',
};

let nextMsgId = 1;

/**
 * A durable queue. It participates in topic routing as an ordinary
 * Subscriber: matched direct messages are spooled. Flow delivery (guaranteed
 * messaging consumers) drains `messages` in order.
 */
export class Queue implements Subscriber {
  readonly messages: StoredMessage[] = [];
  readonly topicSubscriptions = new Set<string>();
  properties: QueueProperties;
  /** Set by the AD layer when a consumer flow is bound (M6). */
  onSpooled: (() => void) | undefined;

  constructor(
    readonly name: string,
    readonly vpnName: string,
    props: Partial<QueueProperties> = {},
  ) {
    this.properties = { ...defaultQueueProperties, ...props };
  }

  get subscriberId(): string {
    return `queue:${this.vpnName}/${this.name}`;
  }

  deliver(message: DirectMessage): boolean {
    if (!this.properties.ingressEnabled) return false;
    this.spool(message.topic, message.raw, message.payload);
    return true;
  }

  spool(topic: string, raw: Buffer, payload: Buffer): StoredMessage {
    const stored: StoredMessage = {
      msgId: nextMsgId++,
      topic,
      raw,
      payload,
      spooledAt: Date.now(),
      redelivered: false,
    };
    this.messages.push(stored);
    this.onSpooled?.();
    return stored;
  }

  /** Removes a message by AD message id (consumer ack). */
  ack(msgId: number): boolean {
    const idx = this.messages.findIndex((m) => m.msgId === msgId);
    if (idx === -1) return false;
    this.messages.splice(idx, 1);
    return true;
  }
}
