/** Flat format LE encoding helpers (port of cpp-rpc flat_encoding.hpp). */

export const FLAT_FORMAT_WIDTH_U8 = 0
export const FLAT_FORMAT_WIDTH_U16 = 1
export const FLAT_FORMAT_WIDTH_U32 = 2

const scratch = new ArrayBuffer(8)
const scratchView = new DataView(scratch)

export function offsetWidth(maxCp: number): number {
  if (maxCp < 256) return 1
  if (maxCp < 65536) return 2
  return 4
}

export function packFormat(width: number): number {
  if (width === 1) return FLAT_FORMAT_WIDTH_U8
  if (width === 2) return FLAT_FORMAT_WIDTH_U16
  return FLAT_FORMAT_WIDTH_U32
}

export function unpackWidth(format: number): number {
  switch (format & 0x3) {
    case FLAT_FORMAT_WIDTH_U8: return 1
    case FLAT_FORMAT_WIDTH_U16: return 2
    default: return 4
  }
}

export function trailerSize(k: number, width: number): number {
  if (k === 0) return 0
  return 2 + k * width
}

export function storeLeU8(dest: Uint8Array, offset: number, value: number): void {
  dest[offset] = value & 0xff
}

export function storeLeI8(dest: Uint8Array, offset: number, value: number): void {
  dest[offset] = value & 0xff
}

export function storeLeU16(dest: Uint8Array, offset: number, value: number): void {
  scratchView.setUint16(0, value & 0xffff, true)
  dest[offset] = scratchView.getUint8(0)
  dest[offset + 1] = scratchView.getUint8(1)
}

export function storeLeI16(dest: Uint8Array, offset: number, value: number): void {
  scratchView.setInt16(0, value, true)
  dest[offset] = scratchView.getUint8(0)
  dest[offset + 1] = scratchView.getUint8(1)
}

export function storeLeU32(dest: Uint8Array, offset: number, value: number): void {
  scratchView.setUint32(0, value >>> 0, true)
  dest[offset] = scratchView.getUint8(0)
  dest[offset + 1] = scratchView.getUint8(1)
  dest[offset + 2] = scratchView.getUint8(2)
  dest[offset + 3] = scratchView.getUint8(3)
}

export function storeLeI32(dest: Uint8Array, offset: number, value: number): void {
  scratchView.setInt32(0, value | 0, true)
  dest[offset] = scratchView.getUint8(0)
  dest[offset + 1] = scratchView.getUint8(1)
  dest[offset + 2] = scratchView.getUint8(2)
  dest[offset + 3] = scratchView.getUint8(3)
}

export function storeLeU64(dest: Uint8Array, offset: number, value: bigint | number): void {
  scratchView.setBigUint64(0, BigInt(value), true)
  for (let i = 0; i < 8; ++i) dest[offset + i] = scratchView.getUint8(i)
}

export function storeLeI64(dest: Uint8Array, offset: number, value: bigint | number): void {
  scratchView.setBigInt64(0, BigInt(value), true)
  for (let i = 0; i < 8; ++i) dest[offset + i] = scratchView.getUint8(i)
}

export function storeLeF32(dest: Uint8Array, offset: number, value: number): void {
  scratchView.setFloat32(0, value, true)
  for (let i = 0; i < 4; ++i) dest[offset + i] = scratchView.getUint8(i)
}

export function storeLeF64(dest: Uint8Array, offset: number, value: number): void {
  scratchView.setFloat64(0, value, true)
  for (let i = 0; i < 8; ++i) dest[offset + i] = scratchView.getUint8(i)
}

export function loadLeU8(src: Uint8Array, offset: number): number {
  return src[offset]
}

export function loadLeI8(src: Uint8Array, offset: number): number {
  return (src[offset] << 24) >> 24
}

export function loadLeU16(src: Uint8Array, offset: number): number {
  return src[offset] | (src[offset + 1] << 8)
}

export function loadLeI16(src: Uint8Array, offset: number): number {
  const v = src[offset] | (src[offset + 1] << 8)
  return (v << 16) >> 16
}

export function loadLeU32(src: Uint8Array, offset: number): number {
  return (
    (src[offset] |
      (src[offset + 1] << 8) |
      (src[offset + 2] << 16) |
      (src[offset + 3] << 24)) >>> 0
  )
}

export function loadLeI32(src: Uint8Array, offset: number): number {
  return (
    src[offset] |
    (src[offset + 1] << 8) |
    (src[offset + 2] << 16) |
    (src[offset + 3] << 24)
  )
}

export function loadLeU64(src: Uint8Array, offset: number): bigint {
  for (let i = 0; i < 8; ++i) scratchView.setUint8(i, src[offset + i])
  return scratchView.getBigUint64(0, true)
}

export function loadLeI64(src: Uint8Array, offset: number): bigint {
  for (let i = 0; i < 8; ++i) scratchView.setUint8(i, src[offset + i])
  return scratchView.getBigInt64(0, true)
}

export function loadLeF32(src: Uint8Array, offset: number): number {
  for (let i = 0; i < 4; ++i) scratchView.setUint8(i, src[offset + i])
  return scratchView.getFloat32(0, true)
}

export function loadLeF64(src: Uint8Array, offset: number): number {
  for (let i = 0; i < 8; ++i) scratchView.setUint8(i, src[offset + i])
  return scratchView.getFloat64(0, true)
}

/** Allocate a small LE buffer for a value. */
export function leBytesU32(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  storeLeU32(buf, 0, value)
  return buf
}

export function leBytesI32(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  storeLeI32(buf, 0, value)
  return buf
}

export function storeCp(dest: Uint8Array, offset: number, cp: number, width: number): void {
  if (width === 1) dest[offset] = cp & 0xff
  else if (width === 2) storeLeU16(dest, offset, cp)
  else storeLeU32(dest, offset, cp)
}

export function loadCp(src: Uint8Array, offset: number, width: number): number {
  if (width === 1) return src[offset]
  if (width === 2) return loadLeU16(src, offset)
  return loadLeU32(src, offset)
}

/** Append `[format][cp × count]` to `out`. */
export function appendOffsetTable(out: number[], offs: ReadonlyArray<number>): void {
  let maxOff = 0
  for (const o of offs) if (o > maxOff) maxOff = o
  const width = offsetWidth(maxOff)
  const format = packFormat(width)
  out.push(format)
  const buf = new Uint8Array(4)
  for (const o of offs) {
    storeCp(buf, 0, o, width)
    for (let i = 0; i < width; ++i) out.push(buf[i])
  }
}

/** Append `[format][cp × count][format]` to `out`. No-op if count === 0. */
export function appendOffsetTrailer(out: number[], offs: ReadonlyArray<number>): void {
  if (offs.length === 0) return
  let maxOff = 0
  for (const o of offs) if (o > maxOff) maxOff = o
  const width = offsetWidth(maxOff)
  const format = packFormat(width)
  out.push(format)
  const buf = new Uint8Array(4)
  for (const o of offs) {
    storeCp(buf, 0, o, width)
    for (let i = 0; i < width; ++i) out.push(buf[i])
  }
  out.push(format)
}

/** Compare two byte ranges like memcmp; shorter equal-prefix is smaller. */
export function memcmpBytes(a: Uint8Array, aOff: number, aLen: number, b: Uint8Array, bOff: number, bLen: number): number {
  const m = Math.min(aLen, bLen)
  for (let i = 0; i < m; ++i) {
    const d = a[aOff + i] - b[bOff + i]
    if (d !== 0) return d
  }
  return aLen - bLen
}
