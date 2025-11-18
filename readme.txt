Manifest Viewer Extension
=========================

Overview
--------
Chrome/Firefox extension that pretty-prints DASH (.mpd) and HLS (.m3u8) manifests with syntax highlighting, segment inspection tools, and DASH segment helpers. The source lives in the `app/` directory, which is what ships with the extension.

Prerequisites
-------------
- Node.js 18+ (required for the bundled Jest test runner and build tooling)
- npm (ships with Node)

Setup
-----
1. Install dependencies:
   ```
   npm install
   ```
2. Run the automated tests:
   ```
   npm test
   ```

Building the Extension
----------------------
Use the build script to package the extension into a distributable ZIP:
```
npm run build
```
The archive is output to `dist/manifest-viewer-extension.zip`, containing the contents of `app/`. Upload this ZIP to the Chrome Web Store, or sideload it via chrome://extensions (Developer Mode → Load unpacked → select `app/` for debugging or drag-and-drop the ZIP for quick tests where supported).

Hosted Viewer & Deep Links
--------------------------
This repository also serves a hosted viewer via GitHub Pages. You can deep-link directly to a specific manifest and the viewer will auto-load it on page open.

- Base URLs:
  - Root: `https://123-test.stream/`
  - Viewer page: `https://123-test.stream/app/viewer.html`

- Parameters:
  - `u`: the manifest URL to load (percent-encode it). Also accepts `url` for backward compatibility, but links will canonicalize to `u`.
  - `ua`: optional User-Agent string to apply for requests.
  - `headers=1`: optional; opens the Custom Headers panel on load.

- Examples:
  - `https://123-test.stream/?u=https%3A%2F%2Fcdn.example.com%2Fstream%2Fmaster.m3u8`
  - `https://123-test.stream/app/viewer.html?u=https%3A%2F%2Fcdn.example.com%2Fvod%2Fmanifest.mpd&ua=ExoPlayerDemo%2F1.0`
  - Also accepted: `https://123-test.stream/?url=https%3A%2F%2Fcdn.example.com%2Fmanifest.json`

Notes:
- The viewer keeps the current `?u=` in the address bar as you load or refresh URLs, so you can copy the page URL to share the exact view.
- The "Copy Manifest URL" button copies the original manifest URL only; to share the viewer page with the manifest preloaded, copy the browser address bar.
- CORS: If the target server blocks cross-origin fetches, the hosted viewer may not be able to fetch the manifest. In that case, use the browser extension (which can apply request header overrides) or fetch via an allowed domain.

License
-------
This project is licensed under the Apache License 2.0. See LICENSE and NOTICE for details. You may use, modify, and redistribute, including building your own versions, provided you retain attribution and license notices.

Packaging for Firefox
---------------------
Firefox MV3 is supported (Firefox 115+). A dedicated build script generates a Firefox-specific ZIP with the correct manifest fields:

- Build ZIP for Firefox:
  ```
  npm run build:firefox
  ```
  Outputs: `dist/manifest-viewer-extension-firefox.zip`

- What the Firefox build changes:
  - Adds `browser_specific_settings.gecko` with `strict_min_version: "115.0"`
  - Optionally sets an extension id if you export `FIREFOX_EXTENSION_ID` (useful for self-distribution):
    ```
    FIREFOX_EXTENSION_ID="manifest-viewer@example.com" npm run build:firefox
    ```
  - Replaces the Chrome-only permission `declarativeNetRequestWithHostAccess` with `declarativeNetRequest` for Gecko.

- Sideload (temporary install) for local testing:
  1. Open `about:debugging#/runtime/this-firefox`
  2. Click "Load Temporary Add-on"
  3. Select the `app/manifest.json` file (use the unpacked source during development)

- Distribute via AMO (addons.mozilla.org):
  1. Run `npm run build:firefox`
  2. Upload `dist/manifest-viewer-extension-firefox.zip` to the AMO Developer Hub

Notes & Compatibility
---------------------
- The background script uses Manifest V3 APIs (`background.service_worker`, `webNavigation`, `downloads`, and `declarativeNetRequest`). These are supported by modern Firefox versions. We pin `strict_min_version` to 115 to stay within supported MV3.
- The code uses the `chrome.*` namespace, which Firefox aliases for compatibility; no additional polyfill is required.

Linting & Formatting
--------------------
- Check code style and best practices:
  ```
  npm run lint
  ```
- Apply automatic ESLint fixes:
  ```
  npm run lint:fix
  ```
- Prettier is configured via `.prettierrc.json`; run it manually if you want to reformat files:
  ```
  npx prettier --write <files>
  ```

Validation
----------
- Load a manifest in the viewer and use the contextual `Validate HLS` / `Validate DASH` button to replace the manifest panel with validation results.
- The validator performs lightweight structural checks (required tags, segment addressing, timeline integrity) and reports errors, warnings, and info entries directly in the viewer.
- Use the validation button (or the back control) again to return to the original manifest view; history entries are preserved so you can move between views.

Development Notes
-----------------
- Unit tests live under `__tests__/` and leverage Jest + JSDOM. They cover the pure utility functions in `app/viewer.js` and helper logic in `app/background.js`.
- If you add new utilities that run in the page context, export them inside the `module.exports` guards to keep them testable by Node.
- The live extension relies on MV3 APIs (`background.js`) and Chrome runtime messaging; when writing tests, stub any additional Chrome APIs you need under the `global.chrome` object.
