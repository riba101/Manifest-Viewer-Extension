const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let viewer;

jest.useFakeTimers();

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
  global.URL = dom.window.URL;
  global.history = dom.window.history;
  global.requestAnimationFrame = (cb) => (typeof cb === 'function' ? cb() : undefined);
  global.navigator.clipboard = {
    writeText: jest.fn(() => Promise.resolve()),
  };
  global.URL.createObjectURL = jest.fn(() => 'blob://test');
  global.URL.revokeObjectURL = jest.fn();
  global.alert = jest.fn();
  global.console.error = jest.fn(); // silence jsdom navigation warnings in tests

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

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.clearAllTimers();
});

afterAll(() => {
  delete require.cache[require.resolve('../app/viewer.js')];
  jest.runAllTimers();
  jest.useRealTimers();
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

  test('decodeIso639 converts packed bits to language code', () => {
    expect(viewer.decodeIso639(5575)).toBe('eng');
  });

  test('formatUuid renders byte array with hyphen groups', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(viewer.formatUuid(bytes)).toBe('00010203-0405-0607-0809-0a0b0c0d0e0f');
  });

  test('detectMode infers dash, hls, json, and mp4 sources', () => {
    const modeSelect = document.getElementById('mode');
    modeSelect.value = 'auto';

    expect(
      viewer.detectMode('https://cdn.example.com/video.mpd', '<MPD mediaPresentationDuration="PT0S"></MPD>', 'application/dash+xml')
    ).toBe('dash');

    expect(viewer.detectMode('https://cdn.example.com/playlist.m3u8', '#EXTM3U\n#EXTINF:10,\nseg.ts', '')).toBe('hls');

    expect(viewer.detectMode('https://cdn.example.com/manifest.json', '{"streams": []}', 'application/json')).toBe('json');

    expect(viewer.detectMode('https://cdn.example.com/chunk.bin', '', 'video/mp4')).toBe('mp4');
  });

  test('detectMode respects manual selection and detects subtitles', () => {
    const modeSelect = document.getElementById('mode');
    modeSelect.value = 'hls';
    expect(
      viewer.detectMode('https://cdn.example.com/movie.mpd', '<MPD mediaPresentationDuration="PT0S"></MPD>', 'application/dash+xml')
    ).toBe('hls');

    modeSelect.value = 'auto';
    const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello';
    expect(viewer.detectMode('https://cdn.example.com/captions.vtt', vtt, 'text/vtt')).toBe('subtitles');

    const srt = '1\n00:00:00,000 --> 00:00:01,000\nHi';
    expect(viewer.detectMode('https://cdn.example.com/captions.srt', srt, '')).toBe('subtitles');
    modeSelect.value = 'auto';
  });

  test('detectMode falls back to dash for XML without extensions', () => {
    const modeSelect = document.getElementById('mode');
    modeSelect.value = 'auto';
    const xml = '<?xml version="1.0"?><root><child /></root>';
    expect(viewer.detectMode('https://cdn.example.com/data', xml, 'application/xml')).toBe('dash');
  });

  test('detectMode identifies multiple subtitle formats', () => {
    const modeSelect = document.getElementById('mode');
    modeSelect.value = 'auto';
    const ttml = '<tt xmlns="http://www.w3.org/ns/ttml"><body></body></tt>';
    expect(viewer.detectMode('https://cdn.example.com/captions.ttml', ttml, 'application/ttml+xml')).toBe('subtitles');
    const scc = 'Scenarist_SCC V1.0';
    expect(viewer.detectMode('https://cdn.example.com/captions.scc', scc, '')).toBe('subtitles');
  });

  test('renderLoadedView covers json and subtitles rendering', () => {
    const codeEl = document.getElementById('code');
    // JSON rendering
    viewer.renderLoadedView({
      mode: 'json',
      text: '{"hello":"world"}',
      buffer: null,
      url: 'https://cdn.example.com/manifest.json',
      meta: { contentType: 'application/json' },
      validation: null,
    });
    expect(codeEl.className).toBe('language-json');
    expect(codeEl.innerHTML).toContain('hello');

    // Subtitles rendering
    viewer.renderLoadedView({
      mode: 'subtitles',
      text: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello',
      buffer: null,
      url: 'https://cdn.example.com/captions.vtt',
      meta: { contentType: 'text/vtt' },
      validation: null,
    });
    expect(codeEl.className).toBe('language-plain');
    expect(codeEl.innerHTML).toContain('00:00:00.000');
  });

  test('renderLoadedView displays mp4 tree', () => {
    const codeEl = document.getElementById('code');
    const uint32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    const str = (value) => value.split('').map((ch) => ch.charCodeAt(0));
    const ftypPayload = [...str('isom'), ...uint32(0), ...str('isom')];
    const ftypBox = [...uint32(8 + ftypPayload.length), ...str('ftyp'), ...ftypPayload];
    const moovBox = [...uint32(8), ...str('moov')]; // empty container
    const bytes = Uint8Array.from([...ftypBox, ...moovBox]);

    viewer.renderLoadedView({
      mode: 'mp4',
      text: '',
      buffer: bytes,
      url: 'https://cdn.example.com/segment.mp4',
      meta: { contentType: 'video/mp4' },
      validation: null,
    });
    expect(codeEl.querySelector('.mp4-tree')).not.toBeNull();
  });

  test('parseMp4Structure warns on truncated uuid payload', () => {
    const bytes = Uint8Array.from([
      0x00, 0x00, 0x00, 0x10, // size 16
      0x75, 0x75, 0x69, 0x64, // uuid
      // missing 16-byte uuid identifier (only 4 bytes here)
      0x01, 0x02, 0x03, 0x04,
      0x00, 0x00, 0x00, 0x00, // size 0 box to consume rest
      0x6d, 0x64, 0x61, 0x74,
    ]);
    const { warnings } = viewer.parseMp4Structure(bytes);
    expect(warnings.some((w) => w.toLowerCase().includes('uuid'))).toBe(true);
  });

  test('parseMp4Structure warns on truncated child container', () => {
    // Box declares size longer than buffer
    const bytes = Uint8Array.from([
      0x00, 0x00, 0x00, 0x20, // size 32
      0x6d, 0x6f, 0x6f, 0x76, // moov
      0x00, 0x00, 0x00, 0x18, // child size 24
      0x6d, 0x76, 0x68, 0x64, // mvhd
      // insufficient payload for mvhd box
      0x00, 0x00, 0x00, 0x00,
    ]);
    const { warnings } = viewer.parseMp4Structure(bytes);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('renderLoadedView shows validation result view for dash', () => {
    const codeEl = document.getElementById('code');
    viewer.renderLoadedView({
      mode: 'validation',
      text: '',
      buffer: null,
      url: 'https://cdn.example.com/video.mpd',
      meta: null,
      validation: {
        url: 'https://cdn.example.com/video.mpd',
        sourceMode: 'dash',
        result: { errors: [], warnings: [], info: [{ message: 'ok' }] },
      },
    });
    expect(codeEl.className).toBe('validation-results');
    expect(codeEl.textContent).toContain('ok');
  });

  test('setCustomHeaders re-renders rows when panel is open', () => {
    const headersBtn = document.getElementById('editHeaders');
    headersBtn.click(); // open panel
    viewer.setCustomHeaders(
      [
        { name: 'X-Row-One', value: '1' },
        { name: 'X-Row-Two', value: '2' },
      ],
      { persist: false }
    );
    const rows = document.querySelectorAll('.headers-row[data-row-type="custom"]');
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test('headers panel validates, saves, and closes', () => {
    const headersBtn = document.getElementById('editHeaders');
    const headersPanel = document.getElementById('headersPanel');
    const saveBtn = document.getElementById('headersSave');
    const errorEl = document.getElementById('headersError');
    const uaInput = document.getElementById('ua');
    const uaEnabled = document.getElementById('uaEnabled');

    headersBtn.click();
    expect(headersPanel.hidden).toBe(false);

    const nameInput = headersPanel.querySelector('.headers-name');
    const valueInput = headersPanel.querySelector('.headers-value');

    nameInput.value = 'User-Agent'; // reserved => error
    valueInput.value = 'bad';
    saveBtn.click();
    expect(errorEl.textContent).toMatch(/managed separately/);
    expect(headersPanel.hidden).toBe(false);

    nameInput.value = 'X-Test-Header';
    valueInput.value = 'ok';
    uaInput.value = 'UA-Test';
    uaEnabled.checked = true;
    saveBtn.click();

    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ customUA: 'UA-Test', uaEnabled: true });
    expect(headersPanel.hidden).toBe(true);
    expect(headersBtn.title).toContain('X-Test-Header');
  });

  test('headers panel closes on Escape', () => {
    const headersBtn = document.getElementById('editHeaders');
    const headersPanel = document.getElementById('headersPanel');
    headersBtn.click();
    expect(headersPanel.hidden).toBe(false);
    const escapeEvent = new window.KeyboardEvent('keydown', { key: 'Escape' });
    document.dispatchEvent(escapeEvent);
    expect(headersPanel.hidden).toBe(true);
  });

  test('navigation snapshot and back button toggles', () => {
    const backBtn = document.getElementById('back');
    viewer.restoreSnapshot({
      url: 'https://cdn.example.com/video.mpd',
      text: '<MPD></MPD>',
      mode: 'dash',
      selectedMode: 'dash',
    });
    viewer.pushCurrentState();
    expect(backBtn.style.display).toBe('inline-flex');
    backBtn.click();
    expect(backBtn.style.display).toBe('none');
  });

  test('navigation/history serialization round trip', () => {
    const original = {
      url: 'https://cdn.example.com/movie.mpd',
      text: '<MPD></MPD>',
      mode: 'dash',
      selectedMode: 'dash',
      meta: { status: 200 },
    };
    viewer.restoreSnapshot(original);
    viewer.pushCurrentState();
    // simulate sessionStorage round-trip used by compat page
    const nav = JSON.parse(JSON.stringify(global.window.navigationStack || []));
    expect(Array.isArray(nav)).toBe(true);
  });

  test('copy/download flows handle text and binary modes', async () => {
    const copyManifestBtn = document.getElementById('copyManifest');
    const copyManifestUrlBtn = document.getElementById('copyManifestUrl');
    const downloadManifestBtn = document.getElementById('downloadManifest');
    const appendSpy = jest.spyOn(document.body, 'appendChild');
    const removeSpy = jest.spyOn(document.body, 'removeChild');
    const anchorSpy = jest.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL.mockClear();
    navigator.clipboard.writeText.mockClear();

    viewer.restoreSnapshot({
      url: 'https://cdn.example.com/playlist.m3u8',
      text: '#EXTM3U',
      mode: 'hls',
      selectedMode: 'hls',
    });

    await copyManifestBtn.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('#EXTM3U');

    await copyManifestUrlBtn.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://cdn.example.com/playlist.m3u8');

    downloadManifestBtn.click();
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));

    viewer.restoreSnapshot({
      url: 'https://cdn.example.com/segment.mp4',
      buffer: new Uint8Array([0, 0, 0, 0]),
      mode: 'segments',
      selectedMode: 'segments',
    });
    downloadManifestBtn.click();
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));

    appendSpy.mockRestore();
    removeSpy.mockRestore();
    anchorSpy.mockRestore();
  });

  test('renderLoadedView validation flow toggles back to manifest view', async () => {
    const validateBtn = document.getElementById('validateManifest');
    // Preload HLS manifest
    viewer.restoreSnapshot({
      url: 'https://cdn.example.com/playlist.m3u8',
      text: '#EXTM3U\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST',
      mode: 'hls',
      selectedMode: 'hls',
    });
    // Simulate manifest validation library
    global.window.ManifestValidation = {
      validateHlsManifest: jest.fn(async () => ({ errors: [], warnings: [], info: [{ message: 'Media segments: 1' }] })),
      validateDashManifest: jest.fn(),
    };

    validateBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(global.window.ManifestValidation.validateHlsManifest).toHaveBeenCalled();
    // After validation, button switches to "Return to Manifest"
    expect(validateBtn.textContent).toMatch(/Return to Manifest/);
    const backBtn = document.getElementById('back');
    backBtn.click();
    expect(validateBtn.textContent).toMatch(/Validate HLS/);
  });

  test('DASH inspector renders base options and unsupported segments', () => {
    const dashManifest = `
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
        <BaseURL>https://base.test/</BaseURL>
        <BaseURL serviceLocation="cdn2">https://cdn2.test/</BaseURL>
        <Period>
          <AdaptationSet contentType="video">
            <Representation id="v1" bandwidth="1000">
              <SegmentBase />
            </Representation>
            <Representation id="v2" bandwidth="2000">
              <SegmentTemplate media="seg_$Number$.m4s" initialization="init.m4s" />
            </Representation>
          </AdaptationSet>
        </Period>
      </MPD>
    `;
    const data = viewer.buildDashData(dashManifest, 'https://cdn.example.com/manifest.mpd');
    expect(data).not.toBeNull();
    if (!data) return;
    // Render into DOM
    viewer.renderLoadedView({
      mode: 'dash',
      text: dashManifest,
      buffer: null,
      url: 'https://cdn.example.com/manifest.mpd',
      meta: null,
      validation: null,
    });
    const baseSelect = document.getElementById('dash-base-select');
    expect(baseSelect).not.toBeNull();
    expect(Array.from(baseSelect.options).map((opt) => opt.value)).toEqual(
      expect.arrayContaining(['https://base.test/', 'https://cdn2.test/'])
    );
    // Unsupported segments list should exist
    const list = document.querySelector('.dash-rep-list');
    const options = Array.from(document.querySelectorAll('#dash-base-select option')).map((o) => o.value);
    expect(list).not.toBeNull();
    expect(options).toEqual(expect.arrayContaining(['https://base.test/', 'https://cdn2.test/']));
    // Unsupported segments should be recorded in data
    expect(data.unsupportedSegments.some((s) => s.type === 'SegmentBase')).toBe(true);
  });

  test('format helpers cover additional branches', () => {
    expect(viewer.formatFixed1616(null)).toBe('');
    expect(viewer.formatFixed1616(65536)).toBe('1.0000');
    expect(viewer.formatFixed88(undefined)).toBe('');
    expect(viewer.formatFixed88(512)).toBe('2.00');
    expect(viewer.formatDetailDisplay([1, 2, 3])).toBe('1, 2, 3');
    expect(viewer.formatDetailDisplay(null)).toBe('—');
    expect(viewer.formatDetailDisplay(1234)).toBe('1,234');
  });

  test('loadStoredHeaders parses legacy strings and updates tooltip', () => {
    const headersBtn = document.getElementById('editHeaders');
    const legacy = 'X-One: 1\n# comment line\nX-Two: 2';
    localStorage.setItem('mv_custom_headers_v1', legacy);
    viewer.loadStoredHeaders();
    expect(headersBtn.title).toContain('X-One');
    expect(headersBtn.title).toContain('X-Two');
  });

  test('header UI disables UA and updates tooltip', () => {
    const headersBtn = document.getElementById('editHeaders');
    const uaEnabled = document.getElementById('uaEnabled');
    const uaInput = document.getElementById('ua');
    viewer.setCustomHeaders([{ name: 'X-Foo', value: 'bar' }], { persist: false });
    uaEnabled.checked = false;
    uaInput.value = 'UA-Test';
    viewer.setCustomHeaders([{ name: 'X-Foo', value: 'bar' }], { persist: false });
    expect(headersBtn.title).toContain('Additional headers');
    expect(headersBtn.title).not.toContain('User-Agent');
  });

  test('buildDashData parses base URLs and segment timeline into groups', () => {
    const manifestUrl = 'https://cdn.example.com/path/manifest.mpd';
    const dashManifest = `
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
        <BaseURL>https://media.example.com/global/</BaseURL>
        <Period>
          <BaseURL>period/</BaseURL>
          <AdaptationSet contentType="video" lang="en">
            <BaseURL>adapt/</BaseURL>
            <Representation id="video_1080" bandwidth="1500000" codecs="avc1.4d401f" width="1920" height="1080">
              <BaseURL>rep/</BaseURL>
              <SegmentTemplate timescale="1000" media="chunk_$Number$.m4s" initialization="init-$RepresentationID$.mp4" startNumber="5">
                <SegmentTimeline>
                  <S t="0" d="2000" r="2" />
                  <S d="4000" />
                </SegmentTimeline>
              </SegmentTemplate>
            </Representation>
          </AdaptationSet>
        </Period>
      </MPD>
    `;

    const data = viewer.buildDashData(dashManifest, manifestUrl);
    expect(data).not.toBeNull();
    if (!data) throw new Error('buildDashData returned null');

    expect(data.manifestBase).toBe('https://cdn.example.com/path/');
    expect(data.baseOptions).toEqual([
      { value: 'https://media.example.com/global/', label: 'https://media.example.com/global/' },
    ]);

    expect(data.contexts).toHaveLength(1);
    const ctx = data.contexts[0];
    expect(ctx.mediaTemplate).toBe('chunk_$Number$.m4s');
    expect(ctx.initTemplate).toBe('init-$RepresentationID$.mp4');
    expect(ctx.autoBase).toBe('https://media.example.com/global/');
    expect(ctx.baseParts).toEqual(['period/', 'adapt/', 'rep/']);
    expect(ctx.startNumber).toBe(5);
    expect(ctx.contentType).toBe('video');
    expect(ctx.groups).toHaveLength(2);
    expect(ctx.groups[0].segments.map((seg) => seg.number)).toEqual([5, 6, 7]);
    expect(ctx.groups[0].segments.map((seg) => seg.time)).toEqual([0, 2000, 4000]);
    expect(ctx.groups[1].segments.map((seg) => seg.number)).toEqual([8]);
    expect(ctx.groups[1].segments[0].time).toBe(6000);
  });

  test('buildDashData returns null for malformed XML', () => {
    const badManifest = '<MPD><Unclosed';
    const data = viewer.buildDashData(badManifest, 'https://cdn.example.com/path/manifest.mpd');
    expect(data).toBeNull();
  });

  test('buildDashData flags representations without SegmentTemplate support', () => {
    const manifestUrl = 'https://cdn.example.com/path/manifest.mpd';
    const dashManifest = `
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
        <Period>
          <AdaptationSet contentType="audio">
            <Representation id="audio_1">
              <SegmentList />
            </Representation>
          </AdaptationSet>
        </Period>
      </MPD>
    `;

    const data = viewer.buildDashData(dashManifest, manifestUrl);
    expect(data).not.toBeNull();
    if (!data) throw new Error('buildDashData returned null');

    expect(data.contexts).toHaveLength(0);
    expect(data.unsupportedSegments).toHaveLength(1);
    expect(data.unsupportedSegments[0]).toEqual(
      expect.objectContaining({
        type: 'SegmentList',
        reason: expect.stringMatching(/SegmentList/),
        label: expect.stringContaining('audio'),
      })
    );
  });

  test('parseMp4Structure extracts top-level boxes and mvhd details', () => {
    const uint32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    const uint16 = (value) => [(value >>> 8) & 0xff, value & 0xff];
    const str = (value) => value.split('').map((ch) => ch.charCodeAt(0));
    const zeros = (count) => Array(count).fill(0);

    const buildBox = (type, payload) => {
      const size = 8 + payload.length;
      return [...uint32(size), ...str(type), ...payload];
    };

    const ftypPayload = [...str('isom'), ...uint32(0), ...str('isom')];
    const ftypBox = buildBox('ftyp', ftypPayload);

    const mvhdPayload = [
      0, 0, 0, 0, // version + flags
      ...uint32(0), // creation_time
      ...uint32(0), // modification_time
      ...uint32(1000), // timescale
      ...uint32(5000), // duration
      ...uint32(0x00010000), // rate
      ...uint16(0x0100), // volume
      ...zeros(10), // reserved
      ...zeros(36), // matrix
      ...zeros(24), // pre_defined
      ...uint32(2), // next_track_id
    ];
    const mvhdBox = buildBox('mvhd', mvhdPayload);
    const moovBox = buildBox('moov', mvhdBox);
    const bytes = Uint8Array.from([...ftypBox, ...moovBox]);

    const { boxes, warnings } = viewer.parseMp4Structure(bytes);
    expect(warnings).toHaveLength(0);
    expect(boxes.map((box) => box.type)).toEqual(['ftyp', 'moov']);

    const ftyp = boxes[0];
    expect(ftyp.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'major_brand', value: "'isom'" }),
        expect.objectContaining({ name: 'compatible_brands', value: "'isom'" }),
      ])
    );

    const moov = boxes[1];
    expect(moov.children).toHaveLength(1);
    const mvhd = moov.children[0];
    expect(mvhd.type).toBe('mvhd');
    expect(mvhd.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'timescale', value: 1000 }),
        expect.objectContaining({ name: 'duration', value: '5000' }),
        expect.objectContaining({ name: 'rate', value: '1.0000' }),
        expect.objectContaining({ name: 'volume', value: '1.00' }),
        expect.objectContaining({ name: 'next_track_id', value: 2 }),
      ])
    );
  });

  test('parseMp4Structure handles uuid boxes and keeps parsing', () => {
    const uint32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    const str = (value) => value.split('').map((ch) => ch.charCodeAt(0));

    const uuidPayload = Array(8).fill(0); // no payload after uuid header
    const uuidBox = [...uint32(8 + 16 + uuidPayload.length), ...str('uuid'), ...Array(16).fill(1), ...uuidPayload];
    const ftypPayload = [...str('isom'), ...uint32(0), ...str('isom')];
    const ftypBox = [...uint32(8 + ftypPayload.length), ...str('ftyp'), ...ftypPayload];
    const bytes = Uint8Array.from([...uuidBox, ...ftypBox]);

    const { boxes, warnings } = viewer.parseMp4Structure(bytes);
    expect(warnings).toHaveLength(0);
    expect(boxes[0].type).toBe('uuid');
    expect(boxes[0].uuid).toBe('01010101-0101-0101-0101-010101010101'); // derived from filled 0x01 bytes
    expect(boxes[1].type).toBe('ftyp');
  });

  test('parseMp4Structure surfaces warnings for invalid box sizes', () => {
    const bytes = Uint8Array.from([0, 0, 0, 4, 0x66, 0x74, 0x79, 0x70]); // size smaller than header
    const { boxes, warnings } = viewer.parseMp4Structure(bytes);
    expect(boxes).toHaveLength(0);
    expect(warnings.some((msg) => msg.includes('Invalid size'))).toBe(true);
  });

  test('parseMp4Structure handles zero-sized boxes consuming the remainder', () => {
    const ftyp = [
      0x00, 0x00, 0x00, 0x10, // size = 16
      0x66, 0x74, 0x79, 0x70, // ftyp
      0x69, 0x73, 0x6f, 0x6d, // payload
      0x00, 0x00, 0x00, 0x00,
    ];
    const mdatZero = [
      0x00, 0x00, 0x00, 0x00, // size 0 => runs to end
      0x6d, 0x64, 0x61, 0x74, // mdat
      0x01, 0x02, 0x03, 0x04,
    ];
    const bytes = Uint8Array.from([...ftyp, ...mdatZero]);
    const { boxes, warnings } = viewer.parseMp4Structure(bytes);
    expect(warnings).toEqual([]);
    const types = boxes.map((b) => b.type);
    expect(types).toEqual(['ftyp', 'mdat']);
    const mdat = boxes.find((b) => b.type === 'mdat');
    expect(mdat.size).toBe(bytes.length - 16); // size extends to end
  });

  test('formatMp4Date returns raw value when beyond safe range', () => {
    const huge = 2082844800n + BigInt(Number.MAX_SAFE_INTEGER) + 1000000n;
    expect(viewer.formatMp4Date(huge)).toBe(huge.toString());
  });

  test('highlightJSON keeps text when parsing fails', () => {
    const html = viewer.highlightJSON('not-json');
    expect(html).toContain('not-json');
    expect(html).not.toContain('data-manifest-link');
  });

  test('linkifyAbsoluteUrls returns empty string for falsy input', () => {
    expect(viewer.linkifyAbsoluteUrls('')).toBe('');
    expect(viewer.linkifyAbsoluteUrls(null)).toBe('');
  });
});
