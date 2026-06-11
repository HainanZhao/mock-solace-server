/**
 * Binary-metadata handling for request/reply: extracts correlationId and
 * replyTo from a published message, and builds reply frames the SDK's
 * sendRequest() matching accepts. See docs/protocol-notes.md §11.
 */
import { SmfMessage } from '../codec.js';
import { SmfProtocol } from '../constants.js';
import { encodeSmfFrame } from '../header.js';
import { encodeSmfParam, encodeTopicNameParam } from '../params.js';
import { SmfParam } from '../constants.js';
import {
  decodeSdtField,
  decodeSdtMap,
  decodeSdtStream,
  encodeSdtField,
  encodeSdtMapBody,
  SdtType,
  sdtString,
  sdtTopicDestination,
} from '../sdt.js';
import {
  alloc,
  concat,
  readU16BE,
  readU32BE,
  readUIntBE,
  toUtf8,
  writeU16BE,
  writeU32BE,
  writeUIntBE,
} from '../../util/bytes.js';

export const ContentElementType = {
  XML_META: 0,
  XML_PAYLOAD: 1,
  BINARY_ATTACHMENT: 2,
  BINARY_METADATA: 4,
} as const;

interface ContentElement {
  type: number;
  length: number;
}

/** Parses the MESSAGE_CONTENT_SUMMARY param value: (type<<4|lenMode) + length. */
export function parseContentSummary(value: Uint8Array): ContentElement[] {
  const elements: ContentElement[] = [];
  let pos = 0;
  while (pos < value.length) {
    const b = value[pos]!;
    const type = (b >> 4) & 0x0f;
    const lenMode = b & 0x0f;
    pos++;
    let length: number;
    switch (lenMode) {
      case 2:
        length = value[pos]!;
        pos += 1;
        break;
      case 3:
        length = readU16BE(value, pos);
        pos += 2;
        break;
      case 4:
        length = readUIntBE(value, pos, 3);
        pos += 3;
        break;
      case 5:
        length = readU32BE(value, pos);
        pos += 4;
        break;
      default:
        throw new Error(`unsupported content summary length mode ${lenMode}`);
    }
    elements.push({ type, length });
  }
  return elements;
}

function encodeContentElement(type: number, length: number): Uint8Array {
  if (length <= 0xff) return Uint8Array.of((type << 4) | 2, length);
  if (length <= 0xffff) {
    const b = alloc(3);
    b[0] = (type << 4) | 3;
    writeU16BE(b, length, 1);
    return b;
  }
  const b = alloc(5);
  b[0] = (type << 4) | 5;
  writeU32BE(b, length, 1);
  return b;
}

export interface MessageMeta {
  correlationId?: string;
  replyToTopic?: string;
  isReply: boolean;
  /** The binary-attachment portion of the payload (the message body). */
  attachment: Uint8Array;
}

function stripNull(s: string): string {
  return s.endsWith('\0') ? s.slice(0, -1) : s;
}

/**
 * Splits a TrMsg payload into content elements and decodes the metadata
 * block (correlationId, replyTo, reply flag) when present.
 */
export function extractMessageMeta(msg: SmfMessage): MessageMeta {
  const meta: MessageMeta = { isReply: false, attachment: msg.payload };
  const summary = msg.params.contentSummary;
  if (!summary) return meta; // bare payload = single binary attachment
  let offset = 0;
  for (const element of parseContentSummary(summary)) {
    const chunk = msg.payload.subarray(offset, offset + element.length);
    offset += element.length;
    if (element.type === ContentElementType.BINARY_ATTACHMENT) {
      meta.attachment = chunk;
    } else if (element.type === ContentElementType.BINARY_METADATA) {
      decodeMetaBlock(chunk, meta);
    }
  }
  return meta;
}

