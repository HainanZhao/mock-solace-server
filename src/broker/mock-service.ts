/**
 * Broker-side mock services: virtual responders for request/reply stubbing,
 * broker-originated publishing, and replayable scenarios. No real client
 * session is involved — responders live inside the broker and participate in
 * topic routing as ordinary subscribers.
 */
const randomUUID = (): string => globalThis.crypto.randomUUID();
import { buildOutboundMessage, extractMessageMeta } from '../smf/messages/binary-meta.js';
import { decodeSmf } from '../smf/codec.js';
import { DirectMessage } from '../smf/messages/trmsg.js';
import { fromUtf8 } from '../util/bytes.js';
import { Broker } from './broker.js';
import { Subscriber } from './vpn.js';

export type Payload = string | Uint8Array | object;

export function toPayloadBytes(payload: Payload): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === 'string') return fromUtf8(payload);
  return fromUtf8(JSON.stringify(payload));
}

export interface ServiceRequest {
  topic: string;
  payload: Uint8Array;
  /** Set when the publisher used session.sendRequest(). */
  correlationId?: string;
  replyToTopic?: string;
  vpnName: string;
}

export type ResponderHandler = (
  request: ServiceRequest,
) => Payload | null | undefined | Promise<Payload | null | undefined>;

export interface ResponderOptions {
  vpnName?: string;
  /** Name shown as the publisher of replies. Default 'mock-service'. */
  serviceName?: string;
}

/** A virtual broker-side service bound to a topic subscription. */
export class Responder implements Subscriber {
  readonly subscriberId = `responder:${randomUUID()}`;
  /** Every request this responder received, for assertions. */
  readonly requests: ServiceRequest[] = [];

  constructor(
    private readonly broker: Broker,
    readonly subscription: string,
    readonly vpnName: string,
    private readonly serviceName: string,
    private readonly handler: ResponderHandler,
  ) {}

  deliver(message: DirectMessage): boolean {
    const meta = extractMessageMeta(decodeSmf(message.raw));
    const request: ServiceRequest = {
      topic: message.topic,
      payload: meta.attachment,
      correlationId: meta.correlationId,
      replyToTopic: meta.replyToTopic,
      vpnName: this.vpnName,
    };
    this.requests.push(request);
    Promise.resolve(this.handler(request)).then(
      (reply) => {
        if (reply === null || reply === undefined) return;
        if (!request.replyToTopic) return; // fire-and-forget publish, no reply path
        const frame = buildOutboundMessage(request.replyToTopic, toPayloadBytes(reply), {
          isReply: true,
          correlationId: request.correlationId,
        });
        this.broker.injectMessage(this.vpnName, frame, this.serviceName);
      },
      () => {
        // Handler threw: swallow — a missing reply surfaces as a client-side
        // request timeout, which is the realistic failure mode.
      },
    );
    return true;
  }

  /** Unsubscribes this responder from the broker. */
  remove(): void {
    this.broker.getVpn(this.vpnName)?.trie.removeAll(this);
  }
}

export type ScenarioStep =
  | { kind: 'publish'; topic: string; payload: Uint8Array; vpnName?: string }
  | { kind: 'wait'; ms: number };

/** Fluent builder passed to `server.scenario(name, build)`. */
export class ScenarioBuilder {
  readonly steps: ScenarioStep[] = [];

  publish(topic: string, payload: Payload, opts: { vpnName?: string } = {}): this {
    this.steps.push({
      kind: 'publish',
      topic,
      payload: toPayloadBytes(payload),
      vpnName: opts.vpnName,
    });
    return this;
  }

  wait(ms: number): this {
    this.steps.push({ kind: 'wait', ms });
    return this;
  }
}

export class MockServices {
  private readonly scenarios = new Map<string, ScenarioStep[]>();

  constructor(private readonly broker: Broker) {}

  publish(topic: string, payload: Payload, opts: { vpnName?: string } = {}): void {
    const vpnName = opts.vpnName ?? 'default';
    this.broker.getOrCreateVpn(vpnName);
    const frame = buildOutboundMessage(topic, toPayloadBytes(payload));
    this.broker.injectMessage(vpnName, frame, 'mock-service');
  }

  respondTo(
    subscription: string,
    handler: ResponderHandler | Payload,
    opts: ResponderOptions = {},
  ): Responder {
    const vpnName = opts.vpnName ?? 'default';
    const fn: ResponderHandler =
      typeof handler === 'function' ? (handler as ResponderHandler) : () => handler;
    const responder = new Responder(
      this.broker,
      subscription,
      vpnName,
      opts.serviceName ?? 'mock-service',
      fn,
    );
    this.broker.getOrCreateVpn(vpnName).trie.add(subscription, responder);
    return responder;
  }

  defineScenario(name: string, build: (s: ScenarioBuilder) => void): void {
    const builder = new ScenarioBuilder();
    build(builder);
    this.scenarios.set(name, builder.steps);
  }

  async play(name: string): Promise<void> {
    const steps = this.scenarios.get(name);
    if (!steps) {
      throw new Error(
        `unknown scenario '${name}' — define it first with server.scenario('${name}', ...)`,
      );
    }
    for (const step of steps) {
      if (step.kind === 'wait') {
        await new Promise((r) => setTimeout(r, step.ms));
      } else {
        const vpnName = step.vpnName ?? 'default';
        this.broker.getOrCreateVpn(vpnName);
        const frame = buildOutboundMessage(step.topic, step.payload);
        this.broker.injectMessage(vpnName, frame, 'mock-service');
      }
    }
  }
}
