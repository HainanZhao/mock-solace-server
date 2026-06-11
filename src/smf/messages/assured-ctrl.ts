import { AdMsgType, AdParam, SmfProtocol } from '../constants.js';
import { encodeSmfFrame, SmfDecodeError } from '../header.js';
import { encodeCorrelationTagParam, encodeResponseParam } from '../params.js';

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
  params: Map<number, Buffer>;
  /** APPLICATION_ACK is a repeated param: one range per occurrence. */
  applicationAcks: AckRange[];
}

export function decodeAdProtocol(payload: Buffer): AdProtocolMessage {
  if (payload.length < 6) throw new SmfDecodeError('AdProtocol body too short');
  const version = payload.readUInt8(0) & 0x3f;
  if (version !== ADP_VERSION) {
    throw new SmfDecodeError(`unsupported AdProtocol version ${version}`);
  }
  const msgType = payload.readUInt8(1);
  const msgLength = payload.readUInt32BE(2);
  if (msgLength < 6 || msgLength > payload.length) {
    throw new SmfDecodeError('invalid AdProtocol length');
  }
  const params = new Map<number, Buffer>();
  const applicationAcks: AckRange[] = [];
  let pos = 6;
  while (pos < msgLength) {
    const b = payload.readUInt8(pos);
    pos++;
    const type = b & 0x3f;
    if (type === 0) continue; // padding
    let paramLen = payload.readUInt8(pos);
    pos++;
    let valueLen: number;
    if (paramLen === 0) {
      paramLen = payload.readUInt32BE(pos);
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
        min: Number(value.readBigUInt64BE(0)),
        max: Number(value.readBigUInt64BE(8)),
        outcome: valueLen >= 17 ? value.readUInt8(16) : 0,
      });
    } else {
      params.set(type, value);
    }
    pos += valueLen;
  }
  return { msgType, params, applicationAcks };
}

function encodeAdParam(type: number, value: Buffer): Buffer {
  if (value.length <= 253) {
    return Buffer.concat([Buffer.from([type & 0x3f, value.length + 2]), value]);
  }
  const head = Buffer.alloc(6);
  head.writeUInt8(type & 0x3f, 0);
  head.writeUInt8(0, 1);
  head.writeUInt32BE(value.length + 5, 2);
  return Buffer.concat([head, value]);
}

function u8(n: number): Buffer {
  return Buffer.from([n & 0xff]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

function encodeAdBody(msgType: number, params: Buffer[]): Buffer {
  const paramData = Buffer.concat(params);
  const head = Buffer.alloc(6);
  head.writeUInt8(ADP_VERSION, 0);
  head.writeUInt8(msgType, 1);
  head.writeUInt32BE(6 + paramData.length, 2);
  return Buffer.concat([head, paramData]);
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
export function encodeBindResponse(opts: BindResponseOptions): Buffer {
  const smfParams: Buffer[] = [];
  if (opts.correlationTag !== undefined) {
    smfParams.push(encodeCorrelationTagParam(opts.correlationTag));
  }
  smfParams.push(encodeResponseParam(opts.responseCode, opts.responseText));
  const adParams: Buffer[] =
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
    Buffer.concat(smfParams),
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
): Buffer {
  const smfParams: Buffer[] = [];
  if (correlationTag !== undefined) smfParams.push(encodeCorrelationTagParam(correlationTag));
  smfParams.push(encodeResponseParam(code, text));
  const adParams: Buffer[] = flowId !== undefined ? [encodeAdParam(AdParam.FLOWID, u32(flowId))] : [];
  return encodeSmfFrame(
    { protocol: SmfProtocol.ADCTRL, ttl: 1 },
    Buffer.concat(smfParams),
    encodeAdBody(msgType, adParams),
  );
}

export function getAdString(msg: AdProtocolMessage, type: number): string | undefined {
  const v = msg.params.get(type);
  if (v === undefined) return undefined;
  const s = v.toString('utf8');
  return s.endsWith('\0') ? s.slice(0, -1) : s;
}

export function getAdU32(msg: AdProtocolMessage, type: number): number | undefined {
  const v = msg.params.get(type);
  return v !== undefined && v.length >= 4 ? v.readUInt32BE(0) : undefined;
}

export function getAdU8(msg: AdProtocolMessage, type: number): number | undefined {
  const v = msg.params.get(type);
  return v !== undefined && v.length >= 1 ? v.readUInt8(0) : undefined;
}

export function getAdU64(msg: AdProtocolMessage, type: number): number | undefined {
  const v = msg.params.get(type);
  return v !== undefined && v.length >= 8 ? Number(v.readBigUInt64BE(0)) : undefined;
}
