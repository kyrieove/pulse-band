# Automatic Watchface Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically decode the embedded preview from every watchface `.bin` Pulse can access, cache it once by watchface ID and source hash, and make it available before the watchface page reads previews.

**Architecture:** A pure TypeScript decoder in the Electron main-process layer parses the modern Xiaomi header and preview image block, returning Windows BGRA bitmap bytes. `WatchfacePreviewService` converts that bitmap with Electron `nativeImage`, persists it through the existing store, and owns a one-time startup preparation promise. `WatchfaceService` triggers the same preparation after a successful install, using the device-returned final ID.

**Tech Stack:** TypeScript 7, Electron 44 `nativeImage`, Node built-ins, existing preview store and IPC, Node test runner. No AIoT runtime, no new npm dependency, no full watchface renderer.

---

## Prompt for Antigravity

Implement the approved automatic watchface-preview design in `C:\dev\pulse-band2`.

Read these first and follow them as requirements:

- `C:\dev\pulse-band2\AGENTS.md`
- `C:\dev\pulse-band2\HANDOFF.md`
- `C:\dev\pulse-band2\docs\superpowers\specs\2026-09-13-watchface-auto-preview-design.md`
- `C:\dev\pulse-band2\docs\superpowers\specs\2026-09-13-aiot-watchface-preview-feasibility-design.md`
- `C:\Users\ASUS\.codex\skills\karpathy-guidelines\SKILL.md`

Preserve all existing user changes. In particular, `src/renderer/components/pulse/WatchFacePage.tsx` already has an uncommitted grid change; do not edit, stage, restore, or reformat that file. Do not stage unrelated untracked files. Do not push.

The reference decoder is MIT licensed:

- `https://github.com/utsabfdahal/band10-toolkit/blob/main/parser/bytes.ts`
- `https://github.com/utsabfdahal/band10-toolkit/blob/main/parser/rle.ts`
- decode-only portion of `https://github.com/utsabfdahal/band10-toolkit/blob/main/parser/imageCodec.ts`
- license: `https://github.com/utsabfdahal/band10-toolkit/blob/main/LICENSE`

Adapt only the minimum required decode logic and retain a concise source/license attribution in the decoder file. Do not copy its builder, React studio, encoder, CLI, `sharp` dependency, examples, or packaging code.

## File map

- Create `src/main/services/watchface-preview-decoder.ts`: bounds-checked Xiaomi header/image/RLE decoder; no Electron imports.
- Modify `src/main/services/watchface-preview-store.ts`: persist optional source hash and preserve manual-over-auto priority.
- Modify `src/main/services/watchface-preview-service.ts`: startup scan, cache decision, bitmap-to-PNG conversion, and one-file preparation API.
- Modify `src/main/services/watchface-service.ts`: prepare the preview after device install success without changing install success into failure.
- Modify `src/main/index.ts`: inject the preview service and start preparation for the repository `watch-face` seed directory.
- Modify `src/renderer/hooks/useWatchFace.ts`: reload preview mapping after successful installation.
- Create `scripts/test-watchface-preview-decoder.mjs`: pure decoder tests with generated binary fixtures.
- Modify `scripts/test-watchface-preview-store.mjs`: hash compatibility and manual priority cases.
- Modify `package.json`: add the decoder test to the existing `npm test` chain.

Do not modify `WatchFacePage.tsx`, preload APIs, Rust core, BLE protocol, app installer, or visual layout.

### Task 1: Pure `.bin` preview decoder

**Files:**

- Create: `src/main/services/watchface-preview-decoder.ts`
- Create: `scripts/test-watchface-preview-decoder.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing decoder tests**

The test must construct small buffers in memory; committed tests must not depend on the untracked `watch-face` directory. Build a valid fixture with this shape:

```js
const MAIN_HEADER_SIZE = 0xa8;
const IMAGE_HEADER_SIZE = 12;

