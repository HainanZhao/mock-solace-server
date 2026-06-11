/** Transport-agnostic connection carrying opaque byte chunks. */
export interface Connection {
  send(data: Buffer): void;
  close(): void;
  /** Bytes queued but not yet flushed to the peer. */
  bufferedAmount(): number;
  remoteAddress: string;
  onBytes(cb: (chunk: Buffer) => void): void;
  onClose(cb: () => void): void;
}
