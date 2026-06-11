import { MockSolaceServerOptions } from './config.js';
import { SempServer } from './semp/semp-server.js';
import { ServerAddresses, SolaceServerCore } from './server-core.js';
import { WsTransport } from './transport/ws-transport.js';

export type { ServerAddresses } from './server-core.js';

/** Mock Solace broker bound to real sockets (Node only). */
export class MockSolaceServer extends SolaceServerCore {
  private readonly wsTransport: WsTransport;
  private semp: SempServer | undefined;
  private addresses: ServerAddresses | undefined;

  constructor(opts: MockSolaceServerOptions = {}) {
    super(opts);
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
}
