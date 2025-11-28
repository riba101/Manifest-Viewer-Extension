(function(){
  const $ = (id) => document.getElementById(id);
  const envEl = $('env');
  const codecWrap = $('codecTableWrapper');
  const drmWrap = $('drmTableWrapper');
  const runBtn = $('runChecks');
  const copyBtn = $('copyJson');
  const copyShareLinkBtn = $('copyShareLink');
  const shareStatusEl = $('shareStatus');
  const toggleThemeBtn = $('toggleTheme');
  const backBtn = $('backToViewer');

  const RESULTS = { env: {}, codecs: [], mse: [], mediaCapabilities: {}, drmMatrix: [] };
  const HOSTED_COMPAT_URL = 'https://123-test.stream/app/compat.html';
  let manifestVersion = '';
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

  function renderEnvData(env) {
    if (!envEl) return;
    envEl.innerHTML = '';
    const ua = (env && env.ua) || '';
    const vendor = (env && env.vendor) || '';
    const platform = (env && env.platform) || '';
    const lang = (env && env.languages) || '';
    const mediaCap = !!(env && env.mediaCapabilities);
    const mse = !!(env && env.mse);
    const eme = !!(env && env.eme);
    const hwConcurrency = (env && env.hardwareConcurrency) || 'n/a';
    const mem = (env && env.deviceMemory) || 'n/a';
    const res = (env && env.screenResolution) || 'n/a';
    const availRes = (env && env.availableScreenResolution) || '';
    const refresh = env && env.screenFrequency;
    const colorGamut = (env && env.colorGamut) || 'Unknown';
    const hdrSupport = !!(env && env.hdr);
    const hdcp = env && env.hdcp;

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
    const hdcpLabel = hdcp
      ? (hdcp.level ? `HDCP ${hdcp.level}${hdcp.system ? ` (${hdcp.system})` : ''}` : 'Not available')
      : 'n/a';
    addKV('HDCP Level', hdcpLabel);
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

  // Probe best-effort HDCP level using EME policy checks (Widevine/PlayReady/WisePlay)
  async function detectHdcpLevel() {
    if (!navigator.requestMediaKeySystemAccess) return null;
    const systems = ['com.widevine.alpha', 'com.microsoft.playready', 'com.huawei.wiseplay'];
    const versions = ['2.3', '2.2', '2.1', '2.0', '1.4', '1.0'];
    const base = {
      initDataTypes: ['cenc', 'keyids'],
      distinctiveIdentifier: 'not-allowed',
      persistentState: 'optional',
      sessionTypes: ['temporary'],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
    };

    for (const ks of systems) {
      try {
        const access = await navigator.requestMediaKeySystemAccess(ks, [base]);
        if (!access) continue;
        const keys = await access.createMediaKeys();
        if (!keys || typeof keys.getStatusForPolicy !== 'function') continue;

        for (const ver of versions) {
          try {
            const status = await keys.getStatusForPolicy({ minHdcpVersion: ver });
            if (status === 'usable') {
              return { system: ks, level: ver, status };
            }
          } catch {
            // Ignore and try the next level
          }
        }
      } catch {
        // Try next key system
      }
    }
    return null;
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
    const hwConcurrency = nav.hardwareConcurrency || 'n/a';
    const mem = nav.deviceMemory || 'n/a';
    const ua = nav.userAgent || '';
    const vendor = nav.vendor || '';
    const platform = nav.platform || '';
    const lang = (nav.languages && nav.languages.join(', ')) || nav.language || '';

    // Display capabilities
    const scr = typeof window !== 'undefined' && window.screen ? window.screen : null;
    const res = scr && scr.width && scr.height ? `${scr.width} x ${scr.height}` : 'n/a';
    const availRes = scr && scr.availWidth && scr.availHeight ? `${scr.availWidth} x ${scr.availHeight}` : '';
    const refresh = await measureRefreshRate();
    const mm = (q) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : false);
    const colorGamut = mm('(color-gamut: rec2020)') ? 'Rec.2020' : mm('(color-gamut: p3)') ? 'P3' : (mm('(color-gamut: srgb)') ? 'sRGB' : 'Unknown');
    const hdrSupport = mm('(dynamic-range: high)') || mm('(video-dynamic-range: high)');
    const hdcp = await detectHdcpLevel();

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
      hdr: hdrSupport,
      hdcp: hdcp ? { level: hdcp.level, system: hdcp.system, status: hdcp.status } : null
    };

    renderEnvData(RESULTS.env);
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

  function renderCodecsTable(rows) {
    if (!codecWrap) return;
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

  async function testCodecs() {
    const v = document.createElement('video');
    const a = document.createElement('audio');
    const hasMSE = typeof window.MediaSource !== 'undefined';
    const mc = navigator.mediaCapabilities;

    const rows = [];

    async function check(entry, kind) {
      const res = { key: entry.key, label: entry.label, contentType: entry.contentType, kind, html: '""', mse: false, mc: null };
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
    renderCodecsTable(rows);
  }

  // DRM matrix
  const KEY_SYSTEMS = [
    { id: 'com.widevine.alpha', label: 'Widevine' },
    { id: 'com.microsoft.playready', label: 'PlayReady' },
    { id: 'org.w3.clearkey', label: 'ClearKey' },
    { id: 'com.huawei.wiseplay', label: 'WisePlay' },
    { id: 'com.apple.fps.1_0', label: 'FairPlay' },
  ];

  // Robustness levels to probe per key system (ordered strongest to weakest)
  const ROBUSTNESS = {
    'com.widevine.alpha': ['HW_SECURE_ALL', 'HW_SECURE_DECODE', 'HW_SECURE_CRYPTO', 'SW_SECURE_DECODE', 'SW_SECURE_CRYPTO'],
    'com.microsoft.playready': ['HW_SECURE_DECODE', 'HW_SECURE_CRYPTO', 'SW_SECURE_DECODE', 'SW_SECURE_CRYPTO'],
    'org.w3.clearkey': [''],
    'com.huawei.wiseplay': ['HW_SECURE_ALL', 'HW_SECURE_DECODE', 'HW_SECURE_CRYPTO', 'SW_SECURE_DECODE', 'SW_SECURE_CRYPTO', ''],
    'com.apple.fps.1_0': ['']
  };
  const ENCRYPTION_SCHEMES = ['cenc', 'cbcs'];

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
    const matrix = [];

    for (const codec of DRM_CODECS) {
      const row = { codecId: codec.id, label: codec.label, keySystems: {} };

      for (const ks of KEY_SYSTEMS) {
        if (!hasEME) {
          row.keySystems[ks.id] = { supported: false, error: 'EME not available', schemes: {} };
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
          const schemes = {};
          let supported = false;
          let best = null;
          let bestScheme = null;

          for (const scheme of ENCRYPTION_SCHEMES) {
            const schemeAttempts = [];
            let schemeBest = null;
            let schemeSupported = false;

            for (const rlevel of levels) {
              const cap = { contentType: codec.contentType, encryptionScheme: scheme };
              if (rlevel) cap.robustness = rlevel;
              const cfg = codec.kind === 'video'
                ? { ...base, videoCapabilities: [ cap ] }
                : { ...base, audioCapabilities: [ cap ] };
              try {
                const access = await navigator.requestMediaKeySystemAccess(ks.id, [cfg]);
                const ok = !!access;
                schemeAttempts.push({ robustness: rlevel || '', encryptionScheme: scheme, supported: ok });
                attempts.push({ robustness: rlevel || '', encryptionScheme: scheme, supported: ok });
                if (ok) {
                  schemeSupported = true;
                  if (schemeBest === null) schemeBest = rlevel || '';
                  break;
                }
              } catch (e) {
                const msg = (e && e.message) || String(e);
                schemeAttempts.push({ robustness: rlevel || '', encryptionScheme: scheme, supported: false, error: msg });
                attempts.push({ robustness: rlevel || '', encryptionScheme: scheme, supported: false, error: msg });
              }
            }

            schemes[scheme] = { supported: schemeSupported, bestRobustness: schemeBest, attempts: schemeAttempts };
            if (schemeSupported) {
              supported = true;
              if (best === null) best = schemeBest;
              if (bestScheme === null) bestScheme = scheme;
            }
          }

          // Fallback probe without specifying encryptionScheme for older implementations
          if (!supported) {
            const defaultAttempts = [];
            let defaultBest = null;
            let defaultSupported = false;
            for (const rlevel of levels) {
              const cap = { contentType: codec.contentType };
              if (rlevel) cap.robustness = rlevel;
              const cfg = codec.kind === 'video'
                ? { ...base, videoCapabilities: [ cap ] }
                : { ...base, audioCapabilities: [ cap ] };
              try {
                const access = await navigator.requestMediaKeySystemAccess(ks.id, [cfg]);
                const ok = !!access;
                defaultAttempts.push({ robustness: rlevel || '', encryptionScheme: '', supported: ok });
                attempts.push({ robustness: rlevel || '', encryptionScheme: '', supported: ok });
                if (ok) {
                  defaultSupported = true;
                  if (defaultBest === null) defaultBest = rlevel || '';
                  break;
                }
              } catch (e) {
                const msg = (e && e.message) || String(e);
                defaultAttempts.push({ robustness: rlevel || '', encryptionScheme: '', supported: false, error: msg });
                attempts.push({ robustness: rlevel || '', encryptionScheme: '', supported: false, error: msg });
              }
            }
            schemes[''] = { supported: defaultSupported, bestRobustness: defaultBest, attempts: defaultAttempts };
            if (defaultSupported) {
              supported = true;
              if (best === null) best = defaultBest;
              if (bestScheme === null) bestScheme = '';
            }
          }

          row.keySystems[ks.id] = { supported, bestRobustness: best, bestEncryptionScheme: bestScheme, attempts, schemes };
        } catch (err) {
          const msg = (err && err.message) || String(err);
          row.keySystems[ks.id] = { supported: false, error: msg, schemes: {} };
        }
      }
      matrix.push(row);
    }

    RESULTS.drmMatrix = matrix;
    drmState = { matrix, hasEME };
    renderDRM();
  }

  async function runAll() {
    setShareStatus('');
    // version
    const versionEl = document.getElementById('viewer-version');
    const versionSection = document.getElementById('version-section');
    const hide = () => { if (versionSection) versionSection.style.display = 'none'; };
    if (versionEl) {
      try {
        const manifest = chrome.runtime.getManifest();
        const v = manifest && typeof manifest.version === 'string' ? manifest.version.trim() : '';
        if (v) {
          manifestVersion = v;
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
    if (!RESULTS || !RESULTS.codecs || !RESULTS.codecs.length) {
      setShareStatus('Run compatibility checks before copying.', true);
      return;
    }
    try {
      const report = buildReportPayload();
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      copyBtn.textContent = '✓ Copied';
      setShareStatus('Copied full report JSON.', false);
      setTimeout(() => (copyBtn.textContent = 'Copy report JSON'), 1200);
    } catch (e) {
      alert('Copy failed: ' + (e && e.message ? e.message : String(e)));
    }
  });
  if (copyShareLinkBtn) copyShareLinkBtn.addEventListener('click', handleCopyShareLink);
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
  let drmState = { matrix: [], hasEME: false };

  function renderDRM() {
    if (!drmWrap) return;
    const { matrix, hasEME } = drmState;
    drmWrap.innerHTML = '';
    const drmNotice = document.createElement('div');
    drmNotice.className = 'note';
    drmNotice.style.marginBottom = '8px';
    if (!hasEME) {
      drmNotice.textContent = 'DRM/EME is not supported on this browser.';
      drmWrap.appendChild(drmNotice);
    }

    if (!matrix.length) {
      if (hasEME && !drmNotice.textContent) {
        drmNotice.textContent = 'Run compatibility checks to populate DRM results.';
        drmWrap.appendChild(drmNotice);
      }
      return;
    }

    const visibleKeySystems = KEY_SYSTEMS.filter((ks) => matrix.some((row) => row.keySystems[ks.id] && row.keySystems[ks.id].supported));
    const isNarrow = (typeof window !== 'undefined' && window.matchMedia)
      ? window.matchMedia('(max-width: 639px)').matches
      : (typeof window !== 'undefined' ? window.innerWidth < 640 : false);
    const keySystemsToRender = isNarrow ? visibleKeySystems : KEY_SYSTEMS;
    const narrowNote = (isNarrow && visibleKeySystems.length && visibleKeySystems.length < KEY_SYSTEMS.length)
      ? 'Only DRM key systems that report support are shown!'
      : '';

    if (!keySystemsToRender.length) {
      if (hasEME && !drmNotice.textContent) {
        drmNotice.textContent = 'No DRM key systems report as supported on this browser.';
        drmWrap.appendChild(drmNotice);
      }
      return;
    }

    const table = document.createElement('table');
    table.className = 'matrix';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.appendChild(th('Codec'));
    keySystemsToRender.forEach((ks) => hr.appendChild(th(ks.label)));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tb = document.createElement('tbody');
    for (const row of matrix) {
      const tr = document.createElement('tr');
      tr.appendChild(td(row.label));
      for (const ks of keySystemsToRender) {
        const cell = document.createElement('td');
        const r = row.keySystems[ks.id] || { supported: false };
        let schemeLabel = '';
        if (r.schemes) {
          const parts = [];
          const addPart = (name, data) => {
            if (!data || !data.supported) return;
            const robustness = data.bestRobustness ? `:${data.bestRobustness}` : '';
            parts.push(`${name}${robustness}`);
          };
          addPart('CENC', r.schemes.cenc);
          addPart('CBCS', r.schemes.cbcs);
          if (parts.length) schemeLabel = ` (${parts.join(', ')})`;
        }
        const label = r.supported ? `Yes${schemeLabel || (r.bestRobustness ? ` (${r.bestRobustness})` : '')}` : 'No';
        cell.appendChild(pill(!!r.supported, label));
        tr.appendChild(cell);
      }
      tb.appendChild(tr);
    }
    table.appendChild(tb);

    if (drmNotice.textContent) drmWrap.appendChild(drmNotice);
    if (narrowNote) {
      const note = document.createElement('div');
      note.className = 'note';
      note.style.marginBottom = '8px';
      note.style.color = 'var(--error)';
      note.textContent = narrowNote;
      drmWrap.appendChild(note);
    }
    drmWrap.appendChild(table);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => renderDRM());
  }

  function cloneResults() {
    try {
      return JSON.parse(JSON.stringify(RESULTS));
    } catch {
      return { env: {}, codecs: [], mse: [], mediaCapabilities: {}, drmMatrix: [] };
    }
  }

  function encodeReport(report) {
    try {
      const json = JSON.stringify(report);
      if (typeof TextEncoder !== 'undefined') {
        const bytes = new TextEncoder().encode(json);
        let binary = '';
        bytes.forEach((b) => { binary += String.fromCharCode(b); });
        return btoa(binary);
      }
      return btoa(unescape(encodeURIComponent(json)));
    } catch (err) {
      console.error('Failed to encode report', err);
      return '';
    }
  }

  function decodeReport(encoded) {
    try {
      const binary = atob(encoded);
      let jsonString = '';
      if (typeof TextDecoder !== 'undefined') {
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        jsonString = new TextDecoder().decode(bytes);
      } else {
        jsonString = decodeURIComponent(Array.prototype.map.call(binary, (ch) => {
          const hex = ch.charCodeAt(0).toString(16).padStart(2, '0');
          return `%${hex}`;
        }).join(''));
      }
      return JSON.parse(jsonString);
    } catch (err) {
      console.warn('Failed to decode report', err);
      return null;
    }
  }

  function buildReportPayload() {
    const snapshot = cloneResults();
    return {
      schema: 'mv-compat-v1',
      generatedAt: new Date().toISOString(),
      version: manifestVersion || null,
      preset: null,
      results: snapshot,
      userAgent: (navigator && navigator.userAgent) || ''
    };
  }

  function setShareStatus(msg, isError) {
    if (!shareStatusEl) return;
    const text = msg || '';
    shareStatusEl.textContent = text;
    shareStatusEl.style.display = text ? '' : 'none';
    shareStatusEl.style.color = isError ? 'var(--error)' : 'var(--muted)';
  }

  async function handleCopyShareLink() {
    if (!RESULTS || !RESULTS.codecs || !RESULTS.codecs.length) {
      setShareStatus('Run compatibility checks before sharing.', true);
      return;
    }
    const report = buildReportPayload();
    const encoded = encodeReport(report);
    if (!encoded) {
      setShareStatus('Unable to build share link.', true);
      return;
    }
    try {
      const url = new URL(HOSTED_COMPAT_URL);
      url.searchParams.set('compat', encoded);
      await navigator.clipboard.writeText(url.toString());
      setShareStatus('Copied share link with embedded report.', false);
      if (copyShareLinkBtn) {
        const prev = copyShareLinkBtn.textContent;
        copyShareLinkBtn.textContent = '✓ Copied';
        setTimeout(() => (copyShareLinkBtn.textContent = prev), 1200);
      }
    } catch (err) {
      alert('Copy failed: ' + (err && err.message ? err.message : String(err)));
    }
  }

  function hydrateFromReport(report) {
    if (!report || !report.results) return false;
    RESULTS.env = report.results.env || {};
    RESULTS.codecs = report.results.codecs || [];
    RESULTS.mse = report.results.mse || [];
    RESULTS.mediaCapabilities = report.results.mediaCapabilities || {};
    RESULTS.drmMatrix = report.results.drmMatrix || [];
    manifestVersion = report.version || manifestVersion;
    if (manifestVersion) {
      const versionEl = document.getElementById('viewer-version');
      const versionSection = document.getElementById('version-section');
      if (versionEl) {
        versionEl.textContent = manifestVersion;
        if (versionSection) versionSection.style.display = '';
      }
    }
    renderEnvData(RESULTS.env);
    renderCodecsTable(RESULTS.codecs || []);
    drmState = { matrix: RESULTS.drmMatrix || [], hasEME: !!(RESULTS.env && RESULTS.env.eme) };
    renderDRM();
    setShareStatus(report.generatedAt ? `Loaded shared report from ${report.generatedAt}.` : 'Loaded shared report.', false);
    return true;
  }

  function maybeLoadSharedReportFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const encoded = params.get('compat');
      if (!encoded) return false;
      const report = decodeReport(encoded);
      if (!report || report.schema !== 'mv-compat-v1') {
        setShareStatus('Shared report is invalid or uses an unknown schema.', true);
        return false;
      }
      const hydrated = hydrateFromReport(report);
      return !!hydrated;
    } catch (err) {
      console.warn('Failed to load shared report from URL', err);
      setShareStatus('Could not load shared report from link.', true);
      return false;
    }
  }

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

  async function init() {
    const loaded = maybeLoadSharedReportFromUrl();
    if (!loaded) {
      await runAll();
    }
  }

  init();
})();