function makeRawBgraFixture() {
  const pixels = Buffer.from([
    0x00, 0x00, 0xff, 0xff, // red in BGRA
    0x00, 0xff, 0x00, 0xff, // green
  ]);
  const file = Buffer.alloc(MAIN_HEADER_SIZE + IMAGE_HEADER_SIZE + pixels.length);
  Buffer.from([0x5a, 0xa5, 0x34, 0x12]).copy(file, 0);
  file.writeUInt32LE(MAIN_HEADER_SIZE, 0x20);
  file.write('123456789', 0x28, 'ascii');
  file.write('Fixture', 0x68, 'utf8');
  file[MAIN_HEADER_SIZE] = 0;
  file.writeUInt16LE(2, MAIN_HEADER_SIZE + 4);
  file.writeUInt16LE(1, MAIN_HEADER_SIZE + 6);
  file.writeUInt32LE(pixels.length, MAIN_HEADER_SIZE + 8);
  pixels.copy(file, MAIN_HEADER_SIZE + IMAGE_HEADER_SIZE);
  return file;
}
```

Required assertions:

```js
const decoded = decodeWatchfacePreview(makeRawBgraFixture());
assert.equal(decoded.id, '123456789');
assert.equal(decoded.name, 'Fixture');
assert.equal(decoded.width, 2);
assert.equal(decoded.height, 1);
assert.deepEqual([...decoded.bgra], [0, 0, 255, 255, 0, 255, 0, 255]);
assert.throws(() => decodeWatchfacePreview(Buffer.alloc(32)), /magic|header/i);
assert.throws(() => decodeWatchfacePreview(fixtureWithOutOfRangePreviewOffset()), /offset|range/i);
assert.throws(() => decodeWatchfacePreview(fixtureWithZeroDimensions()), /dimensions/i);
assert.throws(() => decodeWatchfacePreview(fixtureWithOversizedDimensions()), /dimensions|pixels/i);
assert.throws(() => decodeWatchfacePreview(fixtureWithUnknownEncoding()), /encoding|sign/i);
```

Add deterministic fixtures for compressed palette/RLE v2 and compressed BGRA/RLE v1. Assert their exact decoded pixels, not merely that decoding does not throw. Also cover raw RGB565 sign `3` and RGB565+alpha sign `6`.

- [ ] **Step 2: Run the new test and confirm it fails because the decoder does not exist**

Run:

```powershell
node scripts/test-watchface-preview-decoder.mjs
```

Expected: non-zero exit with a missing-module error.

- [ ] **Step 3: Implement the minimum decoder**

Export this stable contract:

```ts
export interface DecodedWatchfacePreview {
  id: string;
  name: string;
  width: number;
  height: number;
  bgra: Buffer;
}

export function decodeWatchfacePreview(file: Uint8Array): DecodedWatchfacePreview;
```

Required parsing rules:

```ts
const MAIN_HEADER_SIZE = 0xa8;
const IMAGE_HEADER_SIZE = 12;
const PALETTE_BYTES = 256 * 4;
const MAX_DIMENSION = 800;
const MAX_PIXELS = 800 * 800;
const MAGIC = Buffer.from([0x5a, 0xa5, 0x34, 0x12]);
const COMPRESSED_MAGIC = Buffer.from([0xe0, 0x21, 0xa5, 0x5a]);
```

- Validate the main header before reading `previewOffset` at `0x20`.
- Read ID from `0x28` with maximum length 9 and name from `0x68` with maximum length 60, both null-terminated.
- Validate every addition and slice with a single `assertRange` helper.
- Validate width, height, pixel count, encoded length, and decompressed expected length before allocating.
- Support signs `0`, `3`, `6`, and `0x10`; reject all other signs.
- Port `decodeRleV1` and `decodeRleV2` exactly from the cited MIT source, retaining attribution.
- Return BGRA bytes because the target application is Windows-only and Electron `nativeImage.createFromBitmap()` consumes the same native bitmap channel order on the verified target.
- Do not parse face definitions, widgets, animations, AOD, or arbitrary resource images.

- [ ] **Step 4: Run focused tests**

```powershell
node scripts/test-watchface-preview-decoder.mjs
```

Expected: all decoder cases pass.

- [ ] **Step 5: Commit Task 1 only**

```powershell
git add package.json scripts/test-watchface-preview-decoder.mjs src/main/services/watchface-preview-decoder.ts
git commit -m "feat(watchface): decode embedded preview images"
```

### Task 2: Hash-aware cache without breaking old indexes

**Files:**

- Modify: `src/main/services/watchface-preview-store.ts`
- Modify: `scripts/test-watchface-preview-store.mjs`

- [ ] **Step 1: Add failing store tests**

Cover these exact behaviors:

```js
const auto = store.set('face-a', {
  bytes: pngBytes,
  source: 'auto',
  sourceHash: 'abc123',
  width: 212,
  height: 520,
});
assert.equal(auto.sourceHash, 'abc123');
assert.equal(store.readIndex().entries['face-a'].sourceHash, 'abc123');
```

Also write an old version-1 index entry without `sourceHash` and assert it still loads. Write malformed non-string hashes and assert they are discarded without losing the otherwise valid entry.

- [ ] **Step 2: Run and observe the expected failure**

```powershell
node scripts/test-watchface-preview-store.mjs
```

- [ ] **Step 3: Extend the existing types and sanitizer**

Use an optional field for backward compatibility:

```ts
export interface WatchfacePreviewEntry {
  file: string;
  source: WatchfacePreviewSource;
  sourceHash?: string;
  addedAt: string;
  width: number;
  height: number;
  bytes: number;
}
```

Extend `set()` input with `sourceHash?: string`. Persist only a non-empty string of at most 128 characters. Do not change the index version and do not alter `clear()`, file naming, or atomic-write behavior.

Manual-over-auto priority belongs to the service in Task 3; the store remains a small persistence primitive.

- [ ] **Step 4: Run the store tests**

```powershell
node scripts/test-watchface-preview-store.mjs
```

Expected: all existing and new cases pass.

- [ ] **Step 5: Commit Task 2 only**

```powershell
git add scripts/test-watchface-preview-store.mjs src/main/services/watchface-preview-store.ts
git commit -m "feat(watchface): track preview source hashes"
```

### Task 3: One-time background preparation service

**Files:**

- Modify: `src/main/services/watchface-preview-service.ts`
- Create: `scripts/test-watchface-preview-auto.mjs`
- Modify: `package.json`

- [ ] **Step 1: Extract and test the pure cache decision**

Export a pure helper from the preview service or decoder-adjacent module:

```ts
export function shouldPrepareAutoPreview(
  entry: WatchfacePreviewEntry | null,
  sourceHash: string,
): boolean {
  if (!entry) return true;
  if (entry.source === 'manual') return false;
  return entry.sourceHash !== sourceHash;
}
```

Test missing entry, manual entry, matching auto hash, different auto hash, and legacy auto entry without a hash.

- [ ] **Step 2: Implement the preparation API**

Add these methods while preserving `setFromFile()`, `clear()`, and all IPC response shapes:

```ts
startBackgroundPreparation(seedDirectories: string[]): void;

