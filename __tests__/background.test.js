let background;
let messageListener;
let storageChangedListener;
let onBeforeNavigateListener;
let downloadCreatedListener;
let webRequestCompletedListener;

// Use fake timers to capture background startup timers and cleanup across tests
jest.useFakeTimers();

beforeEach(() => {
  jest.clearAllMocks();
  jest.clearAllTimers();
});

beforeAll(() => {
  const storageSyncGet = jest.fn((defaults, callback) => {
    if (typeof defaults === 'function') {
      defaults({});
      return;
    }
    if (typeof callback === 'function') {
      const value = defaults === null ? {} : defaults;
      callback(value);
    }
  });

  global.chrome = {
    storage: {
      sync: {
        get: storageSyncGet,
        set: jest.fn(),
      },
      onChanged: {
        addListener: jest.fn((cb) => {
          storageChangedListener = cb;
        }),
      },
    },
    runtime: {
      onInstalled: { addListener: jest.fn() },
      onMessage: {
        addListener: jest.fn((cb) => {
          messageListener = cb;
        }),
      },
      onStartup: { addListener: jest.fn() },
      getURL: jest.fn((path) => `chrome-extension://test/${path}`),
      sendMessage: jest.fn(),
    },
    declarativeNetRequest: {
      updateDynamicRules: jest.fn(() => Promise.resolve()),
      getDynamicRules: jest.fn((cb) => cb([{ id: 123 }])),
    },
    webNavigation: {
      onBeforeNavigate: {
        addListener: jest.fn((cb) => {
          onBeforeNavigateListener = cb;
        }),
      },
      onCommitted: {
        addListener: jest.fn(),
      },
      onErrorOccurred: {
        addListener: jest.fn(),
      },
    },
    downloads: {
      onCreated: {
        addListener: jest.fn((cb) => {
          downloadCreatedListener = cb;
        }),
      },
      onDeterminingFilename: {
        addListener: jest.fn(),
      },
      search: jest.fn((opts, cb) => cb([])),
      cancel: jest.fn((id, cb) => {
        if (typeof cb === 'function') cb();
      }),
    },
    tabs: {
      update: jest.fn((tabId, opts, cb) => {
        if (typeof cb === 'function') cb();
      }),
      create: jest.fn(),
    },
    webRequest: {
      onCompleted: {
        addListener: jest.fn((cb) => {
          webRequestCompletedListener = cb;
        }),
      },
      onBeforeSendHeaders: {
        addListener: jest.fn(),
      },
    },
  };

  background = require('../app/background.js');
  jest.runOnlyPendingTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.clearAllTimers();
});

afterAll(() => {
  delete require.cache[require.resolve('../app/background.js')];
  jest.runAllTimers();
  jest.useRealTimers();
});

