/**
 * Minimal SDT (structured data type) codec — just enough to read and write
 * the binary-metadata block that carries correlationId/replyTo for
 * request/reply. See docs/protocol-notes.md §11.
 *
 * Field encoding: byte0 = (type << 2) | (lengthBytes - 1), then the length
 * (u8/u16/u32, INCLUSIVE of header byte and length bytes), then the value.
 */

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
  value: Buffer;
}

export function encodeSdtField(type: number, value: Buffer): Buffer {
  // Always use the 4-byte length form for simplicity (mode 3).
  const total = 1 + 4 + value.length;
  const out = Buffer.alloc(total);
  out.writeUInt8(((type & 0x3f) << 2) | 3, 0);
  out.writeUInt32BE(total, 1);
  value.copy(out, 5);
  return out;
}

/** Decodes one field at `offset`; returns the field and the next offset. */
export function decodeSdtField(buf: Buffer, offset: number): { field: SdtField; next: number } {
  const byte0 = buf.readUInt8(offset);
  const type = (byte0 & 0xfc) >> 2;
  const lenBytes = (byte0 & 0x03) + 1;
  let total: number;
  if (lenBytes === 1) total = buf.readUInt8(offset + 1);
  else if (lenBytes === 2) total = buf.readUInt16BE(offset + 1);
  else if (lenBytes === 4) total = buf.readUInt32BE(offset + 1);
  else throw new Error('unsupported SDT length mode');
  const valueStart = offset + 1 + lenBytes;
  const next = offset + total;
  if (total < 1 + lenBytes || next > buf.length) throw new Error('SDT field overruns buffer');
  return { field: { type, value: buf.subarray(valueStart, next) }, next };
}

/** Decodes consecutive fields covering `buf` entirely (a STREAM body). */
export function decodeSdtStream(buf: Buffer): SdtField[] {
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
export function decodeSdtMap(buf: Buffer): Map<string, SdtField> {
  const out = new Map<string, SdtField>();
  let pos = 0;
  while (pos < buf.length) {
    const key = decodeSdtField(buf, pos);
    pos = key.next;
    const value = decodeSdtField(buf, pos);
    pos = value.next;
    let name = key.field.value.toString('utf8');
    if (name.endsWith('\0')) name = name.slice(0, -1);
    out.set(name, value.field);
  }
  return out;
}

export function sdtString(s: string): Buffer {
  return encodeSdtField(SdtType.STRING, Buffer.from(`${s}\0`, 'utf8'));
}

/** Destination value: 1 byte type (0 = topic) + null-terminated name. */
export function sdtTopicDestination(name: string): Buffer {
  return encodeSdtField(
    SdtType.DESTINATION,
    Buffer.concat([Buffer.from([0]), Buffer.from(`${name}\0`, 'utf8')]),
  );
}

export function encodeSdtMapBody(entries: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  for (const [key, encodedValue] of entries) {
    parts.push(sdtString(key), encodedValue);
  }
  return Buffer.concat(parts);
}
