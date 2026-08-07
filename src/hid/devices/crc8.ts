/**
 * CRC-8 with polynomial 0x31 initialised to 0xff.
 *
 * Sensirion's, and TI's on the HDC302x, and the same one the AS7341's family
 * uses -- a de facto standard across sensors that checksum their I2C words. The
 * libraries reject a mismatch outright, so a virtual part has to compute it
 * properly: a stub returning zeros fails every read.
 */
export function crc8(bytes: readonly number[]): number {
  let crc = 0xff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** Pack 16-bit words each followed by its checksum, as these parts do. */
export function withCrcs(bytes: readonly number[]): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    const pair = [bytes[i] ?? 0, bytes[i + 1] ?? 0];
    out.push(...pair, crc8(pair));
  }
  return Uint8Array.from(out);
}
