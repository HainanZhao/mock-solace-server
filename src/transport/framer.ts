import { SMF_MIN_HEADER_LEN, SMF_VERSION } from '../smf/constants.js';

const DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024;

/**
 * Stateful byte-stream reassembler: accepts arbitrary chunks (WS frames or TCP
 * segments) and emits complete SMF frames. One chunk may carry several SMF
 * messages or a fraction of one.
 */
export class SmfFramer {
  private buffered: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onFrame: (frame: Buffer) => void,
    private readonly onError: (err: Error) => void,
    private readonly maxMessageBytes = DEFAULT_MAX_MESSAGE,
  ) {}

  push(chunk: Buffer): void {
    this.buffered =
      this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length >= SMF_MIN_HEADER_LEN) {
      const version = this.buffered.readUInt8(0) & 0x07;
      if (version !== SMF_VERSION) {
        this.onError(new Error(`lost SMF framing: version=${version}`));
        this.buffered = Buffer.alloc(0);
        return;
      }
      const headerLen = this.buffered.readUInt32BE(4);
      const msgLen = this.buffered.readUInt32BE(8);
      if (msgLen < headerLen || headerLen < SMF_MIN_HEADER_LEN || msgLen > this.maxMessageBytes) {
        this.onError(new Error(`invalid SMF lengths header=${headerLen} msg=${msgLen}`));
        this.buffered = Buffer.alloc(0);
        return;
      }
      if (this.buffered.length < msgLen) return;
      const frame = this.buffered.subarray(0, msgLen);
      this.buffered = this.buffered.subarray(msgLen);
      this.onFrame(frame);
    }
  }
}
