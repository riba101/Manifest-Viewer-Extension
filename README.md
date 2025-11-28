# Manifest Viewer (Extension)

Chrome/Firefox extension that pretty-prints DASH (`.mpd`) and HLS (`.m3u8`) manifests with syntax highlighting, segment inspection tools, and DASH segment helpers. The shipped extension lives in `app/`.

## Features
- Pretty-print manifests with syntax highlighting and quick navigation.
- Segment inspection, DASH helpers, and validation tools for HLS/DASH.
- Auto-open detection for `.mpd` / `.m3u8` (toggle in the popup); forced manifest downloads are intercepted and opened in the viewer.
- Custom User-Agent and headers support via the extension UI.

## Auto-open behavior
- Auto-open is off/on via the popup toggle (`autoOpenViewer` in storage).
- During browser startup or session restore, auto-open is suppressed for restored tabs until you navigate them yourself. This prevents previously closed viewer tabs from reopening on relaunch.
- If you load a manifest while the extension is active, the background script redirects it to the viewer page; if the server forces a download, the download handler opens it in the viewer instead.

## Prerequisites
- Node.js 18+ (required for Jest and build tooling)
- npm (ships with Node)

## Setup
```bash
npm install
npm test
```

## Building
- Chrome + Firefox bundles:
  ```bash
  npm run build
  ```
  Outputs:
  - `dist/manifest-viewer-extension-chrome.zip`
  - `dist/manifest-viewer-extension-firefox.zip`

- Chrome-only bundle:
  ```bash
  npm run build:chrome
  ```

- Firefox-only bundle:
  ```bash
  npm run build:firefox
  ```
  Adds `browser_specific_settings.gecko` (`strict_min_version: "115.0"`). Set `FIREFOX_EXTENSION_ID` if you need a fixed ID:
  ```bash
  FIREFOX_EXTENSION_ID="manifest-viewer@example.com" npm run build:firefox
  ```

## Hosted viewer & deep links
- Base URLs:  
  - Root: `https://123-test.stream/`  
  - Viewer: `https://123-test.stream/app/viewer.html`
- Query params:
  - `u`: manifest URL (percent-encode) — `url` also accepted.
  - `ua`: optional User-Agent to apply.
  - `headers=1`: open the Custom Headers panel on load.
- Examples:
  - `https://123-test.stream/?u=https%3A%2F%2Fcdn.example.com%2Fstream%2Fmaster.m3u8`
  - `https://123-test.stream/app/viewer.html?u=https%3A%2F%2Fcdn.example.com%2Fvod%2Fmanifest.mpd&ua=ExoPlayerDemo%2F1.0`
- The viewer keeps the current `?u=` in the address bar as you load/refresh, so you can copy/share the exact view. The “Copy Manifest URL” button copies only the original manifest URL.
- CORS: If blocked, use the extension or fetch via an allowed domain.

## Compatibility & permissions
- Manifest V3 background service worker uses `webNavigation`, `downloads`, `declarativeNetRequest`, `tabs`, and `storage`.
- Firefox MV3 supported (115+); Chrome/Edge supported via the same MV3 build. Uses the `chrome.*` namespace, which Firefox aliases.

## Linting & formatting
```bash
npm run lint        # ESLint
npm run lint:fix    # ESLint with --fix
# Prettier if you want to reformat files manually:
npx prettier --write <files>
```

## Validation tools
- Load a manifest in the viewer and use “Validate HLS” / “Validate DASH” to replace the manifest panel with validation results.
- Run the button again (or use back) to return to the original manifest view; history is preserved so you can move between views.

## Development notes
- Source that ships with the extension is under `app/`.
- Unit tests live under `__tests__/` (Jest + JSDOM). If you add new utilities, export them under the `module.exports` guard to keep them testable by Node.
- The background script relies on MV3 APIs and runtime messaging; stub additional `chrome.*` APIs in tests as needed.

## License
Apache 2.0 — see `LICENSE` and `NOTICE` for details.
