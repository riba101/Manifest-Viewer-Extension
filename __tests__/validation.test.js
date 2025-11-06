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
});
