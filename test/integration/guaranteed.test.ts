import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockSolaceServer } from '../../src/index.js';
import {
  connectSession,
  createSession,
  disconnectSession,
  publishText,
  solace,
  waitFor,
} from '../helpers/solclient.js';

describe('guaranteed messaging happy path (integration)', () => {
  let server: MockSolaceServer;
  let url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any;

  beforeAll(async () => {
    server = new MockSolaceServer();
    const addr = await server.start();
    url = addr.smfWsUrl;
    server.createQueue('q/gm', { topics: ['gm/>'] });
    session = createSession({ url, clientName: 'gm-client' });
    await connectSession(session);
  });

  afterAll(async () => {
    await disconnectSession(session);
    await server.stop();
  });

  it('consumer binds, receives a spooled message, and ack removes it', async () => {
    // Spool a message before the consumer exists.
    publishText(session, 'gm/orders/1', 'spooled-first');
    await waitFor(() => (server.getQueue('q/gm')?.messages.length ?? 0) >= 1);

    const consumer = session.createMessageConsumer({
      queueDescriptor: { name: 'q/gm', type: solace.QueueType.QUEUE },
      acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = [];
    let consumerUp = false;
    consumer.on(solace.MessageConsumerEventName.UP, () => {
      consumerUp = true;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    consumer.on(solace.MessageConsumerEventName.MESSAGE, (m: any) => messages.push(m));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failures: any[] = [];
    consumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, (e: unknown) =>
      failures.push(e),
    );
    consumer.on(solace.MessageConsumerEventName.DOWN_ERROR, (e: unknown) => failures.push(e));
    consumer.connect();

    await waitFor(() => consumerUp);
    expect(failures).toEqual([]);

    // The pre-spooled message arrives.
    await waitFor(() => messages.length >= 1);
    expect(messages[0]!.getDestination().getName()).toBe('gm/orders/1');
    expect(messages[0]!.getBinaryAttachment()?.toString()).toBe('spooled-first');
    expect(messages[0]!.getDeliveryMode()).toBe(solace.MessageDeliveryModeType.PERSISTENT);

    // A message published while the consumer is up flows through live.
    publishText(session, 'gm/orders/2', 'live-second');
    await waitFor(() => messages.length >= 2);
    expect(messages[1]!.getBinaryAttachment()?.toString()).toBe('live-second');

    // Client-ack both; the queue must drain.
    messages[0]!.acknowledge();
    messages[1]!.acknowledge();
    await waitFor(() => server.getQueue('q/gm')!.messages.length === 0);

    // Clean consumer teardown.
    await new Promise<void>((resolve) => {
      consumer.on(solace.MessageConsumerEventName.DOWN, () => resolve());
      consumer.disconnect();
    });
  }, 20000);

  it('unacked messages survive consumer teardown and are redelivered', async () => {
    publishText(session, 'gm/orders/3', 'unacked');
    await waitFor(() => (server.getQueue('q/gm')?.messages.length ?? 0) >= 1);

    const first = session.createMessageConsumer({
      queueDescriptor: { name: 'q/gm', type: solace.QueueType.QUEUE },
      acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
    });
    let got = false;
    first.on(solace.MessageConsumerEventName.MESSAGE, () => {
      got = true; // deliberately do NOT acknowledge
    });
    first.connect();
    await waitFor(() => got);
    await new Promise<void>((resolve) => {
      first.on(solace.MessageConsumerEventName.DOWN, () => resolve());
      first.disconnect();
    });

    // Message is back in the spool, flagged for redelivery.
    const queue = server.getQueue('q/gm')!;
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0]!.redelivered).toBe(true);

    const second = session.createMessageConsumer({
      queueDescriptor: { name: 'q/gm', type: solace.QueueType.QUEUE },
      acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redelivered: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    second.on(solace.MessageConsumerEventName.MESSAGE, (m: any) => redelivered.push(m));
    second.connect();
    await waitFor(() => redelivered.length >= 1);
    expect(redelivered[0]!.getBinaryAttachment()?.toString()).toBe('unacked');
    expect(redelivered[0]!.isRedelivered()).toBe(true);
    redelivered[0]!.acknowledge();
    await waitFor(() => server.getQueue('q/gm')!.messages.length === 0);
    await new Promise<void>((resolve) => {
      second.on(solace.MessageConsumerEventName.DOWN, () => resolve());
      second.disconnect();
    });
  }, 20000);

  it('binding to a missing queue fails the consumer cleanly', async () => {
    const consumer = session.createMessageConsumer({
      queueDescriptor: { name: 'q/missing', type: solace.QueueType.QUEUE },
    });
    const failed = await new Promise<boolean>((resolve) => {
      consumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, () => resolve(true));
      consumer.on(solace.MessageConsumerEventName.UP, () => resolve(false));
      consumer.connect();
      setTimeout(() => resolve(false), 8000);
    });
    expect(failed).toBe(true);
    consumer.dispose();
  }, 12000);
});
