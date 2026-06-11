/**
 * In-memory (browser-mode) transport: no sockets, no ports. The server
 * patches globalThis.WebSocket/fetch; the solclientjs BROWSER bundle —
 * which, unlike the Node build, uses the global WebSocket — is loaded
 * afterwards so it captures the interceptor, exactly as in a browser.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemorySolaceServer } from '../../src/browser.js';
import type { ServerAddresses } from '../../src/browser.js';
import { toUtf8 } from '../../src/util/bytes.js';

const require = createRequire(import.meta.url);

let server: InMemorySolaceServer;
let addresses: ServerAddresses;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let solace: any;
const realWebSocket = globalThis.WebSocket;

beforeAll(async () => {
  server = new InMemorySolaceServer();
  addresses = await server.start(); // installs the WebSocket/fetch interceptors
  expect(globalThis.WebSocket).not.toBe(realWebSocket);

  // Load the browser build only now, so it captures the fake WebSocket.
  solace = require('solclientjs/lib-browser/solclient.js');
  solace.SolclientFactory.init(
    new solace.SolclientFactoryProperties({
      profile: solace.SolclientFactoryProfiles.version10_5,
    }),
  );
  solace.SolclientFactory.setLogLevel(solace.LogLevel.WARN);
});

afterAll(async () => {
  await server.stop();
  expect(globalThis.WebSocket).toBe(realWebSocket);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createSession(clientName?: string): any {
  return solace.SolclientFactory.createSession(
    new solace.SessionProperties({
      url: addresses.smfWsUrl,
      vpnName: 'default',
      userName: 'test-user',
      password: 'test-pass',
      clientName,
      connectTimeoutInMsecs: 5000,
      reconnectRetries: 0,
      connectRetries: 0,
    }),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function connectSession(session: any, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for UP_NOTICE')),
      timeoutMs,
    );
    session.on(solace.SessionEventCode.UP_NOTICE, () => {
      clearTimeout(timer);
      resolve();
    });
    session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e: unknown) => {
      clearTimeout(timer);
      reject(new Error(`CONNECT_FAILED_ERROR: ${String((e as Error)?.message ?? e)}`));
    });
    session.connect();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function disconnectSession(session: any, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.dispose();
      resolve();
    }, timeoutMs);
    session.on(solace.SessionEventCode.DISCONNECTED, () => {
      clearTimeout(timer);
      session.dispose();
      resolve();
    });
    try {
      session.disconnect();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function subscribe(session: any, topic: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const correlationKey = `sub-${topic}-${Math.random()}`;
    const timer = setTimeout(
      () => reject(new Error(`timed out subscribing to ${topic}`)),
      timeoutMs,
    );
    session.on(solace.SessionEventCode.SUBSCRIPTION_OK, (e: { correlationKey?: unknown }) => {
      if (e.correlationKey !== correlationKey) return;
      clearTimeout(timer);
      resolve();
    });
    session.on(
      solace.SessionEventCode.SUBSCRIPTION_ERROR,
      (e: { correlationKey?: unknown; infoStr?: string }) => {
        if (e.correlationKey !== correlationKey) return;
        clearTimeout(timer);
        reject(new Error(`SUBSCRIPTION_ERROR for ${topic}: ${e.infoStr ?? ''}`));
      },
    );
    session.subscribe(
      solace.SolclientFactory.createTopicDestination(topic),
      true,
      correlationKey,
      timeoutMs,
    );
  });
}

describe('in-memory transport (solclientjs browser bundle)', () => {
  it('connects to UP_NOTICE through the WebSocket interceptor', async () => {
    const session = createSession('inmem-client-1');
    await connectSession(session);
    expect(server.clients().map((c) => c.clientName)).toContain('inmem-client-1');
    await disconnectSession(session);
  });

  it('delivers broker-published messages to a subscribed session', async () => {
    const session = createSession();
    await connectSession(session);
    await subscribe(session, 'inmem/news');

    const received: { topic: string; payload: string }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.on(solace.SessionEventCode.MESSAGE, (message: any) => {
      received.push({
        topic: message.getDestination().getName(),
        payload: message.getBinaryAttachment()?.toString() ?? '',
      });
    });
    server.publish('inmem/news', 'hello from broker');

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([{ topic: 'inmem/news', payload: 'hello from broker' }]);
    await disconnectSession(session);
  });

  it('captures client-published messages on the server', async () => {
    const session = createSession();
    await connectSession(session);

    const msg = solace.SolclientFactory.createMessage();
    msg.setDestination(solace.SolclientFactory.createTopicDestination('inmem/out'));
    msg.setBinaryAttachment('from the client');
    msg.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
    session.send(msg);

    const captured = await server.waitForMessage((m) => m.topic === 'inmem/out');
    expect(toUtf8(captured.payload)).toBe('from the client');
    await disconnectSession(session);
  });

  it('answers request/reply via a broker-side mock service', async () => {
    server.respondTo('inmem/svc/echo', (req) => `echo:${toUtf8(req.payload)}`);
    const session = createSession();
    await connectSession(session);

    const reply = await new Promise<string>((resolve, reject) => {
      const msg = solace.SolclientFactory.createMessage();
      msg.setDestination(solace.SolclientFactory.createTopicDestination('inmem/svc/echo'));
      msg.setBinaryAttachment('ping');
      session.sendRequest(
        msg,
        5000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_s: unknown, m: any) => resolve(m.getBinaryAttachment().toString()),
        (_s: unknown, e: { infoStr?: string }) => reject(new Error(e.infoStr ?? 'request failed')),
      );
    });
    expect(reply).toBe('echo:ping');
    await disconnectSession(session);
  });

  it('serves SEMP through the fetch interceptor', async () => {
    const res = await fetch(
      `${addresses.sempUrl}/SEMP/v2/config/msgVpns/default/queues`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queueName: 'q/inmem' }),
      },
    );
    expect(res.status).toBe(200);
    const created = (await res.json()) as { data: { queueName: string } };
    expect(created.data.queueName).toBe('q/inmem');
    expect(server.getQueue('q/inmem')).toBeDefined();

    const list = await fetch(`${addresses.sempUrl}/SEMP/v2/monitor/msgVpns/default/queues`);
    const listJson = (await list.json()) as { data: { queueName: string }[] };
    expect(listJson.data.map((q) => q.queueName)).toContain('q/inmem');
  });
});
