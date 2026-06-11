/**
 * The only place the real solclientjs SDK is loaded. It is CJS/UMD; load via
 * createRequire and initialize the factory once.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const solace: any = require('solclientjs');

const factoryProps = new solace.SolclientFactoryProperties({
  profile: solace.SolclientFactoryProfiles.version10_5,
});
solace.SolclientFactory.init(factoryProps);
solace.SolclientFactory.setLogLevel(solace.LogLevel.WARN);

export interface TestSessionOptions {
  url: string;
  vpnName?: string;
  userName?: string;
  password?: string;
  clientName?: string;
  connectTimeoutInMsecs?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSession(opts: TestSessionOptions): any {
  return solace.SolclientFactory.createSession(
    new solace.SessionProperties({
      url: opts.url,
      vpnName: opts.vpnName ?? 'default',
      userName: opts.userName ?? 'test-user',
      password: opts.password ?? 'test-pass',
      clientName: opts.clientName,
      connectTimeoutInMsecs: opts.connectTimeoutInMsecs ?? 5000,
      reconnectRetries: 0,
      connectRetries: 0,
    }),
  );
}

/** Connects a session and resolves on UP_NOTICE, rejecting on failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function connectSession(session: any, timeoutMs = 8000): Promise<void> {
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
export function disconnectSession(session: any, timeoutMs = 5000): Promise<void> {
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

/** Subscribes with confirmation and resolves on SUBSCRIPTION_OK. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function subscribe(session: any, topic: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const correlationKey = `sub-${topic}-${Math.random()}`;
    const timer = setTimeout(
      () => reject(new Error(`timed out subscribing to ${topic}`)),
      timeoutMs,
    );
    const onOk = (e: { correlationKey?: unknown }): void => {
      if (e.correlationKey !== correlationKey) return;
      cleanup();
      resolve();
    };
    const onErr = (e: { correlationKey?: unknown; infoStr?: string }): void => {
      if (e.correlationKey !== correlationKey) return;
      cleanup();
      reject(new Error(`SUBSCRIPTION_ERROR for ${topic}: ${e.infoStr ?? ''}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
    };
    session.on(solace.SessionEventCode.SUBSCRIPTION_OK, onOk);
    session.on(solace.SessionEventCode.SUBSCRIPTION_ERROR, onErr);
    session.subscribe(
      solace.SolclientFactory.createTopicDestination(topic),
      true,
      correlationKey,
      timeoutMs,
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function publishText(session: any, topic: string, text: string): void {
  const msg = solace.SolclientFactory.createMessage();
  msg.setDestination(solace.SolclientFactory.createTopicDestination(topic));
  msg.setBinaryAttachment(text);
  msg.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
  session.send(msg);
}

/** Collects messages received by a session into an array. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectMessages(session: any): { topic: string; payload: string }[] {
  const received: { topic: string; payload: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session.on(solace.SessionEventCode.MESSAGE, (message: any) => {
    received.push({
      topic: message.getDestination().getName(),
      payload: message.getBinaryAttachment()?.toString() ?? '',
    });
  });
  return received;
}

export function waitFor<T>(
  fn: () => T | undefined | false,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      const result = fn();
      if (result) return resolve(result);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
