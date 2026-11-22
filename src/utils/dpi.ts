/**
 * Binary DPI metadata injection for JPEG (JFIF APP0) and PNG (pHYs chunk).
 * Ensures exported ID photos pass government & exam registration DPI verification.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Writes exact DPI (e.g., 300 or 350) into a JPEG Blob's JFIF APP0 segment.
 * If an APP0 JFIF segment already exists, updates its density unit & X/Y density in place.
 * Otherwise, inserts a standard 18-byte JFIF APP0 segment immediately after SOI (0xFFD8).
 */
export async function injectJpegDpi(blob: Blob, dpi: number): Promise<Blob> {
  const safeDpi = Math.max(72, Math.min(1200, Math.round(dpi)));
  const buffer = await blob.arrayBuffer();
  const data = new Uint8Array(buffer);

  // Verify JPEG SOI marker (0xFF 0xD8)
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return blob;
  }

  const dpiHigh = (safeDpi >> 8) & 0xff;
  const dpiLow = safeDpi & 0xff;

  // Scan segments after SOI for an existing JFIF APP0 segment
  let offset = 2;
  while (offset + 4 < data.length) {
    if (data[offset] !== 0xff) break;
    const marker = data[offset + 1];

    // SOS (Start of Scan) or EOI -> stop scanning headers
    if (marker === 0xda || marker === 0xd9) break;

    // Standalone markers without length
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const segLen = (data[offset + 2] << 8) | data[offset + 3];
    if (segLen < 2 || offset + 2 + segLen > data.length) break;

    // APP0 (0xFFE0) with "JFIF\0" identifier
    if (
      marker === 0xe0 &&
      segLen >= 16 &&
      data[offset + 4] === 0x4a && // 'J'
      data[offset + 5] === 0x46 && // 'F'
      data[offset + 6] === 0x49 && // 'I'
      data[offset + 7] === 0x46 && // 'F'
      data[offset + 8] === 0x00
    ) {
      // offset + 9..10: version (1.1)
      // offset + 11: density units (1 = pixels per inch / DPI)
      // offset + 12..13: Xdensity
      // offset + 14..15: Ydensity
      data[offset + 11] = 0x01;
      data[offset + 12] = dpiHigh;
      data[offset + 13] = dpiLow;
      data[offset + 14] = dpiHigh;
      data[offset + 15] = dpiLow;
      return new Blob([data], { type: 'image/jpeg' });
    }

    offset += 2 + segLen;
  }

  // No JFIF APP0 found -> insert one immediately after SOI (0xFF 0xD8)
  const app0 = new Uint8Array([
    0xff, 0xe0, // APP0 marker
    0x00, 0x10, // Length = 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // Version 1.01
    0x01, // Units: dots per inch
    dpiHigh, dpiLow, // Xdensity
    dpiHigh, dpiLow, // Ydensity
    0x00, 0x00, // No thumbnail
  ]);

  const output = new Uint8Array(data.length + app0.length);
  output.set(data.subarray(0, 2), 0);
  output.set(app0, 2);
  output.set(data.subarray(2), 2 + app0.length);

  return new Blob([output], { type: 'image/jpeg' });
}

/**
 * Writes exact DPI into a PNG Blob via the pHYs chunk (pixels per meter).
 */
export async function injectPngDpi(blob: Blob, dpi: number): Promise<Blob> {
  const safeDpi = Math.max(72, Math.min(1200, Math.round(dpi)));
  const buffer = await blob.arrayBuffer();
  const data = new Uint8Array(buffer);

  // Verify PNG signature (8 bytes)
  if (
    data.length < 33 ||
    data[0] !== 0x89 ||
    data[1] !== 0x50 ||
    data[2] !== 0x4e ||
    data[3] !== 0x47
  ) {
    return blob;
  }

  const ppm = Math.round(safeDpi / 0.0254);

  // Build pHYs chunk (4 len + 4 type + 9 data + 4 crc = 21 bytes)
  const physChunk = new Uint8Array(21);
  const physView = new DataView(physChunk.buffer);
  physView.setUint32(0, 9, false); // data length = 9
  physChunk[4] = 0x70; // 'p'
  physChunk[5] = 0x48; // 'H'
  physChunk[6] = 0x59; // 'Y'
  physChunk[7] = 0x73; // 's'
  physView.setUint32(8, ppm, false); // X pixels per meter
  physView.setUint32(12, ppm, false); // Y pixels per meter
  physChunk[16] = 1; // unit = meter
  const crc = crc32(physChunk.subarray(4, 17));
  physView.setUint32(17, crc, false);

  // Find end of IHDR chunk and strip any existing pHYs chunk
  const chunks: Uint8Array[] = [data.subarray(0, 8)];
  let offset = 8;
  let inserted = false;

  while (offset + 12 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset + offset, 8);
    const length = view.getUint32(0, false);
    const type = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7]
    );
    const totalLen = 12 + length;
    if (offset + totalLen > data.length) break;

    if (type !== 'pHYs') {
      chunks.push(data.subarray(offset, offset + totalLen));
    }
    if (type === 'IHDR' && !inserted) {
      chunks.push(physChunk);
      inserted = true;
    }

    offset += totalLen;
  }

  const totalSize = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }

  return new Blob([out], { type: 'image/png' });
}

export async function injectImageDpi(blob: Blob, dpi: number): Promise<Blob> {
  if (blob.type === 'image/jpeg') {
    return injectJpegDpi(blob, dpi);
  }
  if (blob.type === 'image/png') {
    return injectPngDpi(blob, dpi);
  }
  return blob;
}
