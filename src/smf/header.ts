import { SMF_MIN_HEADER_LEN, SMF_VERSION } from './constants.js';
import { alloc, concat, readU32BE, writeU32BE } from '../util/bytes.js';

/** Decoded SMF fixed header (12 bytes). See docs/protocol-notes.md §1. */
export interface SmfHeader {
  di: boolean;
  elidingEligible: boolean;
  dto: boolean;
  adf: boolean;
  dmqe: boolean;
  uh: number;
  protocol: number;
  priority: number;
  ttl: number;
  /** Offset where the payload begins (12 + encoded params length). */
  headerLen: number;
  /** Total message length including header and payload. */
  msgLen: number;
}

export class SmfDecodeError extends Error {}

/** Reads the fixed header. `buf` must contain at least 12 bytes at `offset`. */
export function decodeSmfHeader(buf: Uint8Array, offset = 0): SmfHeader {
  if (buf.length - offset < SMF_MIN_HEADER_LEN) {
    throw new SmfDecodeError('buffer too short for SMF header');
  }
  const w1 = readU32BE(buf, offset);
  const version = (w1 >>> 24) & 0x07;
  if (version !== SMF_VERSION) {
    throw new SmfDecodeError(`invalid SMF version ${version}`);
  }
  const headerLen = readU32BE(buf, offset + 4);
  const msgLen = readU32BE(buf, offset + 8);
  if (headerLen < SMF_MIN_HEADER_LEN || msgLen < headerLen) {
    throw new SmfDecodeError(`invalid SMF lengths header=${headerLen} msg=${msgLen}`);
  }
  return {
    di: !!((w1 >>> 31) & 1),
    elidingEligible: !!((w1 >>> 30) & 1),
    dto: !!((w1 >>> 29) & 1),
    adf: !!((w1 >>> 28) & 1),
    dmqe: !!((w1 >>> 27) & 1),
    uh: (w1 >>> 22) & 0x03,
    protocol: (w1 >>> 16) & 0x3f,
    priority: (w1 >>> 12) & 0x0f,
    ttl: w1 & 0xff,
    headerLen,
    msgLen,
  };
}

export interface SmfHeaderFields {
  protocol: number;
  ttl?: number;
  uh?: number;
  priority?: number;
  di?: boolean;
  elidingEligible?: boolean;
  dto?: boolean;
  adf?: boolean;
  dmqe?: boolean;
}

/** Builds a full SMF frame around already-encoded params and payload. */
export function encodeSmfFrame(
  fields: SmfHeaderFields,
  params: Uint8Array = alloc(0),
  payload: Uint8Array = alloc(0),
): Uint8Array {
  const headerLen = SMF_MIN_HEADER_LEN + params.length;
  const msgLen = headerLen + payload.length;
  let w1 = 0;
  if (fields.di) w1 |= 1 << 31;
  if (fields.elidingEligible) w1 |= 1 << 30;
  if (fields.dto) w1 |= 1 << 29;
  if (fields.adf) w1 |= 1 << 28;
  if (fields.dmqe) w1 |= 1 << 27;
  w1 |= SMF_VERSION << 24;
  w1 |= (fields.uh ?? 0) << 22;
  w1 |= (fields.protocol & 0x3f) << 16;
  w1 |= (fields.priority ?? 0) << 12;
  w1 |= (fields.ttl ?? 0) & 0xff;
  const head = alloc(SMF_MIN_HEADER_LEN);
  writeU32BE(head, w1 >>> 0, 0);
  writeU32BE(head, headerLen, 4);
  writeU32BE(head, msgLen, 8);
  return concat([head, params, payload]);
}
