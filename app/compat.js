(function(){
  const $ = (id) => document.getElementById(id);
  const envEl = $('env');
  const codecWrap = $('codecTableWrapper');
  const drmWrap = $('drmTableWrapper');
  const runBtn = $('runChecks');
  const copyBtn = $('copyJson');
  const toggleThemeBtn = $('toggleTheme');
  const backBtn = $('backToViewer');

  const RESULTS = { env: {}, codecs: [], mse: [], mediaCapabilities: {}, drmMatrix: [] };
  // Toggle to suppress MediaCapabilities.decodingInfo for all codecs

  async function measureRefreshRate(samples = 12, timeoutMs = 800) {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame !== 'function') {
        resolve(null);
        return;
      }
      const times = [];
      let last;
      const start = performance.now();
      const done = () => {
        if (!times.length) return resolve(null);
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        resolve(Math.round(1000 / avg));
      };
      const step = (ts) => {
        if (ts - start > timeoutMs) return done();
        if (last !== undefined) times.push(ts - last);
        last = ts;
        if (times.length >= samples) return done();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

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

  function addKV(label, value) {
    const div = document.createElement('div');
    div.className = 'item';
    const s = document.createElement('strong');
    s.textContent = label;
    const v = document.createElement('span');
    v.textContent = value;
    div.appendChild(s);
    div.appendChild(v);
    envEl.appendChild(div);
  }

  function pill(ok, label) {
    const span = document.createElement('span');
    span.className = 'pill ' + (ok === true ? 'ok' : ok === false ? 'no' : 'maybe');
    span.textContent = label || (ok === true ? 'Yes' : ok === false ? 'No' : 'Maybe');
    return span;
  }

  function td(text) {
    const d = document.createElement('td');
    if (text instanceof Node) d.appendChild(text); else d.textContent = '' + text;
    return d;
  }
  function th(text) {
    const d = document.createElement('th');
    d.textContent = text; return d;
  }

  // Suppress known noisy console warnings during MediaCapabilities.decodingInfo
  // without affecting other logs. Filters messages like:
  // - "Failed to parse <audio|video> contentType: ..."
  // - "Invalid (ambiguous) <audio|video> codec string: ..."
  async function mcDecodingInfoQuiet(mc, cfg) {
    const ow = console.warn, oe = console.error;
    const shouldFilter = (args) => {
      try {
        const s = (args || []).map(a => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        return /Failed to parse\s+(audio|video)\s+contentType|Invalid \(ambiguous\)\s+(audio|video)\s+codec string/i.test(s);
      } catch {
        return false;
      }
    };
    console.warn = (...args) => { if (!shouldFilter(args)) ow(...args); };
    console.error = (...args) => { if (!shouldFilter(args)) oe(...args); };
    try {
      return await mc.decodingInfo(cfg);
    } finally {
      console.warn = ow;
      console.error = oe;
    }
  }

  async function getEnv() {
    const nav = navigator || {};
    const mediaCap = 'mediaCapabilities' in navigator;
    const mse = typeof window.MediaSource !== 'undefined';
    const eme = !!(navigator.requestMediaKeySystemAccess);
    const scr = typeof window !== 'undefined' && window.screen ? window.screen : null;
    const res = scr && scr.width && scr.height ? `${scr.width} x ${scr.height}` : 'n/a';
    const availRes = scr && scr.availWidth && scr.availHeight ? `${scr.availWidth} x ${scr.availHeight}` : '';
    const refresh = await measureRefreshRate();
    const hwConcurrency = nav.hardwareConcurrency || 'n/a';
    const mem = nav.deviceMemory || 'n/a';
    const ua = nav.userAgent || '';
    const vendor = nav.vendor || '';
    const platform = nav.platform || '';
    const lang = (nav.languages && nav.languages.join(', ')) || nav.language || '';

    // Display capabilities
    const mm = (q) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : false);
    const colorGamut = mm('(color-gamut: rec2020)') ? 'Rec.2020' : mm('(color-gamut: p3)') ? 'P3' : (mm('(color-gamut: srgb)') ? 'sRGB' : 'Unknown');
    const hdrSupport = mm('(dynamic-range: high)') || mm('(video-dynamic-range: high)');

    RESULTS.env = {
      ua,
      vendor,
      platform,
      languages: lang,
      mediaCapabilities: mediaCap,
      mse,
      eme,
      hardwareConcurrency: hwConcurrency,
      deviceMemory: mem,
      screenResolution: res,
      availableScreenResolution: availRes,
      screenFrequency: refresh,
      colorGamut,
      hdr: hdrSupport
    };

    envEl.innerHTML = '';
    addKV('User-Agent', ua);
    addKV('Vendor', vendor);
    addKV('Platform', platform);
    addKV('Languages', lang);
    addKV('MediaCapabilities API', mediaCap ? 'Yes' : 'No');
    addKV('MediaSource (MSE)', mse ? 'Yes' : 'No');
    addKV('Encrypted Media (EME)', eme ? 'Yes' : 'No');
    addKV('CPU Threads', String(hwConcurrency));
    addKV('Device Memory (GB)', String(mem));
    addKV('Screen Resolution', availRes && availRes !== res ? `${res} (avail ${availRes})` : res);
    addKV('Screen Frequency', refresh ? `${refresh} Hz` : 'n/a');
    addKV('Color Gamut', colorGamut);
    addKV('HDR', hdrSupport ? 'Yes' : 'No');
  }

  const VIDEO_TESTS = [
    { label: 'H.264 Baseline',   contentType: 'video/mp4; codecs="avc1.42E01E"', key: 'h264_b' },
    { label: 'H.264 High',       contentType: 'video/mp4; codecs="avc1.640028"', key: 'h264_h' },
    { label: 'HEVC (hvc1)',      contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"', key: 'hevc_hvc1' },
    { label: 'HEVC (hev1)',      contentType: 'video/mp4; codecs="hev1.1.6.L93.B0"', key: 'hevc_hev1' },
    // Dolby Vision over HEVC (dvhe) profiles
    { label: 'Dolby Vision (dvhe) P5',   contentType: 'video/mp4; codecs="dvhe.05.06"', key: 'dvhe_p5' },
    { label: 'Dolby Vision (dvhe) P8.1', contentType: 'video/mp4; codecs="dvhe.08.01"', key: 'dvhe_p8_1' },
    { label: 'Dolby Vision (dvhe) P8.4', contentType: 'video/mp4; codecs="dvhe.08.04"', key: 'dvhe_p8_4' },
    // AV1 variants
    { label: 'AV1 (MP4, 8-bit)',  contentType: 'video/mp4; codecs="av01.0.08M.08"', key: 'av1_mp4' },
    { label: 'AV1 (MP4, 10-bit)', contentType: 'video/mp4; codecs="av01.0.12M.10"', key: 'av1_mp4_10' },
    { label: 'VP9 (WebM)',       contentType: 'video/webm; codecs="vp09.00.10.08"', key: 'vp9' },
    { label: 'AV1 (WebM)',       contentType: 'video/webm; codecs="av01.0.05M.08"', key: 'av1_webm' },
    { label: 'VP8 (WebM)',       contentType: 'video/webm; codecs="vp8"', key: 'vp8' },
  ];
  const AUDIO_TESTS = [
    { label: 'AAC-LC',       contentType: 'audio/mp4; codecs="mp4a.40.2"', key: 'aac_lc' },
    { label: 'HE-AAC',       contentType: 'audio/mp4; codecs="mp4a.40.5"', key: 'heaac' },
    { label: 'Opus (WebM)',  contentType: 'audio/webm; codecs="opus"', key: 'opus' },
    { label: 'Vorbis (WebM)',contentType: 'audio/webm; codecs="vorbis"', key: 'vorbis' },
    { label: 'AC-3',         contentType: 'audio/mp4; codecs="ac-3"', key: 'ac3' },
    { label: 'E-AC-3',       contentType: 'audio/mp4; codecs="ec-3"', key: 'eac3' },
    { label: 'AC-4',         contentType: 'audio/mp4; codecs="ac-4"', key: 'ac4' },
  ];

  async function testCodecs() {
    const v = document.createElement('video');
    const a = document.createElement('audio');
    const hasMSE = typeof window.MediaSource !== 'undefined';
    const mc = navigator.mediaCapabilities;

    const rows = [];

    async function check(entry, kind) {
      const res = { label: entry.label, contentType: entry.contentType, kind, html: '""', mse: false, mc: null };
      try {
        const can = (kind === 'video' ? v.canPlayType(entry.contentType) : a.canPlayType(entry.contentType)) || '';
        res.html = can; // '', 'maybe', 'probably'
      } catch {}
      try {
        res.mse = hasMSE && MediaSource.isTypeSupported(entry.contentType);
      } catch { res.mse = false; }
      try {
        if (mc && typeof mc.decodingInfo === 'function') {
          const isVideo = kind === 'video';
          const cfg = isVideo ? {
            type: 'file',
            video: {
              contentType: entry.contentType,
              width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30,
            }
          } : {
            type: 'file',
            audio: {
              contentType: entry.contentType,
              channels: 2, bitrate: 128_000, samplerate: 48000,
            }
          };
          const info = await mcDecodingInfoQuiet(mc, cfg);
          res.mc = { supported: !!info.supported, smooth: !!info.smooth, powerEfficient: !!info.powerEfficient };
        }
      } catch { res.mc = null; }
      rows.push(res);
    }

    for (const e of VIDEO_TESTS) await check(e, 'video');
    for (const e of AUDIO_TESTS) await check(e, 'audio');

    RESULTS.codecs = rows;

    // Render
    const table = document.createElement('table');
    table.className = 'matrix';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.appendChild(th('Type'));
    hr.appendChild(th('MIME + codecs'));
    hr.appendChild(th('HTML5'));
    hr.appendChild(th('MSE'));
    hr.appendChild(th('MediaCapabilities'));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tb = document.createElement('tbody');
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      tr.appendChild(td(r.contentType.startsWith('video') ? 'Video' : 'Audio'));
      const mimeTd = document.createElement('td');
      mimeTd.innerHTML = `<span class="code">${r.contentType}</span>`;
      tr.appendChild(mimeTd);
      const htmlCell = document.createElement('td');
      htmlCell.appendChild(pill(r.html === 'probably' ? true : r.html === 'maybe' ? null : false, r.html || ''));
      tr.appendChild(htmlCell);
      tr.appendChild(td(pill(r.mse === true ? true : r.mse === false ? false : null)));
      const mcCell = document.createElement('td');
      if (r.mc) {
        const label = r.mc.supported ? (r.mc.powerEfficient ? 'Yes (efficient)' : 'Yes') : 'No';
        mcCell.appendChild(pill(r.mc.supported, label));
      } else {
        mcCell.appendChild(pill(null, 'n/a'));
      }
      tr.appendChild(mcCell);
      tb.appendChild(tr);
    });
    table.appendChild(tb);

    codecWrap.innerHTML = '';
    codecWrap.appendChild(table);
  }

  // DRM matrix
  const KEY_SYSTEMS = [
    { id: 'com.widevine.alpha', label: 'Widevine' },
    { id: 'com.microsoft.playready', label: 'PlayReady' },
    { id: 'org.w3.clearkey', label: 'ClearKey' },
    { id: 'com.apple.fps.1_0', label: 'FairPlay' },
  ];

  // Robustness levels to probe per key system (ordered strongest to weakest)
  const ROBUSTNESS = {
    'com.widevine.alpha': ['HW_SECURE_ALL', 'HW_SECURE_DECODE', 'HW_SECURE_CRYPTO', 'SW_SECURE_DECODE', 'SW_SECURE_CRYPTO'],
    'com.microsoft.playready': ['HW_SECURE_DECODE', 'HW_SECURE_CRYPTO', 'SW_SECURE_DECODE', 'SW_SECURE_CRYPTO'],
    'org.w3.clearkey': [''],
    'com.apple.fps.1_0': ['']
  };

  const DRM_CODECS = [
    // Video codecs
    { id: 'avc',    label: 'avc1',       kind: 'video', contentType: 'video/mp4; codecs="avc1.640028"', initDataTypes: ['cenc','keyids'] },
    { id: 'hevc',   label: 'hvc1',       kind: 'video', contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"', initDataTypes: ['cenc','keyids'] },
    { id: 'av1',    label: 'av01',       kind: 'video', contentType: 'video/mp4; codecs="av01.0.12M.10"', initDataTypes: ['cenc','keyids'] },
    // Audio codecs
    { id: 'aac_lc', label: 'mp4a.40.2',  kind: 'audio', contentType: 'audio/mp4; codecs="mp4a.40.2"', initDataTypes: ['cenc','keyids'] },
    { id: 'opus',   label: 'opus',       kind: 'audio', contentType: 'audio/webm; codecs="opus"', initDataTypes: ['webm','keyids'] },
    { id: 'ac3',    label: 'ac-3',       kind: 'audio', contentType: 'audio/mp4; codecs="ac-3"', initDataTypes: ['cenc','keyids'] },
    { id: 'eac3',   label: 'ec-3',       kind: 'audio', contentType: 'audio/mp4; codecs="ec-3"', initDataTypes: ['cenc','keyids'] },
  ];

  async function testDRM() {
    const hasEME = !!navigator.requestMediaKeySystemAccess;
    const table = document.createElement('table');
    table.className = 'matrix';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.appendChild(th('Codec'));
    KEY_SYSTEMS.forEach((ks) => hr.appendChild(th(ks.label)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tb = document.createElement('tbody');

    const matrix = [];

    for (const codec of DRM_CODECS) {
      const tr = document.createElement('tr');
      tr.appendChild(td(codec.label));
      const row = { codecId: codec.id, label: codec.label, keySystems: {} };

      for (const ks of KEY_SYSTEMS) {
        const cell = document.createElement('td');
        if (!hasEME) {
          cell.appendChild(pill(false, 'No'));
          row.keySystems[ks.id] = { supported: false, error: 'EME not available' };
          tr.appendChild(cell);
          continue;
        }
        try {
          const base = {
            initDataTypes: codec.initDataTypes,
            distinctiveIdentifier: 'not-allowed',
            persistentState: 'optional',
            sessionTypes: ['temporary']
          };

          const levels = ROBUSTNESS[ks.id] || [''];
          const attempts = [];
          let best = null;

          for (const rlevel of levels) {
            const cap = { contentType: codec.contentType };
            if (rlevel) cap.robustness = rlevel;
            const cfg = codec.kind === 'video'
              ? { ...base, videoCapabilities: [ cap ] }
              : { ...base, audioCapabilities: [ cap ] };
            try {
              const access = await navigator.requestMediaKeySystemAccess(ks.id, [cfg]);
              const ok = !!access;
              attempts.push({ robustness: rlevel || '', supported: ok });
              if (ok) { best = best === null ? (rlevel || '') : best; break; }
            } catch (e) {
              attempts.push({ robustness: rlevel || '', supported: false, error: (e && e.message) || String(e) });
            }
          }

          const supported = attempts.some(t => t.supported);
          row.keySystems[ks.id] = { supported, bestRobustness: best, attempts };
          const label = supported ? (best ? `Yes (${best})` : 'Yes') : 'No';
          cell.appendChild(pill(supported, label));
        } catch (err) {
          const msg = (err && err.message) || String(err);
          row.keySystems[ks.id] = { supported: false, error: msg };
          cell.appendChild(pill(false, 'No'));
        }
        tr.appendChild(cell);
      }
      matrix.push(row);
      tb.appendChild(tr);
    }

    table.appendChild(tb);
    drmWrap.innerHTML = '';
    drmWrap.appendChild(table);
    RESULTS.drmMatrix = matrix;
  }

  async function runAll() {
    // version
    const versionEl = document.getElementById('viewer-version');
    const versionSection = document.getElementById('version-section');
    const hide = () => { if (versionSection) versionSection.style.display = 'none'; };
    if (versionEl) {
      try {
        const manifest = chrome.runtime.getManifest();
        const v = manifest && typeof manifest.version === 'string' ? manifest.version.trim() : '';
        if (v) {
          versionEl.textContent = v;
          if (versionSection) versionSection.style.display = '';
        } else {
          hide();
        }
      } catch (e) {
        hide();
      }
    }

    await getEnv();

    await testCodecs();
    await testDRM();
  }

  if (runBtn) runBtn.addEventListener('click', runAll);
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(RESULTS, null, 2));
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy JSON'), 1200);
    } catch (e) {
      alert('Copy failed: ' + (e && e.message ? e.message : String(e)));
    }
  });
  if (backBtn) backBtn.addEventListener('click', () => {
    const isExt = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function';
    const page = isExt ? chrome.runtime.getURL('viewer.html') : (function(){ try { return new URL('viewer.html', window.location.href).href; } catch (e) { return 'viewer.html'; } })();
    try {
      window.location.href = page;
    } catch (e) {
      try { window.open(page, '_self'); } catch {}
    }
  });

  // Custom tester
  const customInput = $('customContentType');

  const customRunBtn = $('runCustom');
  const customResults = $('customResults');

  // Normalize user input: accept either full contentType or just a codec string
  function normalizeContentInput(raw) {
    const s = String(raw || '').trim();
    if (!s) return { contentType: '', kind: 'video' };
    // If it includes a slash, assume it's a full contentType (e.g., video/mp4; codecs="...")
    if (s.includes('/')) {
      const ct = s;
      const kind = ct.trim().toLowerCase().startsWith('audio/') ? 'audio' : 'video';
      return { contentType: ct, kind };
    }
    const c = s.toLowerCase();
    // Audio heuristics
    if (
      c.startsWith('mp4a.') || c === 'opus' || c === 'vorbis' ||
      c.startsWith('ac-') || c.startsWith('ec-') || c.startsWith('ac-4')
    ) {
      if (c === 'opus' || c === 'vorbis') {
        return { contentType: `audio/webm; codecs="${s}"`, kind: 'audio' };
      }
      return { contentType: `audio/mp4; codecs="${s}"`, kind: 'audio' };
    }
    // Video heuristics
    if (c.startsWith('vp09') || c === 'vp8') {
      return { contentType: `video/webm; codecs="${s}"`, kind: 'video' };
    }
    // Default to MP4 video for common codec strings (avc1., av01., hvc1., hev1.)
    return { contentType: `video/mp4; codecs="${s}"`, kind: 'video' };
  }

  async function runCustom() {
    if (!customResults) return;
    const raw = (customInput && customInput.value ? customInput.value.trim() : '') || '';
    const { contentType: ct, kind } = normalizeContentInput(raw);
    customResults.innerHTML = '';
    if (!ct) {
      const p = document.createElement('p');
      p.className = 'small';
      p.textContent = 'Enter a full contentType (e.g. video/mp4; codecs="avc1.640028").';
      customResults.appendChild(p);
      return;
    }

    // HTML5 canPlayType
    let html = '';
    try {
      const el = kind === 'video' ? document.createElement('video') : document.createElement('audio');
      html = el.canPlayType(ct) || '';
    } catch {}

    // MSE isTypeSupported
    let mse = false;
    try {
      mse = typeof window.MediaSource !== 'undefined' && MediaSource.isTypeSupported(ct);
    } catch { mse = false; }

    // MediaCapabilities decodingInfo
    let mc = null;
    try {
      const mcApi = navigator.mediaCapabilities;
      if (mcApi && typeof mcApi.decodingInfo === 'function') {
        const cfg = kind === 'video' ? {
          type: 'file',
          video: {
            contentType: ct,
            width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30,
          }
        } : {
          type: 'file',
          audio: {
            contentType: ct,
            channels: 2, bitrate: 128_000, samplerate: 48000,
          }
        };
        const info = await mcDecodingInfoQuiet(mcApi, cfg);
        mc = { supported: !!info.supported, smooth: !!info.smooth, powerEfficient: !!info.powerEfficient };
      }
    } catch {
      mc = { supported: false, smooth: false, powerEfficient: false };
    }

    // DRM (EME) across key systems with robustness sweep
    const ksResults = {};
    const hasEME = !!navigator.requestMediaKeySystemAccess;
    if (hasEME) {
      for (const ks of KEY_SYSTEMS) {
        const levels = (ROBUSTNESS && ROBUSTNESS[ks.id]) || [''];
        const attempts = [];
        let best = null;
        try {
          for (const rlevel of levels) {
            const base = {
              initDataTypes: (ct.includes('webm') ? ['webm','keyids'] : ['cenc','keyids']),
              distinctiveIdentifier: 'not-allowed',
              persistentState: 'optional',
              sessionTypes: ['temporary']
            };
            const cap = { contentType: ct };
            if (rlevel) cap.robustness = rlevel;
            const cfg = kind === 'video'
              ? { ...base, videoCapabilities: [ cap ] }
              : { ...base, audioCapabilities: [ cap ] };
            try {
              const access = await navigator.requestMediaKeySystemAccess(ks.id, [cfg]);
              const ok = !!access;
              attempts.push({ robustness: rlevel || '', supported: ok });
              if (ok) { best = best === null ? (rlevel || '') : best; break; }
            } catch (e) {
              attempts.push({ robustness: rlevel || '', supported: false, error: (e && e.message) || String(e) });
            }
          }
          ksResults[ks.id] = { supported: attempts.some(t => t.supported), bestRobustness: best, attempts };
        } catch (err) {
          ksResults[ks.id] = { supported: false, error: (err && err.message) || String(err) };
        }
      }
    }

    // Render results
    const wrap = document.createElement('div');
    wrap.style.display = 'grid';
    wrap.style.gap = '8px';

    const summary = document.createElement('div');
    summary.className = 'small';
    const safeCt = ct.replace(/&/g,'&').replace(/</g,'<');
    summary.innerHTML = `Type: <strong>${kind}</strong> | <span class="code">${safeCt}</span>`;
    wrap.appendChild(summary);

    const table = document.createElement('table');
    table.className = 'matrix';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.appendChild(th('Check'));
    hr.appendChild(th('Result'));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tb = document.createElement('tbody');

    const trHtml = document.createElement('tr');
    trHtml.appendChild(td('HTML5'));
    trHtml.appendChild(td(pill(html === 'probably' ? true : html === 'maybe' ? null : false, html || '')));
    tb.appendChild(trHtml);

    const trMse = document.createElement('tr');
    trMse.appendChild(td('MSE'));
    trMse.appendChild(td(pill(mse === true ? true : mse === false ? false : null)));
    tb.appendChild(trMse);

    const trMc = document.createElement('tr');
    trMc.appendChild(td('MediaCapabilities'));
    if (mc) {
      const label = mc.supported ? (mc.powerEfficient ? 'Yes (efficient)' : 'Yes') : 'No';
      trMc.appendChild(td(pill(mc.supported, label)));
    } else {
      trMc.appendChild(td(pill(null, 'n/a')));
    }
    tb.appendChild(trMc);

    table.appendChild(tb);
    wrap.appendChild(table);

    // DRM table
    const drmTable = document.createElement('table');
    drmTable.className = 'matrix';
    const dthead = document.createElement('thead');
    const dhr = document.createElement('tr');
    dhr.appendChild(th('DRM System'));
    dhr.appendChild(th('Supported'));
    dthead.appendChild(dhr);
    drmTable.appendChild(dthead);
    const dtb = document.createElement('tbody');

    KEY_SYSTEMS.forEach((ks) => {
      const row = document.createElement('tr');
      row.appendChild(td(ks.label));
      if (!hasEME) {
        row.appendChild(td(pill(false, 'No')));
      } else {
        const r = ksResults[ks.id] || { supported: false };
        const label = r.supported ? (r.bestRobustness ? `Yes (${r.bestRobustness})` : 'Yes') : 'No';
        row.appendChild(td(pill(!!r.supported, label)));
      }
      dtb.appendChild(row);
    });
    drmTable.appendChild(dtb);
    wrap.appendChild(drmTable);

    customResults.appendChild(wrap);
  }

  if (customRunBtn) customRunBtn.addEventListener('click', runCustom);
  // Run when pressing Enter in the input
  if (customInput) {
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runCustom();
      }
    });
  }

  // autorun
  runAll();
})();
