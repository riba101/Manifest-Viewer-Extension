'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const rootDir = path.resolve(__dirname, '..');
const appDir = path.join(rootDir, 'app');
const distDir = path.join(rootDir, 'dist');
const outputName = 'manifest-viewer-extension-firefox.zip';
const outputPath = path.join(distDir, outputName);

if (!fs.existsSync(appDir)) {
  console.error(`Missing app directory at ${appDir}`);
  process.exit(1);
}

fs.mkdirSync(distDir, { recursive: true });

try {
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
} catch (error) {
  console.warn(`Could not remove existing archive: ${error.message}`);
}

// Load and transform manifest.json for Firefox
const manifestPath = path.join(appDir, 'manifest.json');
let manifestRaw;
try {
  manifestRaw = fs.readFileSync(manifestPath, 'utf8');
} catch (err) {
  console.error(`Failed to read manifest.json: ${err.message}`);
  process.exit(1);
}

/** @type {any} */
let manifest;
try {
  manifest = JSON.parse(manifestRaw);
} catch (err) {
  console.error(`manifest.json is not valid JSON: ${err.message}`);
  process.exit(1);
}

// Ensure browser_specific_settings for Gecko
manifest.browser_specific_settings = manifest.browser_specific_settings || {};
manifest.browser_specific_settings.gecko = manifest.browser_specific_settings.gecko || {};

// Set a conservative strict_min_version for MV3 support in Firefox
if (!manifest.browser_specific_settings.gecko.strict_min_version) {
  manifest.browser_specific_settings.gecko.strict_min_version = '115.0';
}

// Set an extension ID (required by AMO for MV3). Allow override via env var.
if (!manifest.browser_specific_settings.gecko.id) {
  manifest.browser_specific_settings.gecko.id = process.env.FIREFOX_EXTENSION_ID || '{9f79d8f8-87a9-4c9a-9d5a-7f2f8802a3b9}';
}

// Declare AMO data collection permissions (required for NEW extensions as of 2025-11-03).
// This extension does not collect or transmit personal data → declare "none".
if (!manifest.browser_specific_settings.gecko.data_collection_permissions) {
  manifest.browser_specific_settings.gecko.data_collection_permissions = {
    required: ['none'],
    optional: []
  };
}

// Permissions: replace Chrome-only permission with the generic one for Firefox
if (Array.isArray(manifest.permissions)) {
  manifest.permissions = manifest.permissions.map((p) =>
    p === 'declarativeNetRequestWithHostAccess' ? 'declarativeNetRequest' : p
  );
}

// Firefox doesn't support background.service_worker yet; switch to background.scripts
if (manifest.background && typeof manifest.background === 'object' && manifest.background.service_worker) {
  const sw = manifest.background.service_worker;
  manifest.background = { scripts: [sw] };
}

// Firefox AMO validator requires non-empty rule_resources. We don't ship static rules -> remove the block.
if (
  manifest.declarative_net_request &&
  Array.isArray(manifest.declarative_net_request.rule_resources) &&
  manifest.declarative_net_request.rule_resources.length === 0
) {
  delete manifest.declarative_net_request;
}

const output = fs.createWriteStream(outputPath);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`Built Firefox package → ${outputPath} (${archive.pointer()} bytes)`);
});

archive.on('warning', (error) => {
  if (error.code === 'ENOENT') {
    console.warn(error.message);
    return;
  }
  throw error;
});

archive.on('error', (error) => {
  throw error;
});

archive.pipe(output);

// Add all files except the original manifest.json
archive.glob('**/*', { cwd: appDir, dot: false, ignore: ['manifest.json'] });

// Add transformed manifest.json
archive.append(JSON.stringify(manifest, null, 2) + '\n', { name: 'manifest.json' });

archive.finalize();
