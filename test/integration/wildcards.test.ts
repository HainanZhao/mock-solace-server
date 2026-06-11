import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockSolaceServer } from '../../src/index.js';
import {
  collectMessages,
  connectSession,
  createSession,
  disconnectSession,
  publishText,
  subscribe,
  waitFor,
} from '../helpers/solclient.js';

describe('wildcard routing (integration)', () => {
  let server: MockSolaceServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sub: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pub: any;
  let received: { topic: string; payload: string }[];

  beforeAll(async () => {
    server = new MockSolaceServer();
    const addr = await server.start();
    sub = createSession({ url: addr.smfWsUrl, clientName: 'wild-sub' });
    pub = createSession({ url: addr.smfWsUrl, clientName: 'wild-pub' });
    await Promise.all([connectSession(sub), connectSession(pub)]);
    received = collectMessages(sub);
  });

  afterAll(async () => {
    await Promise.all([disconnectSession(sub), disconnectSession(pub)]);
    await server.stop();
  });

  async function expectDelivery(topics: string[], expectDelivered: string[]): Promise<void> {
    received.length = 0;
    for (const t of topics) publishText(pub, t, t);
    // Publish a sentinel on a subscribed control topic to mark the end.
    publishText(pub, 'control/end', 'end');
    await waitFor(() => received.some((m) => m.topic === 'control/end'));
    const delivered = received.filter((m) => m.topic !== 'control/end').map((m) => m.topic);
    expect(delivered.sort()).toEqual([...expectDelivered].sort());
  }

  it('single-level * wildcard through a real client', async () => {
    await subscribe(sub, 'control/end');
    await subscribe(sub, 'animals/*/wild');
    await expectDelivery(
      ['animals/red/wild', 'animals/x/wild', 'animals/wild', 'animals/a/b/wild'],
      ['animals/red/wild', 'animals/x/wild'],
    );
  });

  it('prefix wildcard red*', async () => {
    await subscribe(sub, 'colors/red*');
    await expectDelivery(
      ['colors/red', 'colors/reddish', 'colors/blue', 'colors/red/deep'],
      ['colors/red', 'colors/reddish'],
    );
  });

  it('multi-level > wildcard', async () => {
    await subscribe(sub, 'iot/>');
    await expectDelivery(
      ['iot', 'iot/device1', 'iot/device1/temp/value'],
      ['iot/device1', 'iot/device1/temp/value'],
    );
  });

  it('overlapping wildcard subscriptions deliver one copy', async () => {
    await subscribe(sub, 'dup/>');
    await subscribe(sub, 'dup/*/x');
    await expectDelivery(['dup/a/x'], ['dup/a/x']);
  });
});
