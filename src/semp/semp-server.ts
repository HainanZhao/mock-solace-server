import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Broker } from '../broker/broker.js';

interface SempMeta {
  responseCode: number;
  error?: { code: number; description: string; status: string };
}

function sendJson(res: ServerResponse, status: number, data: unknown, meta?: SempMeta): void {
  const body = JSON.stringify({ data, meta: meta ?? { responseCode: status } }, null, 2);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, statusName: string, desc: string): void {
  sendJson(res, status, {}, {
    responseCode: status,
    error: { code: status, description: desc, status: statusName },
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * Minimal SEMP v2 server. Phase 1 exposes msgVpn objects; queue endpoints
 * arrive with guaranteed-messaging support.
 */
export class SempServer {
  private http: Server | undefined;

  constructor(private readonly broker: Broker) {}

  async listen(host: string, port: number): Promise<number> {
    this.http = createServer((req, res) => {
      this.route(req, res).catch(() => sendError(res, 500, 'INTERNAL', 'internal error'));
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

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    // Expected shape: SEMP/v2/config/msgVpns[/{vpn}[/...]]
    if (parts[0] !== 'SEMP' || parts[1] !== 'v2') {
      return sendError(res, 404, 'NOT_FOUND', 'unknown path');
    }
    const api = parts[2];
    if (api !== 'config' && api !== 'monitor') {
      return sendError(res, 404, 'NOT_FOUND', 'unsupported SEMP API');
    }
    if (parts[3] !== 'msgVpns') {
      return sendError(res, 404, 'NOT_FOUND', 'unknown resource');
    }
    const vpnName = parts[4] !== undefined ? decodeURIComponent(parts[4]) : undefined;
    const rest = parts.slice(5);

    if (vpnName === undefined) {
      if (req.method === 'GET') {
        const vpns = [...this.broker.vpns.keys()].map((name) => this.msgVpnObject(name));
        return sendJson(res, 200, vpns);
      }
      return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'unsupported method');
    }

    const vpn = this.broker.getVpn(vpnName);
    if (!vpn) return sendError(res, 400, 'NOT_FOUND', `VPN '${vpnName}' not found`);

    if (rest.length === 0) {
      if (req.method === 'GET') return sendJson(res, 200, this.msgVpnObject(vpnName));
      return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'unsupported method');
    }

    void (await readBody(req).catch(() => ({})));
    return sendError(res, 404, 'NOT_FOUND', `unknown resource ${rest[0]}`);
  }

  private msgVpnObject(name: string): Record<string, unknown> {
    return {
      msgVpnName: name,
      enabled: true,
      authenticationBasicEnabled: true,
      maxConnectionCount: 1000,
    };
  }
}
