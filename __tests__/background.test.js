let background;

beforeAll(() => {
  global.chrome = {
    storage: {
      sync: {
        get: jest.fn((defaults, callback) => {
          if (typeof defaults === 'function') {
            defaults({});
            return;
          }
          if (typeof callback === 'function') {
            const value = defaults === null ? {} : defaults;
            callback(value);
          }
        }),
        set: jest.fn(),
      },
      onChanged: {
        addListener: jest.fn(),
      },
    },
    runtime: {
      onInstalled: { addListener: jest.fn() },
      onMessage: { addListener: jest.fn() },
      getURL: jest.fn((path) => `chrome-extension://test/${path}`),
      sendMessage: jest.fn(),
    },
    declarativeNetRequest: {
      updateDynamicRules: jest.fn(() => Promise.resolve()),
    },
    webNavigation: {
      onBeforeNavigate: { addListener: jest.fn() },
      onCommitted: { addListener: jest.fn() },
      onErrorOccurred: { addListener: jest.fn() },
    },
    downloads: {
      onCreated: { addListener: jest.fn() },
      cancel: jest.fn(),
    },
    tabs: {
      update: jest.fn(),
      create: jest.fn(),
    },
  };

  background = require('../app/background.js');
});

afterAll(() => {
  delete require.cache[require.resolve('../app/background.js')];
});

describe('background helpers', () => {
  test('buildExactUrlRule escapes URLs and injects UA header', () => {
    const rule = background.buildExactUrlRule('https://example.com/manifest.mpd?x=1', 'TestUA', 42);
    expect(rule).toMatchObject({
      id: 42,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'User-Agent', operation: 'set', value: 'TestUA' }],
      },
      condition: {
        regexFilter: expect.stringMatching(/^\^https:.*$/),
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    });
    expect(rule.condition.regexFilter).toContain('\\?x=1');
  });

  test('looksLikeManifestUrl detects mpd and m3u8 paths', () => {
    expect(background.looksLikeManifestUrl('https://foo.bar/live/stream.m3u8')).toBe(true);
    expect(background.looksLikeManifestUrl('https://foo.bar/vod/manifest.mpd?token=abc')).toBe(true);
    expect(background.looksLikeManifestUrl('https://foo.bar/video.mp4')).toBe(false);
    expect(background.looksLikeManifestUrl('not-a-url')).toBe(false);
  });
});
