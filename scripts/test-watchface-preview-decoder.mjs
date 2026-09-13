import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeWatchfacePreview,
} from '../src/main/services/watchface-preview-decoder.ts';

const MAIN_HEADER_SIZE = 0xa8;
const IMAGE_HEADER_SIZE = 12;
const PALETTE_BYTES = 256 * 4;
const MAGIC = Buffer.from([0x5a, 0xa5, 0x34, 0x12]);
const COMPRESSED_MAGIC = Buffer.from([0xe0, 0x21, 0xa5, 0x5a]);

function buildTestBin({
  id = '123456789',
  name = 'Fixture',
  previewOffset = MAIN_HEADER_SIZE,
  sign = 0,
  width = 2,
  height = 1,
  payload = Buffer.alloc(0),
  magic = MAGIC,
  fileSize = null,
}) {
  const minSize = Math.max(MAIN_HEADER_SIZE, previewOffset + IMAGE_HEADER_SIZE + payload.length);
  const total = fileSize !== null ? fileSize : minSize;
  const file = Buffer.alloc(total);
  magic.copy(file, 0);
  file.writeUInt32LE(previewOffset, 0x20);
  file.write(id, 0x28, 'ascii');
  file.write(name, 0x68, 'utf8');

  if (previewOffset + IMAGE_HEADER_SIZE <= file.length) {
    file[previewOffset] = sign;
    file.writeUInt16LE(width, previewOffset + 4);
    file.writeUInt16LE(height, previewOffset + 6);
    file.writeUInt32LE(payload.length, previewOffset + 8);
    if (payload.length > 0 && previewOffset + IMAGE_HEADER_SIZE + payload.length <= file.length) {
      payload.copy(file, previewOffset + IMAGE_HEADER_SIZE);
    }
  }
  return file;
}

function makeRawBgraFixture() {
  const pixels = Buffer.from([
    0x00, 0x00, 0xff, 0xff, // red in BGRA
    0x00, 0xff, 0x00, 0xff, // green in BGRA
  ]);
  return buildTestBin({
    id: '123456789',
    name: 'Fixture',
    sign: 0,
    width: 2,
    height: 1,
    payload: pixels,
  });
}

function fixtureWithOutOfRangePreviewOffset() {
  const file = Buffer.alloc(MAIN_HEADER_SIZE + 32);
  MAGIC.copy(file, 0);
  file.writeUInt32LE(0x2000, 0x20); // out of range
  file.write('123456789', 0x28, 'ascii');
  file.write('Fixture', 0x68, 'utf8');
  return file;
}

function fixtureWithZeroDimensions() {
  return buildTestBin({
    sign: 0,
    width: 0,
    height: 10,
    payload: Buffer.alloc(10),
  });
}

function fixtureWithOversizedDimensions() {
  return buildTestBin({
    sign: 0,
    width: 801,
    height: 10,
    payload: Buffer.alloc(10),
  });
}

function fixtureWithUnknownEncoding() {
  return buildTestBin({
    sign: 99,
    width: 2,
    height: 1,
    payload: Buffer.alloc(8),
  });
}

function makeCompressedBgraFixture() {
  // 3 pixels: red, red, blue
  // RLE v1:
  // repeat 2 red: count=2, [0, 0, 255, 255]
  // literal 1 blue: count=1 | 0x80 = 0x81, [255, 0, 0, 255]
  const encoded = Buffer.from([
    0x02, 0x00, 0x00, 0xff, 0xff,
    0x81, 0xff, 0x00, 0x00, 0xff,
  ]);
  const expectedLength = 3 * 4; // 12 bytes
  const info = (expectedLength << 4) | 4; // 4 bpp
  const payload = Buffer.alloc(4 + 4 + encoded.length);
  COMPRESSED_MAGIC.copy(payload, 0);
  payload.writeUInt32LE(info, 4);
  encoded.copy(payload, 8);

  return buildTestBin({
    id: 'comp-bgra',
    name: 'CompressedBgra',
    sign: 0,
    width: 3,
    height: 1,
    payload,
  });
}

