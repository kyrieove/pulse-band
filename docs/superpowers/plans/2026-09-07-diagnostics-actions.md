# Diagnostics and Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-triggered, plain-language full diagnostic report and GitHub Actions that verify every change and publish Windows installers from version tags.

**Architecture:** A pure TypeScript report builder converts already-sanitized runtime observations into stable UI results and remains directly testable with Node 24. `OronBoxBridge` collects runtime observations and exposes one new IPC endpoint; the existing diagnostics screen renders the report without changing device behavior. Two workflows separate continuous verification from privileged release creation.

**Tech Stack:** Electron 44, React 19, TypeScript 7, Node 24 test runner, GitHub Actions Windows runners, GitHub CLI.

---

### Task 1: Diagnostic report contract and mapping

**Files:**
- Create: `scripts/test-diagnostics.mjs`
- Create: `src/main/services/diagnostics.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests**

Import `buildDiagnosticReport` from the not-yet-created TypeScript module and assert that a healthy observation produces pass results, a timeout produces a readable status-service failure, a degraded daemon is a warning, a missing plugin in plugin mode is a failure, direct mode does not require the plugin, and zero usable quotas is a warning.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosticReport } from '../src/main/services/diagnostics.ts';

test('turns a status timeout into a readable failure', () => {
  const report = buildDiagnosticReport(healthy({ statusService: { ok: false, error: 'ETIMEDOUT' } }));
  const check = report.checks.find((item) => item.id === 'status-service');
  assert.equal(check.status, 'fail');
  assert.match(check.nextStep, /重启 Pulse/);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/test-diagnostics.mjs`

Expected: FAIL because `src/main/services/diagnostics.ts` does not exist.

- [ ] **Step 3: Implement the pure report builder**

Define `DiagnosticStatus`, `DiagnosticCheck`, `DiagnosticReport`, `ProbeResult`, `DiagnosticObservation`, `describeProbeFailure`, and `buildDiagnosticReport`. Always return nine ordered checks: status service, Hook configuration, Hook service, daemon, protocol, bridge, band, bundled RPK, and quota.

```ts
export function describeProbeFailure(service: 'status' | 'hook', error = ''): string {
  if (/timeout|timedout/i.test(error)) return service === 'status' ? '状态服务响应超时，请重启 Pulse。' : 'Hook 服务响应超时，请重启 Pulse。';
  if (/refused|fetch failed/i.test(error)) return service === 'status' ? '状态服务没有启动，请重启 Pulse。' : 'Hook 服务没有启动，请重启 Pulse。';
  return service === 'status' ? '状态服务不可用，请重启 Pulse。' : 'Hook 服务不可用，请重启 Pulse。';
}
```

- [ ] **Step 4: Verify GREEN and expose one test command**

Run: `node --test scripts/test-diagnostics.mjs`

Expected: all diagnostic tests pass.

Add this script without changing existing commands:

```json
"test": "node scripts/test-hook-install.mjs && node scripts/test-band-key-extract.mjs && node --test scripts/test-diagnostics.mjs"
```

- [ ] **Step 5: Commit**

```powershell
git add package.json scripts/test-diagnostics.mjs src/main/services/diagnostics.ts
git commit -m "feat: add diagnostic report builder"
```

### Task 2: Runtime diagnostic collection and IPC

**Files:**
- Modify: `src/main/services/claude-hook-install.ts`
- Modify: `src/main/services/oronbox-bridge.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/env.d.ts`

- [ ] **Step 1: Extend the failing diagnostic test**

Add assertions for missing Hook files and an unavailable bundled RPK so the result builder contract is fixed before runtime wiring.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/test-diagnostics.mjs`

Expected: FAIL because those observations are not reflected yet.

- [ ] **Step 3: Complete the report builder and export Hook status**

Rename private `status()` to exported `getHookStatus()`. Treat Hook installation as valid only when all configured events, `pulse-hook.cmd`, and `claude-hook.cjs` exist. Keep the existing `HookStatus` shape.

- [ ] **Step 4: Register the new IPC endpoint**

In `OronBoxBridge.registerIpc`, concurrently probe `http://127.0.0.1:8765/api/status` and `http://127.0.0.1:41789/health` with three-second abort signals, inspect `this.state`, call `getHookStatus()`, and check `../../assets/band-app.rpk`. Pass only booleans, mode, quota count, and error strings to `buildDiagnosticReport`.

