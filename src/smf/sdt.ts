/**
 * Minimal SDT (structured data type) codec — just enough to read and write
 * the binary-metadata block that carries correlationId/replyTo for
 * request/reply. See docs/protocol-notes.md §11.
 *
 * Field encoding: byte0 = (type << 2) | (lengthBytes - 1), then the length
 * (u8/u16/u32, INCLUSIVE of header byte and length bytes), then the value.
 */

import { alloc, concat, fromUtf8, readU16BE, readU32BE, toUtf8, writeU32BE } from '../util/bytes.js';

export const SdtType = {
  NULL: 0,
  BOOLEAN: 1,
  INTEGER: 2,
  UINTEGER: 3,
  FLOAT: 4,
  CHAR: 5,
  BYTEARRAY: 6,
  STRING: 7,
  DESTINATION: 8,
  SMF_MESSAGE: 9,
  MAP: 10,
  STREAM: 11,
} as const;

export interface SdtField {
  type: number;
  value: Uint8Array;
}

export function encodeSdtField(type: number, value: Uint8Array): Uint8Array {
  // Always use the 4-byte length form for simplicity (mode 3).
  const total = 1 + 4 + value.length;
  const out = alloc(total);
  out[0] = ((type & 0x3f) << 2) | 3;
  writeU32BE(out, total, 1);
  out.set(value, 5);
  return out;
}

/** Decodes one field at `offset`; returns the field and the next offset. */
export function decodeSdtField(buf: Uint8Array, offset: number): { field: SdtField; next: number } {
  const byte0 = buf[offset]!;
  const type = (byte0 & 0xfc) >> 2;
  const lenBytes = (byte0 & 0x03) + 1;
  let total: number;
  if (lenBytes === 1) total = buf[offset + 1]!;
  else if (lenBytes === 2) total = readU16BE(buf, offset + 1);
  else if (lenBytes === 4) total = readU32BE(buf, offset + 1);
  else throw new Error('unsupported SDT length mode');
  const valueStart = offset + 1 + lenBytes;
  const next = offset + total;
  if (total < 1 + lenBytes || next > buf.length) throw new Error('SDT field overruns buffer');
  return { field: { type, value: buf.subarray(valueStart, next) }, next };
}

/** Decodes consecutive fields covering `buf` entirely (a STREAM body). */
export function decodeSdtStream(buf: Uint8Array): SdtField[] {
  const fields: SdtField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const { field, next } = decodeSdtField(buf, pos);
    fields.push(field);
    pos = next;
  }
  return fields;
}

/** Decodes a MAP body: alternating string-key fields and value fields. */
export function decodeSdtMap(buf: Uint8Array): Map<string, SdtField> {
  const out = new Map<string, SdtField>();
  let pos = 0;
  while (pos < buf.length) {
    const key = decodeSdtField(buf, pos);
    pos = key.next;
    const value = decodeSdtField(buf, pos);
    pos = value.next;
    let name = toUtf8(key.field.value);
    if (name.endsWith('\0')) name = name.slice(0, -1);
    out.set(name, value.field);
  }
  return out;
}

export function sdtString(s: string): Uint8Array {
  return encodeSdtField(SdtType.STRING, fromUtf8(`${s}\0`));
}

/** Destination value: 1 byte type (0 = topic) + null-terminated name. */
export function sdtTopicDestination(name: string): Uint8Array {
  return encodeSdtField(
    SdtType.DESTINATION,
    concat([Uint8Array.of(0), fromUtf8(`${name}\0`)]),
  );
}

export function encodeSdtMapBody(entries: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [key, encodedValue] of entries) {
    parts.push(sdtString(key), encodedValue);
  }
  return concat(parts);
}
