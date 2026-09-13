/**
 * Watchface preview decoder for modern Xiaomi smart band binaries.
 *
 * Adapted from band10-toolkit (MIT License):
 * Copyright (c) 2025 utsabfdahal
 * https://github.com/utsabfdahal/band10-toolkit
 */

export const MAIN_HEADER_SIZE = 0xa8;
export const IMAGE_HEADER_SIZE = 12;
export const PALETTE_BYTES = 256 * 4;
export const MAX_DIMENSION = 800;
export const MAX_PIXELS = 800 * 800;
export const MAGIC = Buffer.from([0x5a, 0xa5, 0x34, 0x12]);
export const COMPRESSED_MAGIC = Buffer.from([0xe0, 0x21, 0xa5, 0x5a]);

const MAX_RUN = 0x7f;

export interface DecodedWatchfacePreview {
  id: string;
  name: string;
  width: number;
  height: number;
  bgra: Buffer;
}

export function assertRange(
  buffer: Uint8Array,
  offset: number,
  length: number,
  label = 'read',
): void {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new RangeError(
      `${label} is outside the binary: offset=${offset}, length=${length}, size=${buffer.length}`,
    );
  }
}

export function readU16LE(buffer: Uint8Array, offset: number): number {
  assertRange(buffer, offset, 2, 'u16');
  return (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8);
}