```ts
ipcMain.handle('pulse:run-diagnostics', async () => {
  const [statusService, hookService] = await Promise.all([
    probeJson('http://127.0.0.1:8765/api/status'),
    probeJson('http://127.0.0.1:41789/health'),
  ]);
  return buildDiagnosticReport({ /* sanitized observations */ });
});
```

- [ ] **Step 5: Expose typed renderer API**

Add `runDiagnostics: () => ipcRenderer.invoke('pulse:run-diagnostics')` to the preload bridge and `runDiagnostics(): Promise<DiagnosticReport>` to `PulseBridge`, importing the report type with `import type`.

- [ ] **Step 6: Verify**

Run: `npm test` and `npm run build`.

Expected: all tests pass and TypeScript/Vite exits 0.

- [ ] **Step 7: Commit**

```powershell
git add src/main/services/diagnostics.ts src/main/services/claude-hook-install.ts src/main/services/oronbox-bridge.ts src/preload/index.ts src/renderer/env.d.ts scripts/test-diagnostics.mjs
git commit -m "feat: expose full runtime diagnostics"
```

### Task 3: One-click diagnostics UI

**Files:**
- Modify: `src/renderer/components/pulse/DiagnosticsScreen.tsx`

- [ ] **Step 1: Add report state and action**

Add `report`, `runningDiagnostics`, and `runDiagnostics`. Clear no existing monitoring data; disable only the new button while the report runs.

```ts
const runDiagnostics = async () => {
  setRunningDiagnostics(true);
  try {
    setReport((await window.pulse?.runDiagnostics()) ?? null);
  } finally {
    setRunningDiagnostics(false);
  }
};
```

- [ ] **Step 2: Render the summary panel**

Insert one panel above the quota section. Use the existing dark surfaces and emerald/amber/rose tones. Show a compact count summary and each item as a row containing label, status, summary, and optional next step. Use text labels as well as color for accessibility.

- [ ] **Step 3: Verify**

Run: `npm run build`.

Expected: TypeScript and both Vite builds exit 0.

- [ ] **Step 4: Commit**

```powershell
git add src/renderer/components/pulse/DiagnosticsScreen.tsx
git commit -m "feat: add one-click diagnostics UI"
```

### Task 4: Continuous integration workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the Windows CI workflow**

Use `actions/checkout@v6` and `actions/setup-node@v7`, Node 24, npm cache, `npm ci`, `npm test`, `npm run build`, and `npm audit --omit=dev`. Trigger on pushes to `main` and all pull requests. Grant only `contents: read`.

- [ ] **Step 2: Validate locally**

Parse the workflow with the installed YAML runtime if available, otherwise parse it with the bundled workspace Python and PyYAML. Then run `npm test` and `npm run build`, which are the workflow's repository-specific commands.

- [ ] **Step 3: Commit**

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: verify Windows builds"
```

### Task 5: Tag-driven release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Add the release workflow**

Trigger only on `push.tags: ['v*']`, use a Windows runner, and grant `contents: write`. Run `npm ci`, `npm test`, and `npm run dist`. In PowerShell, compare `${{ github.ref_name }}` with `v` plus the package version, generate `Pulse-Setup-X.Y.Z.exe.sha256`, and call `gh release create --verify-tag --generate-notes` with both assets and `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

- [ ] **Step 2: Validate safety properties**

Confirm the workflow contains no personal token, no `pull_request_target`, no third-party release action, and no overwrite flag. Parse YAML and inspect the event and permission fields.

- [ ] **Step 3: Commit**

```powershell
git add .github/workflows/release.yml
git commit -m "ci: publish tagged Windows releases"
```

### Task 6: Final verification and delivery

**Files:**
- Verify all modified files

- [ ] **Step 1: Run complete verification**

Run:

```powershell
npm test
npm run build
npm audit
git diff --check
```

Expected: three test groups pass, build exits 0, audit reports zero vulnerabilities, and no whitespace errors.

- [ ] **Step 2: Inspect repository state and workflow contents**

Confirm only approved files changed, the design and plan have no placeholders or contradictions, and no secrets appear in `.github/workflows`.

- [ ] **Step 3: Push**

```powershell
git push origin main
```

- [ ] **Step 4: Verify GitHub Actions**

Use `gh run list` and `gh run watch` to confirm the CI run for the pushed commit completes successfully. Do not create a release tag during this task; `v1.0.1` is already published and the release workflow will be exercised by the next version tag.
