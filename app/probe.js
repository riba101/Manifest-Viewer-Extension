(function(){
  const $ = (id) => document.getElementById(id);
  const urlInput = $('probeUrl');
  const countSelect = $('probeCount');
  const runBtn = $('runProbe');
  const statusEl = $('status');
  const timelineEl = $('timelineWrapper');
  const timelineMeta = $('timelineMeta');
  const segmentsTable = $('segmentsTable');
  const timelineZoomInput = $('timelineZoom');
  const timelineZoomValue = $('timelineZoomValue');
  const toggleThemeBtn = $('toggleTheme');

  const entityDecoder = document.createElement('textarea');
  let timelineZoom = 0;
  let lastTimelineSegments = null;
  let lastTimelineMeta = null;

  function setTheme(theme) {
    const html = document.documentElement;
    if (theme === 'light') html.setAttribute('data-theme', 'light');
    else html.setAttribute('data-theme', 'dark');
  }
  (function initTheme(){
    const t = localStorage.getItem('mv_theme');
    setTheme(t || 'dark');
  })();
  if (toggleThemeBtn) {
    toggleThemeBtn.addEventListener('click', () => {
      const html = document.documentElement;
      const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      setTheme(next);
      localStorage.setItem('mv_theme', next);
    });
  }

  function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.style.display = msg ? '' : 'none';
    statusEl.style.color = isError ? 'var(--error)' : 'var(--muted)';
  }

  function setZoom(val) {
    const parsed = Number(val);
    const next = Math.min(100, Math.max(0, Number.isFinite(parsed) ? parsed : (timelineZoom || 50)));
    timelineZoom = next;
    if (timelineZoomInput) timelineZoomInput.value = String(next);
    if (timelineZoomValue) timelineZoomValue.textContent = next === 0 ? 'Fit' : next === 100 ? '2 segments' : `${next}%`;
    if (lastTimelineSegments) renderTimeline(lastTimelineSegments, lastTimelineMeta);
  }

  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  function decodeHTML(s) {
    entityDecoder.innerHTML = s;
    return entityDecoder.value;
  }

  function detectMode(url, bodyText, contentType = '') {
    const ct = (contentType || '').toLowerCase();
    const trimmed = (bodyText || '').trim();
    const sanitized = trimmed.charCodeAt(0) === 0xfeff ? trimmed.slice(1) : trimmed;
    if (/\.mpd(\b|$)/i.test(url) || /dash|mpd/.test(ct) || /^<\?xml/.test(trimmed) || /^<MPD/i.test(trimmed)) {
      return 'dash';
    }
    if (/\.m3u8(\b|$)/i.test(url) || /application\/vnd\.apple\.mpegurl|application\/x-mpegurl/.test(ct) || /^#EXTM3U/i.test(trimmed)) {
      return 'hls';
    }
    if (/json/.test(ct)) return 'json';
    if (/^(\{|\[)/.test(trimmed)) return 'json';
    return 'plain';
  }

  async function fetchText(url) {
    const t0 = performance.now();
    const res = await fetch(url, { cache: 'no-store' });
    const text = await res.text();
    const duration = performance.now() - t0;
    const contentType = res.headers.get('content-type') || '';
    return { url, status: res.status, text, contentType, durationMs: duration };
  }

  function parseHlsAttrs(raw) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^,]*)/gi;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const key = m[1];
      let val = m[2] || '';
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      attrs[key] = val;
    }
    return attrs;
  }

  function parseHlsMedia(text, baseUrl, label, trackOrder = 0) {
    const lines = (text || '').split(/\r?\n/);
    const segments = [];
    let seq = 0;
    let targetDuration = null;
    let mediaSeq = 0;
    let startTime = 0;
    let endlist = false;
    let programDateTime = null;
    let availabilityStart = null;
    let availabilityEnd = null;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] || '';
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-TARGETDURATION')) {
        const val = line.split(':')[1];
        const num = Number.parseInt(val, 10);
        if (Number.isFinite(num)) targetDuration = num;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        const val = line.split(':')[1];
        const num = Number.parseInt(val, 10);
        if (Number.isFinite(num)) {
          mediaSeq = num;
          seq = num;
        }
      } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME')) {
        const val = line.split(':')[1];
        const ts = Date.parse(val);
        if (!Number.isNaN(ts)) programDateTime = ts;
      } else if (line.startsWith('#EXTINF')) {
        const durStr = line.split(':')[1];
        const dur = durStr ? Number.parseFloat(durStr) : null;
        const uriLine = (lines[i + 1] || '').trim();
        let uri = uriLine;
        try { uri = new URL(uriLine, baseUrl).href; } catch {}
        segments.push({
          number: seq,
          duration: dur,
          uri,
          start: startTime,
          track: label || '',
          trackOrder
        });
        seq += 1;
        if (dur !== null) startTime += dur;
      } else if (line === '#EXT-X-ENDLIST') {
        endlist = true;
      }
    }

    if (programDateTime !== null && segments.length) {
      availabilityStart = programDateTime;
      const totalDur = segments.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0);
      availabilityEnd = availabilityStart + totalDur * 1000;
    }

    return {
      mode: 'hls',
      targetDuration,
      mediaSequence: mediaSeq,
      segments,
      endlist,
      availabilityStart,
      availabilityEnd,
      availabilityLive: !endlist
    };
  }

  async function parseHls(text, baseUrl) {
    const lines = (text || '').split(/\r?\n/);
    const isMaster = lines.some((l) => /^#EXT-X-STREAM-INF/i.test(l));
    if (!isMaster) {
      return parseHlsMedia(text, baseUrl, 'default');
    }
    const variants = [];
    const audioGroups = {};
    const subtitleGroups = {};

    for (let i = 0; i < lines.length; i += 1) {
      const line = (lines[i] || '').trim();
      if (line.startsWith('#EXT-X-MEDIA')) {
        const attrs = parseHlsAttrs(line);
        const type = (attrs.TYPE || '').toLowerCase();
        const groupId = attrs['GROUP-ID'] || '';
        const name = attrs.NAME || '';
        const uriLine = attrs.URI || '';
        let uri = uriLine;
        try { uri = new URL(uriLine, baseUrl).href; } catch {}
        if (type === 'audio') {
          if (!audioGroups[groupId]) audioGroups[groupId] = [];
          audioGroups[groupId].push({ uri, label: name || groupId || uri });
        } else if (type === 'subtitles') {
          if (!subtitleGroups[groupId]) subtitleGroups[groupId] = [];
          subtitleGroups[groupId].push({ uri, label: name || groupId || uri });
        }
      }
      if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = parseHlsAttrs(line);
      const uriLine = (lines[i + 1] || '').trim();
      if (!uriLine) continue;
      let uri = uriLine;
      try { uri = new URL(uriLine, baseUrl).href; } catch {}
      variants.push({
        uri,
        label: `${attrs.RESOLUTION || ''} ${attrs.BANDWIDTH ? `${Number(attrs.BANDWIDTH).toLocaleString()}bps` : ''}`.trim() || uri,
        audioGroup: attrs.AUDIO || '',
        subtitleGroup: attrs.SUBTITLES || ''
      });
    }

    const tracks = [];
    let trackOrderCounter = 0;

    const fetchAndPush = async (entry, labelPrefix) => {
      if (!entry || !entry.uri) return;
      try {
        const media = await fetchText(entry.uri);
        tracks.push({
          meta: entry,
          parsed: parseHlsMedia(
            media.text,
            entry.uri,
            labelPrefix ? `${labelPrefix} • ${entry.label || entry.uri}` : (entry.label || entry.uri),
            trackOrderCounter
          )
        });
        trackOrderCounter += 1;
      } catch (err) {
        console.warn('Failed to fetch media playlist', entry.uri, err);
      }
    };

    for (const v of variants) {
      await fetchAndPush(v, 'Video');
      const audios = audioGroups[v.audioGroup] || [];
      for (const a of audios) await fetchAndPush(a, 'Audio');
      const subs = subtitleGroups[v.subtitleGroup] || [];
      for (const s of subs) await fetchAndPush(s, 'Subtitles');
    }

    const mergedSegments = tracks.flatMap((t) => (t.parsed && t.parsed.segments ? t.parsed.segments : []));
    const availabilityStart = Math.min(...tracks.map((t) => t.parsed.availabilityStart || Infinity));
    const availabilityEnd = Math.max(...tracks.map((t) => t.parsed.availabilityEnd || -Infinity));
    return {
      mode: 'hls',
      segments: mergedSegments,
      availabilityStart: Number.isFinite(availabilityStart) ? availabilityStart : null,
      availabilityEnd: Number.isFinite(availabilityEnd) ? availabilityEnd : null,
      availabilityLive: tracks.some((t) => t.parsed && t.parsed.availabilityLive)
    };
  }

  function collectElementsByLocalName(root, localName) {
    const out = [];
    if (!root) return out;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.localName === localName) out.push(node);
      if (node.children && node.children.length) {
        for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
      }
    }
    return out;
  }

  function resolveDashBaseUrls({ mpd, period, adaptation, rep, manifestUrl }) {
    const collectBaseUrls = (el) => {
      if (!el) return [];
      return collectElementsByLocalName(el, 'BaseURL')
        .map((b) => ({
          url: b && b.textContent ? b.textContent.trim() : '',
          label: b && b.getAttribute ? (b.getAttribute('serviceLocation') || '') : ''
        }))
        .filter((b) => b.url);
    };
    const manifestBase = (() => {
      try {
        const u = new URL(manifestUrl);
        u.hash = '';
        u.search = '';
        return u.href;
      } catch {
        return manifestUrl;
      }
    })();

    const layers = [
      collectBaseUrls(mpd),
      collectBaseUrls(period),
      collectBaseUrls(adaptation),
      collectBaseUrls(rep)
    ];

    let current = [{ url: manifestBase, label: '' }];
    layers.forEach((bases) => {
      if (!bases.length) return;
      const next = [];
      current.forEach((parent) => {
        bases.forEach((b) => {
          let resolved = b.url;
          try {
            resolved = new URL(b.url, parent.url).href;
          } catch {
            resolved = b.url;
          }
          next.push({ url: resolved, label: b.label || b.url });
        });
      });
      current = next;
    });

    // de-duplicate while preserving order
    const seen = new Set();
    const result = [];
    current.forEach((entry) => {
      if (seen.has(entry.url)) return;
      seen.add(entry.url);
      result.push(entry);
    });
    return result.length ? result : [{ url: manifestBase, label: manifestBase }];
  }

  function parseDash(text, url) {
    let doc = null;
    try {
      doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc && doc.getElementsByTagName('parsererror').length) {
        return { mode: 'dash', error: 'Failed to parse DASH XML.' };
      }
    } catch {
      return { mode: 'dash', error: 'Failed to parse DASH XML.' };
    }

    const segments = [];
    const mpd = doc.documentElement;
    const periods = collectElementsByLocalName(mpd, 'Period');

    const getDurationSeconds = (attr) => {
      if (!attr) return null;
      // PT#H#M#S
      const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/i.exec(attr);
      if (!match) return null;
      const hours = Number(match[1] || 0);
      const mins = Number(match[2] || 0);
      const secs = Number(match[3] || 0);
      return hours * 3600 + mins * 60 + secs;
    };

    let trackOrderCounter = 0;
    let cdnOrderCounter = 0;

    periods.forEach((period, pIdx) => {
      const adaptations = collectElementsByLocalName(period, 'AdaptationSet');
      adaptations.forEach((as) => {
        const reps = collectElementsByLocalName(as, 'Representation');
        reps.forEach((rep) => {
          // Use SegmentTemplate timeline
          const tmpl = collectElementsByLocalName(rep, 'SegmentTemplate')[0] || collectElementsByLocalName(as, 'SegmentTemplate')[0];
          const listEl = collectElementsByLocalName(rep, 'SegmentList')[0] || collectElementsByLocalName(as, 'SegmentList')[0];
          const base = url;
          const repId = rep.getAttribute('id') || `rep-${pIdx}-${segments.length}`;
          const trackLabelParts = [];
          const bw = rep.getAttribute('bandwidth');
          const width = rep.getAttribute('width');
          const height = rep.getAttribute('height');
          const codecs = rep.getAttribute('codecs') || as.getAttribute('codecs') || '';
          if (width && height) trackLabelParts.push(`${width}x${height}`);
          if (bw) trackLabelParts.push(`${Number(bw).toLocaleString()}bps`);
          if (codecs) trackLabelParts.push(codecs);
          const trackLabel = trackLabelParts.join(' • ') || repId;
          const baseUrls = resolveDashBaseUrls({ mpd, period, adaptation: as, rep, manifestUrl: url });

          baseUrls.forEach((baseUrlEntry, baseIdx) => {
            const trackOrder = trackOrderCounter++;
            const cdnOrder = cdnOrderCounter++;
            const cdnLabel = baseUrlEntry.label || baseUrlEntry.url || `CDN ${baseIdx + 1}`;
            const trackLabelWithCdn = baseUrls.length > 1
              ? `${trackLabel} [${cdnLabel}]`
              : (cdnLabel ? `${trackLabel} [${cdnLabel}]` : trackLabel);
            const baseUrl = baseUrlEntry.url;

            if (tmpl) {
              const timescale = Number.parseInt(tmpl.getAttribute('timescale') || '1', 10) || 1;
              const duration = Number.parseInt(tmpl.getAttribute('duration') || '0', 10);
              const startNumber = Number.parseInt(tmpl.getAttribute('startNumber') || '1', 10);
              const timeline = collectElementsByLocalName(tmpl, 'SegmentTimeline')[0];
              if (timeline) {
                const sNodes = collectElementsByLocalName(timeline, 'S');
                let currentNumber = startNumber;
                let currentTime = 0;
                sNodes.forEach((s) => {
                  const d = Number.parseInt(s.getAttribute('d') || '0', 10);
                  const r = Number.parseInt(s.getAttribute('r') || '0', 10);
                  const t = s.hasAttribute('t') ? Number.parseInt(s.getAttribute('t'), 10) : currentTime;
                  const repeat = Number.isFinite(r) ? r : 0;
                  const start = Number.isFinite(t) ? t : currentTime;
                  const count = repeat >= 0 ? repeat + 1 : 1;
                  for (let i = 0; i < count; i += 1) {
                    const st = start + i * d;
                    const segDur = d;
                    const uri = tmpl.getAttribute('media') || '';
                    const resolved = uri
                      ? uri.replace('$Number$', (currentNumber + i).toString()).replace('$Time$', st.toString()).replace('$RepresentationID$', rep.getAttribute('id') || '')
                      : '';
                    let fullUrl = resolved;
                    try { fullUrl = new URL(resolved, baseUrl).href; } catch {}
                    segments.push({
                      number: currentNumber + i,
                    duration: segDur / timescale,
                    uri: fullUrl,
                    start: st / timescale,
                    track: trackLabelWithCdn,
                    trackOrder,
                    cdnLabel,
                    cdnOrder
                  });
                }
                currentNumber += count;
                currentTime = start + count * d;
              });
              } else if (duration) {
                for (let i = 0; i < 10; i += 1) {
                  const st = (startNumber + i - 1) * duration;
                  const uri = tmpl.getAttribute('media') || '';
                  const resolved = uri
                    ? uri.replace('$Number$', (startNumber + i).toString()).replace('$Time$', st.toString()).replace('$RepresentationID$', rep.getAttribute('id') || '')
                    : '';
                  let fullUrl = resolved;
                  try { fullUrl = new URL(resolved, baseUrl).href; } catch {}
                  segments.push({
                    number: startNumber + i,
                    duration: duration / timescale,
                    uri: fullUrl,
                    start: st / timescale,
                    track: trackLabelWithCdn,
                    trackOrder,
                    cdnLabel,
                    cdnOrder
                  });
                }
              }
            } else if (listEl) {
              const segs = collectElementsByLocalName(listEl, 'SegmentURL');
              let startTime = 0;
              segs.forEach((seg, idx) => {
                const d = seg.getAttribute('d');
                const dur = d ? Number.parseInt(d, 10) : null;
                const media = seg.getAttribute('media') || '';
                let fullUrl = media;
                try { fullUrl = new URL(media, baseUrl).href; } catch {}
                segments.push({
                  number: idx + 1,
                duration: dur,
                uri: fullUrl,
                start: startTime,
                track: trackLabelWithCdn,
                trackOrder,
                cdnLabel,
                cdnOrder
              });
              if (dur !== null) startTime += dur;
            });
          }
          });
        });
      });
    });

    const periodDur = mpd.getAttribute('mediaPresentationDuration');
    const availabilityStart = mpd.getAttribute('availabilityStartTime');
    const minBufferTime = mpd.getAttribute('minBufferTime');

    return {
      mode: 'dash',
      segments,
      mediaPresentationDuration: periodDur,
      availabilityStart,
      minBufferTime
    };
  }

  function buildTimeline(segments, scalePxPerSecond, globalStartOverride) {
    if (!segments || !segments.length) return { total: 0, bars: [], gaps: [], start: 0, end: 0 };
    const start = globalStartOverride !== undefined ? globalStartOverride : Math.min(...segments.map((s) => s.start || 0));
    const end = Math.max(...segments.map((s) => (s.start || 0) + (s.duration || 0)));
    const span = Math.max(end - start, 0.0001);
    const bars = segments.map((s) => {
      const left = Math.max(0, (s.start - start) * scalePxPerSecond);
      const width = Math.max(1, (s.duration || 0) * scalePxPerSecond);
      return {
        left,
        width,
        label: `#${s.number} (${(s.duration || 0).toFixed(3)}s)`
      };
    });
    const gaps = [];
    const sorted = [...segments].sort((a, b) => (a.start || 0) - (b.start || 0));
    for (let i = 1; i < sorted.length; i += 1) {
      const prevEnd = (sorted[i - 1].start || 0) + (sorted[i - 1].duration || 0);
      const curStart = sorted[i].start || 0;
      const diff = curStart - prevEnd;
      if (diff > 0.05) {
        gaps.push({
          left: Math.max(0, (prevEnd - start) * scalePxPerSecond),
          width: Math.max(1, diff * scalePxPerSecond),
          label: `Gap ${diff.toFixed(3)}s`
        });
      }
    }
    return { total: span, bars, gaps, start, end };
  }

