import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockSolaceServer } from '../../src/index.js';
import {
  connectSession,
  createSession,
  disconnectSession,
  solace,
  waitFor,
} from '../helpers/solclient.js';

describe('solclientjs connect (integration)', () => {
  let server: MockSolaceServer;
  let url: string;

  beforeEach(async () => {
    server = new MockSolaceServer();
    const addr = await server.start();
    url = addr.smfWsUrl;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('reaches UP_NOTICE against the mock broker', async () => {
    const session = createSession({ url, clientName: 'it-connect' });
    await connectSession(session);
    const clients = server.clients();
    expect(clients).toHaveLength(1);
    expect(clients[0]!.clientName).toBe('it-connect');
    expect(clients[0]!.vpnName).toBe('default');
    expect(clients[0]!.username).toBe('test-user');
    await disconnectSession(session);
  });

  it('stays up across multiple keepalive intervals', async () => {
    const session = createSession({ url });
    await connectSession(session);
    let down = false;
    session.on(solace.SessionEventCode.DOWN_ERROR, () => {
      down = true;
    });
    // Default client keepalive interval is 3s with a 3-miss limit; surviving
    // 8s proves the server's keepalive handling satisfies the SDK.
    await new Promise((r) => setTimeout(r, 8000));
    expect(down).toBe(false);
    expect(server.clients()).toHaveLength(1);
    await disconnectSession(session);
  }, 20000);

  it('emits clientConnected/clientDisconnected and cleans up on disconnect', async () => {
    const events: string[] = [];
    server.on('clientConnected', () => events.push('connected'));
    server.on('clientDisconnected', () => events.push('disconnected'));
    const session = createSession({ url });
    await connectSession(session);
    expect(events).toEqual(['connected']);
    await disconnectSession(session);
    await waitFor(() => server.clients().length === 0);
    expect(events).toEqual(['connected', 'disconnected']);
  });

  it('rejects bad credentials via validateCredentials hook', async () => {
    const authServer = new MockSolaceServer({
      validateCredentials: ({ username, password }) =>
        username === 'good' && password === 'secret',
    });
    const addr = await authServer.start();
    try {
      const bad = createSession({
        url: addr.smfWsUrl,
        userName: 'bad',
        password: 'wrong',
      });
      await expect(connectSession(bad, 5000)).rejects.toThrow(/CONNECT_FAILED|timed out/);
      bad.dispose();

      const good = createSession({
        url: addr.smfWsUrl,
        userName: 'good',
        password: 'secret',
      });
      await connectSession(good);
      await disconnectSession(good);
    } finally {
      await authServer.stop();
    }
  }, 15000);
});