describe('background helpers', () => {
  test('buildExactUrlRule escapes URLs and injects request headers', () => {
    const rule = background.buildExactUrlRule(
      'https://example.com/manifest.mpd?x=1',
      [{ header: 'User-Agent', operation: 'set', value: 'TestUA' }],
      42
    );
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

  test('isBlockedContext returns true for extension pages', () => {
    expect(background.isBlockedContext('chrome-extension://abc/viewer.html')).toBe(true);
  });

  test('isBlockedContext returns true for 123-test.stream host', () => {
    expect(background.isBlockedContext('https://123-test.stream/whatever.mpd')).toBe(true);
    expect(background.isBlockedHost('123-test.stream')).toBe(true);
  });

  test('isBlockedContext returns false for normal pages', () => {
    expect(background.isBlockedContext('https://example.com')).toBe(false);
  });

  test('APPLY_UA_RULE rejects when User-Agent override disabled', () => {
    const sendResponse = jest.fn();
    storageChangedListener?.({ uaEnabled: { newValue: false } }, 'sync');
    const shouldAsync = messageListener(
      { type: 'APPLY_UA_RULE', url: 'https://example.com/manifest.mpd' },
      null,
      sendResponse
    );
    expect(shouldAsync).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'User-Agent override disabled' });
  });

  test('APPLY_UA_RULE rejects when UA is missing', () => {
    const sendResponse = jest.fn();
    storageChangedListener?.({ uaEnabled: { newValue: true } }, 'sync');
    const shouldAsync = messageListener(
      { type: 'APPLY_UA_RULE', url: 'https://example.com/manifest.mpd', ua: '' },
      null,
      sendResponse
    );
    expect(shouldAsync).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'No User-Agent set' });
  });

  test('GET_TAB_MANIFEST_DOWNLOADS returns empty for blocked context', () => {
    const sendResponse = jest.fn();
    const shouldAsync = messageListener(
      { type: 'GET_TAB_MANIFEST_DOWNLOADS', tabId: 1, pageUrl: 'https://123-test.stream/manifest.mpd' },
      null,
      sendResponse
    );
    expect(shouldAsync).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, downloads: [] });
  });

  test('onBeforeNavigate redirects manifest URLs when auto-open enabled', async () => {
    // Ensure autoOpenViewer is true
    chrome.storage.sync.get.mockImplementation((defaults, cb) => cb({ autoOpenViewer: true }));
    const nowSpy = jest.spyOn(Date, 'now').mockImplementationOnce(() => 0).mockImplementationOnce(() => 40000);
    const details = {
      frameId: 0,
      tabId: 99,
      url: 'https://example.com/live/stream.m3u8',
      transitionType: 'typed',
      transitionQualifiers: [],
    };

    await onBeforeNavigateListener(details);
    nowSpy.mockRestore();

    expect(chrome.tabs.update).toHaveBeenCalledWith(
      99,
      { url: 'chrome-extension://test/viewer.html?u=https%3A%2F%2Fexample.com%2Flive%2Fstream.m3u8' },
      expect.any(Function)
    );
  });

  test('manifest downloads are intercepted and canceled', async () => {
    chrome.storage.sync.get.mockImplementation((defaults, cb) => cb({ autoOpenViewer: true }));
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(9999999999999);
    const item = {
      id: 123,
      finalUrl: 'https://example.com/file.mpd',
      tabId: 7,
      mime: 'application/dash+xml',
      startTime: '2024-01-01T00:00:00Z',
      referrer: 'https://example.com',
    };

    expect(typeof downloadCreatedListener).toBe('function');
    await downloadCreatedListener(item);
    await Promise.resolve();
    nowSpy.mockRestore();

    expect(chrome.storage.sync.get).toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalled();
    expect(chrome.downloads.cancel).toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(
      7,
      { url: 'chrome-extension://test/viewer.html?u=https%3A%2F%2Fexample.com%2Ffile.mpd' },
      expect.any(Function)
    );
  });

  test('GET_TAB_MANIFEST_DOWNLOADS returns detections from webRequest listener', async () => {
    // Record a manifest request
    await webRequestCompletedListener({
      url: 'https://foo.test/video.m3u8',
      tabId: 55,
      initiator: 'https://foo.test',
      timeStamp: Date.now(),
      requestHeaders: [{ name: 'User-Agent', value: 'TestUA' }],
    });

    const response = await new Promise((resolve) => {
      const shouldAsync = messageListener(
        { type: 'GET_TAB_MANIFEST_DOWNLOADS', tabId: 55, pageUrl: 'https://foo.test' },
        null,
        (payload) => resolve(payload)
      );
      expect(shouldAsync).toBe(true);
    });

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        downloads: expect.arrayContaining([expect.objectContaining({ url: 'https://foo.test/video.m3u8' })]),
      })
    );
  });

  test('onBeforeNavigate does not redirect when auto-open is disabled', async () => {
    chrome.storage.sync.get.mockImplementation((defaults, cb) => cb({ autoOpenViewer: false }));
    const details = {
      frameId: 0,
      tabId: 100,
      url: 'https://example.com/live/stream.m3u8',
      transitionType: 'typed',
      transitionQualifiers: [],
    };

    await onBeforeNavigateListener(details);

    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  test('GET_TAB_MANIFEST_DOWNLOADS includes history downloads', async () => {
    chrome.downloads.search.mockImplementation((opts, cb) =>
      cb([
        {
          finalUrl: 'https://media.test/clip.mpd',
          tabId: 77,
          mime: 'application/dash+xml',
          startTime: '2024-01-01T00:00:00Z',
          referrer: 'https://media.test/page',
        },
      ])
    );

    const response = await new Promise((resolve) => {
      const shouldAsync = messageListener(
        { type: 'GET_TAB_MANIFEST_DOWNLOADS', tabId: 77, pageUrl: 'https://media.test/page' },
        null,
        (payload) => resolve(payload)
      );
      expect(shouldAsync).toBe(true);
    });

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        downloads: expect.arrayContaining([expect.objectContaining({ url: 'https://media.test/clip.mpd', source: 'download_history' })]),
      })
    );
  });

  test('GET_MANIFEST_REQUEST_HEADERS returns normalized headers from detections', async () => {
    await webRequestCompletedListener({
      url: 'https://headers.test/video.m3u8',
      tabId: 5,
      initiator: 'https://headers.test',
      timeStamp: Date.now(),
      requestHeaders: [
        { name: 'User-Agent', value: 'UA-ONE' },
        { name: 'user-agent', value: 'UA-TWO' }, // should be deduped
      ],
    });

    const sendResponse = jest.fn();
    const shouldAsync = messageListener(
      { type: 'GET_MANIFEST_REQUEST_HEADERS', url: 'https://headers.test/video.m3u8' },
      null,
      sendResponse
    );

    expect(shouldAsync).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        headers: [{ name: 'User-Agent', value: 'UA-ONE' }],
      })
    );
  });

  test('APPLY_UA_RULE surfaces dynamic rules errors', async () => {
    chrome.declarativeNetRequest.updateDynamicRules.mockImplementationOnce(() =>
      Promise.reject(new Error('dnr fail'))
    );
    const response = await new Promise((resolve) => {
      const shouldAsync = messageListener(
        { type: 'APPLY_UA_RULE', url: 'https://example.com/manifest.mpd', ua: 'AgentX' },
        null,
        (payload) => resolve(payload)
      );
      expect(shouldAsync).toBe(true);
    });
    expect(response).toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/dnr fail/i) }));
  });

  test('APPLY_UA_RULE succeeds and applies rule', async () => {
    chrome.declarativeNetRequest.updateDynamicRules.mockImplementation(() => Promise.resolve());
    const response = await new Promise((resolve) => {
      const shouldAsync = messageListener(
        { type: 'APPLY_UA_RULE', url: 'https://example.com/manifest.mpd', ua: 'AgentY' },
        null,
        (payload) => resolve(payload)
      );
      expect(shouldAsync).toBe(true);
    });
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalled();
    expect(response).toEqual(expect.objectContaining({ ok: true }));
  });

  test('isUserInitiatedNavigation detects typed vs link clicks', () => {
    expect(background.isUserInitiatedNavigation({ transitionType: 'typed' })).toBe(true);
    expect(
      background.isUserInitiatedNavigation({
        transitionType: 'link',
        transitionQualifiers: ['from_address_bar'],
      })
    ).toBe(true);
    expect(background.isUserInitiatedNavigation({ transitionType: 'link', transitionQualifiers: [] })).toBe(false);
  });

  test('mergeHeaders prefers newer values and preserves previous', () => {
    const merged = background.mergeHeaders(
      [{ name: 'X-Test', value: 'new' }, { name: 'User-Agent', value: 'A' }],
      [{ name: 'X-Test', value: 'old' }, { name: 'Accept', value: 'application/json' }]
    );
    expect(merged).toEqual(
      expect.arrayContaining([
        { name: 'X-Test', value: 'new' },
        { name: 'User-Agent', value: 'A' },
        { name: 'Accept', value: 'application/json' },
      ])
    );
  });

  test('manifestNotificationMessage formats URL and host', () => {
    const msg = background.manifestNotificationMessage({
      url: 'https://cdn.test/path/manifest.mpd',
      pageUrl: 'https://player.test/page',
    });
    expect(msg).toContain('manifest.mpd');
    expect(msg).toContain('cdn.test');
  });

  test('startup gating defers non-user navigation on startup tabs', () => {
    const tabId = 10;
    background.markTabAsStartup(tabId);
    expect(background.shouldDeferForStartupTab(tabId, { transitionType: 'link', transitionQualifiers: [] })).toBe(true);
    // User-initiated clears startup flag
    expect(background.shouldDeferForStartupTab(tabId, { transitionType: 'typed', transitionQualifiers: [] })).toBe(false);
  });

  test('manifest detection sets badge and notification', async () => {
    chrome.action = {
      setBadgeText: jest.fn(),
      setBadgeBackgroundColor: jest.fn(),
    };
    chrome.notifications = {
      create: jest.fn((_id, _payload, cb) => cb && cb()),
      getPermissionLevel: jest.fn((cb) => cb('granted')),
      onClicked: { addListener: jest.fn() },
      onClosed: { addListener: jest.fn() },
    };
    chrome.runtime.sendMessage = jest.fn((payload, cb) => cb && cb());
    // ensure notifications are enabled
    background.recordManifestDetection({ url: 'https://noop', tabId: 0, pageUrl: 'https://noop' });
    const entry = {
      url: 'https://notify.test/stream.m3u8',
      tabId: 5,
      pageUrl: 'https://notify.test',
      headers: [{ name: 'User-Agent', value: 'UA' }],
    };
    background.recordManifestDetection(entry);
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 5, text: '!' });
    expect(chrome.notifications.create).toHaveBeenCalled();
  });

  test('recordManifestDetection merges headers across duplicate entries', () => {
    const url = 'https://merge.test/stream.m3u8';
    background.recordManifestDetection({
      url,
      tabId: 1,
      pageUrl: 'https://merge.test',
      headers: [{ name: 'User-Agent', value: 'UA1' }],
    });
    background.recordManifestDetection({
      url,
      tabId: 1,
      pageUrl: 'https://merge.test',
      headers: [{ name: 'Accept', value: 'application/vnd.apple.mpegurl' }],
    });
    const detection = background.findDetectionForUrl(url);
    expect(detection.headers).toEqual(
      expect.arrayContaining([
        { name: 'User-Agent', value: 'UA1' },
        { name: 'Accept', value: 'application/vnd.apple.mpegurl' },
      ])
    );
  });

  test('manifestNotificationMessage falls back to page host when URL missing', () => {
    const msg = background.manifestNotificationMessage({
      url: '',
      pageUrl: 'https://fallback.test/path',
    });
    expect(msg).toContain('fallback.test');
  });

  test('applyUARuleForUrl removes existing rules before adding', async () => {
    chrome.declarativeNetRequest.updateDynamicRules.mockClear();
    await background.applyUARuleForUrl('https://ua.test/manifest.mpd', 'AgentZ');
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [123] });
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith(
      expect.objectContaining({ addRules: expect.any(Array) })
    );
  });

  test('handleManifestDownload respects autoOpenViewer=false', async () => {
    chrome.storage.sync.get.mockImplementation((defaults, cb) => cb({ autoOpenViewer: false }));
    const item = {
      id: 99,
      finalUrl: 'https://skip.test/manifest.m3u8',
      tabId: 9,
      mime: 'application/vnd.apple.mpegurl',
    };
    await background.handleManifestDownload(item);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});
