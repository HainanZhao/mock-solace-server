import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockSolaceServer } from '../../src/index.js';
import {
  connectSession,
  createSession,
  disconnectSession,
  publishText,
  waitFor,
} from '../helpers/solclient.js';

describe('SEMP v2 (integration)', () => {
  let server: MockSolaceServer;
  let sempUrl: string;
  let smfUrl: string;

  beforeAll(async () => {
    server = new MockSolaceServer();
    const addr = await server.start();
    sempUrl = addr.sempUrl!;
    smfUrl = addr.smfWsUrl;
  });

  afterAll(async () => {
    await server.stop();
  });

  async function semp(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: { data: unknown; meta: { responseCode: number } } }> {
    const res = await fetch(`${sempUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as never };
  }

  it('lists and fetches msgVpns', async () => {
    const list = await semp('GET', '/SEMP/v2/config/msgVpns');
    expect(list.status).toBe(200);
    expect(list.json.data).toEqual([expect.objectContaining({ msgVpnName: 'default' })]);
    const one = await semp('GET', '/SEMP/v2/config/msgVpns/default');
    expect(one.json.data).toMatchObject({ msgVpnName: 'default', enabled: true });
  });

  it('creates, reads and deletes a queue', async () => {
    const create = await semp('POST', '/SEMP/v2/config/msgVpns/default/queues', {
      queueName: 'q/test',
      accessType: 'exclusive',
      egressEnabled: true,
      ingressEnabled: true,
    });
    expect(create.status).toBe(200);
    expect(create.json.data).toMatchObject({ queueName: 'q/test', accessType: 'exclusive' });

    const dup = await semp('POST', '/SEMP/v2/config/msgVpns/default/queues', {
      queueName: 'q/test',
    });
    expect(dup.status).toBe(400);

    const get = await semp('GET', '/SEMP/v2/config/msgVpns/default/queues/q%2Ftest');
    expect(get.json.data).toMatchObject({ queueName: 'q/test' });

    const del = await semp('DELETE', '/SEMP/v2/config/msgVpns/default/queues/q%2Ftest');
    expect(del.status).toBe(200);
    const after = await semp('GET', '/SEMP/v2/config/msgVpns/default/queues/q%2Ftest');
    expect(after.status).toBe(400);
  });

  it('queue topic subscription spools matching published messages', async () => {
    await semp('POST', '/SEMP/v2/config/msgVpns/default/queues', { queueName: 'q/orders' });
    const addSub = await semp(
      'POST',
      '/SEMP/v2/config/msgVpns/default/queues/q%2Forders/subscriptions',
      { subscriptionTopic: 'orders/>' },
    );
    expect(addSub.status).toBe(200);

    const session = createSession({ url: smfUrl, clientName: 'semp-pub' });
    await connectSession(session);
    publishText(session, 'orders/eu/created', 'queued-1');
    await waitFor(() => (server.getQueue('q/orders')?.messages.length ?? 0) >= 1);
    await disconnectSession(session);

    const queue = server.getQueue('q/orders')!;
    expect(queue.messages[0]!.topic).toBe('orders/eu/created');
    expect(queue.messages[0]!.payload.toString()).toBe('queued-1');

    const msgs = await semp('GET', '/SEMP/v2/monitor/msgVpns/default/queues/q%2Forders/msgs');
    expect(msgs.json.data).toEqual([
      expect.objectContaining({ destinationTopic: 'orders/eu/created' }),
    ]);

    const monitorQ = await semp('GET', '/SEMP/v2/monitor/msgVpns/default/queues/q%2Forders');
    expect(monitorQ.json.data).toMatchObject({ msgs: { count: 1 } });
  });

  it('unknown VPN and resources return SEMP-style errors', async () => {
    const bad = await semp('GET', '/SEMP/v2/config/msgVpns/nope/queues');
    expect(bad.status).toBe(400);
    expect(bad.json.meta).toMatchObject({
      responseCode: 400,
      error: expect.objectContaining({ status: 'NOT_FOUND' }),
    });
  });

  it('programmatic createQueue with topics works the same way', () => {
    const queue = server.createQueue('q/direct', { topics: ['direct/>'] });
    expect(queue.topicSubscriptions.has('direct/>')).toBe(true);
    expect(server.getQueue('q/direct')).toBe(queue);
  });
});
