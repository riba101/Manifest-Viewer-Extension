const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let viewer;

beforeAll(() => {
  const htmlPath = path.join(__dirname, '..', 'app', 'viewer.html');
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const dom = new JSDOM(html, { url: 'https://example.com/viewer.html', runScripts: 'outside-only' });

  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.localStorage = dom.window.localStorage;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.location = dom.window.location;

  global.chrome = {
    runtime: {
      sendMessage: jest.fn((_req, callback) => {
        if (typeof callback === 'function') callback({});
      }),
    },
    storage: {
      sync: {
        set: jest.fn(),
      },
    },
    declarativeNetRequest: {
      updateDynamicRules: jest.fn(),
    },
  };

  viewer = require('../app/viewer.js');
});

afterAll(() => {
  delete require.cache[require.resolve('../app/viewer.js')];
});

describe('viewer utilities', () => {
  test('formatDuration formats milliseconds and seconds', () => {
    expect(viewer.formatDuration(500)).toBe('500 ms');
    expect(viewer.formatDuration(2500)).toBe('2.50 s');
  });

  test('isLikelyMp4 detects by extension, content type, and bytes', () => {
    expect(viewer.isLikelyMp4('https://example.com/video.m4s')).toBe(true);
    expect(viewer.isLikelyMp4('https://example.com/data', 'video/mp4')).toBe(true);
    const bytes = Uint8Array.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]);
    expect(viewer.isLikelyMp4('https://example.com/other', '', bytes)).toBe(true);
    expect(viewer.isLikelyMp4('https://example.com/playlist.m3u8')).toBe(false);
  });

  test('parseRepeatCount guards invalid values and converts repeats to counts', () => {
    expect(viewer.parseRepeatCount(null)).toBe(1);
    expect(viewer.parseRepeatCount('-1')).toBe(1);
    expect(viewer.parseRepeatCount('0')).toBe(1);
    expect(viewer.parseRepeatCount('3')).toBe(4);
  });

  test('deriveManifestBase strips filename, query, and hash', () => {
    const url = 'https://cdn.example.com/video/manifest.mpd?token=abc#section';
    expect(viewer.deriveManifestBase(url)).toBe('https://cdn.example.com/video/');
  });

  test('resolveAgainstBase resolves paths', () => {
    const base = 'https://cdn.example.com/video/';
    expect(viewer.resolveAgainstBase(base, 'segment1.m4s')).toBe('https://cdn.example.com/video/segment1.m4s');
  });

  test('formatMp4Date converts MP4 epoch values to ISO timestamps', () => {
    expect(viewer.formatMp4Date(0n)).toBe('0');
    expect(viewer.formatMp4Date(2082844801n)).toBe('2082844801 (1970-01-01T00:00:01.000Z)');
  });

  test('formatHex pads hexadecimal numbers', () => {
    expect(viewer.formatHex(255)).toBe('0x000000ff');
    expect(viewer.formatHex(255, 4)).toBe('0x00ff');
  });

  test('formatBigInt handles numbers and bigints', () => {
    expect(viewer.formatBigInt(123456)).toBe('123,456');
    expect(viewer.formatBigInt(10n)).toBe('10');
    expect(viewer.formatBigInt(null)).toBe('');
  });
});
