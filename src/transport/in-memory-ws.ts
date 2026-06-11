import { WS_SUBPROTOCOL } from '../smf/constants.js';
import { Connection } from './connection.js';

/**
 * In-memory WebSocket transport: a fake WebSocket class installed on
 * globalThis so an unmodified solclientjs browser build connects straight
 * into the broker core with no network. URLs without a registered endpoint
 * fall through to the platform WebSocket.
 *
 * The fake mirrors the parts of the W3C WebSocket API solclientjs uses:
 * binaryType on the prototype (its capability probe checks
 * `'binaryType' in WebSocket.prototype`), handler properties assigned after
 * construction, ArrayBuffer message events, bufferedAmount, and the
 * smf.solacesystems.com subprotocol echo.
 */

type AcceptFn = (conn: Connection) => void;

const endpoints = new Map<string, AcceptFn>();
let savedWebSocket: unknown;
let installed = false;
let pinned = false;

function originKey(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

interface FakeEvent {
  type: string;
  target: unknown;
  data?: ArrayBuffer;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  message?: string;
}

type EventHandler = (event: FakeEvent) => void;

/** Server half of an in-memory socket pair, handed to the broker. */
class InMemoryConnection implements Connection {
  readonly remoteAddress = 'in-memory';
  private bytesCb: ((chunk: Uint8Array) => void) | undefined;
  private closeCb: (() => void) | undefined;

  constructor(private readonly socket: FakeWebSocket) {}

  send(data: Uint8Array): void {
    this.socket.deliverFromServer(data);
  }

  close(): void {
    this.socket.closeFromServer();
  }

  bufferedAmount(): number {
    return 0;
  }

  onBytes(cb: (chunk: Uint8Array) => void): void {
    this.bytesCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  receiveFromClient(chunk: Uint8Array): void {
    this.bytesCb?.(chunk);
  }

  notifyClosed(): void {
    this.closeCb?.();
  }
}

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  protocol = '';
  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;

  onopen: EventHandler | null = null;
  onmessage: EventHandler | null = null;
  onclose: EventHandler | null = null;
  onerror: EventHandler | null = null;

  private _binaryType = 'arraybuffer';
  private conn: InMemoryConnection | undefined;
  private readonly extraListeners = new Map<string, Set<EventHandler>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    const accept = endpoints.get(originKey(url));
    if (!accept) {
      const Real = savedWebSocket as (new (u: string, p?: string | string[]) => unknown) | undefined;
      if (!Real) {
        throw new Error(
          `no in-memory Solace endpoint registered for ${url} and no platform WebSocket to fall back to`,
        );
      }
      // Constructor-return override: non-mock URLs get a real socket.
      return new Real(url, protocols) as FakeWebSocket;
    }

    const offered = typeof protocols === 'string' ? [protocols] : (protocols ?? []);
    if (offered.includes(WS_SUBPROTOCOL)) this.protocol = WS_SUBPROTOCOL;

    // Open on a macrotask, like a real socket: solclientjs assigns its
    // handlers synchronously after construction.
    setTimeout(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.conn = new InMemoryConnection(this);
      this.readyState = FakeWebSocket.OPEN;
      accept(this.conn);
      this.dispatch({ type: 'open', target: this });
    }, 0);
  }

  get binaryType(): string {
    return this._binaryType;
  }

  set binaryType(value: string) {
    this._binaryType = value;
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('InvalidStateError: WebSocket is not open');
    }
    let bytes: Uint8Array;
    if (typeof data === 'string') bytes = new TextEncoder().encode(data);
    else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } else bytes = new Uint8Array(data.slice(0));
    // Deliver on a microtask so broker replies never re-enter send().
    queueMicrotask(() => {
      if (this.readyState === FakeWebSocket.OPEN) this.conn?.receiveFromClient(bytes);
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSING || this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    const wasConnecting = this.readyState === FakeWebSocket.CONNECTING;
    this.readyState = FakeWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.CLOSED;
      if (!wasConnecting) this.conn?.notifyClosed();
      this.dispatch({ type: 'close', target: this, code, reason, wasClean: true });
    });
  }

  addEventListener(type: string, listener: EventHandler): void {
    let set = this.extraListeners.get(type);
    if (!set) {
      set = new Set();
      this.extraListeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventHandler): void {
    this.extraListeners.get(type)?.delete(listener);
  }

  /** Broker → client bytes (always a fresh ArrayBuffer message event). */
  deliverFromServer(data: Uint8Array): void {
    const copy = data.slice().buffer as ArrayBuffer;
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.dispatch({ type: 'message', target: this, data: copy });
    });
  }

  /** Broker-initiated close (e.g. server.stop()). */
  closeFromServer(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => {
      this.conn?.notifyClosed();
      this.dispatch({ type: 'close', target: this, code, reason, wasClean: true });
    });
  }

  private dispatch(event: FakeEvent): void {
    const handlers: Record<string, EventHandler | null> = {
      open: this.onopen,
      message: this.onmessage,
      close: this.onclose,
      error: this.onerror,
    };
    handlers[event.type]?.call(this, event);
    for (const listener of this.extraListeners.get(event.type) ?? []) listener.call(this, event);
  }
}

function install(): void {
  if (installed) return;
  savedWebSocket = (globalThis as Record<string, unknown>)['WebSocket'];
  (globalThis as Record<string, unknown>)['WebSocket'] = FakeWebSocket;
  installed = true;
}

function restore(): void {
  if (!installed || pinned) return;
  if (savedWebSocket === undefined) delete (globalThis as Record<string, unknown>)['WebSocket'];
  else (globalThis as Record<string, unknown>)['WebSocket'] = savedWebSocket;
  installed = false;
}

/**
 * Eagerly installs the WebSocket interceptor and pins it: it stays installed
 * across server stop()/start() cycles instead of being restored when the
 * last endpoint unregisters. With no endpoints registered, the fake class
 * passes every connection through to the platform WebSocket, so pinning is
 * observable only by identity (`globalThis.WebSocket !== platform class`).
 *
 * This exists for the `mock-solace-server/browser/auto` entry point, which
 * lets libraries that capture the WebSocket constructor at module-evaluation
 * time (like the solclientjs browser build) be imported statically.
 */
export function installWebSocketInterceptor(): void {
  pinned = true;
  install();
}

/**
 * Registers an in-memory SMF endpoint and patches globalThis.WebSocket
 * (first registration installs the patch; removing the last restores it).
 * Returns an unregister function.
 *
 * Must run before solclientjs is imported: its browser build captures the
 * WebSocket constructor at module-evaluation time.
 */
export function registerInMemoryWsEndpoint(url: string, accept: AcceptFn): () => void {
  const key = originKey(url);
  if (endpoints.has(key)) throw new Error(`in-memory endpoint already registered for ${key}`);
  endpoints.set(key, accept);
  install();
  return () => {
    endpoints.delete(key);
    if (endpoints.size === 0) restore();
  };
}
