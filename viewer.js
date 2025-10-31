const $ = (id) => document.getElementById(id);
const urlInput = $('url');
const uaInput = $('ua');
const modeSelect = $('mode');
const refreshBtn = $('refresh');
const copyBtn = $('copy');
const codeEl = $('code');
const metaEl = $('meta');
const toggleThemeBtn = $('toggleTheme');

// Init from query params
const params = new URLSearchParams(location.search);
if (params.get('u')) urlInput.value = params.get('u');
if (params.get('ua')) uaInput.value = params.get('ua');

// Load default UA if not present
if (!uaInput.value) {
  chrome.runtime.sendMessage({ type: 'GET_UA' }, (res) => {
    if (res && res.ua) uaInput.value = res.ua;
  });
}

function setTheme(theme) {
  const html = document.documentElement;
  if (theme === 'light') html.setAttribute('data-theme', 'light');
  else html.setAttribute('data-theme', 'dark');
}

// Persist theme in localStorage
(function initTheme(){
  const t = localStorage.getItem('mv_theme');
  setTheme(t || 'dark');
})();

toggleThemeBtn.addEventListener('click', () => {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  setTheme(next);
  localStorage.setItem('mv_theme', next);
});

function escapeHTML(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function detectMode(url, bodyText) {
  if (modeSelect.value !== 'auto') return modeSelect.value;
  if (/\.mpd(\b|$)/i.test(url) || /<MPD[\s>]/i.test(bodyText)) return 'dash';
  if (/\.m3u8(\b|$)/i.test(url) || /^#EXTM3U/m.test(bodyText)) return 'hls';
  // fallback: xml-ish => dash, else hls/plain
  if (/^\s*<\?xml|<\w+/i.test(bodyText)) return 'dash';
  return 'hls';
}

function highlightDASH(xml) {
  const s = escapeHTML(xml);
  // very light-weight tokenization: tags, attrs, values, comments
  let out = s
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="token comment">$1</span>')
    .replace(/(&lt;\/?)([a-zA-Z0-9:_-]+)([^&]*?)(&gt;)/g, (m, open, name, rest, close) => {
      // Attributes inside rest: name="value"
      const attrs = rest.replace(/([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')/g, (mm, an, eq, av) => {
        return `<span class="token attr-name">${an}</span>${eq}<span class="token attr-value">${av}</span>`;
      });
      return `${open}<span class="token tag">${name}</span>${attrs}${close}`;
    });
  return out;
}

function highlightHLS(text, baseUrl) {
  const lines = text.split(/\n/);

  const linkifyAttrURI = (k, v) => {
    // v can be quoted or unquoted. Keep the quotes in the output, but make only the inner value clickable.
    const key = k.toUpperCase();
    if (key !== 'URI') {
      // non-URI attr: just colorize normally
      return `<span class="token key">${k}</span>=<span class="token value">${escapeHTML(v)}</span>`;
    }

    // Pull inner value (strip quotes if present)
    let inner = v;
    let qL = '', qR = '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      qL = v[0];
      qR = v[v.length - 1];
      inner = v.slice(1, -1);
    }

    // Resolve relative to baseUrl
    let href = inner;
    try { href = new URL(inner, baseUrl).href; } catch {}

    return `<span class="token key">${k}</span>=` +
           `${escapeHTML(qL)}<a href="${href}" data-hls-uri="1" class="token uri">${escapeHTML(inner)}</a>${escapeHTML(qR)}`;
  };

  const out = lines.map((raw) => {
    const line = raw.trim();
    if (!line) return '';

    // Directive line: e.g. #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"
    if (/^#EXT/i.test(line)) {
      const i = line.indexOf(':');
      const head = i >= 0 ? line.slice(0, i) : line;
      let rhs = i >= 0 ? line.slice(i + 1) : '';

      // Colorize head
      let rendered = `<span class="token directive">${escapeHTML(head)}</span>`;

      if (!rhs) return rendered;

      // key=value pairs, values may be quoted
      // Capture groups: 1=key, 2=value (quoted or not)
      rhs = rhs.replace(/([A-Z0-9-]+)=([^,"']+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, (_m, k, v) => {
        // Special-case URI=... → clickable
        return linkifyAttrURI(k, v);
      });

      return `${rendered}:${rhs}`;
    }

    // Comment line
    if (/^#/i.test(line)) {
      return `<span class="token comment">${escapeHTML(line)}</span>`;
    }

    // URI content line (absolute or relative) → clickable
    const isUriLine =
      /^https?:\/\//i.test(line) || /^\.{1,2}\//.test(line) || /^[^#].+/.test(line);

    if (isUriLine) {
      let href = line;
      try { href = new URL(line, baseUrl).href; } catch {}
      return `<a href="${href}" data-hls-uri="1" class="token uri">${escapeHTML(line)}</a>`;
    }

    return escapeHTML(line);
  });

  return out.join('\n');
}



async function fetchWithOptionalUA(url, ua) {
  if (ua && ua.trim()) {
    const res = await chrome.runtime.sendMessage({ type: 'APPLY_UA_RULE', url, ua });
    if (!res || !res.ok) {
      console.warn('UA rule not applied:', res && res.error);
    }
  }
  const t0 = performance.now();
  const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  const ct = r.headers.get('content-type') || '';
  const text = await r.text();
  const t1 = performance.now();
  return { status: r.status, contentType: ct, text, durationMs: t1 - t0 };
}

function renderMeta({ status, contentType, bytes, mode, durationMs }) {
  metaEl.innerHTML = '';
  const add = (label, value) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<strong>${label}:</strong><span>${value}</span>`;
    metaEl.appendChild(div);
  };
  add('Status', `${status}`);
  add('Content-Type', `<code>${escapeHTML(contentType || 'n/a')}</code>`);
  add('Mode', mode.toUpperCase());
  add('Size', `${bytes.toLocaleString()} bytes`);
  add('Response time', `${formatDuration(durationMs)}`);
}


async function load() {
  const url = urlInput.value.trim();
  if (!url) return;
  const ua = uaInput.value.trim();
  try {
    codeEl.textContent = 'Loading…';
    const { status, contentType, text, durationMs } = await fetchWithOptionalUA(url, ua);
    const mode = detectMode(url, text);

    lastLoadedUrl = url;

    let html;
    if (mode === 'dash') html = highlightDASH(text);
    else html = highlightHLS(text, url);

    codeEl.innerHTML = html;
    renderMeta({
      status,
      contentType,
      bytes: new Blob([text]).size,
      mode,
      durationMs
    });
    chrome.storage.sync.set({ customUA: ua });
  } catch (e) {
    codeEl.textContent = 'Error: ' + (e && e.message ? e.message : String(e));
  }
}


refreshBtn.addEventListener('click', load);

copyBtn.addEventListener('click', async () => {
  try {
    const plain = codeEl.innerText; // innerText preserves newlines
    await navigator.clipboard.writeText(plain);
    copyBtn.textContent = '✓ Copied';
    setTimeout(() => (copyBtn.textContent = '⧉ Copy'), 1200);
  } catch (e) {
    alert('Copy failed: ' + e.message);
  }
});

urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
uaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

// Auto-load if URL provided
if (urlInput.value) load();
