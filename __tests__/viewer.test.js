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
});
