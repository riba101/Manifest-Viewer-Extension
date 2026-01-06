# GitHub Copilot / Agent Instructions for Manifest-Viewer-Extension ✅

Purpose
- Short: help an AI coding agent be immediately productive in this repo—what to run, where to look, and concrete patterns to follow.

Quick start (commands) 🔧
- Install & run tests: `npm install && npm test`
- Lint: `npm run lint` (auto-fix: `npm run lint:fix`)
- Build (Chrome + Firefox): `npm run build`
  - Chrome-only: `npm run build:chrome`
  - Firefox-only: `FIREFOX_EXTENSION_ID="manifest-viewer@example.com" npm run build:firefox`
- Environment: Node.js 18+ (required for Jest/build scripts)

High-level architecture (big picture) 🏗️
- app/: UI and runtime code shipped in the extension (viewer.html, popup.html, background.js, validation-core.js).
- background.js: MV3 service worker — primary responsibilities:
  - Auto-open viewer for `.m3u8` / `.mpd` by listening to webNavigation + downloads
  - Maintain manifest detections, soft-notifications, and badges
  - Apply temporary User-Agent overrides via Declarative Net Request dynamic rules
  - Expose a messaging API for UI pages (see "Messaging" below)
- viewer.js / popup.js: front-end UI code (query params: `u`, `ua`, `headers`), reads/writes localStorage & chrome.storage.sync
- validation-core.js: manifest validation logic (HLS/DASH). Exported as UMD for browser + Node tests.

Key files to scan for context 🔍
- `README.md` — primary developer notes (build, hosted viewer usage)
- `package.json` — scripts: lint/test/build
- `scripts/build-extension.js` & `scripts/build-extension-firefox.js` — artifact creation and Firefox manifest transform (adds gecko settings, strict_min_version, optional FIREFOX_EXTENSION_ID)
- `app/background.js` — core runtime logic & messaging handlers
- `app/viewer.js` & `app/popup.js` — UI behavior, storage keys and header management
- `app/validation-core.js` — validation logic (UMD, importable for tests)
- `__tests__/` — examples of how tests stub `global.chrome`, mock listeners, and assert behavior

Messaging & integration patterns (concrete) 🔗
- Background <-> UI communication uses `chrome.runtime.sendMessage` / `onMessage`.
- Important message types and usage (examples):
  - APPLY_UA_RULE { type: 'APPLY_UA_RULE', url, ua } — background applies temporary UA via DNR; errors returned in response
  - GET_MANIFEST_REQUEST_HEADERS { type: 'GET_MANIFEST_REQUEST_HEADERS', url } — viewer uses to prefill headers
  - GET_TAB_MANIFEST_DOWNLOADS / GET_LATEST_TAB_MANIFEST — popup queries detected manifest downloads
  - CLEAR_TAB_MANIFEST_BADGE — clear badge on tab
  - GET_UA — returns saved UA string
  - Notification: background sends `TAB_MANIFEST_DETECTED` via `chrome.runtime.sendMessage` to notify UI

Testing conventions & tips ✅
- Tests use Jest + JSDOM (see `__tests__/validation.test.js`, `__tests__/background.test.js`).
- To make JS functions testable in Node, export internals using the existing `if (typeof module !== 'undefined' && module.exports)` guard. Follow the same pattern when adding utilities.
- Mock `global.chrome` in tests; pattern in `__tests__/background.test.js` captures listener callbacks then invokes them to simulate browser events.
- Use `setImmediate` or fake timers when you need to wait for microtasks; tests already handle service worker timing and setTimeouts carefully.

Project-specific conventions & patterns ⚠️
- Storage keys: `HEADERS_STORAGE_KEY = 'mv_custom_headers_v1'`, `STARTUP_STATE_KEY = 'mv_startup_state_v1'` — preserve these naming conventions when adding new persisted keys.
- Headers handling: viewer uses `localStorage` for custom headers and merges with headers provided by background detection (via `GET_MANIFEST_REQUEST_HEADERS`). Avoid storing `User-Agent` in custom headers (reserved name).
- Prefer small, pure, testable helper functions over large untestable code blocks. If you add logic that should be unit-tested, expose it behind the `module.exports` guard.
- Background uses Declarative Net Request (DNR) dynamic rules for temporary UA overrides — implement careful cleanup (existing code ensures active cleanup and best-effort timeouts).
- Firefox packaging: `scripts/build-extension-firefox.js` **transforms** `manifest.json` instead of asking you to modify it in-place. Use or update that script if you need Firefox-specific changes.

Style & tooling ✍️
- ESLint + Prettier configured; run `npm run lint` and `npm run lint:fix` before PRs.
- Tests should be added under `__tests__/` and follow existing mocking patterns.
- Running `npm run build` runs lint + tests + packaging; CI expects all three to pass.

Examples (copy/paste) 📎
- Apply UA rule from UI (viewer):
  ```js
  chrome.runtime.sendMessage({ type: 'APPLY_UA_RULE', url: manifestUrl, ua: 'MyUA/1.0' }, (res) => { /* handle res.ok / res.error */ });
  ```
- Export a helper for tests:
  ```js
  function helper() { /* ... */ }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { helper }; }
  ```
- Mock `chrome` in Jest tests (pattern used in `__tests__/background.test.js`): define functions for listeners and capture callbacks assigned by addListener so tests can invoke them directly.

When to ask a human 🧑‍💻
- If you need clarification about user-visible behavior (notification wording, default toggles), or any change that alters content shown to users, ask a repo maintainer.
- If your change affects permissions or host permissions (manifest changes), open a PR and request a review — these can have platform and privacy implications.

If anything in this draft is unclear or missing (specific files, higher-level rationale, or CI expectations), tell me which part you'd like clarified and I will update the file. ✨
