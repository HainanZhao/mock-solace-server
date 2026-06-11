/** Transport-agnostic connection carrying opaque byte chunks. */
export interface Connection {
  send(data: Uint8Array): void;
  close(): void;
  /** Bytes queued but not yet flushed to the peer. */
  bufferedAmount(): number;
  remoteAddress: string;
  onBytes(cb: (chunk: Uint8Array) => void): void;
  onClose(cb: () => void): void;
}
