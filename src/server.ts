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
import { SempServer } from './semp/semp-server.js';
import { WsTransport } from './transport/ws-transport.js';

export interface ServerAddresses {
  /** SMF-over-WebSocket port; connect solclientjs with `ws://host:port`. */
  smfWsPort: number;
  smfWsUrl: string;
  /** SEMP v2 port, or undefined when SEMP is disabled. */
  sempPort?: number;
  sempUrl?: string;
}

export class MockSolaceServer extends ServerEventEmitter {
  readonly options: ResolvedOptions;
  private readonly broker: Broker;
  private readonly services: MockServices;
  private readonly wsTransport: WsTransport;
  private semp: SempServer | undefined;
  private addresses: ServerAddresses | undefined;

  constructor(opts: MockSolaceServerOptions = {}) {
    super();
    this.options = resolveOptions(opts);
    this.broker = new Broker(this.options, this);
    this.services = new MockServices(this.broker);
    this.wsTransport = new WsTransport((conn) => this.broker.acceptConnection(conn));
  }

  async start(): Promise<ServerAddresses> {
    if (this.addresses) return this.addresses;
    const { host } = this.options;
    const smfWsPort = await this.wsTransport.listen(host, this.options.smfWsPort);
    const addresses: ServerAddresses = {
      smfWsPort,
      smfWsUrl: `ws://${host}:${smfWsPort}`,
    };
    if (this.options.sempPort !== false) {
      this.semp = new SempServer(this.broker);
      addresses.sempPort = await this.semp.listen(host, this.options.sempPort);
      addresses.sempUrl = `http://${host}:${addresses.sempPort}`;
    }
    this.addresses = addresses;
    return addresses;
  }

  async stop(): Promise<void> {
    this.broker.closeAllSessions();
    await this.wsTransport.close();
    await this.semp?.close();
    this.addresses = undefined;
  }

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
   * payload (string/Buffer/object) or a static payload may be given directly;
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
