(function(){
  const $ = (id) => document.getElementById(id);
  const urlAInput = $('urlA');
  const urlBInput = $('urlB');
  const historyASelect = $('historyA');
  const historyBSelect = $('historyB');
  const runBtn = $('runDiff');
  const swapBtn = $('swapSources');
  const statusEl = $('status');
  const overviewEl = $('overview');
  const diffEl = $('diffResults');
  const manifestAEl = $('manifestA');
  const manifestBEl = $('manifestB');
  const toggleThemeBtn = $('toggleTheme');
  const entityDecoder = document.createElement('textarea');

  const snapshots = new Map();
  const selection = { a: null, b: null };

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


  function escapeAttrValue(s) {
    return escapeHTML(s).replace(/"/g, '&quot;');
  }

  function decodeHTML(s) {
    entityDecoder.innerHTML = s;
    return entityDecoder.value;
  }

  function renderJsonStringToken(token) {
    const s = typeof token === 'string' ? token : '""';
    let decoded = null;
    try {
      decoded = JSON.parse(s);
    } catch {
      decoded = null;
    }
    if (decoded && /^https?:\/\//i.test(decoded)) {
      const safeHref = escapeAttrValue(decoded);
      const safeTarget = escapeAttrValue(decoded);
      return `"${`<a href="${safeHref}" class="token uri" data-manifest-link="1" data-manifest-target="${safeTarget}">${escapeHTML(decoded)}</a>`}"`;
    }
    return `<span class="token string">${escapeHTML(s)}</span>`;
  }

  function stripBom(text) {
    if (!text) return '';
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function highlightJSON(text) {
    const sanitizedText = stripBom(text || '');
    let pretty = sanitizedText;
    if (sanitizedText) {
      try {
        const parsed = JSON.parse(sanitizedText);
        pretty = JSON.stringify(parsed, null, 2);
      } catch {
        // leave as-is
      }
    }

    const jsonTokenRe =
      /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|(\btrue\b|\bfalse\b)|(\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

    const out = [];
    let lastIndex = 0;
    let match;
    while ((match = jsonTokenRe.exec(pretty)) !== null) {
      out.push(escapeHTML(pretty.slice(lastIndex, match.index)));
      const [full, prop, str, boolVal, nullVal, numVal] = match;
      let cls = 'string';
      let textForSpan = full;

      if (prop) {
        cls = 'key';
        textForSpan = prop;
      } else if (str) {
        cls = 'string';
        textForSpan = str;
      } else if (boolVal) {
        cls = 'boolean';
        textForSpan = boolVal;
      } else if (nullVal) {
        cls = 'null';
        textForSpan = nullVal;
      } else if (numVal) {
        cls = 'number';
        textForSpan = numVal;
      }

      if (cls === 'string') {
        out.push(renderJsonStringToken(textForSpan));
      } else {
        out.push(`<span class="token ${cls}">${escapeHTML(textForSpan)}</span>`);
      }
      lastIndex = jsonTokenRe.lastIndex;
    }
    out.push(escapeHTML(pretty.slice(lastIndex)));
    return out.join('');
  }

  function linkifyDashContentSteeringText(html, baseUrl) {
    if (!html) return html;
    const re = /(&lt;<span class="token tag">ContentSteering<\/span>[\s\S]*?&gt;)([\s\u00a0]*)(https?:\/\/[^<\s][^<]*)/gi;
    return html.replace(re, (_match, open, ws, url) => {
      const decoded = decodeHTML(url);
      let href = decoded;
      if (baseUrl) {
        try {
          href = new URL(decoded, baseUrl).href;
        } catch {
          href = decoded;
        }
      }
      const safeHref = escapeAttrValue(href);
      const safeTarget = escapeAttrValue(href);
      return `${open}${ws}<a href="${safeHref}" class="token uri" data-dash-uri="1" data-manifest-link="1" data-manifest-target="${safeTarget}">${url}</a>`;
    });
  }

  function highlightDASH(xml, baseUrl) {
    const s = escapeHTML(xml);
    let out = s
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="token comment">$1</span>')
      .replace(/(&lt;\/?)([a-zA-Z0-9:_-]+)([^&]*?)(&gt;)/g, (m, open, name, rest, close) => {
        const attrs = rest.replace(/([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')/g, (mm, an, eq, av) => {
          return `<span class="token attr-name">${an}</span>${eq}<span class="token attr-value">${av}</span>`;
        });
        return `${open}<span class="token tag">${name}</span>${attrs}${close}`;
      });
    out = linkifyDashContentSteeringText(out, baseUrl);
    return out;
  }

  function highlightHLS(text, baseUrl) {
    const lines = text.split(/\n/);

    const linkifyAttrURI = (k, v) => {
      const key = k.toUpperCase();
      const isUriAttr = key === 'URI' || key.endsWith('-URI') || key.endsWith(':URI');
      if (!isUriAttr) {
        return `<span class="token key">${k}</span>=<span class="token value">${escapeHTML(v)}</span>`;
      }
      let inner = v;
      let qL = '', qR = '';
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        qL = v[0];
        qR = v[v.length - 1];
        inner = v.slice(1, -1);
      }
      let href = inner;
      try { href = new URL(inner, baseUrl).href; } catch {}
      const safeHref = escapeAttrValue(href);
      const safeTarget = escapeAttrValue(href);
      return `<span class="token key">${k}</span>=${escapeHTML(qL)}<a href="${safeHref}" data-manifest-link="1" data-manifest-target="${safeTarget}" data-hls-uri="1" class="token uri">${escapeHTML(inner)}</a>${escapeHTML(qR)}`;
    };

    const out = lines.map((raw) => {
      const line = raw.trim();
      if (!line) return '';
      if (/^#EXT/i.test(line)) {
        const i = line.indexOf(':');
        const head = i >= 0 ? line.slice(0, i) : line;
        let rhs = i >= 0 ? line.slice(i + 1) : '';
        let rendered = `<span class="token directive">${escapeHTML(head)}</span>`;
        if (!rhs) return rendered;
        rhs = rhs.replace(/([A-Z0-9-]+)=([^,"']+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, (_m, k, v) => linkifyAttrURI(k, v));
        return `${rendered}:${rhs}`;
      }
      if (/^#/i.test(line)) {
        return `<span class="token comment">${escapeHTML(line)}</span>`;
      }
      const isUriLine =
        /^https?:\/\//i.test(line) || /^\.{1,2}\//.test(line) || /^[^#].+/.test(line);
      if (isUriLine) {
        let href = line;
        try { href = new URL(line, baseUrl).href; } catch {}
        const safeHref = escapeAttrValue(href);
        const safeTarget = escapeAttrValue(href);
        return `<a href="${safeHref}" data-manifest-link="1" data-manifest-target="${safeTarget}" data-hls-uri="1" class="token uri">${escapeHTML(line)}</a>`;
      }
      return escapeHTML(line);
    });

    return out.join('\n');
  }

  function parseSnapshotList(raw, prefix) {
    if (!raw) return [];
    try {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list.map((entry, idx) => ({
        id: `${prefix}-${idx}`,
        url: entry.url || '',
        text: entry.text || '',
        mode: entry.mode || 'auto',
        contentType: entry.contentType || '',
        meta: entry.meta || null
      }));
    } catch {
      return [];
    }
  }

  function loadSnapshotsFromSession() {
    try {
      const currentRaw = sessionStorage.getItem('mv_diff_current');
      if (currentRaw) {
        const snap = JSON.parse(currentRaw);
        snapshots.set('current', {
          id: 'current',
          url: snap.url || '',
          text: snap.text || '',
          mode: snap.mode || 'auto',
          contentType: snap.contentType || '',
          meta: snap.meta || null
        });
      }
      const nav = parseSnapshotList(sessionStorage.getItem('mv_diff_nav'), 'hist');
      nav.forEach((snap) => snapshots.set(snap.id, snap));
    } catch {
      // ignore
    }
  }

  function buildHistorySelect(selectEl) {
    if (!selectEl) return;
    const opts = ['<option value="">History snapshot…</option>'];
    for (const [id, snap] of snapshots.entries()) {
      if (!snap.url) continue;
      const labelUrl = snap.url.length > 60 ? `${snap.url.slice(0, 57)}…` : snap.url;
      const label = snap.id === 'current'
        ? `Current • ${labelUrl}`
        : `History • ${labelUrl}`;
      opts.push(`<option value="${id}">${label}</option>`);
    }
    selectEl.innerHTML = opts.join('');
  }

  function selectSnapshot(side, id) {
    selection[side] = id || null;
    const snap = id ? snapshots.get(id) : null;
    const input = side === 'a' ? urlAInput : urlBInput;
    if (snap && input) {
      input.value = snap.url || '';
    }
  }

  function swapSources() {
    const aVal = urlAInput ? urlAInput.value : '';
    const bVal = urlBInput ? urlBInput.value : '';
    if (urlAInput) urlAInput.value = bVal;
    if (urlBInput) urlBInput.value = aVal;
    const aSel = selection.a;
    selection.a = selection.b;
    selection.b = aSel;
  }

  function resolveMode(source, text) {
    const explicit = source && source.mode ? String(source.mode).toLowerCase() : '';
    const inferred = source && source.analysis && source.analysis.mode
      ? String(source.analysis.mode).toLowerCase()
      : '';
    const preferred = ['dash', 'hls', 'json'].includes(explicit) ? explicit
      : ['dash', 'hls', 'json'].includes(inferred) ? inferred
      : '';
    return preferred || detectMode(text || '', source?.url || '', source?.contentType || '');
  }

  function detectMode(bodyText, url, contentType) {
    const ct = (contentType || '').toLowerCase();
    const trimmed = stripBom(bodyText || '').trim();
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

  async function fetchManifest(url) {
    const t0 = performance.now();
    const res = await fetch(url, { cache: 'no-store' });
    const rawText = await res.text();
    const text = stripBom(rawText);
    if (!res.ok) {
      const err = new Error(`Fetch failed (${res.status}) for ${url}`);
      err.responseText = text;
      throw err;
    }
    const duration = performance.now() - t0;
    const contentType = res.headers.get('content-type') || '';
    return {
      url,
      text,
      mode: detectMode(text, url, contentType),
      contentType,
      status: res.status,
      durationMs: duration
    };
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

  function parseHlsManifest(text, baseUrl) {
    const lines = (text || '').split(/\r?\n/);
    const variants = [];
    const audioGroups = [];
    const drm = new Set();
    const scte = new Set();

    let pendingStreamInf = null;
    lines.forEach((raw) => {
      const line = (raw || '').trim();
      if (!line) return;
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        pendingStreamInf = parseHlsAttrs(line);
        return;
      }
      if (!line.startsWith('#') && pendingStreamInf) {
        const attrs = pendingStreamInf;
        const bandwidth = attrs.BANDWIDTH ? Number.parseInt(attrs.BANDWIDTH, 10) : null;
        const resolution = attrs.RESOLUTION || '';
        const codecs = (attrs.CODECS || '').split(',').map((c) => c.trim()).filter(Boolean);
        const uri = (() => {
          try { return new URL(line, baseUrl).href; } catch { return line; }
        })();
        variants.push({
          type: 'video',
          id: attrs['STABLE-VARIANT-ID'] || attrs.AUDIO || uri || '',
          uri,
          bandwidth,
          avgBandwidth: attrs['AVERAGE-BANDWIDTH'] ? Number.parseInt(attrs['AVERAGE-BANDWIDTH'], 10) : null,
          resolution,
          frameRate: attrs['FRAME-RATE'] ? attrs['FRAME-RATE'] : '',
          codecs
        });
        pendingStreamInf = null;
        return;
      }
      if (line.startsWith('#EXT-X-MEDIA')) {
        const attrs = parseHlsAttrs(line);
        audioGroups.push({
          type: (attrs.TYPE || '').toLowerCase(),
          groupId: attrs['GROUP-ID'] || '',
          name: attrs.NAME || '',
          language: attrs.LANGUAGE || '',
          assocLanguage: attrs['ASSOC-LANGUAGE'] || '',
          uri: attrs.URI ? (() => { try { return new URL(attrs.URI, baseUrl).href; } catch { return attrs.URI; } })() : '',
          channels: attrs.CHANNELS || '',
          characteristics: attrs.CHARACTERISTICS || ''
        });
      }
      if (/^#EXT-X-(SESSION-)?KEY/i.test(line)) {
        const attrs = parseHlsAttrs(line);
        const keyformat = attrs.KEYFORMAT || 'identity';
        const method = attrs.METHOD || '';
        const item = method ? `${keyformat}:${method}` : keyformat;
        drm.add(item);
      }
      if (/SCTE-35/i.test(line) || /DATERANGE/.test(line) && /SCTE35/i.test(line)) {
        scte.add(line);
      }
    });

    return {
      mode: 'hls',
      variants,
      audioGroups,
      drm: Array.from(drm),
      scte: Array.from(scte),
      timeline: { type: 'HLS' }
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

  function parseDashManifest(text, url) {
    let doc = null;
    try {
      doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc && doc.getElementsByTagName('parsererror').length) {
        return { mode: 'dash', error: 'Failed to parse DASH XML.' };
      }
    } catch {
      return { mode: 'dash', error: 'Failed to parse DASH XML.' };
    }

    const drm = new Set();
    collectElementsByLocalName(doc.documentElement, 'ContentProtection').forEach((el) => {
      const scheme = el.getAttribute('schemeIdUri') || el.getAttribute('schemeiduri') || '';
      if (scheme) drm.add(scheme);
    });

    const scte = new Set();
    collectElementsByLocalName(doc.documentElement, 'EventStream').forEach((el) => {
      const scheme = (el.getAttribute('schemeIdUri') || '').toLowerCase();
      if (scheme.includes('scte35')) scte.add(scheme || 'scte35');
    });
    collectElementsByLocalName(doc.documentElement, 'InbandEventStream').forEach((el) => {
      const scheme = (el.getAttribute('schemeIdUri') || '').toLowerCase();
      if (scheme.includes('scte35')) scte.add(scheme || 'scte35');
    });

    const adaptations = collectElementsByLocalName(doc.documentElement, 'AdaptationSet');
    const variants = [];
    const timelineTypes = new Set();

    const getSegType = (as) => {
      if (!as) return 'None';
      if (collectElementsByLocalName(as, 'SegmentTimeline').length) return 'SegmentTemplate+Timeline';
      if (collectElementsByLocalName(as, 'SegmentTemplate').length) return 'SegmentTemplate';
      if (collectElementsByLocalName(as, 'SegmentList').length) return 'SegmentList';
      if (collectElementsByLocalName(as, 'SegmentBase').length) return 'SegmentBase';
      return 'None';
    };

    adaptations.forEach((as, idx) => {
      const asType = as.getAttribute('contentType') || as.getAttribute('mimeType') || '';
      const reps = collectElementsByLocalName(as, 'Representation');
      timelineTypes.add(getSegType(as));
      reps.forEach((rep, repIdx) => {
        const bw = rep.getAttribute('bandwidth');
        const width = rep.getAttribute('width');
        const height = rep.getAttribute('height');
        const frameRate = rep.getAttribute('frameRate');
        const codecs = rep.getAttribute('codecs') || as.getAttribute('codecs') || '';
        const mime = rep.getAttribute('mimeType') || as.getAttribute('mimeType') || '';
        const id = rep.getAttribute('id') || `adapt${idx}-rep${repIdx}`;
        variants.push({
          type: asType || (mime ? mime.split('/')[0] : ''),
          id,
          bandwidth: bw ? Number.parseInt(bw, 10) : null,
          resolution: width && height ? `${width}x${height}` : '',
          frameRate: frameRate || '',
          codecs: codecs ? codecs.split(',').map((c) => c.trim()).filter(Boolean) : [],
          mime
        });
      });
    });

    const timeline = { type: Array.from(timelineTypes).filter(Boolean).join(' / ') || 'None' };

    return {
      mode: 'dash',
      variants,
      drm: Array.from(drm),
      scte: Array.from(scte),
      timeline
    };
  }

  function analyzeManifest(source) {
    if (!source || !source.text) return { mode: 'plain', variants: [], drm: [], scte: [], timeline: { type: 'None' } };
    const sanitizedText = stripBom(source.text);
    const mode = resolveMode(source, sanitizedText);
    if (mode === 'hls') return { ...parseHlsManifest(sanitizedText, source.url || ''), url: source.url };
    if (mode === 'dash') return { ...parseDashManifest(sanitizedText, source.url || ''), url: source.url };
    return {
      mode,
      variants: [],
      drm: [],
      scte: [],
      timeline: { type: 'None' },
      url: source.url
    };
  }

  function variantKey(v) {
    if (!v) return '';
    if (v.id) return `id:${v.id}`;
    const parts = [v.type || '', v.resolution || '', v.bandwidth || '', (v.codecs || []).join('/')];
    return parts.join('|');
  }

  function variantLabel(v) {
    if (!v) return '';
    const parts = [];
    if (v.type) parts.push(v.type);
    if (v.resolution) parts.push(v.resolution);
    if (v.bandwidth) parts.push(`${v.bandwidth.toLocaleString()}bps`);
    if (v.codecs && v.codecs.length) parts.push(v.codecs.join(', '));
    if (v.frameRate) parts.push(`${v.frameRate}fps`);
    return parts.join(' • ') || (v.id || 'variant');
  }

  function diffVariants(listA, listB) {
    const mapA = new Map();
    const mapB = new Map();
    listA.forEach((v) => mapA.set(variantKey(v), v));
    listB.forEach((v) => mapB.set(variantKey(v), v));

    const added = [];
    const removed = [];
    const changed = [];

    for (const [key, vB] of mapB.entries()) {
      if (!mapA.has(key)) added.push(vB);
    }
    for (const [key, vA] of mapA.entries()) {
      if (!mapB.has(key)) removed.push(vA);
    }
    for (const [key, vA] of mapA.entries()) {
      if (!mapB.has(key)) continue;
      const vB = mapB.get(key);
      const fields = ['resolution', 'bandwidth', 'avgBandwidth', 'frameRate'];
      const diffFields = fields.filter((f) => (vA[f] || '') !== (vB[f] || ''));
      const codecsA = (vA.codecs || []).join(',');
      const codecsB = (vB.codecs || []).join(',');
      if (codecsA !== codecsB) diffFields.push('codecs');
      if (diffFields.length) {
        changed.push({ from: vA, to: vB, fields: diffFields });
      }
    }

    return { added, removed, changed };
  }

  function diffSets(a, b) {
    const setA = new Set(a || []);
    const setB = new Set(b || []);
    const added = [];
    const removed = [];
    setB.forEach((item) => { if (!setA.has(item)) added.push(item); });
    setA.forEach((item) => { if (!setB.has(item)) removed.push(item); });
    return { added, removed };
  }

  function renderOverview(a, b) {
    if (!overviewEl) return;
    const makeBlock = (label, src) => {
      if (!src) return `<div class="diff-group"><h3>${label}</h3><div class="small">No data.</div></div>`;
      const parts = [];
      if (src.url) parts.push(`<div class="small">URL: <span class="code">${escapeHTML(src.url)}</span></div>`);
      parts.push(`<div class="small">Mode: ${src.analysis.mode.toUpperCase()}</div>`);
      parts.push(`<div class="small">Variants: ${src.analysis.variants.length}</div>`);
      parts.push(`<div class="small">DRM entries: ${src.analysis.drm.length}</div>`);
      parts.push(`<div class="small">SCTE-35 tags: ${src.analysis.scte.length}</div>`);
      parts.push(`<div class="small">Timeline: ${src.analysis.timeline.type || 'None'}</div>`);
      return `<div class="diff-group"><h3>${label}</h3>${parts.join('')}</div>`;
    };
    overviewEl.innerHTML = `<div class="diff-grid">${makeBlock('Manifest A', a)}${makeBlock('Manifest B', b)}</div>`;
  }

  function renderDiff(diff) {
    if (!diffEl) return;
    const parts = [];

    const renderList = (title, items, formatter) => {
      const content = !items || !items.length
        ? '<div class="small">None</div>'
        : `<ul>${items.map((i) => `<li>${formatter(i)}</li>`).join('')}</ul>`;
      return `<div class="diff-group"><h3>${title}</h3>${content}</div>`;
    };

    parts.push(renderList('Added variants', diff.variants.added, (v) => escapeHTML(variantLabel(v))));
    parts.push(renderList('Removed variants', diff.variants.removed, (v) => escapeHTML(variantLabel(v))));
    parts.push(renderList('Changed variants', diff.variants.changed, (entry) => {
      const fields = entry.fields.join(', ');
      return `${escapeHTML(variantLabel(entry.from))} → ${escapeHTML(variantLabel(entry.to))} (${escapeHTML(fields)})`;
    }));

    const drmContent = `
      <div class="diff-grid">
        <div class="diff-group">
          <h3>Added DRM</h3>
          ${diff.drm.added.length ? `<ul>${diff.drm.added.map((d) => `<li>${escapeHTML(d)}</li>`).join('')}</ul>` : '<div class="small">None</div>'}
        </div>
        <div class="diff-group">
          <h3>Removed DRM</h3>
          ${diff.drm.removed.length ? `<ul>${diff.drm.removed.map((d) => `<li>${escapeHTML(d)}</li>`).join('')}</ul>` : '<div class="small">None</div>'}
        </div>
      </div>
    `;

    const scteContent = `
      <div class="diff-grid">
        <div class="diff-group">
          <h3>Added SCTE-35 tags</h3>
          ${diff.scte.added.length ? `<ul>${diff.scte.added.map((d) => `<li>${escapeHTML(d)}</li>`).join('')}</ul>` : '<div class="small">None</div>'}
        </div>
        <div class="diff-group">
          <h3>Removed SCTE-35 tags</h3>
          ${diff.scte.removed.length ? `<ul>${diff.scte.removed.map((d) => `<li>${escapeHTML(d)}</li>`).join('')}</ul>` : '<div class="small">None</div>'}
        </div>
      </div>
    `;

    const timelineContent = `
      <div class="diff-group">
        <h3>Timeline / addressing</h3>
        <div class="small">A: ${escapeHTML(diff.timeline.a || 'None')}</div>
        <div class="small">B: ${escapeHTML(diff.timeline.b || 'None')}</div>
      </div>
    `;

    diffEl.innerHTML = `
      <div class="diff-grid">${parts.join('')}</div>
      ${drmContent}
      ${scteContent}
      ${timelineContent}
    `;
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

  function renderManifestContent(el, source, fallback) {
    if (!el) return;
    const message = fallback || 'No manifest loaded.';
    if (!source || !source.text) {
      el.textContent = message;
      return;
    }
    const sanitized = stripBom(source.text);
    const mode = resolveMode(source, sanitized);
    let html = '';
    let cls = 'language-plain';
    if (mode === 'dash') {
      html = highlightDASH(sanitized, source.url || '');
      cls = 'language-xml';
    } else if (mode === 'hls') {
      html = highlightHLS(sanitized, source.url || '');
      cls = 'language-plain';
    } else if (mode === 'json') {
      html = highlightJSON(sanitized);
      cls = 'language-json';
    } else {
      html = escapeHTML(sanitized);
      cls = 'language-plain';
    }
    el.className = cls;
    el.innerHTML = html;
  }

  function renderManifests(a, b) {
    renderManifestContent(manifestAEl, a, 'No manifest loaded.');
    renderManifestContent(manifestBEl, b, 'No manifest loaded.');
  }

  async function getSource(side) {
    const input = side === 'a' ? urlAInput : urlBInput;
    const snapId = selection[side];
    if (snapId && snapshots.has(snapId)) {
      const snap = snapshots.get(snapId);
      if (snap && snap.text) {
        return { ...snap, analysis: analyzeManifest(snap) };
      }
    }
    const url = input && input.value ? input.value.trim() : '';
    if (!url) {
      throw new Error(`Manifest ${side.toUpperCase()} is empty.`);
    }
    const fetched = await fetchManifest(url);
    snapshots.set(`fetched-${side}`, fetched);
    return { ...fetched, analysis: analyzeManifest(fetched) };
  }

  async function runDiff() {
    setStatus('Running manifest diff…');
    diffEl.innerHTML = '';
    overviewEl.innerHTML = '';
    try {
      const [a, b] = await Promise.all([getSource('a'), getSource('b')]);
      a.analysis = a.analysis || analyzeManifest(a);
      b.analysis = b.analysis || analyzeManifest(b);
      if (a.analysis.error) throw new Error(`Manifest A: ${a.analysis.error}`);
      if (b.analysis.error) throw new Error(`Manifest B: ${b.analysis.error}`);
      renderOverview(a, b);

      const variants = diffVariants(a.analysis.variants || [], b.analysis.variants || []);
      const drm = diffSets(a.analysis.drm || [], b.analysis.drm || []);
      const scte = diffSets(a.analysis.scte || [], b.analysis.scte || []);
      const timeline = { a: a.analysis.timeline?.type || 'None', b: b.analysis.timeline?.type || 'None' };
      renderDiff({ variants, drm, scte, timeline });
      renderManifests(a, b);
      setStatus('Manifest diff complete.');
    } catch (err) {
      setStatus(err && err.message ? err.message : 'Manifest diff failed.', true);
    }
  }

  if (runBtn) runBtn.addEventListener('click', () => {
    runDiff();
  });
  if (swapBtn) swapBtn.addEventListener('click', () => {
    swapSources();
  });

  if (historyASelect) {
    historyASelect.addEventListener('change', (e) => {
      selectSnapshot('a', e.target.value || null);
    });
  }
  if (historyBSelect) {
    historyBSelect.addEventListener('change', (e) => {
      selectSnapshot('b', e.target.value || null);
    });
  }

  function tryRunDiffOnEnter(event) {
    if (event.key !== 'Enter') return;
    const a = urlAInput && urlAInput.value ? urlAInput.value.trim() : '';
    const b = urlBInput && urlBInput.value ? urlBInput.value.trim() : '';
    if (!a || !b) return;
    event.preventDefault();
    runDiff();
  }

  function handleGlobalEnter(event) {
    if (event.defaultPrevented || event.key !== 'Enter') return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const tag = (event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '');
    if (tag === 'textarea') return;
    const a = urlAInput && urlAInput.value ? urlAInput.value.trim() : '';
    const b = urlBInput && urlBInput.value ? urlBInput.value.trim() : '';
    if (!a || !b) return;
    event.preventDefault();
    runDiff();
  }

  if (urlAInput) urlAInput.addEventListener('keydown', tryRunDiffOnEnter);
  if (urlBInput) urlBInput.addEventListener('keydown', tryRunDiffOnEnter);
  document.addEventListener('keydown', handleGlobalEnter);

  loadSnapshotsFromSession();
  buildHistorySelect(historyASelect);
  buildHistorySelect(historyBSelect);
  if (snapshots.has('current')) {
    selectSnapshot('a', 'current');
  }
  setStatus('');
})();
