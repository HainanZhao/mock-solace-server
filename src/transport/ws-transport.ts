import { createServer, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { WS_SUBPROTOCOL } from '../smf/constants.js';
import { Connection } from './connection.js';

class WsConnection implements Connection {
  private bytesCb: ((chunk: Uint8Array) => void) | undefined;
  private closeCb: (() => void) | undefined;
  readonly remoteAddress: string;

  constructor(private readonly ws: WebSocket, remoteAddress: string) {
    this.remoteAddress = remoteAddress;
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary || !this.bytesCb) return;
      if (Buffer.isBuffer(data)) this.bytesCb(data);
      else if (Array.isArray(data)) this.bytesCb(Buffer.concat(data));
      else this.bytesCb(Buffer.from(data));
    });
    ws.on('close', () => this.closeCb?.());
    ws.on('error', () => ws.close());
  }

  send(data: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }

  bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  onBytes(cb: (chunk: Uint8Array) => void): void {
    this.bytesCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
}

export class WsTransport {
  private http: HttpServer | undefined;
  private wss: WebSocketServer | undefined;

  constructor(private readonly onConnection: (conn: Connection) => void) {}

  async listen(host: string, port: number): Promise<number> {
    this.http = createServer();
    this.wss = new WebSocketServer({
      server: this.http,
      // solclientjs offers 'smf.solacesystems.com'; accept it (or none).
      handleProtocols: (protocols) =>
        protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false,
    });
    this.wss.on('connection', (ws, req) => {
      this.onConnection(new WsConnection(ws, req.socket.remoteAddress ?? 'unknown'));
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(port, host, () => resolve());
    });
    const addr = this.http.address();
    if (addr === null || typeof addr === 'string') throw new Error('no listen address');
    return addr.port;
  }

  async close(): Promise<void> {
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
  }
}