export function readU32LE(buffer: Uint8Array, offset: number): number {
  assertRange(buffer, offset, 4, 'u32');
  return (
    ((buffer[offset] ?? 0) |
      ((buffer[offset + 1] ?? 0) << 8) |
      ((buffer[offset + 2] ?? 0) << 16) |
      ((buffer[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

export function readNullTerminated(
  buffer: Uint8Array,
  offset: number,
  maximum: number,
): string {
  assertRange(buffer, offset, maximum, 'string');
  let end = offset;
  while (end < offset + maximum && buffer[end] !== 0) {
    end += 1;
  }
  return new TextDecoder('utf-8').decode(buffer.subarray(offset, end));
}

/**
 * Older Xiaomi image RLE (v1).
 * Adapted from band10-toolkit (MIT License).
 */
export function decodeRleV1(
  encoded: Uint8Array,
  expectedLength: number,
  bytesPerPixel: number,
): Uint8Array {
  const output = new Uint8Array(expectedLength);
  let inputOffset = 0;
  let outputOffset = 0;

  while (inputOffset < encoded.length && outputOffset < output.length) {
    const control = encoded[inputOffset++] ?? 0;
    const count = control & MAX_RUN;
    if (count === 0) {
      throw new Error('RLE v1 contains a zero-length packet');
    }

    if ((control & 0x80) === 0) {
      if (inputOffset + bytesPerPixel > encoded.length) {
        throw new RangeError('Truncated RLE v1 repeat packet');
      }
      const pixel = encoded.subarray(inputOffset, inputOffset + bytesPerPixel);
      inputOffset += bytesPerPixel;
      for (let repeat = 0; repeat < count; repeat += 1) {
        if (outputOffset + bytesPerPixel > output.length) {
          throw new RangeError('RLE v1 expands beyond its declared size');
        }
        output.set(pixel, outputOffset);
        outputOffset += bytesPerPixel;
      }
    } else {
      const literalLength = count * bytesPerPixel;
      if (
        inputOffset + literalLength > encoded.length ||
        outputOffset + literalLength > output.length
      ) {
        throw new RangeError('Truncated RLE v1 literal packet');
      }
      output.set(
        encoded.subarray(inputOffset, inputOffset + literalLength),
        outputOffset,
      );
      inputOffset += literalLength;
      outputOffset += literalLength;
    }
  }

  if (outputOffset !== expectedLength) {
    throw new RangeError(
      `RLE v1 produced ${outputOffset} bytes; expected ${expectedLength}`,
    );
  }
  return output;
}

/**
 * Palette/index RLE (v2) used by modern Xiaomi band binaries.
 * Adapted from band10-toolkit (MIT License).
 */
export function decodeRleV2(
  encoded: Uint8Array,
  expectedLength: number,
): Uint8Array {
  const output = new Uint8Array(expectedLength);
  let inputOffset = 0;
  let outputOffset = 0;

  while (inputOffset < encoded.length && outputOffset < output.length) {
    const control = encoded[inputOffset++] ?? 0;
    const count = control & MAX_RUN;
    if (count === 0) {
      throw new Error('RLE v2 contains a zero-length packet');
    }

    if ((control & 0x80) !== 0) {
      if (
        inputOffset + count > encoded.length ||
        outputOffset + count > output.length
      ) {
        throw new RangeError('Truncated RLE v2 literal packet');
      }
      output.set(
        encoded.subarray(inputOffset, inputOffset + count),
        outputOffset,
      );
      inputOffset += count;
      outputOffset += count;
    } else {
      if (
        inputOffset >= encoded.length ||
        outputOffset + count > output.length
      ) {
        throw new RangeError('Truncated RLE v2 repeat packet');
      }
      output.fill(encoded[inputOffset++] ?? 0, outputOffset, outputOffset + count);
      outputOffset += count;
    }
  }

  if (outputOffset !== expectedLength) {
    throw new RangeError(
      `RLE v2 produced ${outputOffset} bytes; expected ${expectedLength}`,
    );
  }
  return output;
}

function hasCompressedMagic(buffer: Uint8Array, offset: number): boolean {
  if (offset + COMPRESSED_MAGIC.length > buffer.length) return false;
  for (let i = 0; i < COMPRESSED_MAGIC.length; i++) {
    if (buffer[offset + i] !== COMPRESSED_MAGIC[i]) return false;
  }
  return true;
}

export function decodeWatchfacePreview(file: Uint8Array): DecodedWatchfacePreview {
  if (file.length < MAIN_HEADER_SIZE) {
    throw new RangeError(
      `Invalid header: file size ${file.length} is less than main header size ${MAIN_HEADER_SIZE}`,
    );
  }

  for (let i = 0; i < MAGIC.length; i++) {
    if (file[i] !== MAGIC[i]) {
      throw new Error('Invalid magic header');
    }
  }

  const id = readNullTerminated(file, 0x28, 9);
  const name = readNullTerminated(file, 0x68, 60);

  const previewOffset = readU32LE(file, 0x20);
  if (
    previewOffset < MAIN_HEADER_SIZE ||
    previewOffset + IMAGE_HEADER_SIZE > file.length
  ) {
    throw new RangeError(
      `previewOffset ${previewOffset} is outside binary range (file size: ${file.length})`,
    );
  }

  const sign = file[previewOffset] ?? 0;
  const width = readU16LE(file, previewOffset + 4);
  const height = readU16LE(file, previewOffset + 6);
  const encodedLength = readU32LE(file, previewOffset + 8);

  if (width === 0 || height === 0) {
    throw new Error(`Invalid image dimensions: ${width}x${height}`);
  }

  if (
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new Error(
      `Oversized image dimensions: ${width}x${height} (${width * height} pixels)`,
    );
  }

  if (sign !== 0 && sign !== 3 && sign !== 6 && sign !== 0x10) {
    throw new Error(`Unsupported image sign/encoding: ${sign}`);
  }

  const payloadOffset = previewOffset + IMAGE_HEADER_SIZE;
  assertRange(file, payloadOffset, encodedLength, 'image payload');

  const pixelCount = width * height;
  let raw: Uint8Array;
  let bytesPerPixel: number;

  if (encodedLength >= 8 && hasCompressedMagic(file, payloadOffset)) {
    const info = readU32LE(file, payloadOffset + 4);
    bytesPerPixel = info & 0x0f;
    const expectedLength = info >>> 4;

    const maxAllowedBytes = MAX_PIXELS * 4 + PALETTE_BYTES;
    if (expectedLength <= 0 || expectedLength > maxAllowedBytes) {
      throw new RangeError(
        `Invalid compressed expected length: ${expectedLength}`,
      );
    }

    const encoded = file.subarray(
      payloadOffset + 8,
      payloadOffset + encodedLength,
    );
    raw =
      sign === 0x10 || bytesPerPixel === 1
        ? decodeRleV2(encoded, expectedLength)
        : decodeRleV1(encoded, expectedLength, bytesPerPixel);
  } else {
    raw = file.subarray(payloadOffset, payloadOffset + encodedLength);
    bytesPerPixel = sign === 6 ? 3 : sign === 3 ? 2 : sign === 0x10 ? 1 : 4;
  }

  const bgra = Buffer.alloc(pixelCount * 4);

  if (sign === 0x10 || bytesPerPixel === 1) {
    if (raw.length < PALETTE_BYTES + pixelCount) {
      throw new RangeError(
        `Indexed image payload is shorter than palette and pixels: ${raw.length} < ${PALETTE_BYTES + pixelCount}`,
      );
    }
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const paletteOffset = (raw[PALETTE_BYTES + pixel] ?? 0) * 4;
      const output = pixel * 4;
      bgra[output] = raw[paletteOffset] ?? 0;
      bgra[output + 1] = raw[paletteOffset + 1] ?? 0;
      bgra[output + 2] = raw[paletteOffset + 2] ?? 0;
      bgra[output + 3] = raw[paletteOffset + 3] ?? 0;
    }
  } else if (bytesPerPixel === 4) {
    if (raw.length < pixelCount * 4) {
      throw new RangeError(
        `BGRA image payload is truncated: ${raw.length} < ${pixelCount * 4}`,
      );
    }
    Buffer.from(raw.buffer, raw.byteOffset, pixelCount * 4).copy(bgra, 0, 0, pixelCount * 4);
  } else if (bytesPerPixel === 2) {
    if (raw.length < pixelCount * 2) {
      throw new RangeError(
        `RGB565 image payload is truncated: ${raw.length} < ${pixelCount * 2}`,
      );
    }
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const input = pixel * 2;
      const low = raw[input] ?? 0;
      const high = raw[input + 1] ?? 0;
      const output = pixel * 4;
      bgra[output] = (low & 0x1f) << 3;
      bgra[output + 1] = (((high & 0x07) << 5) | ((low & 0xe0) >>> 3)) & 0xfc;
      bgra[output + 2] = high & 0xf8;
      bgra[output + 3] = 255;
    }
  } else if (bytesPerPixel === 3) {
    if (raw.length < pixelCount * 3) {
      throw new RangeError(
        `RGB565+alpha image payload is truncated: ${raw.length} < ${pixelCount * 3}`,
      );
    }
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const input = pixel * 3;
      const low = raw[input] ?? 0;
      const high = raw[input + 1] ?? 0;
      const output = pixel * 4;
      bgra[output] = (low & 0x1f) << 3;
      bgra[output + 1] = (((high & 0x07) << 5) | ((low & 0xe0) >>> 3)) & 0xfc;
      bgra[output + 2] = high & 0xf8;
      bgra[output + 3] = raw[input + 2] ?? 255;
    }
  }

  return { id, name, width, height, bgra };
}

/**
 * Pure cache decision helper.
 */
export function shouldPrepareAutoPreview(
  entry: { source: string; sourceHash?: string } | null,
  sourceHash: string,
): boolean {
  if (!entry) return true;
  if (entry.source === 'manual') return false;
  return entry.sourceHash !== sourceHash;
}
