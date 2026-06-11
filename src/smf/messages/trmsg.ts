import { SmfProtocol } from '../constants.js';
import { SmfMessage } from '../codec.js';
import { encodeSmfFrame } from '../header.js';
import { encodeTopicNameParam } from '../params.js';

/** A direct message as seen by the broker. */
export interface DirectMessage {
  topic: string;
  /** Message body bytes (binary attachment region, may include SDT containers). */
  payload: Buffer;
  /** Original frame for zero-copy fan-out to subscribers. */
  raw: Buffer;
}

export function trMsgFromSmf(msg: SmfMessage): DirectMessage | null {
  if (msg.header.protocol !== SmfProtocol.TRMSG) return null;
  if (!msg.params.topicName) return null;
  // Topic bytes are null-terminated on the wire.
  let topicBytes = msg.params.topicName;
  if (topicBytes.length > 0 && topicBytes[topicBytes.length - 1] === 0) {
    topicBytes = topicBytes.subarray(0, -1);
  }
  return {
    topic: topicBytes.toString('utf8'),
    payload: msg.payload,
    raw: msg.raw,
  };
}

/**
 * Encodes a broker-originated direct message with a bare binary-attachment
 * payload (the SDK treats a payload without a content summary as a single
 * binary attachment).
 */
export function encodeDirectMessage(topic: string, payload: Buffer): Buffer {
  return encodeSmfFrame(
    { protocol: SmfProtocol.TRMSG, ttl: 255 },
    encodeTopicNameParam(`${topic}\0`),
    payload,
  );
}
