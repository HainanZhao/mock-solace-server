import { SmfProtocol, SmpFlags, SmpMsgType, SmpMsgTypeId } from '../constants.js';
import { encodeSmfFrame, SmfDecodeError } from '../header.js';
import { encodeCorrelationTagParam, encodeResponseParam } from '../params.js';

/** Decoded SMP body. See docs/protocol-notes.md §6. */
export interface SmpMessage {
  msgType: SmpMsgTypeId;
  flags: number;
  subscription: string;
  queueName?: string;
}

export function decodeSmp(payload: Buffer): SmpMessage {
  if (payload.length < 6) throw new SmfDecodeError('SMP body too short');
  const msgType = (payload.readUInt8(0) & 0x7f) as SmpMsgTypeId;
  const len = payload.readUInt32BE(1);
  if (len < 6 || len > payload.length) throw new SmfDecodeError('invalid SMP length');
  const flags = payload.readUInt8(5);
  if (msgType === SmpMsgType.ADDSUBSCRIPTION || msgType === SmpMsgType.REMSUBSCRIPTION) {
    return { msgType, flags, subscription: payload.toString('utf8', 6, len) };
  }
  if (
    msgType === SmpMsgType.ADDQUEUESUBSCRIPTION ||
    msgType === SmpMsgType.REMQUEUESUBSCRIPTION
  ) {
    let pos = 6;
    const qLen = payload.readUInt8(pos);
    pos++;
    const queueName = payload.toString('utf8', pos, pos + qLen);
    pos += qLen;
    const sLen = payload.readUInt8(pos);
    pos++;
    const subscription = payload.toString('utf8', pos, pos + sLen);
    return { msgType, flags, subscription, queueName };
  }
  throw new SmfDecodeError(`unsupported SMP msgType ${msgType}`);
}

export function responseRequired(msg: SmpMessage): boolean {
  return (msg.flags & SmpFlags.RESPREQUIRED) !== 0;
}

function encodeSmpBody(msg: SmpMessage): Buffer {
  if (msg.queueName !== undefined) {
    const q = Buffer.from(msg.queueName, 'utf8');
    const s = Buffer.from(msg.subscription, 'utf8');
    const body = Buffer.alloc(6 + 1 + q.length + 1 + s.length);
    body.writeUInt8(msg.msgType, 0);
    body.writeUInt32BE(body.length, 1);
    body.writeUInt8(msg.flags, 5);
    body.writeUInt8(q.length, 6);
    q.copy(body, 7);
    body.writeUInt8(s.length, 7 + q.length);
    s.copy(body, 8 + q.length);
    return body;
  }
  const sub = Buffer.from(msg.subscription, 'utf8');
  const body = Buffer.alloc(6 + sub.length);
  body.writeUInt8(msg.msgType, 0);
  body.writeUInt32BE(body.length, 1);
  body.writeUInt8(msg.flags, 5);
  sub.copy(body, 6);
  return body;
}

/**
 * Builds an SMP response frame: the request body echoed back with the
 * correlation tag and a Response param in the SMF header. The SDK matches on
 * the correlation tag and reads the response code (200 = SUBSCRIPTION_OK).
 */
export function encodeSmpResponse(
  request: SmpMessage,
  correlationTag: number | undefined,
  code: number,
  text: string,
): Buffer {
  const params: Buffer[] = [];
  if (correlationTag !== undefined) params.push(encodeCorrelationTagParam(correlationTag));
  params.push(encodeResponseParam(code, text));
  return encodeSmfFrame(
    { protocol: SmfProtocol.SMP, ttl: 1 },
    Buffer.concat(params),
    encodeSmpBody(request),
  );
}

/** Encodes a standalone SMP request frame (used by tests). */
export function encodeSmpRequest(msg: SmpMessage, correlationTag?: number): Buffer {
  const params =
    correlationTag !== undefined ? encodeCorrelationTagParam(correlationTag) : Buffer.alloc(0);
  return encodeSmfFrame({ protocol: SmfProtocol.SMP, ttl: 1 }, params, encodeSmpBody(msg));
}