function renderTimeline(segments, meta) {
  if (!timelineEl || !timelineMeta) return;
  if (!segments || !segments.length) {
    timelineEl.innerHTML = '<div class="small" style="padding:8px;">No segments parsed.</div>';
    timelineMeta.textContent = '';
    return;
  }
  const cdnGroups = segments.reduce((map, seg) => {
    const cdnKey = seg.cdnLabel || seg.cdnUrl || 'Default';
    if (!map.has(cdnKey)) map.set(cdnKey, { order: seg.cdnOrder || 0, tracks: new Map() });
    const group = map.get(cdnKey);
    const trackKey = seg.track || 'default';
    if (!group.tracks.has(trackKey)) group.tracks.set(trackKey, { order: seg.trackOrder || 0, segments: [] });
    group.tracks.get(trackKey).segments.push(seg);
    return map;
  }, new Map());
  const orderedCdn = Array.from(cdnGroups.entries()).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
  timelineEl.innerHTML = '';
  const inner = document.createElement('div');
  inner.className = 'timeline-inner';

  // Global start/end for consistent ticks
  const globalStart = Math.min(...segments.map((s) => s.start || 0));
  const globalEnd = Math.max(...segments.map((s) => (s.start || 0) + (s.duration || 0)));
  const spanSeconds = Math.max(0.1, globalEnd - globalStart);

  const wrapperWidth = Math.max(
    320,
    timelineEl.clientWidth
    || timelineEl.offsetWidth
    || (timelineEl.parentElement ? timelineEl.parentElement.clientWidth : 0)
    || 0
  );
  const durations = segments
    .map((s) => s.duration)
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  const mid = durations.length ? Math.floor(durations.length / 2) : 0;
  const medianDuration = durations.length
    ? (durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2)
    : 0;
  const fallbackDuration = spanSeconds / Math.max(segments.length, 1);
  const typicalDuration = medianDuration || fallbackDuration || 1;
  const minScale = wrapperWidth / spanSeconds;
  const maxScale = typicalDuration > 0 ? wrapperWidth / (typicalDuration * 2) : minScale;
  const scaleHi = Math.max(minScale, maxScale);
  const zoomPct = Math.min(1, Math.max(0, (timelineZoom || 0) / 100));
  const pxPerSecond = minScale + (scaleHi - minScale) * zoomPct;
  const innerWidth = Math.max(wrapperWidth, spanSeconds * pxPerSecond);
  inner.style.width = `${innerWidth}px`;

  // Ticks based on global span
  const ticks = document.createElement('div');
  ticks.className = 'ticks';
  const roughStep = spanSeconds > 300 ? 60 : spanSeconds > 120 ? 30 : spanSeconds > 60 ? 10 : spanSeconds > 20 ? 5 : 1;
  const step = roughStep;
  for (let t = 0; t <= spanSeconds + 0.001; t += step) {
    const left = (t / spanSeconds) * innerWidth;
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = `${left}px`;
    tick.textContent = `${(globalStart + t).toFixed(1)}s`;
    ticks.appendChild(tick);
  }
  inner.appendChild(ticks);

  const metaParts = [];
  orderedCdn.forEach(([cdnLabel, group]) => {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'small';
    summary.textContent = cdnLabel;
    details.appendChild(summary);

    const orderedTracks = Array.from(group.tracks.entries()).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
    orderedTracks.forEach(([trackName, track]) => {
      const segList = track.segments;
      const wrapper = document.createElement('div');
      wrapper.style.position = 'relative';
      wrapper.style.height = '70px';
      wrapper.style.marginBottom = '8px';
      wrapper.style.borderBottom = '1px dashed var(--border)';
      wrapper.style.width = '100%';

      const label = document.createElement('div');
      label.className = 'small';
      label.style.position = 'absolute';
      label.style.top = '0';
      label.style.left = '0';
      label.textContent = trackName;
      wrapper.appendChild(label);

      const tl = buildTimeline(segList, pxPerSecond, globalStart);
      const barsSorted = [...tl.bars].sort((a, b) => a.left - b.left);
      barsSorted.forEach((bar, idx) => {
        const div = document.createElement('div');
        div.className = 'bar';
        div.style.left = `${bar.left}px`;
        div.style.width = `${Math.max(bar.width, 1)}px`;
        const baseBg = '#1e3a8a';
        const altBg = '#93c5fd';
        const baseBorder = '#1d4ed8';
        const altBorder = '#60a5fa';
        const useAlt = idx % 2 === 1;
        div.style.background = useAlt ? altBg : baseBg;
        div.style.borderColor = useAlt ? altBorder : baseBorder;
        div.title = bar.label;
        wrapper.appendChild(div);
      });
      tl.gaps.forEach((gap) => {
        const div = document.createElement('div');
        div.className = 'gap';
        div.style.left = `${gap.left}px`;
        div.style.width = `${Math.max(gap.width, 1)}px`;
        div.title = gap.label;
        wrapper.appendChild(div);
      });
      details.appendChild(wrapper);
      metaParts.push(`${cdnLabel} • ${trackName}: ${tl.total.toFixed(3)}s · ${segList.length} segments`);
    });

    inner.appendChild(details);
  });

  timelineEl.appendChild(inner);
  const availabilityText = meta && meta.availability ? ` · Availability: ${meta.availability}` : '';
  timelineMeta.textContent = `${metaParts.join(' | ')}${availabilityText}`;
}

  function pill(ok, label) {
    const span = document.createElement('span');
    span.className = 'pill ' + (ok === true ? 'ok' : ok === false ? 'no' : 'maybe');
    span.textContent = label || (ok === true ? 'Yes' : ok === false ? 'No' : 'Maybe');
    return span;
  }

  async function probeSegments(segments, count) {
    const out = [];
    const tracks = segments.reduce((map, seg) => {
      const key = seg.track || 'default';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(seg);
      return map;
    }, new Map());
    const perTrack = Math.max(1, count || 10);
    for (const [, list] of tracks.entries()) {
      const take = list.slice(0, perTrack);
      for (const seg of take) {
        const t0 = performance.now();
        let status = 0;
        let headers = {};
        let ok = false;
        let errMsg = '';
      try {
        const res = await fetch(seg.uri, { method: 'GET', cache: 'no-store' });
        status = res.status;
        ok = res.ok;
        res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
        await res.arrayBuffer(); // ensure body consumed
      } catch (err) {
        ok = false;
        errMsg = err && err.message ? err.message : String(err);
      }
      const latency = performance.now() - t0;
        out.push({
          ...seg,
          status,
          ok,
          latency,
          headers,
          error: errMsg
        });
      }
    }
    return out;
  }

  function renderSegmentsTable(rows) {
    if (!segmentsTable) return;
    if (!rows || !rows.length) {
      segmentsTable.innerHTML = '<div class="small">No segments probed yet.</div>';
      return;
    }
    const buildTable = (list) => {
      const table = document.createElement('table');
      table.className = 'matrix';
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      ['Track', '#', 'Duration', 'Status', 'Latency', 'CORS', 'Cache', 'URL'].forEach((h) => {
        const th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      const tb = document.createElement('tbody');
      list.forEach((r) => {
        const headers = r.headers || {};
        const tr = document.createElement('tr');
        tr.appendChild(cell(r.track || ''));
        const cors = headers['access-control-allow-origin'] || '';
        const cache = headers['cache-control'] || headers.age || '';
        tr.appendChild(cell(r.number || ''));
        tr.appendChild(cell(Number.isFinite(r.duration) ? `${r.duration.toFixed(3)}s` : '—'));
        tr.appendChild(cell(pill(r.ok, r.status ? String(r.status) : (r.error ? 'Err' : 'n/a'))));
        tr.appendChild(cell(Number.isFinite(r.latency) ? `${r.latency.toFixed(1)}ms` : 'n/a'));
        tr.appendChild(cell(cors || ''));
        tr.appendChild(cell(cache || ''));
        const urlCell = cell('');
        const a = document.createElement('a');
        a.href = r.uri;
        a.textContent = r.uri;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        urlCell.appendChild(a);
        tr.appendChild(urlCell);
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      return table;
    };

    const groups = rows.reduce((map, r) => {
      const key = r.cdnLabel || r.cdnUrl || 'Default';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
      return map;
    }, new Map());

    const orderedGroups = Array.from(groups.entries()).sort((a, b) => {
      const aOrder = a[1][0] && Number.isFinite(a[1][0].cdnOrder) ? a[1][0].cdnOrder : 0;
      const bOrder = b[1][0] && Number.isFinite(b[1][0].cdnOrder) ? b[1][0].cdnOrder : 0;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (a[0] || '').localeCompare(b[0] || '');
    });

    segmentsTable.innerHTML = '';
    const frag = document.createDocumentFragment();
    orderedGroups.forEach(([cdnLabel, list]) => {
      const details = document.createElement('details');
      details.className = 'segments-cdn';
      details.open = true;

      const summary = document.createElement('summary');
      summary.className = 'small';
      const failing = list.filter((r) => r.ok === false).length;
      const meta = [`${list.length} segment${list.length === 1 ? '' : 's'}`];
      if (failing) meta.push(`${failing} failing`);
      summary.textContent = `${cdnLabel} (${meta.join(', ')})`;
      details.appendChild(summary);

      details.appendChild(buildTable(list));
      frag.appendChild(details);
    });
    segmentsTable.appendChild(frag);
  }

  function cell(content) {
    const td = document.createElement('td');
    if (content instanceof Node) td.appendChild(content);
    else td.textContent = String(content);
    return td;
  }

  async function runProbe() {
    const url = urlInput && urlInput.value ? urlInput.value.trim() : '';
    if (!url) {
      setStatus('Enter a manifest URL.', true);
      return;
    }
    let count = countSelect ? Number.parseInt(countSelect.value, 10) : 10;
    if (!Number.isFinite(count) || count <= 0) count = 10;
    setStatus('Fetching manifest…');
    timelineEl.innerHTML = '';
    segmentsTable.innerHTML = '';
    try {
      const manifest = await fetchText(url);
      const mode = detectMode(url, manifest.text, manifest.contentType);
      let parsed = null;
      if (mode === 'hls') parsed = await parseHls(manifest.text, url);
      else if (mode === 'dash') parsed = parseDash(manifest.text, url);
      else throw new Error('Unsupported manifest type for probe.');
      if (parsed.error) throw new Error(parsed.error);
      lastTimelineSegments = parsed.segments;
      lastTimelineMeta = {
        availability: parsed.availabilityStart
          ? `${new Date(parsed.availabilityStart).toISOString()}${parsed.availabilityEnd ? ' → ' + new Date(parsed.availabilityEnd).toISOString() : ''}`
          : ''
      };
      renderTimeline(lastTimelineSegments, lastTimelineMeta);
      setStatus('Probing segments…');
      const probed = await probeSegments(parsed.segments, count);
      renderSegmentsTable(probed);
      setStatus('Done.');
    } catch (err) {
      setStatus(err && err.message ? err.message : 'Probe failed.', true);
    }
  }

  function bindEnterToRun(el) {
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      runProbe();
    });
  }

  if (runBtn) runBtn.addEventListener('click', runProbe);
  bindEnterToRun(urlInput);
  bindEnterToRun(countSelect);
  if (countSelect) countSelect.addEventListener('change', () => {
    if (segmentsTable && segmentsTable.innerHTML) {
      runProbe();
    }
  });
  if (timelineZoomInput) {
    timelineZoomInput.addEventListener('input', (e) => setZoom(e.target.value));
    setZoom(timelineZoomInput.value || 0);
  }

  if (backBtn) backBtn.addEventListener('click', () => {
    const isExt = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function';
    const page = isExt ? chrome.runtime.getURL('viewer.html') : 'viewer.html';
    try {
      window.location.href = page;
    } catch (e) {
      try { window.open(page, '_self'); } catch {}
    }
  });

  (function restoreFromViewer() {
    try {
      const raw = sessionStorage.getItem('mv_probe_current');
      if (raw) {
        const snap = JSON.parse(raw);
        if (snap && snap.url && urlInput) {
          urlInput.value = snap.url;
        }
      }
    } catch {}
  })();
})();