function decodeMetaBlock(chunk: Uint8Array, meta: MessageMeta): void {
  // BinaryMetaBlock: u8 chunk count, u8 type, u24 length, SDT payload.
  if (chunk.length < 5 || chunk[0] !== 1) return;
  const sdtPayload = chunk.subarray(5);
  try {
    const { field: stream } = decodeSdtField(sdtPayload, 0);
    if (stream.type !== SdtType.STREAM) return;
    const elements = decodeSdtStream(stream.value);
    const preamble = elements[0];
    if (preamble?.type === SdtType.BYTEARRAY && preamble.value.length >= 2) {
      meta.isReply = (preamble.value[1]! & 0x80) !== 0;
    }
    const outerMap = elements[1];
    if (outerMap?.type !== SdtType.MAP) return;
    const headerField = decodeSdtMap(outerMap.value).get('h');
    if (headerField?.type !== SdtType.MAP) return;
    const headers = decodeSdtMap(headerField.value);
    const ci = headers.get('ci');
    if (ci?.type === SdtType.STRING) meta.correlationId = stripNull(toUtf8(ci.value));
    const rt = headers.get('rt');
    if (rt?.type === SdtType.DESTINATION && rt.value.length >= 2) {
      // value = u8 destination type (0 = topic) + null-terminated name
      meta.replyToTopic = stripNull(toUtf8(rt.value.subarray(1)));
    }
  } catch {
    // Malformed/unknown metadata: leave meta fields unset.
  }
}

export interface OutboundMessageOptions {
  /** Marks the message as a reply (required for sendRequest matching). */
  isReply?: boolean;
  correlationId?: string;
  replyToTopic?: string;
}

/**
 * Builds a broker-originated TrMsg. Without metadata options this is a plain
 * direct message; with them, the payload carries a binary-metadata block the
 * SDK decodes into correlationId/replyTo/reply-flag.
 */
export function buildOutboundMessage(
  topic: string,
  payload: Uint8Array,
  opts: OutboundMessageOptions = {},
): Uint8Array {
  const needsMeta = opts.isReply || opts.correlationId !== undefined || opts.replyToTopic !== undefined;
  if (!needsMeta) {
    return encodeSmfFrame(
      { protocol: SmfProtocol.TRMSG, ttl: 255 },
      encodeTopicNameParam(`${topic}\0`),
      payload,
    );
  }

  const headerEntries: [string, Uint8Array][] = [];
  if (opts.correlationId !== undefined) headerEntries.push(['ci', sdtString(opts.correlationId)]);
  if (opts.replyToTopic !== undefined) {
    headerEntries.push(['rt', sdtTopicDestination(opts.replyToTopic)]);
  }
  const outerMapBody = encodeSdtMapBody([
    ['h', encodeSdtField(SdtType.MAP, encodeSdtMapBody(headerEntries))],
  ]);
  // Preamble: byte0 = 0x80 (binary message), byte1 = 0x80 if reply.
  const preamble = encodeSdtField(
    SdtType.BYTEARRAY,
    Uint8Array.of(0x80, opts.isReply ? 0x80 : 0x00),
  );
  const sdtPayload = encodeSdtField(
    SdtType.STREAM,
    concat([preamble, encodeSdtField(SdtType.MAP, outerMapBody)]),
  );
  const metaBlock = alloc(5 + sdtPayload.length);
  metaBlock[0] = 1; // chunk count
  metaBlock[1] = 0; // type 0 = SDT metadata
  writeUIntBE(metaBlock, sdtPayload.length, 2, 3);
  metaBlock.set(sdtPayload, 5);

  const summary = concat([
    encodeContentElement(ContentElementType.BINARY_ATTACHMENT, payload.length),
    encodeContentElement(ContentElementType.BINARY_METADATA, metaBlock.length),
  ]);
  const params = concat([
    encodeTopicNameParam(`${topic}\0`),
    encodeSmfParam(2, SmfParam.MESSAGE_CONTENT_SUMMARY, summary),
  ]);
  return encodeSmfFrame(
    { protocol: SmfProtocol.TRMSG, ttl: 255 },
    params,
    concat([payload, metaBlock]),
  );
}
