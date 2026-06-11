import { SmfLightParam, SmfParam } from './constants.js';
import { SmfDecodeError } from './header.js';

/**
 * Parsed SMF header parameters relevant to this broker. Unknown params are
 * skipped (matching the SDK's UH=0 behavior).
 */
export interface SmfParams {
  correlationTag?: number;
  ackImmediately?: boolean;
  topicName?: Buffer;
  username?: string;
  password?: string;
  responseCode?: number;
  responseString?: string;
  deliveryMode?: number;
  messagePriority?: number;
  userData?: Buffer;
  contentSummary?: Buffer;
  /** Raw bytes of every param, for re-encoding/forwarding scenarios. */
  raw: Buffer;
}

/** Decodes the parameter region of an SMF message: bytes [12, headerLen). */
export function decodeSmfParams(buf: Buffer, start: number, end: number): SmfParams {
  const params: SmfParams = { raw: buf.subarray(start, end) };
  let pos = start;
  while (pos < end) {
    const b = buf.readUInt8(pos);
    pos++;
    if (b & 0x20) {
      // Lightweight parameter: 3-bit type, 2-bit value length.
      const type = (b >>> 2) & 0x07;
      const valueLen = b & 0x03;
      if (pos + valueLen > end) throw new SmfDecodeError('lightweight param overruns header');
      switch (type) {
        case SmfLightParam.CORRELATION:
          params.correlationTag = buf.readUIntBE(pos, 3);
          break;
        case SmfLightParam.ACK_IMMEDIATELY:
          params.ackImmediately = valueLen > 0 ? !!buf.readUInt8(pos) : true;
          break;
        default:
          break;
      }
      pos += valueLen;
    } else {
      const type = b & 0x1f;
      // Type 0 is padding and terminates the parameter loop (SDK behavior).
      if (type === SmfParam.PADDING) break;
      let totalLen = buf.readUInt8(pos);
      pos++;
      let valueLen: number;
      if (totalLen === 0) {
        totalLen = buf.readUInt32BE(pos);
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
          params.username = Buffer.from(value.toString('latin1'), 'base64').toString('utf8');
          break;
        case SmfParam.PASSWORD:
          params.password = Buffer.from(value.toString('latin1'), 'base64').toString('utf8');
          break;
        case SmfParam.RESPONSE:
          params.responseCode = value.readInt32BE(0);
          params.responseString = value.subarray(4).toString('latin1');
          break;
        case SmfParam.DELIVERY_MODE:
          params.deliveryMode = value.length > 0 ? value.readUInt8(0) : undefined;
          break;
        case SmfParam.MESSAGE_PRIORITY:
          params.messagePriority = value.length > 0 ? value.readUInt8(0) : undefined;
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
export function encodeSmfParam(uh: number, type: number, value: Buffer): Buffer {
  const byte1 = ((uh & 0x03) << 6) | (type & 0x1f);
  if (value.length <= 253) {
    const out = Buffer.alloc(2 + value.length);
    out.writeUInt8(byte1, 0);
    out.writeUInt8(value.length + 2, 1);
    value.copy(out, 2);
    return out;
  }
  const out = Buffer.alloc(6 + value.length);
  out.writeUInt8(byte1, 0);
  out.writeUInt8(0, 1);
  out.writeUInt32BE(value.length + 6, 2);
  value.copy(out, 6);
  return out;
}

/** Encodes one lightweight SMF param (value must be 0-3 bytes). */
export function encodeLightSmfParam(uh: number, type: number, value: Buffer): Buffer {
  if (value.length > 3) throw new Error('lightweight param value too long');
  const byte1 = ((uh & 0x03) << 6) | 0x20 | ((type & 0x07) << 2) | value.length;
  return Buffer.concat([Buffer.from([byte1]), value]);
}

export function encodeCorrelationTagParam(tag: number): Buffer {
  const v = Buffer.alloc(3);
  v.writeUIntBE(tag & 0xffffff, 0, 3);
  return encodeLightSmfParam(0, SmfLightParam.CORRELATION, v);
}

export function encodeResponseParam(code: number, text: string): Buffer {
  const value = Buffer.alloc(4 + Buffer.byteLength(text, 'latin1'));
  value.writeInt32BE(code, 0);
  value.write(text, 4, 'latin1');
  return encodeSmfParam(0, SmfParam.RESPONSE, value);
}

export function encodeTopicNameParam(topic: Buffer | string): Buffer {
  const bytes = typeof topic === 'string' ? Buffer.from(topic, 'utf8') : topic;
  return encodeSmfParam(2, SmfParam.TR_TOPICNAME, bytes);
}
