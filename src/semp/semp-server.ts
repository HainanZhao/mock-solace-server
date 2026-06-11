import { createServer, IncomingMessage, Server } from 'node:http';
import { Broker } from '../broker/broker.js';
import { SempRouter } from './semp-router.js';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Serves the runtime-neutral SempRouter over node:http. */
export class SempServer {
  private readonly router: SempRouter;
  private http: Server | undefined;

  constructor(broker: Broker) {
    this.router = new SempRouter(broker);
  }

  async listen(host: string, port: number): Promise<number> {
    this.http = createServer((req, res) => {
      readBody(req)
        .then((bodyText) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const response = this.router.handle(req.method ?? 'GET', url.pathname, bodyText);
          res.writeHead(response.status, { 'content-type': response.contentType });
          res.end(response.body);
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"meta":{"responseCode":500}}');
        });
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(port, host, () => resolve());
    });
    const addr = this.http.address();
    if (addr === null || typeof addr === 'string') throw new Error('no listen address');
    return addr.port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }
}
