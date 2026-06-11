import { MockSolaceServerOptions } from './config.js';
import { SempRouter } from './semp/semp-router.js';
import { ServerAddresses, SolaceServerCore } from './server-core.js';
import { registerInMemoryHttpEndpoint } from './transport/in-memory-fetch.js';
import { registerInMemoryWsEndpoint } from './transport/in-memory-ws.js';

let instanceCounter = 0;

/**
 * Mock Solace broker with no sockets: start() patches globalThis.WebSocket
 * (and fetch, for SEMP) so unmodified solclientjs connects in-process. Works
 * in browsers and in Node.
 *
 * The returned URLs use a synthetic `.invalid` host — nothing listens there;
 * the interceptor recognizes the origin and routes in-memory. Ports are
 * therefore nominal.
 *
 * IMPORTANT (browser): call start() before importing solclientjs — its
 * browser build captures the WebSocket constructor at module-evaluation
 * time. With dynamic import: `await server.start(); const solace = await
 * import('solclientjs');`
 */
export class InMemorySolaceServer extends SolaceServerCore {
  private readonly instanceId = ++instanceCounter;
  private addresses: ServerAddresses | undefined;
  private unregisterWs: (() => void) | undefined;
  private unregisterHttp: (() => void) | undefined;

  constructor(opts: MockSolaceServerOptions = {}) {
    super(opts);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<ServerAddresses> {
    if (this.addresses) return this.addresses;
    const host = `mock-solace-${this.instanceId}.invalid`;
    const addresses: ServerAddresses = {
      smfWsPort: 55555,
      smfWsUrl: `ws://${host}:55555`,
    };
    this.unregisterWs = registerInMemoryWsEndpoint(addresses.smfWsUrl, (conn) =>
      this.broker.acceptConnection(conn),
    );
    if (this.options.sempPort !== false) {
      const router = new SempRouter(this.broker);
      addresses.sempPort = 8080;
      addresses.sempUrl = `http://${host}:8080`;
      this.unregisterHttp = registerInMemoryHttpEndpoint(addresses.sempUrl, (m, p, b) =>
        router.handle(m, p, b),
      );
    }
    this.addresses = addresses;
    return addresses;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(): Promise<void> {
    this.broker.closeAllSessions();
    this.unregisterWs?.();
    this.unregisterHttp?.();
    this.unregisterWs = undefined;
    this.unregisterHttp = undefined;
    this.addresses = undefined;
  }
}
