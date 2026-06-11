import { CapturedMessage, ClientInfo, ServerEventEmitter } from './api/events.js';
import { Broker } from './broker/broker.js';
import {
  MockServices,
  Payload,
  Responder,
  ResponderHandler,
  ResponderOptions,
  ScenarioBuilder,
} from './broker/mock-service.js';
import { Queue, QueueProperties } from './broker/queue.js';
import { MockSolaceServerOptions, resolveOptions, ResolvedOptions } from './config.js';

export interface ServerAddresses {
  /** SMF-over-WebSocket port; connect solclientjs with `ws://host:port`. */
  smfWsPort: number;
  smfWsUrl: string;
  /** SEMP v2 port, or undefined when SEMP is disabled. */
  sempPort?: number;
  sempUrl?: string;
}

/**
 * Transport-agnostic mock broker: holds the Broker state machine plus the
 * test-facing API (queues, broker-side publishes, mock services, scenarios,
 * captured messages). Subclasses attach a transport: MockSolaceServer binds
 * real sockets in Node; InMemorySolaceServer intercepts WebSocket/fetch for
 * browsers.
 */
export abstract class SolaceServerCore extends ServerEventEmitter {
  readonly options: ResolvedOptions;
  protected readonly broker: Broker;
  protected readonly services: MockServices;

  constructor(opts: MockSolaceServerOptions = {}) {
    super();
    this.options = resolveOptions(opts);
    this.broker = new Broker(this.options, this);
    this.services = new MockServices(this.broker);
  }

  abstract start(): Promise<ServerAddresses>;
  abstract stop(): Promise<void>;

  /** Currently connected clients. */
  clients(): ClientInfo[] {
    return [...this.broker.sessions].map((s) => s.info());
  }

  /** Messages published through the broker (newest last). */
  capturedMessages(): CapturedMessage[] {
    return this.broker.capturedMessages();
  }

  clearCapturedMessages(): void {
    this.broker.clearCapturedMessages();
  }

  /** Creates a queue, optionally subscribed to topics. */
  createQueue(
    queueName: string,
    opts: Partial<QueueProperties> & { vpnName?: string; topics?: string[] } = {},
  ): Queue {
    const { vpnName = 'default', topics = [], ...props } = opts;
    const queue = this.broker.createQueue(vpnName, queueName, props);
    for (const topic of topics) this.broker.addQueueSubscription(vpnName, queueName, topic);
    return queue;
  }

  deleteQueue(queueName: string, vpnName = 'default'): boolean {
    return this.broker.deleteQueue(vpnName, queueName);
  }

  getQueue(queueName: string, vpnName = 'default'): Queue | undefined {
    return this.broker.getQueue(vpnName, queueName);
  }

  /** Publishes a broker-originated direct message (mock service publish). */
  publish(topic: string, payload: Payload, opts: { vpnName?: string } = {}): void {
    this.services.publish(topic, payload, opts);
  }

  /**
   * Registers a broker-side mock service answering request/reply on topics
   * matching `subscription` (wildcards allowed). The handler may return a
   * payload (string/bytes/object) or a static payload may be given directly;
   * return null/undefined to not reply. Replies carry the requester's
   * correlationId so `session.sendRequest()` callbacks fire.
   */
  respondTo(
    subscription: string,
    handler: ResponderHandler | Payload,
    opts: ResponderOptions = {},
  ): Responder {
    return this.services.respondTo(subscription, handler, opts);
  }

  /** Defines a named, replayable message scenario. */
  scenario(name: string, build: (s: ScenarioBuilder) => void): void {
    this.services.defineScenario(name, build);
  }

  /** Replays a scenario defined with `scenario()`. */
  play(name: string): Promise<void> {
    return this.services.play(name);
  }

  /**
   * Resolves with the first captured message matching `predicate` (or any
   * message if omitted), including messages already captured.
   */
  waitForMessage(
    predicate?: (msg: CapturedMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<CapturedMessage> {
    const existing = this.broker.capturedMessages().find((m) => !predicate || predicate(m));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const onMessage = (msg: CapturedMessage): void => {
        if (predicate && !predicate(msg)) return;
        cleanup();
        resolve(msg);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for message'));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('messagePublished', onMessage);
      };
      this.on('messagePublished', onMessage);
    });
  }
}
