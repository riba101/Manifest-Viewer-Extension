const { JSDOM } = require('jsdom');

let validation;

beforeAll(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  global.DOMParser = dom.window.DOMParser;
  validation = require('../app/validation-core.js');
});

afterAll(() => {
  delete require.cache[require.resolve('../app/validation-core.js')];
  delete global.DOMParser;
});

describe('manifest validation helpers', () => {
  test('validateHlsManifest reports a healthy media playlist', async () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXTINF:10,',
      'segment1.ts',
      '#EXTINF:8,',
      'segment2.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const result = await validation.validateHlsManifest(manifest);
    expect(result.errors).toHaveLength(0);
    expect(result.info[0].message).toContain('Media segments: 2');
  });

  test('validateHlsManifest flags missing #EXTM3U', async () => {
    const result = await validation.validateHlsManifest('#EXTINF:10,\nsegment.ts');
    expect(result.errors.some((entry) => entry.message.includes('First line'))).toBe(true);
  });

  test('validateHlsManifest validates master children', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:4',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      'video/index.m3u8',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio/eng.m3u8"',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const media = [
      '#EXTM3U',
      '#EXT-X-VERSION:4',
      '#EXT-X-TARGETDURATION:6',
      '#EXTINF:6,',
      'seg1.ts',
      '#EXTINF:6,',
      'seg2.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const fetcher = jest.fn(async (uri) => {
      if (uri.endsWith('video/index.m3u8')) return media;
      if (uri.endsWith('audio/eng.m3u8')) return media;
      return '';
    });

    const result = await validation.validateHlsManifest(master, {
      baseUrl: 'https://cdn.example.com/master.m3u8',
      fetchPlaylist: fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.mediaPlaylists).toHaveLength(2);
    expect(result.errors.filter((e) => e.message.includes('Child playlist'))).toHaveLength(0);
  });

  test('validateDashManifest accepts template with duration', () => {
    const manifest = `
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT20S">
        <Period>
          <AdaptationSet contentType="video">
            <Representation id="video_1" bandwidth="500000">
              <SegmentTemplate media="chunk_$Number$.m4s" duration="2" startNumber="1" />
            </Representation>
          </AdaptationSet>
        </Period>
      </MPD>
    `;
    const result = validation.validateDashManifest(manifest);
    expect(result.errors).toHaveLength(0);
  });

  test('validateDashManifest detects missing representation segments', () => {
    const manifest = `
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
        <Period>
          <AdaptationSet contentType="video">
            <Representation id="video_1" bandwidth="500000" />
          </AdaptationSet>
        </Period>
      </MPD>
    `;
    const result = validation.validateDashManifest(manifest);
    expect(result.errors.some((entry) => entry.message.includes('SegmentTemplate'))).toBe(true);
  });

  test('validateHlsManifest deduplicates child playlist fetches', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,FRAME-RATE=24',
      'video.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,FRAME-RATE=24',
      'video.m3u8', // duplicate should be ignored
    ].join('\n');

    const child = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXTINF:6,', 'seg1.ts', '#EXT-X-ENDLIST'].join('\n');
    const fetcher = jest.fn(async () => child);

    const result = await validation.validateHlsManifest(master, {
      baseUrl: 'https://cdn.example.com/master.m3u8',
      fetchPlaylist: fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.mediaPlaylists).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  test('validateHlsManifest reports empty child playlist content', async () => {
    const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=100000', 'video.m3u8'].join('\n');
    const fetcher = jest.fn(async () => '   ');

    const result = await validation.validateHlsManifest(master, {
      baseUrl: 'https://cdn.example.com/master.m3u8',
      fetchPlaylist: fetcher,
    });

    expect(result.errors.some((entry) => entry.message.includes('returned empty content'))).toBe(true);
  });

  test('validateHlsManifest rejects empty input', async () => {
    const result = await validation.validateHlsManifest('');
    expect(result.errors).toEqual([expect.objectContaining({ message: 'Manifest is empty.' })]);
  });

  test('validateHlsManifest enforces EXT-X-VERSION for newer tags', async () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=100000',
      'video.m3u8',
      '#EXT-X-BYTERANGE:100@0',
    ].join('\n');

    const result = await validation.validateHlsManifest(manifest);
    expect(result.info.some((entry) => entry.message.includes('Detected 1 referenced child playlist'))).toBe(true);
    expect(result.warnings.some((entry) => entry.message.includes('not validated'))).toBe(true);
    expect(result.errors.some((entry) => entry.message.includes('requires at least version 4'))).toBe(true);
  });

  test('validateDashManifest reports XML parser errors', () => {
    const malformed = '<MPD><Unclosed';
    const result = validation.validateDashManifest(malformed);
    expect(result.errors.some((entry) => entry.message.includes('XML syntax errors'))).toBe(true);
  });

  test('validateDashManifest reports missing DOMParser', () => {
    const originalParser = global.DOMParser;
    try {
      delete global.DOMParser;
      const result = validation.validateDashManifest('<MPD />');
      expect(result.errors.some((entry) => entry.message.includes('DOMParser is unavailable'))).toBe(true);
    } finally {
      global.DOMParser = originalParser;
    }
  });
});