function makeCompressedPaletteFixture() {
  // Sign 0x10. Palette has 256 * 4 = 1024 bytes.
  // 4 pixels: [0, 0, 0, 1]
  // Color 0: [10, 20, 30, 255] (BGRA)
  // Color 1: [40, 50, 60, 255] (BGRA)
  // Remaining 254 colors: 0
  // RLE v2 encoding of uncompressed 1028 bytes:
  // Color 0: literal 4 bytes [0x84, 10, 20, 30, 255]
  // Color 1: literal 4 bytes [0x84, 40, 50, 60, 255]
  // 1016 zeroes: 8 repeat packets of [127, 0] = 1016 bytes
  // Indices: 3 zeroes -> repeat packet [3, 0]; 1 one -> literal [0x81, 1]
  const rlePackets = [
    0x84, 10, 20, 30, 255,
    0x84, 40, 50, 60, 255,
  ];
  for (let i = 0; i < 8; i++) {
    rlePackets.push(127, 0);
  }
  rlePackets.push(3, 0);
  rlePackets.push(0x81, 1);

  const encoded = Buffer.from(rlePackets);
  const expectedLength = PALETTE_BYTES + 4; // 1028
  const info = (expectedLength << 4) | 1; // 1 bpp
  const payload = Buffer.alloc(4 + 4 + encoded.length);
  COMPRESSED_MAGIC.copy(payload, 0);
  payload.writeUInt32LE(info, 4);
  encoded.copy(payload, 8);

  return buildTestBin({
    id: 'comp-pal',
    name: 'CompressedPalette',
    sign: 0x10,
    width: 2,
    height: 2,
    payload,
  });
}

function makeRawRgb565Fixture() {
  // 1 pixel: low=0x1f (Blue 248), high=0xf8 (Red 248), green=0
  const pixels = Buffer.from([0x1f, 0xf8]);
  return buildTestBin({
    id: 'rgb565',
    name: 'RawRgb565',
    sign: 3,
    width: 1,
    height: 1,
    payload: pixels,
  });
}

function makeRawRgb565AlphaFixture() {
  // 1 pixel: low=0x00, high=0x07 (Green 224), alpha=128
  const pixels = Buffer.from([0x00, 0x07, 128]);
  return buildTestBin({
    id: 'rgb565a',
    name: 'RawRgb565Alpha',
    sign: 6,
    width: 1,
    height: 1,
    payload: pixels,
  });
}

test('decodeWatchfacePreview: raw BGRA valid fixture', () => {
  const decoded = decodeWatchfacePreview(makeRawBgraFixture());
  assert.equal(decoded.id, '123456789');
  assert.equal(decoded.name, 'Fixture');
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.deepEqual([...decoded.bgra], [0, 0, 255, 255, 0, 255, 0, 255]);
});

test('decodeWatchfacePreview: header and bounds validations', () => {
  assert.throws(() => decodeWatchfacePreview(Buffer.alloc(32)), /magic|header/i);
  assert.throws(() => decodeWatchfacePreview(fixtureWithOutOfRangePreviewOffset()), /offset|range/i);
  assert.throws(() => decodeWatchfacePreview(fixtureWithZeroDimensions()), /dimensions/i);
  assert.throws(() => decodeWatchfacePreview(fixtureWithOversizedDimensions()), /dimensions|pixels/i);
  assert.throws(() => decodeWatchfacePreview(fixtureWithUnknownEncoding()), /encoding|sign/i);
});

test('decodeWatchfacePreview: compressed BGRA / RLE v1 exact pixel match', () => {
  const decoded = decodeWatchfacePreview(makeCompressedBgraFixture());
  assert.equal(decoded.id, 'comp-bgra');
  assert.equal(decoded.name, 'CompressedBgra');
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 1);
  assert.deepEqual([...decoded.bgra], [
    0, 0, 255, 255, // red
    0, 0, 255, 255, // red
    255, 0, 0, 255, // blue
  ]);
});

test('decodeWatchfacePreview: compressed palette / RLE v2 exact pixel match', () => {
  const decoded = decodeWatchfacePreview(makeCompressedPaletteFixture());
  assert.equal(decoded.id, 'comp-pal');
  assert.equal(decoded.name, 'CompressedPalette');
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.bgra], [
    10, 20, 30, 255, // pixel 0: color 0
    10, 20, 30, 255, // pixel 1: color 0
    10, 20, 30, 255, // pixel 2: color 0
    40, 50, 60, 255, // pixel 3: color 1
  ]);
});

test('decodeWatchfacePreview: raw RGB565 sign 3', () => {
  const decoded = decodeWatchfacePreview(makeRawRgb565Fixture());
  assert.equal(decoded.id, 'rgb565');
  assert.equal(decoded.name, 'RawRgb565');
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.deepEqual([...decoded.bgra], [248, 0, 248, 255]);
});

test('decodeWatchfacePreview: raw RGB565+alpha sign 6', () => {
  const decoded = decodeWatchfacePreview(makeRawRgb565AlphaFixture());
  assert.equal(decoded.id, 'rgb565a');
  assert.equal(decoded.name, 'RawRgb565Alpha');
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.deepEqual([...decoded.bgra], [0, 224, 0, 128]);
});

test('decodeWatchfacePreview: truncated payload throws range/length error', () => {
  const fixture = makeRawBgraFixture();
  // Cut off last 4 bytes of pixels
  const truncated = fixture.subarray(0, fixture.length - 4);
  assert.throws(() => decodeWatchfacePreview(truncated), /range|truncated|length/i);
});
