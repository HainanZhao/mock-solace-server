/**
 * The /browser/auto side-effect entry: patches WebSocket/fetch at
 * module-evaluation time so consumers can statically import libraries that
 * capture the WebSocket constructor when their module evaluates (the
 * solclientjs browser build does). The endpoint registry is late-bound, so a
 * class captured *now* routes to servers started *later*.
 */
import '../../src/auto.js';
import { afterAll, describe, expect, it } from 'vitest';
import { InMemorySolaceServer } from '../../src/browser.js';
import { FakeWebSocket } from '../../src/transport/in-memory-ws.js';

// What a solclientjs-style consumer does: capture at module evaluation,
// before any server exists.
const CapturedWebSocket = globalThis.WebSocket as unknown as typeof FakeWebSocket;

const server = new InMemorySolaceServer();

afterAll(async () => {
  await server.stop();
});

describe('mock-solace-server/browser/auto', () => {
  it('patches globalThis.WebSocket at import time', () => {
    expect(CapturedWebSocket).toBe(FakeWebSocket);
  });

  it('routes a constructor captured before start() to a server started after', async () => {
    const { smfWsUrl } = await server.start();
    const opened = await new Promise<boolean>((resolve, reject) => {
      const ws = new CapturedWebSocket(smfWsUrl, 'smf.solacesystems.com');
      const timer = setTimeout(() => reject(new Error('no open event')), 2000);
      ws.onopen = () => {
        clearTimeout(timer);
        expect(ws.protocol).toBe('smf.solacesystems.com');
        ws.close();
        resolve(true);
      };
      ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message ?? 'socket error'));
      };
    });
    expect(opened).toBe(true);
  });

  it('serves SEMP through the pre-installed fetch patch', async () => {
    const { sempUrl } = await server.start();
    const res = await fetch(`${sempUrl}/SEMP/v2/config/msgVpns`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { msgVpnName: string }[] };
    expect(body.data.map((v) => v.msgVpnName)).toContain('default');
  });

  it('stays installed (pass-through) after server.stop()', async () => {
    await server.stop();
    expect(globalThis.WebSocket as unknown).toBe(FakeWebSocket);
    expect(typeof globalThis.fetch).toBe('function');
  });
});
