/**
 * Runtime-neutral byte helpers replacing Node's Buffer API so the broker
 * core runs in both Node and browsers. All multi-byte reads/writes are
 * big-endian, matching SMF wire order.
 */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');
const latin1Decoder = new TextDecoder('latin1');

export const EMPTY = new Uint8Array(0);

export function alloc(size: number): Uint8Array {
  return new Uint8Array(size);
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function fromUtf8(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}

export function toUtf8(b: Uint8Array, start = 0, end = b.length): string {
  return utf8Decoder.decode(b.subarray(start, end));
}

export function utf8Length(s: string): number {
  return utf8Encoder.encode(s).length;
}

export function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function toLatin1(b: Uint8Array, start = 0, end = b.length): string {
  return latin1Decoder.decode(b.subarray(start, end));
}

/** Write a latin1 string into buf at offset; returns bytes written. */
export function writeLatin1(buf: Uint8Array, text: string, offset: number): number {
  for (let i = 0; i < text.length; i++) buf[offset + i] = text.charCodeAt(i) & 0xff;
  return text.length;
}

/** Decode standard base64 text to bytes (atob exists in browsers and Node >= 16). */
export function fromBase64(s: string): Uint8Array {
  return fromLatin1(atob(s));
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export function readU16BE(b: Uint8Array, offset: number): number {
  return view(b).getUint16(offset);
}

export function writeU16BE(b: Uint8Array, value: number, offset: number): void {
  view(b).setUint16(offset, value);
}

export function readU32BE(b: Uint8Array, offset: number): number {
  return view(b).getUint32(offset);
}

export function writeU32BE(b: Uint8Array, value: number, offset: number): void {
  view(b).setUint32(offset, value);
}

export function readI32BE(b: Uint8Array, offset: number): number {
  return view(b).getInt32(offset);
}

export function writeI32BE(b: Uint8Array, value: number, offset: number): void {
  view(b).setInt32(offset, value);
}

export function readU64BE(b: Uint8Array, offset: number): bigint {
  return view(b).getBigUint64(offset);
}

export function writeU64BE(b: Uint8Array, value: bigint, offset: number): void {
  view(b).setBigUint64(offset, value);
}

/** Big-endian unsigned int of 1-6 bytes (Buffer.readUIntBE equivalent). */
export function readUIntBE(b: Uint8Array, offset: number, byteLength: number): number {
  let value = 0;
  for (let i = 0; i < byteLength; i++) value = value * 256 + b[offset + i]!;
  return value;
}

/** Big-endian unsigned int of 1-6 bytes (Buffer.writeUIntBE equivalent). */
export function writeUIntBE(b: Uint8Array, value: number, offset: number, byteLength: number): void {
  for (let i = byteLength - 1; i >= 0; i--) {
    b[offset + i] = value & 0xff;
    value = Math.floor(value / 256);
  }
}
