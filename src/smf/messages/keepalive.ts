import { SmfProtocol } from '../constants.js';
import { encodeSmfFrame } from '../header.js';

/**
 * KeepAliveV2 frame as sent by solclientjs: UH=2, TTL=2, no params/payload.
 * Exact bytes: 03 8b 00 02 | 00 00 00 0c | 00 00 00 0c
 */
export function encodeKeepAlive(): Uint8Array {
  return encodeSmfFrame({ protocol: SmfProtocol.KEEPALIVEV2, uh: 2, ttl: 2 });
}
