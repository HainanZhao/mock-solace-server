import { CapturedMessage, ClientInfo, ServerEventEmitter } from './api/events.js';
import { Broker } from './broker/broker.js';
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
  private readonly wsTransport: WsTransport;
  private semp: SempServer | undefined;
  private addresses: ServerAddresses | undefined;

  constructor(opts: MockSolaceServerOptions = {}) {
    super();
    this.options = resolveOptions(opts);
    this.broker = new Broker(this.options, this);
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
