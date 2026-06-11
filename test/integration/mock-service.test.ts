import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockSolaceServer } from '../../src/index.js';
import {
  collectMessages,
  connectSession,
  createSession,
  disconnectSession,
  solace,
  subscribe,
  waitFor,
} from '../helpers/solclient.js';

describe('mock services (integration)', () => {
  let server: MockSolaceServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any;

  beforeAll(async () => {
    server = new MockSolaceServer();
    const addr = await server.start();
    session = createSession({ url: addr.smfWsUrl, clientName: 'svc-client' });
    await connectSession(session);
  });

  afterAll(async () => {
    await disconnectSession(session);
    await server.stop();
  });

  it('server.publish delivers a broker-originated message to subscribers', async () => {
    const received = collectMessages(session);
    await subscribe(session, 'broker/news');
    server.publish('broker/news', 'hello from the broker');
    await waitFor(() => received.length >= 1);
    expect(received[0]).toEqual({ topic: 'broker/news', payload: 'hello from the broker' });
  });

  it('respondTo answers session.sendRequest with a computed reply', async () => {
    const responder = server.respondTo('svc/users/*', (req) => {
      const id = req.topic.split('/').pop();
      return { id, name: `user-${id}`, echo: req.payload.toString() };
    });

    const request = solace.SolclientFactory.createMessage();
    request.setDestination(solace.SolclientFactory.createTopicDestination('svc/users/42'));
    request.setBinaryAttachment('give me user 42');
    request.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reply = await new Promise<any>((resolve, reject) => {
      session.sendRequest(
        request,
        5000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_session: unknown, msg: any) => resolve(msg),
        (_session: unknown, err: unknown) => reject(err),
      );
    });

    expect(JSON.parse(reply.getBinaryAttachment().toString())).toEqual({
      id: '42',
      name: 'user-42',
      echo: 'give me user 42',
    });
    expect(responder.requests).toHaveLength(1);
    expect(responder.requests[0]!.topic).toBe('svc/users/42');
    expect(responder.requests[0]!.correlationId).toMatch(/^#REQ/);
    responder.remove();
  });

  it('respondTo accepts a static payload and stops after remove()', async () => {
    const responder = server.respondTo('svc/ping', 'pong');

    const ask = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const request = solace.SolclientFactory.createMessage();
        request.setDestination(solace.SolclientFactory.createTopicDestination('svc/ping'));
        request.setBinaryAttachment('ping');
        session.sendRequest(
          request,
          1500,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (_s: unknown, msg: any) => resolve(msg.getBinaryAttachment().toString()),
          (_s: unknown, err: unknown) => reject(err),
        );
      });

    await expect(ask()).resolves.toBe('pong');
    responder.remove();
    await expect(ask()).rejects.toBeTruthy(); // request now times out
  }, 10000);

  it('handler returning null produces no reply (request times out)', async () => {
    const responder = server.respondTo('svc/silent', () => null);
    const request = solace.SolclientFactory.createMessage();
    request.setDestination(solace.SolclientFactory.createTopicDestination('svc/silent'));
    request.setBinaryAttachment('anyone?');
    const failed = await new Promise<boolean>((resolve) => {
      session.sendRequest(
        request,
        1000,
        () => resolve(false),
        () => resolve(true),
      );
    });
    expect(failed).toBe(true);
    expect(responder.requests).toHaveLength(1);
    responder.remove();
  }, 8000);

  it('plain published messages also reach responders (no reply path)', async () => {
    const seen: string[] = [];
    const responder = server.respondTo('events/>', (req) => {
      seen.push(req.payload.toString());
      return 'never sent'; // no replyTo on a plain publish → no reply routed
    });
    const msg = solace.SolclientFactory.createMessage();
    msg.setDestination(solace.SolclientFactory.createTopicDestination('events/login'));
    msg.setBinaryAttachment('user logged in');
    msg.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
    session.send(msg);
    await waitFor(() => seen.length >= 1);
    expect(seen[0]).toBe('user logged in');
    responder.remove();
  });

  it('scenarios replay a recorded message sequence on play()', async () => {
    const received = collectMessages(session);
    await subscribe(session, 'replay/>');

    server.scenario('routing1', (s) =>
      s
        .publish('replay/orders/created', { id: 1 })
        .wait(30)
        .publish('replay/orders/paid', { id: 1 })
        .publish('replay/orders/shipped', { id: 1 }),
    );

    await server.play('routing1');
    await waitFor(() => received.length >= 3);
    expect(received.map((m) => m.topic)).toEqual([
      'replay/orders/created',
      'replay/orders/paid',
      'replay/orders/shipped',
    ]);

    // Scenarios are replayable: play again, get the sequence again.
    received.length = 0;
    await server.play('routing1');
    await waitFor(() => received.length >= 3);
    expect(received.map((m) => m.topic)).toEqual([
      'replay/orders/created',
      'replay/orders/paid',
      'replay/orders/shipped',
    ]);
  });

  it('play() rejects for unknown scenarios', async () => {
    await expect(server.play('nope')).rejects.toThrow(/unknown scenario/);
  });
});
