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
  global.DOMParser = dom.window.DOMParser;

  global.chrome = {
    runtime: {
      sendMessage: jest.fn((_req, callback) => {
        if (typeof callback === 'function') callback({});
      }),
      getManifest: jest.fn(() => ({ version: '0.0.0-test' })),
      getURL: jest.fn((p) => `chrome-extension://test/${p}`),
    },
    storage: {
      sync: {
        set: jest.fn(),
        get: jest.fn((_q, cb) => cb({})),
      },
    },
  };

  viewer = require('../app/viewer.js');
});

afterAll(() => {
  delete require.cache[require.resolve('../app/viewer.js')];
});

describe('linkification', () => {
  test('highlightJSON linkifies absolute URLs in string values', () => {
    const input = JSON.stringify({
      homepage: 'https://example.com/page',
      nested: { doc: 'http://example.org/doc' },
      array: ['https://a.test/one', 'two'],
    });
    const html = viewer.highlightJSON(input);
    expect(html).toContain('data-manifest-link="1"');
    expect(html).toContain('https://example.com/page');
    expect(html).toContain('http://example.org/doc');
    expect(html).toContain('https://a.test/one');
  });

  test('linkifyAbsoluteUrls wraps absolute URLs in plain text', () => {
    const html = viewer.linkifyAbsoluteUrls('See https://foo.bar/x and http://baz.org/y.');
    expect(html).toContain('<a');
    expect(html).toContain('https://foo.bar/x');
    expect(html).toContain('http://baz.org/y');
  });
});
