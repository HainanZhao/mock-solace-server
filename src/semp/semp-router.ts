import { Broker } from '../broker/broker.js';
import { Queue } from '../broker/queue.js';

export interface SempResponse {
  status: number;
  /** JSON response body, already serialized. */
  body: string;
  contentType: 'application/json';
}

interface SempMeta {
  responseCode: number;
  error?: { code: number; description: string; status: string };
}

function json(status: number, data: unknown, meta?: SempMeta): SempResponse {
  const body = JSON.stringify({ data, meta: meta ?? { responseCode: status } }, null, 2);
  return { status, body, contentType: 'application/json' };
}

function error(status: number, statusName: string, desc: string): SempResponse {
  return json(status, {}, {
    responseCode: status,
    error: { code: status, description: desc, status: statusName },
  });
}

function parseBody(bodyText: string): Record<string, unknown> {
  if (!bodyText) return {};
  const parsed: unknown = JSON.parse(bodyText);
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Runtime-neutral SEMP v2 router covering the endpoints test suites commonly
 * use for provisioning. Served over node:http by SempServer in Node, or via a
 * fetch interceptor in the browser.
 *
 *   GET            /SEMP/v2/{config|monitor}/msgVpns
 *   GET            /SEMP/v2/{config|monitor}/msgVpns/{vpn}
 *   GET, POST      /SEMP/v2/config/msgVpns/{vpn}/queues
 *   GET, DELETE    /SEMP/v2/config/msgVpns/{vpn}/queues/{queue}
 *   GET, POST      /SEMP/v2/config/msgVpns/{vpn}/queues/{queue}/subscriptions
 *   DELETE         /SEMP/v2/config/msgVpns/{vpn}/queues/{queue}/subscriptions/{topic}
 *   GET            /SEMP/v2/monitor/msgVpns/{vpn}/queues/{queue}/msgs
 */
export class SempRouter {
  constructor(private readonly broker: Broker) {}

  handle(method: string, pathname: string, bodyText: string): SempResponse {
    try {
      return this.route(method, pathname, bodyText);
    } catch (err) {
      return error(500, 'INTERNAL', err instanceof Error ? err.message : 'internal error');
    }
  }

  private route(method: string, pathname: string, bodyText: string): SempResponse {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'SEMP' || parts[1] !== 'v2') {
      return error(404, 'NOT_FOUND', 'unknown path');
    }
    const api = parts[2];
    if (api !== 'config' && api !== 'monitor') {
      return error(400, 'BAD_REQUEST', 'unsupported SEMP API');
    }
    if (parts[3] !== 'msgVpns') {
      return error(404, 'NOT_FOUND', 'unknown resource');
    }
    const vpnName = parts[4];
    const rest = parts.slice(5);

    if (vpnName === undefined) {
      if (method !== 'GET') return error(405, 'METHOD_NOT_ALLOWED', 'GET only');
      return json(200, [...this.broker.vpns.keys()].map((n) => this.msgVpnObject(n)));
    }
    const vpn = this.broker.getVpn(vpnName);
    if (!vpn) return error(400, 'NOT_FOUND', `VPN '${vpnName}' not found`);

    if (rest.length === 0) {
      if (method !== 'GET') return error(405, 'METHOD_NOT_ALLOWED', 'GET only');
      return json(200, this.msgVpnObject(vpnName));
    }

    if (rest[0] === 'queues') {
      const queueName = rest[1];
      const sub = rest[2];

      if (queueName === undefined) {
        if (method === 'GET') {
          return json(200, [...vpn.queues.values()].map((q) => this.queueObject(q, api)));
        }
        if (method === 'POST' && api === 'config') {
          const body = parseBody(bodyText);
          const name = body['queueName'];
          if (typeof name !== 'string' || name.length === 0) {
            return error(400, 'INVALID_PARAMETER', 'queueName required');
          }
          if (vpn.queues.has(name)) {
            return error(400, 'ALREADY_EXISTS', `queue '${name}' already exists`);
          }
          const queue = this.broker.createQueue(vpnName, name, {
            accessType: body['accessType'] === 'non-exclusive' ? 'non-exclusive' : 'exclusive',
            ingressEnabled: body['ingressEnabled'] !== false,
            egressEnabled: body['egressEnabled'] !== false,
          });
          return json(200, this.queueObject(queue, api));
        }
        return error(405, 'METHOD_NOT_ALLOWED', 'unsupported method');
      }

      const queue = vpn.queues.get(queueName);
      if (!queue) return error(400, 'NOT_FOUND', `queue '${queueName}' not found`);

      if (sub === undefined) {
        if (method === 'GET') return json(200, this.queueObject(queue, api));
        if (method === 'DELETE' && api === 'config') {
          this.broker.deleteQueue(vpnName, queueName);
          return json(200, {});
        }
        return error(405, 'METHOD_NOT_ALLOWED', 'unsupported method');
      }

      if (sub === 'subscriptions' && api === 'config') {
        const topic = rest[3];
        if (topic === undefined) {
          if (method === 'GET') {
            return json(
              200,
              [...queue.topicSubscriptions].map((t) => ({
                msgVpnName: vpnName,
                queueName,
                subscriptionTopic: t,
              })),
            );
          }
          if (method === 'POST') {
            const body = parseBody(bodyText);
            const topicStr = body['subscriptionTopic'];
            if (typeof topicStr !== 'string' || topicStr.length === 0) {
              return error(400, 'INVALID_PARAMETER', 'subscriptionTopic required');
            }
            this.broker.addQueueSubscription(vpnName, queueName, topicStr);
            return json(200, {
              msgVpnName: vpnName,
              queueName,
              subscriptionTopic: topicStr,
            });
          }
          return error(405, 'METHOD_NOT_ALLOWED', 'unsupported method');
        }
        if (method === 'DELETE') {
          this.broker.removeQueueSubscription(vpnName, queueName, topic);
          return json(200, {});
        }
        return error(405, 'METHOD_NOT_ALLOWED', 'unsupported method');
      }

      if (sub === 'msgs' && api === 'monitor') {
        if (method !== 'GET') return error(405, 'METHOD_NOT_ALLOWED', 'GET only');
        return json(
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

      return error(404, 'NOT_FOUND', `unknown resource ${sub}`);
    }

    return error(404, 'NOT_FOUND', `unknown resource ${rest[0]}`);
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
