'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const rootDir = path.resolve(__dirname, '..');
const appDir = path.join(rootDir, 'app');
const distDir = path.join(rootDir, 'dist');
const outputName = 'manifest-viewer-extension-chrome.zip';
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

const output = fs.createWriteStream(outputPath);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`Built Chrome package → ${outputPath} (${archive.pointer()} bytes)`);
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
archive.directory(appDir, false);
archive.finalize();
