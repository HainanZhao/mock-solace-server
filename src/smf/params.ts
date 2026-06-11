import { SmfLightParam, SmfParam } from './constants.js';
import { SmfDecodeError } from './header.js';
import {
  alloc,
  concat,
  fromBase64,
  fromUtf8,
  readI32BE,
  readU32BE,
  readUIntBE,
  toLatin1,
  toUtf8,
  writeI32BE,
  writeLatin1,
  writeU32BE,
  writeUIntBE,
} from '../util/bytes.js';

/**
 * Parsed SMF header parameters relevant to this broker. Unknown params are
 * skipped (matching the SDK's UH=0 behavior).
 */
export interface SmfParams {
  correlationTag?: number;
  ackImmediately?: boolean;
  topicName?: Uint8Array;
  username?: string;
  password?: string;
  responseCode?: number;
  responseString?: string;
  deliveryMode?: number;
  messagePriority?: number;
  userData?: Uint8Array;
  contentSummary?: Uint8Array;
  /** Raw bytes of every param, for re-encoding/forwarding scenarios. */
  raw: Uint8Array;
}

/** Decodes the parameter region of an SMF message: bytes [12, headerLen). */
export function decodeSmfParams(buf: Uint8Array, start: number, end: number): SmfParams {
  const params: SmfParams = { raw: buf.subarray(start, end) };
  let pos = start;
  while (pos < end) {
    const b = buf[pos]!;
    pos++;
    if (b & 0x20) {
      // Lightweight parameter: 3-bit type, 2-bit value length.
      const type = (b >>> 2) & 0x07;
      const valueLen = b & 0x03;
      if (pos + valueLen > end) throw new SmfDecodeError('lightweight param overruns header');
      switch (type) {
        case SmfLightParam.CORRELATION:
          params.correlationTag = readUIntBE(buf, pos, 3);
          break;
        case SmfLightParam.ACK_IMMEDIATELY:
          params.ackImmediately = valueLen > 0 ? !!buf[pos] : true;
          break;
        default:
          break;
      }
      pos += valueLen;
    } else {
      const type = b & 0x1f;
      // Type 0 is padding and terminates the parameter loop (SDK behavior).
      if (type === SmfParam.PADDING) break;
      let totalLen = buf[pos]!;
      pos++;
      let valueLen: number;
      if (totalLen === 0) {
        totalLen = readU32BE(buf, pos);
        pos += 4;
        valueLen = totalLen - 6;
      } else {
        valueLen = totalLen - 2;
      }
      if (valueLen < 0 || pos + valueLen > end) {
        throw new SmfDecodeError(`param type ${type} overruns header`);
      }
      const value = buf.subarray(pos, pos + valueLen);
      switch (type) {
        case SmfParam.TR_TOPICNAME:
          params.topicName = value;
          break;
        case SmfParam.USERNAME:
          params.username = toUtf8(fromBase64(toLatin1(value)));
          break;
        case SmfParam.PASSWORD:
          params.password = toUtf8(fromBase64(toLatin1(value)));
          break;
        case SmfParam.RESPONSE:
          params.responseCode = readI32BE(value, 0);
          params.responseString = toLatin1(value, 4);
          break;
        case SmfParam.DELIVERY_MODE:
          params.deliveryMode = value.length > 0 ? value[0] : undefined;
          break;
        case SmfParam.MESSAGE_PRIORITY:
          params.messagePriority = value.length > 0 ? value[0] : undefined;
          break;
        case SmfParam.USERDATA:
          params.userData = value;
          break;
        case SmfParam.MESSAGE_CONTENT_SUMMARY:
          params.contentSummary = value;
          break;
        default:
          break;
      }
      pos += valueLen;
    }
  }
  return params;
}

/** Encodes one standard SMF param (extended length form when needed). */
export function encodeSmfParam(uh: number, type: number, value: Uint8Array): Uint8Array {
  const byte1 = ((uh & 0x03) << 6) | (type & 0x1f);
  if (value.length <= 253) {
    const out = alloc(2 + value.length);
    out[0] = byte1;
    out[1] = value.length + 2;
    out.set(value, 2);
    return out;
  }
  const out = alloc(6 + value.length);
  out[0] = byte1;
  out[1] = 0;
  writeU32BE(out, value.length + 6, 2);
  out.set(value, 6);
  return out;
}

/** Encodes one lightweight SMF param (value must be 0-3 bytes). */
export function encodeLightSmfParam(uh: number, type: number, value: Uint8Array): Uint8Array {
  if (value.length > 3) throw new Error('lightweight param value too long');
  const byte1 = ((uh & 0x03) << 6) | 0x20 | ((type & 0x07) << 2) | value.length;
  return concat([Uint8Array.of(byte1), value]);
}

export function encodeCorrelationTagParam(tag: number): Uint8Array {
  const v = alloc(3);
  writeUIntBE(v, tag & 0xffffff, 0, 3);
  return encodeLightSmfParam(0, SmfLightParam.CORRELATION, v);
}

export function encodeResponseParam(code: number, text: string): Uint8Array {
  const value = alloc(4 + text.length);
  writeI32BE(value, code, 0);
  writeLatin1(value, text, 4);
  return encodeSmfParam(0, SmfParam.RESPONSE, value);
}

export function encodeTopicNameParam(topic: Uint8Array | string): Uint8Array {
  const bytes = typeof topic === 'string' ? fromUtf8(topic) : topic;
  return encodeSmfParam(2, SmfParam.TR_TOPICNAME, bytes);
}
