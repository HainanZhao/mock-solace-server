import { AdMsgType, AdParam, SmfProtocol } from '../constants.js';
import { encodeSmfFrame, SmfDecodeError } from '../header.js';
import { encodeCorrelationTagParam, encodeResponseParam } from '../params.js';
import {
  alloc,
  concat,
  readU32BE,
  readU64BE,
  toUtf8,
  writeU32BE,
  writeU64BE,
} from '../../util/bytes.js';

const ADP_VERSION = 3;

export interface AckRange {
  min: number;
  max: number;
  outcome: number;
}

/** Decoded AdProtocol (AssuredCtrl) body. See docs/protocol-notes.md §10. */
export interface AdProtocolMessage {
  msgType: number;
  /** Raw param values keyed by type id (last occurrence wins). */
  params: Map<number, Uint8Array>;
  /** APPLICATION_ACK is a repeated param: one range per occurrence. */
  applicationAcks: AckRange[];
}

export function decodeAdProtocol(payload: Uint8Array): AdProtocolMessage {
  if (payload.length < 6) throw new SmfDecodeError('AdProtocol body too short');
  const version = payload[0]! & 0x3f;
  if (version !== ADP_VERSION) {
    throw new SmfDecodeError(`unsupported AdProtocol version ${version}`);
  }
  const msgType = payload[1]!;
  const msgLength = readU32BE(payload, 2);
  if (msgLength < 6 || msgLength > payload.length) {
    throw new SmfDecodeError('invalid AdProtocol length');
  }
  const params = new Map<number, Uint8Array>();
  const applicationAcks: AckRange[] = [];
  let pos = 6;
  while (pos < msgLength) {
    const b = payload[pos]!;
    pos++;
    const type = b & 0x3f;
    if (type === 0) continue; // padding
    let paramLen = payload[pos]!;
    pos++;
    let valueLen: number;
    if (paramLen === 0) {
      paramLen = readU32BE(payload, pos);
      pos += 4;
      valueLen = paramLen - 5;
    } else {
      valueLen = paramLen - 2;
    }
    if (valueLen < 0 || pos + valueLen > msgLength) {
      throw new SmfDecodeError(`AdProtocol param ${type} overruns body`);
    }
    const value = payload.subarray(pos, pos + valueLen);
    if (type === AdParam.APPLICATION_ACK && valueLen >= 16) {
      applicationAcks.push({
        min: Number(readU64BE(value, 0)),
        max: Number(readU64BE(value, 8)),
        outcome: valueLen >= 17 ? value[16]! : 0,
      });
    } else {
      params.set(type, value);
    }
    pos += valueLen;
  }
  return { msgType, params, applicationAcks };
}

function encodeAdParam(type: number, value: Uint8Array): Uint8Array {
  if (value.length <= 253) {
    return concat([Uint8Array.of(type & 0x3f, value.length + 2), value]);
  }
  const head = alloc(6);
  head[0] = type & 0x3f;
  head[1] = 0;
  writeU32BE(head, value.length + 5, 2);
  return concat([head, value]);
}

function u8(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff);
}

function u32(n: number): Uint8Array {
  const b = alloc(4);
  writeU32BE(b, n >>> 0, 0);
  return b;
}

function u64(n: number): Uint8Array {
  const b = alloc(8);
  writeU64BE(b, BigInt(n), 0);
  return b;
}

function encodeAdBody(msgType: number, params: Uint8Array[]): Uint8Array {
  const paramData = concat(params);
  const head = alloc(6);
  head[0] = ADP_VERSION;
  head[1] = msgType;
  writeU32BE(head, 6 + paramData.length, 2);
  return concat([head, paramData]);
}

export interface BindResponseOptions {
  correlationTag?: number;
  responseCode: number;
  responseText: string;
  flowId: number;
  windowSize: number;
  lastMsgIdAcked: number;
}

/**
 * BIND response. The SDK matches ADCTRL responses by the echoed SMF
 * correlation tag and requires msgType BIND + response code 200 with a FLOWID
 * param to take the consumer flow UP.
 */
export function encodeBindResponse(opts: BindResponseOptions): Uint8Array {
  const smfParams: Uint8Array[] = [];
  if (opts.correlationTag !== undefined) {
    smfParams.push(encodeCorrelationTagParam(opts.correlationTag));
  }
  smfParams.push(encodeResponseParam(opts.responseCode, opts.responseText));
  const adParams: Uint8Array[] =
    opts.responseCode === 200
      ? [
          encodeAdParam(AdParam.FLOWID, u32(opts.flowId)),
          encodeAdParam(AdParam.WINDOW, u8(opts.windowSize)),
          encodeAdParam(AdParam.TRANSPORT_WINDOW, u32(opts.windowSize)),
          encodeAdParam(AdParam.LASTMSGIDACKED, u64(opts.lastMsgIdAcked)),
          encodeAdParam(AdParam.LASTMSGIDRECEIVED, u64(opts.lastMsgIdAcked)),
          encodeAdParam(AdParam.ACTIVE_FLOW_INDICATION, u8(1)),
          encodeAdParam(AdParam.MAX_DELIVERED_UNACKED_MESSAGES_PER_FLOW, u32(10000)),
        ]
      : [];
  return encodeSmfFrame(
    { protocol: SmfProtocol.ADCTRL, ttl: 1 },
    concat(smfParams),
    encodeAdBody(AdMsgType.BIND, adParams),
  );
}

/** UNBIND (or other simple) response: echoed msgType + corrtag + code. */
export function encodeAdSimpleResponse(
  msgType: number,
  correlationTag: number | undefined,
  code: number,
  text: string,
  flowId?: number,
): Uint8Array {
  const smfParams: Uint8Array[] = [];
  if (correlationTag !== undefined) smfParams.push(encodeCorrelationTagParam(correlationTag));
  smfParams.push(encodeResponseParam(code, text));
  const adParams: Uint8Array[] = flowId !== undefined ? [encodeAdParam(AdParam.FLOWID, u32(flowId))] : [];
  return encodeSmfFrame(
    { protocol: SmfProtocol.ADCTRL, ttl: 1 },
    concat(smfParams),
    encodeAdBody(msgType, adParams),
  );
}

export function getAdString(msg: AdProtocolMessage, type: number): string | undefined {
  const v = msg.params.get(type);
  if (v === undefined) return undefined;
  const s = toUtf8(v);
  return s.endsWith('\0') ? s.slice(0, -1) : s;
}

export function getAdU32(msg: AdProtocolMessage, type: number): number | undefined {
  const v = msg.params.get(type);
  return v !== undefined && v.length >= 4 ? readU32BE(v, 0) : undefined;
}

export function getAdU8(msg: AdProtocolMessage, type: number): number | undefined {
  const v = msg.params.get(type);
  return v !== undefined && v.length >= 1 ? v[0] : undefined;
}

export function getAdU64(msg: AdProtocolMessage, type: number): number | undefined {
  const v = msg.params.get(type);
  return v !== undefined && v.length >= 8 ? Number(readU64BE(v, 0)) : undefined;
}
