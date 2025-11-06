Manifest Viewer Extension
=========================

Overview
--------
Chrome extension that pretty-prints DASH (.mpd) and HLS (.m3u8) manifests with syntax highlighting, segment inspection tools, and DASH segment helpers. The source lives in the `app/` directory, which is what ships with the extension.

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

Development Notes
-----------------
- Unit tests live under `__tests__/` and leverage Jest + JSDOM. They cover the pure utility functions in `app/viewer.js` and helper logic in `app/background.js`.
- If you add new utilities that run in the page context, export them inside the `module.exports` guards to keep them testable by Node.
- The live extension relies on MV3 APIs (`background.js`) and Chrome runtime messaging; when writing tests, stub any additional Chrome APIs you need under the `global.chrome` object.
