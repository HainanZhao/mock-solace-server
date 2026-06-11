import { decodeSmfHeader, SmfHeader } from './header.js';
import { decodeSmfParams, SmfParams } from './params.js';

/** A fully decoded SMF message: header, parsed params, payload, raw frame. */
export interface SmfMessage {
  header: SmfHeader;
  params: SmfParams;
  /** Message body following the header (sub-protocol body or message payload). */
  payload: Buffer;
  /** The complete original frame, for zero-copy forwarding. */
  raw: Buffer;
}

/** Decodes a complete SMF frame (as produced by the framer). */
export function decodeSmf(buf: Buffer): SmfMessage {
  const header = decodeSmfHeader(buf, 0);
  const params = decodeSmfParams(buf, 12, header.headerLen);
  return {
    header,
    params,
    payload: buf.subarray(header.headerLen, header.msgLen),
    raw: buf,
  };
}
