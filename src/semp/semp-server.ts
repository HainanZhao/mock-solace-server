import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Broker } from '../broker/broker.js';
import { Queue } from '../broker/queue.js';

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

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Minimal SEMP v2 implementation covering the endpoints test suites commonly
 * use for provisioning:
 *
 *   GET            /SEMP/v2/{config|monitor}/msgVpns
 *   GET            /SEMP/v2/{config|monitor}/msgVpns/{vpn}
 *   GET, POST      /SEMP/v2/config/msgVpns/{vpn}/queues
 *   GET, DELETE    /SEMP/v2/config/msgVpns/{vpn}/queues/{queue}
 *   GET, POST      /SEMP/v2/config/msgVpns/{vpn}/queues/{queue}/subscriptions
 *   DELETE         /SEMP/v2/config/msgVpns/{vpn}/queues/{queue}/subscriptions/{topic}
 *   GET            /SEMP/v2/monitor/msgVpns/{vpn}/queues/{queue}/msgs
 */
export class SempServer {
  private http: Server | undefined;

  constructor(private readonly broker: Broker) {}

  async listen(host: string, port: number): Promise<number> {
    this.http = createServer((req, res) => {
      this.route(req, res).catch((err: unknown) => {
        sendError(res, 500, 'INTERNAL', err instanceof Error ? err.message : 'internal error');
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

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'SEMP' || parts[1] !== 'v2') {
      return sendError(res, 404, 'NOT_FOUND', 'unknown path');
    }
    const api = parts[2];
    if (api !== 'config' && api !== 'monitor') {
      return sendError(res, 400, 'BAD_REQUEST', 'unsupported SEMP API');
    }
    if (parts[3] !== 'msgVpns') {
      return sendError(res, 404, 'NOT_FOUND', 'unknown resource');
    }
    const method = req.method ?? 'GET';
    const vpnName = parts[4];
    const rest = parts.slice(5);

    if (vpnName === undefined) {
      if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET only');
      return sendJson(res, 200, [...this.broker.vpns.keys()].map((n) => this.msgVpnObject(n)));
    }
    const vpn = this.broker.getVpn(vpnName);
    if (!vpn) return sendError(res, 400, 'NOT_FOUND', `VPN '${vpnName}' not found`);

    if (rest.length === 0) {
      if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET only');
      return sendJson(res, 200, this.msgVpnObject(vpnName));
    }

    if (rest[0] === 'queues') {
      const queueName = rest[1];
      const sub = rest[2];

      if (queueName === undefined) {
        if (method === 'GET') {
          return sendJson(
            res,
            200,
            [...vpn.queues.values()].map((q) => this.queueObject(q, api)),
          );
        }
        if (method === 'POST' && api === 'config') {
          const body = await readBody(req);
          const name = body['queueName'];
          if (typeof name !== 'string' || name.length === 0) {
            return sendError(res, 400, 'INVALID_PARAMETER', 'queueName required');
          }
          if (vpn.queues.has(name)) {
            return sendError(res, 400, 'ALREADY_EXISTS', `queue '${name}' already exists`);
          }
          const queue = this.broker.createQueue(vpnName, name, {
            accessType: body['accessType'] === 'non-exclusive' ? 'non-exclusive' : 'exclusive',
            ingressEnabled: body['ingressEnabled'] !== false,
            egressEnabled: body['egressEnabled'] !== false,
          });
          return sendJson(res, 200, this.queueObject(queue, api));
        }
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'unsupported method');
      }

      const queue = vpn.queues.get(queueName);
      if (!queue) return sendError(res, 400, 'NOT_FOUND', `queue '${queueName}' not found`);

      if (sub === undefined) {
        if (method === 'GET') return sendJson(res, 200, this.queueObject(queue, api));
        if (method === 'DELETE' && api === 'config') {
          this.broker.deleteQueue(vpnName, queueName);
          return sendJson(res, 200, {});
        }
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'unsupported method');
      }

      if (sub === 'subscriptions' && api === 'config') {
        const topic = rest[3];
        if (topic === undefined) {
          if (method === 'GET') {
            return sendJson(
              res,
              200,
              [...queue.topicSubscriptions].map((t) => ({
                msgVpnName: vpnName,
                queueName,
                subscriptionTopic: t,
              })),
            );
          }
          if (method === 'POST') {
            const body = await readBody(req);
            const topicStr = body['subscriptionTopic'];
            if (typeof topicStr !== 'string' || topicStr.length === 0) {
              return sendError(res, 400, 'INVALID_PARAMETER', 'subscriptionTopic required');
            }
            this.broker.addQueueSubscription(vpnName, queueName, topicStr);
            return sendJson(res, 200, {
              msgVpnName: vpnName,
              queueName,
              subscriptionTopic: topicStr,
            });
          }
          return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'unsupported method');
        }
        if (method === 'DELETE') {
          this.broker.removeQueueSubscription(vpnName, queueName, topic);
          return sendJson(res, 200, {});
        }
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'unsupported method');
      }

      if (sub === 'msgs' && api === 'monitor') {
        if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET only');
        return sendJson(
          res,
          200,
          queue.messages.map((m) => ({
            msgId: m.msgId,
            attachmentSize: m.payload.length,
            spooledTime: Math.floor(m.spooledAt / 1000),
            redeliveredCount: m.redelivered ? 1 : 0,
            destinationTopic: m.topic,
          })),
        );
      }

      return sendError(res, 404, 'NOT_FOUND', `unknown resource ${sub}`);
    }

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

  private queueObject(queue: Queue, api: 'config' | 'monitor'): Record<string, unknown> {
    const base: Record<string, unknown> = {
      msgVpnName: queue.vpnName,
      queueName: queue.name,
      accessType: queue.properties.accessType,
      ingressEnabled: queue.properties.ingressEnabled,
      egressEnabled: queue.properties.egressEnabled,
      maxMsgSpoolUsage: queue.properties.maxMsgSpoolUsageMb,
      permission: queue.properties.permission,
    };
    if (api === 'monitor') {
      base['msgs'] = { count: queue.messages.length };
      base['msgSpoolUsage'] = queue.messages.reduce((acc, m) => acc + m.payload.length, 0);
    }
    return base;
  }
}
