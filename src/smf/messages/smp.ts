import { SmfProtocol, SmpFlags, SmpMsgType, SmpMsgTypeId } from '../constants.js';
import { encodeSmfFrame, SmfDecodeError } from '../header.js';
import { encodeCorrelationTagParam, encodeResponseParam } from '../params.js';
import { alloc, concat, fromUtf8, readU32BE, toUtf8, writeU32BE } from '../../util/bytes.js';

/** Decoded SMP body. See docs/protocol-notes.md §6. */
export interface SmpMessage {
  msgType: SmpMsgTypeId;
  flags: number;
  subscription: string;
  queueName?: string;
}

/** Subscription/topic strings are null-terminated on the wire. */
function stripNull(s: string): string {
  return s.endsWith('\0') ? s.slice(0, -1) : s;
}

export function decodeSmp(payload: Uint8Array): SmpMessage {
  if (payload.length < 6) throw new SmfDecodeError('SMP body too short');
  const msgType = (payload[0]! & 0x7f) as SmpMsgTypeId;
  const len = readU32BE(payload, 1);
  if (len < 6 || len > payload.length) throw new SmfDecodeError('invalid SMP length');
  const flags = payload[5]!;
  if (msgType === SmpMsgType.ADDSUBSCRIPTION || msgType === SmpMsgType.REMSUBSCRIPTION) {
    return { msgType, flags, subscription: stripNull(toUtf8(payload, 6, len)) };
  }
  if (
    msgType === SmpMsgType.ADDQUEUESUBSCRIPTION ||
    msgType === SmpMsgType.REMQUEUESUBSCRIPTION
  ) {
    let pos = 6;
    const qLen = payload[pos]!;
    pos++;
    const queueName = stripNull(toUtf8(payload, pos, pos + qLen));
    pos += qLen;
    const sLen = payload[pos]!;
    pos++;
    const subscription = stripNull(toUtf8(payload, pos, pos + sLen));
    return { msgType, flags, subscription, queueName };
  }
  throw new SmfDecodeError(`unsupported SMP msgType ${msgType}`);
}

export function responseRequired(msg: SmpMessage): boolean {
  return (msg.flags & SmpFlags.RESPREQUIRED) !== 0;
}

function encodeSmpBody(msg: SmpMessage): Uint8Array {
  if (msg.queueName !== undefined) {
    const q = fromUtf8(`${msg.queueName}\0`);
    const s = fromUtf8(`${msg.subscription}\0`);
    const body = alloc(6 + 1 + q.length + 1 + s.length);
    body[0] = msg.msgType;
    writeU32BE(body, body.length, 1);
    body[5] = msg.flags;
    body[6] = q.length;
    body.set(q, 7);
    body[7 + q.length] = s.length;
    body.set(s, 8 + q.length);
    return body;
  }
  const sub = fromUtf8(`${msg.subscription}\0`);
  const body = alloc(6 + sub.length);
  body[0] = msg.msgType;
  writeU32BE(body, body.length, 1);
  body[5] = msg.flags;
  body.set(sub, 6);
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
): Uint8Array {
  const params: Uint8Array[] = [];
  if (correlationTag !== undefined) params.push(encodeCorrelationTagParam(correlationTag));
  params.push(encodeResponseParam(code, text));
  return encodeSmfFrame(
    { protocol: SmfProtocol.SMP, ttl: 1 },
    concat(params),
    encodeSmpBody(request),
  );
}

/** Encodes a standalone SMP request frame (used by tests). */
export function encodeSmpRequest(msg: SmpMessage, correlationTag?: number): Uint8Array {
  const params =
    correlationTag !== undefined ? encodeCorrelationTagParam(correlationTag) : alloc(0);
  return encodeSmfFrame({ protocol: SmfProtocol.SMP, ttl: 1 }, params, encodeSmpBody(msg));
}
