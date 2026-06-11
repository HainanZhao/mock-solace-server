import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockSolaceServer } from '../../src/index.js';
import {
  collectMessages,
  connectSession,
  createSession,
  disconnectSession,
  publishText,
  solace,
  subscribe,
  waitFor,
} from '../helpers/solclient.js';

describe('direct pub/sub (integration)', () => {
  let server: MockSolaceServer;
  let url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let subSession: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pubSession: any;
  let received: { topic: string; payload: string }[];

  beforeAll(async () => {
    server = new MockSolaceServer();
    const addr = await server.start();
    url = addr.smfWsUrl;
    subSession = createSession({ url, clientName: 'subscriber' });
    pubSession = createSession({ url, clientName: 'publisher' });
    await Promise.all([connectSession(subSession), connectSession(pubSession)]);
    received = collectMessages(subSession);
  });

  afterAll(async () => {
    await Promise.all([disconnectSession(subSession), disconnectSession(pubSession)]);
    await server.stop();
  });

  it('routes a published message to an exact-match subscriber', async () => {
    await subscribe(subSession, 'orders/created');
    publishText(pubSession, 'orders/created', 'order-1');
    await waitFor(() => received.length >= 1);
    expect(received[0]).toEqual({ topic: 'orders/created', payload: 'order-1' });
  });

  it('does not deliver non-matching topics', async () => {
    received.length = 0;
    publishText(pubSession, 'orders/deleted', 'order-2');
    publishText(pubSession, 'orders/created', 'order-3');
    await waitFor(() => received.length >= 1);
    // Give a beat for any (incorrect) extra delivery to arrive.
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([{ topic: 'orders/created', payload: 'order-3' }]);
  });

  it('captures published messages for inspection', async () => {
    const captured = server.capturedMessages();
    expect(captured.length).toBeGreaterThanOrEqual(3);
    const last = captured[captured.length - 1]!;
    expect(last.topic).toBe('orders/created');
    expect(last.payload.toString()).toBe('order-3');
    expect(last.publisherClientName).toBe('publisher');
    expect(last.deliveredTo).toBe(1);
  });

  it('stops delivery after unsubscribe', async () => {
    received.length = 0;
    await new Promise<void>((resolve, reject) => {
      const key = 'unsub-1';
      const timer = setTimeout(() => reject(new Error('unsubscribe timeout')), 5000);
      session_onOk(subSession, key, () => {
        clearTimeout(timer);
        resolve();
      });
      subSession.unsubscribe(
        solace.SolclientFactory.createTopicDestination('orders/created'),
        true,
        key,
        5000,
      );
    });
    publishText(pubSession, 'orders/created', 'after-unsub');
    await server.waitForMessage((m) => m.payload.toString() === 'after-unsub');
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([]);
  });

  it('round-trips a structured text message (SDT) intact', async () => {
    await subscribe(subSession, 'sdt/text');
    received.length = 0;
    const msg = solace.SolclientFactory.createMessage();
    msg.setDestination(solace.SolclientFactory.createTopicDestination('sdt/text'));
    msg.setSdtContainer(solace.SDTField.create(solace.SDTFieldType.STRING, 'hello sdt'));
    msg.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
    pubSession.send(msg);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const got = await new Promise<any>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subSession.on(solace.SessionEventCode.MESSAGE, (m: any) => {
        if (m.getDestination().getName() === 'sdt/text') resolve(m);
      });
    });
    expect(got.getSdtContainer().getValue()).toBe('hello sdt');
  });

  it('fans out to multiple subscribers', async () => {
    const extra = createSession({ url, clientName: 'subscriber-2' });
    await connectSession(extra);
    const extraReceived = collectMessages(extra);
    try {
      await subscribe(extra, 'fan/out');
      await subscribe(subSession, 'fan/out');
      received.length = 0;
      publishText(pubSession, 'fan/out', 'broadcast');
      await waitFor(() => received.length >= 1 && extraReceived.length >= 1);
      expect(received[0]!.payload).toBe('broadcast');
      expect(extraReceived[0]!.payload).toBe('broadcast');
    } finally {
      await disconnectSession(extra);
    }
  });

  it('publisher with subscription receives its own message (no noLocal)', async () => {
    const pubReceived = collectMessages(pubSession);
    await subscribe(pubSession, 'self/echo');
    publishText(pubSession, 'self/echo', 'me');
    await waitFor(() => pubReceived.length >= 1);
    expect(pubReceived[0]).toEqual({ topic: 'self/echo', payload: 'me' });
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function session_onOk(session: any, key: string, cb: () => void): void {
  session.on(solace.SessionEventCode.SUBSCRIPTION_OK, (e: { correlationKey?: unknown }) => {
    if (e.correlationKey === key) cb();
  });
}