prepareFromBin(
  id: string,
  filePath: string,
  sourceHash?: string,
): Promise<{ status: 'written' | 'cached' | 'manual-preserved' | 'skipped'; id: string }>;
```

Rules:

- `startBackgroundPreparation()` is idempotent and stores one promise.
- Each seed directory is optional. Missing directories are ignored.
- Read directory entries with `withFileTypes: true`; process only ordinary `.bin` files, sequentially, so startup cannot spike memory.
- Reject source files larger than the existing 20 MiB limit before `readFile()`.
- Compute SHA-256 for seed files. Installation may pass its already computed MD5; the hash is only a stable cache fingerprint, not a security claim.
- For seed files, call the decoder first and use only a valid embedded ID. Treat empty/all-zero IDs as `skipped`; never match by display name.
- Before decoding, preserve a manual entry and skip a matching auto hash.
- Convert returned BGRA with `nativeImage.createFromBitmap(bgra, { width, height })`, then `toPNG()`.
- Reject an empty native image or empty PNG.
- Save with `source: 'auto'`, original width/height, and `sourceHash`.
- Invalidate the existing in-memory data URL cache for that ID after a write.
- Catch errors per seed file and log one concise warning without leaking the full file contents.
- `list()` must await the startup-preparation promise before reading the store, preventing a first-open race.
- Auto failures never change `list()` into an error; they result in a missing preview for that item.

Do not add a watcher or interval. Startup preparation runs exactly once per app process, and hash matches avoid re-decoding across processes.

- [ ] **Step 3: Run focused tests**

```powershell
node scripts/test-watchface-preview-auto.mjs
node scripts/test-watchface-preview-store.mjs
node scripts/test-watchface-preview-decoder.mjs
```

Expected: all pass. If importing the Electron-bound service is not possible in plain Node, move only the pure decision helper into the decoder module and test it there; do not mock `nativeImage` with a fake success path.

- [ ] **Step 4: Commit Task 3 only**

```powershell
git add package.json scripts/test-watchface-preview-auto.mjs src/main/services/watchface-preview-service.ts src/main/services/watchface-preview-decoder.ts
git commit -m "feat(watchface): prepare previews once in background"
```

### Task 4: Wire startup and successful installs

**Files:**

- Modify: `src/main/index.ts`
- Modify: `src/main/services/watchface-service.ts`
- Modify: `src/renderer/hooks/useWatchFace.ts`
- Test: existing service/build tests plus any focused test added here

- [ ] **Step 1: Add a failing installation behavior test where practical**

The observable contract is:

```ts
// Core install succeeds first.
// prepareFromBin(finalDeviceId, originalPath, computedMd5) is called once.
// A preview exception is logged/ignored and install still returns { ok: true, data }.
// Core install failure never calls prepareFromBin().
```

Use dependency injection rather than module mocking. Extend the constructor minimally:

```ts
interface WatchfacePreviewPreparer {
  prepareFromBin(id: string, filePath: string, sourceHash?: string): Promise<unknown>;
}

