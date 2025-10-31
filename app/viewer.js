const $ = (id) => document.getElementById(id);
const urlInput = $('url');
const uaInput = $('ua');
const modeSelect = $('mode');
const refreshBtn = $('refresh');
const copyBtn = $('copy');
const codeEl = $('code');
const metaEl = $('meta');
const toggleThemeBtn = $('toggleTheme');
const entityDecoder = document.createElement('textarea');

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

function decodeHTML(s) {
  entityDecoder.innerHTML = s;
  return entityDecoder.value;
}

function escapeAttrValue(s) {
  return escapeHTML(s).replace(/"/g, '&quot;');
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function detectMode(url, bodyText, contentType = '') {
  if (modeSelect.value !== 'auto') return modeSelect.value;
  const ct = contentType.toLowerCase();
  const trimmed = bodyText.trim();
  const sanitized = trimmed.charCodeAt(0) === 0xfeff ? trimmed.slice(1) : trimmed;
  const looksLikeJson =
    /\.json(\b|$)/i.test(url) ||
    ct.includes('application/json') ||
    ct.includes('+json') ||
    (!ct && (sanitized.startsWith('{') || sanitized.startsWith('[')));
  if (looksLikeJson && sanitized) {
    try {
      JSON.parse(sanitized);
      return 'json';
    } catch {
      // fall through if not valid json
    }
  }
  if (/\.mpd(\b|$)/i.test(url) || /<MPD[\s>]/i.test(bodyText)) return 'dash';
  if (/\.m3u8(\b|$)/i.test(url) || /^#EXTM3U/m.test(bodyText)) return 'hls';
  // fallback: xml-ish => dash, else hls/plain
  if (/^\s*<\?xml|<\w+/i.test(bodyText)) return 'dash';
  return 'hls';
}

function highlightDASH(xml, baseUrl) {
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
  out = linkifyDashContentSteeringText(out, baseUrl);
  return out;
}

function highlightHLS(text, baseUrl) {
  const lines = text.split(/\n/);

  const linkifyAttrURI = (k, v) => {
    // v can be quoted or unquoted. Keep the quotes in the output, but make only the inner value clickable.
    const key = k.toUpperCase();
    const isUriAttr = key === 'URI' || key.endsWith('-URI') || key.endsWith(':URI');
    if (!isUriAttr) {
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
    const safeHref = escapeAttrValue(href);
    const safeTarget = escapeAttrValue(href);

    return `<span class="token key">${k}</span>=` +
           `${escapeHTML(qL)}<a href="${safeHref}" data-manifest-link="1" data-manifest-target="${safeTarget}" data-hls-uri="1" class="token uri">${escapeHTML(inner)}</a>${escapeHTML(qR)}`;
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
      const safeHref = escapeAttrValue(href);
      const safeTarget = escapeAttrValue(href);
      return `<a href="${safeHref}" data-manifest-link="1" data-manifest-target="${safeTarget}" data-hls-uri="1" class="token uri">${escapeHTML(line)}</a>`;
    }

    return escapeHTML(line);
  });

  return out.join('\n');
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

function highlightJSON(text) {
  let pretty = text;
  if (text) {
    try {
      const sanitized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      const parsed = JSON.parse(sanitized);
      pretty = JSON.stringify(parsed, null, 2);
    } catch {
      // leave text as-is if parsing fails
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

    out.push(`<span class="token ${cls}">${escapeHTML(textForSpan)}</span>`);
    lastIndex = jsonTokenRe.lastIndex;
  }
  out.push(escapeHTML(pretty.slice(lastIndex)));
  return out.join('');
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
    const mode = detectMode(url, text, contentType);

    lastLoadedUrl = url;

    let html;
    if (mode === 'dash') {
      html = highlightDASH(text, url);
      codeEl.className = 'language-plain';
    } else if (mode === 'hls') {
      html = highlightHLS(text, url);
      codeEl.className = 'language-plain';
    } else if (mode === 'json') {
      html = highlightJSON(text);
      codeEl.className = 'language-json';
    } else {
      html = escapeHTML(text);
      codeEl.className = 'language-plain';
    }

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

codeEl.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-manifest-link="1"]');
  if (!link) return;
  if (event.defaultPrevented) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const targetAttr = link.getAttribute('data-manifest-target');
  const href = targetAttr ? decodeHTML(targetAttr) : link.href || link.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  urlInput.value = href;
  modeSelect.value = 'auto';
  load();
});

// Auto-load if URL provided
if (urlInput.value) load();
