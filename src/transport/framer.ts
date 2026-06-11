import { SMF_MIN_HEADER_LEN, SMF_VERSION } from '../smf/constants.js';
import { alloc, concat, readU32BE } from '../util/bytes.js';

const DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024;

/**
 * Stateful byte-stream reassembler: accepts arbitrary chunks (WS frames or TCP
 * segments) and emits complete SMF frames. One chunk may carry several SMF
 * messages or a fraction of one.
 */
export class SmfFramer {
  private buffered: Uint8Array = alloc(0);

  constructor(
    private readonly onFrame: (frame: Uint8Array) => void,
    private readonly onError: (err: Error) => void,
    private readonly maxMessageBytes = DEFAULT_MAX_MESSAGE,
  ) {}

  push(chunk: Uint8Array): void {
    this.buffered =
      this.buffered.length === 0 ? chunk : concat([this.buffered, chunk]);
    while (this.buffered.length >= SMF_MIN_HEADER_LEN) {
      const version = this.buffered[0]! & 0x07;
      if (version !== SMF_VERSION) {
        this.onError(new Error(`lost SMF framing: version=${version}`));
        this.buffered = alloc(0);
        return;
      }
      const headerLen = readU32BE(this.buffered, 4);
      const msgLen = readU32BE(this.buffered, 8);
      if (msgLen < headerLen || headerLen < SMF_MIN_HEADER_LEN || msgLen > this.maxMessageBytes) {
        this.onError(new Error(`invalid SMF lengths header=${headerLen} msg=${msgLen}`));
        this.buffered = alloc(0);
        return;
      }
      if (this.buffered.length < msgLen) return;
      const frame = this.buffered.subarray(0, msgLen);
      this.buffered = this.buffered.subarray(msgLen);
      this.onFrame(frame);
    }
  }
}