constructor(client: CoreRpcClient, previewPreparer?: WatchfacePreviewPreparer)
```

- [ ] **Step 2: Wire the successful installation path**

After `device.watchface.install` returns successfully:

```ts
if (this.previewPreparer) {
  try {
    await this.previewPreparer.prepareFromBin(data.watchface_id, filePath, md5);
  } catch (error) {
    console.warn('[WatchfacePreview] 自动生成失败:', error instanceof Error ? error.message : String(error));
  }
}
return { ok: true, data };
```

Do not run preparation before the device confirms the final ID. Do not fail installation if preview generation fails.

- [ ] **Step 3: Wire the startup seed**

Instantiate `WatchfacePreviewService` before `WatchfaceService`, inject it, and start preparation once in `app.whenReady()`:

```ts
watchfacePreviewService.startBackgroundPreparation([
  path.resolve(import.meta.dirname, '../../watch-face'),
]);
```

The directory is a development/first-run seed only and may not exist in packaged builds. Do not add it to `electron-builder` resources and do not commit the `.bin` files.

- [ ] **Step 4: Reload previews after installation**

In `useWatchFace.ts`, extract the existing preview-list call into a stable `loadPreviews` callback. Call it on connected-page initialization and after a successful `install()` result, before or alongside the device list refresh. Preserve existing error behavior: missing previews do not block the list or installation success.

Do not edit `WatchFacePage.tsx`.

- [ ] **Step 5: Run focused and full automated checks**

```powershell
npm run build
npm test
```

Expected: both exit `0`. Report actual test counts from output; do not reuse an older count.

- [ ] **Step 6: Commit Task 4 only**

```powershell
git add src/main/index.ts src/main/services/watchface-service.ts src/renderer/hooks/useWatchFace.ts scripts package.json
git commit -m "feat(watchface): generate previews after install"
```

### Task 5: Real-file and app acceptance

**Files:** no source changes unless a verified defect is found.

- [ ] **Step 1: Decode the three local samples through the product decoder**

Use the implementation itself, not the temporary research clone. Do not commit the source `.bin` or generated PNGs.

Expected observations:

```text
丝柯克2.0-1.bin -> id 976603977, name 丝柯克, 212x520
BetaUI-黑塔.bin -> embedded id 000000000, name BetaUI-黑塔, 336x480, startup seed skipped
wf_design.bin -> id 120917361, name 简约1+, 212x520
```

Confirm generated PNGs are non-empty and Electron can decode them. The zero-ID BetaUI file must still generate successfully when `prepareFromBin()` is called with a valid device-returned ID after installation.

- [ ] **Step 2: Verify no repeated decode**

Start once, record the preview PNG modification times, quit, start again, and confirm the times are unchanged for matching hashes. Do not claim this from code inspection alone.

- [ ] **Step 3: Run target Electron verification**

Before launching the current build, follow the project process-cleanup rule:

```powershell
Get-Process electron,pulse-core -ErrorAction SilentlyContinue | Stop-Process -Force
```

Launch the exact freshly built app. Open the watchface page and capture a screenshot showing decoded previews. If a real connected-band list cannot map the two valid seed IDs, report that limitation rather than substituting a mock screenshot.

- [ ] **Step 4: Final report to the reviewer**

Return:

- commit hashes in order;
- exact changed files;
- `npm run build` exit code;
- `npm test` exit code and actual pass count;
- real `.bin` decode results and dimensions;
- evidence that second startup did not rewrite cached PNGs;
- screenshot path and exact build/run method, if target UI was verified;
- any failure or unverified item;
- confirmation that `WatchFacePage.tsx` and unrelated user files were untouched.

Stop after reporting. Do not redesign the cards, push commits, or start the next feature.
