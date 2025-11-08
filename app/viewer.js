const $ = (id) => document.getElementById(id);
const urlInput = $('url');
const uaInput = $('ua');
const modeSelect = $('mode');
const refreshBtn = $('refresh');
const copyManifestBtn = $('copyManifest');
const downloadManifestBtn = $('downloadManifest');
const copyManifestUrlBtn = $('copyManifestUrl');
const backBtn = $('back');
const validateBtn = $('validateManifest');
const codeEl = $('code');
const metaEl = $('meta');
const toggleThemeBtn = $('toggleTheme');
const entityDecoder = document.createElement('textarea');
let lastLoadedUrl = '';
let lastLoadedText = '';
let hasLoadedManifest = false;
let lastLoadedBuffer = null;
let lastLoadedMode = 'auto';
let lastLoadedContentType = '';
let lastResponseMeta = null;
const navigationStack = [];
let currentValidationView = null;

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

async function fetchTextWithOptionalUA(url) {
  const ua = uaInput ? uaInput.value.trim() : '';
  const { status, buffer } = await fetchWithOptionalUA(url, ua);
  if (status && Number.isFinite(status) && status >= 400) {
    throw new Error(`HTTP ${status}`);
  }
  const byteArray = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return decoder.decode(byteArray);
}

if (validateBtn) {
  validateBtn.addEventListener('click', async () => {
    if (validateBtn.disabled) return;
    if (lastLoadedMode === 'validation') {
      if (!navigationStack.length) return;
      const snapshot = navigationStack.pop();
      restoreSnapshot(snapshot);
      updateBackButton();
      return;
    }
    if (lastLoadedMode !== 'dash' && lastLoadedMode !== 'hls') return;
    if (typeof lastLoadedText !== 'string' || !lastLoadedText.trim()) {
      console.warn('Manifest text unavailable for validation.');
      return;
    }
    const validator =
      (typeof window !== 'undefined' && window.ManifestValidation) || null;
    if (!validator) {
      console.error('Manifest validation library unavailable.');
      return;
    }
    const validateFn =
      lastLoadedMode === 'dash'
        ? validator.validateDashManifest
        : validator.validateHlsManifest;
    if (typeof validateFn !== 'function') {
      console.error('Manifest validation function unavailable.');
      return;
    }
    if (lastLoadedMode === 'hls') {
      validateBtn.disabled = true;
      validateBtn.textContent = 'Validating…';
    }
    try {
      const validationOptions =
        lastLoadedMode === 'hls'
          ? {
              baseUrl: lastLoadedUrl || '',
              fetchPlaylist: async (uri) => fetchTextWithOptionalUA(uri),
            }
          : undefined;
      const result =
        lastLoadedMode === 'hls'
          ? await validateFn(lastLoadedText, validationOptions)
          : validateFn(lastLoadedText);
      pushCurrentState();
      currentValidationView = {
        sourceMode: lastLoadedMode,
        url: lastLoadedUrl,
        result,
      };
      lastLoadedMode = 'validation';
      hasLoadedManifest = true;
      lastLoadedText = '';
      lastLoadedBuffer = null;
      lastLoadedContentType = '';
      lastResponseMeta = null;
      renderLoadedView({
        mode: 'validation',
        text: '',
        buffer: null,
        url: lastLoadedUrl,
        meta: null,
        validation: currentValidationView,
      });
      updateBackButton();
    } catch (err) {
      console.error('Failed to validate manifest', err);
      validateBtn.disabled = false;
      validateBtn.textContent = lastLoadedMode === 'dash' ? 'Validate DASH' : 'Validate HLS';
    }
  });
}

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

function isLikelyMp4(url, contentType = '', bytes) {
  const lowerUrl = (url || '').toLowerCase();
  const ct = (contentType || '').toLowerCase();
  if (/\.(?:mp4|m4s|m4a|m4v|ismv|cmfv|cmft|cmfa)(?:$|\?)/.test(lowerUrl)) return true;
  if (ct.includes('mp4') || ct.includes('isobmff') || ct.includes('cmaf') || ct.includes('fragmented')) return true;
  if (bytes && bytes.length >= 8) {
    const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (type === 'ftyp' || type === 'styp' || type === 'moov' || type === 'uuid') return true;
  }
  return false;
}

function detectMode(url, bodyText, contentType = '') {
  if (modeSelect.value !== 'auto') return modeSelect.value;
  if (isLikelyMp4(url, contentType)) return 'mp4';
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

const dashState = {
  panel: null,
  summary: null,
  body: null,
  toolbar: null,
  baseSelect: null,
  list: null,
  data: null,
  selectedBase: 'auto',
  mediaHandlers: [],
  unsupported: [],
};

function cleanupDashDecorations() {
  removeMediaTemplateHandlers();
  dashState.data = null;
  dashState.selectedBase = 'auto';
  if (dashState.baseSelect) dashState.baseSelect.value = 'auto';
  if (dashState.list) dashState.list.innerHTML = '';
  if (dashState.summary) dashState.summary.textContent = 'Segments';
  if (dashState.panel) dashState.panel.open = false;
  if (dashState.panel) dashState.panel.style.display = 'none';
  dashState.unsupported = [];
}

function removeMediaTemplateHandlers() {
  dashState.mediaHandlers.forEach(({ span, handler }) => {
    span.classList.remove('dash-template-link');
    span.removeEventListener('click', handler);
  });
  dashState.mediaHandlers = [];
}

function decorateDashManifest(xmlText, manifestUrl) {
  removeMediaTemplateHandlers();

  const data = buildDashData(xmlText, manifestUrl);
  if (!data) {
    cleanupDashDecorations();
    return;
  }

  dashState.data = data;
  dashState.unsupported = data.unsupportedSegments || [];

  ensureDashInspector();
  if (dashState.panel) dashState.panel.style.display = 'block';
  populateDashBaseOptions(data.baseOptions);
  renderDashInspector();
  if (data.contexts && data.contexts.length) {
    if (dashState.panel) dashState.panel.open = false;
    decorateSegmentTemplateSpans();
  } else if (dashState.panel) {
    dashState.panel.open = dashState.unsupported.length > 0;
  }
}

function ensureDashInspector() {
  const codePanel = codeEl.closest('.code-panel');
  if (!codePanel) return;

  if (!dashState.panel) {
    const panel = document.createElement('details');
    panel.className = 'dash-inspector';
    panel.open = false;

    const summary = document.createElement('summary');
    summary.className = 'dash-inspector-summary';
    summary.textContent = 'Segments';
    panel.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'dash-inspector-body';

    const toolbar = document.createElement('div');
    toolbar.className = 'dash-toolbar';

    const label = document.createElement('label');
    label.textContent = 'Base URL:';
    const select = document.createElement('select');
    select.id = 'dash-base-select';
    label.htmlFor = select.id;

    toolbar.appendChild(label);
    toolbar.appendChild(select);

    const list = document.createElement('div');
    list.className = 'dash-rep-list';

    body.appendChild(toolbar);
    body.appendChild(list);
    panel.appendChild(body);

    codePanel.insertBefore(panel, codePanel.firstChild);

    body.addEventListener('click', (event) => {
      if (maybeHandleManifestLinkClick(event)) event.preventDefault();
    });

    select.addEventListener('change', () => {
      dashState.selectedBase = select.value;
      renderDashInspector();
    });

    dashState.panel = panel;
    dashState.summary = summary;
    dashState.body = body;
    dashState.toolbar = toolbar;
    dashState.baseSelect = select;
    dashState.list = list;
  }
}

function populateDashBaseOptions(baseOptions) {
  if (!dashState.baseSelect) return;
  const select = dashState.baseSelect;
  const prev = dashState.selectedBase || 'auto';
  select.innerHTML = '';

  const autoOption = document.createElement('option');
  autoOption.value = 'auto';
  autoOption.textContent = 'Auto (manifest)';
  select.appendChild(autoOption);

  baseOptions.forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    select.appendChild(option);
  });

  if (prev && (prev === 'auto' || baseOptions.some((opt) => opt.value === prev))) {
    select.value = prev;
    dashState.selectedBase = prev;
  } else {
    select.value = 'auto';
    dashState.selectedBase = 'auto';
  }

  if (dashState.toolbar) {
    dashState.toolbar.style.display = baseOptions.length ? 'flex' : 'none';
  }
}

function renderDashInspector() {
  if (!dashState.panel || !dashState.list) return;
  const data = dashState.data;
  const unsupported = dashState.unsupported || [];
  const totalReps =
    (data && Number.isFinite(data.totalRepresentations) ? data.totalRepresentations : 0) ||
    contexts.length + unsupported.length;
  const hasSegments = data && data.contexts && data.contexts.length;
  if (!data || !hasSegments) {
    dashState.list.innerHTML = '';
    if (dashState.summary) {
      dashState.summary.textContent =
        totalReps > 0 ? `Representations (${totalReps})` : 'Representations (0)';
    }
    if (dashState.toolbar) dashState.toolbar.style.display = 'none';
    if (unsupported.length) {
      const info = document.createElement('div');
      info.className = 'dash-empty';
      info.textContent =
        'Segment inspector currently supports SegmentTemplate with a media attribute. Some representations could not be expanded:';
      dashState.list.appendChild(info);

      const list = document.createElement('ul');
      list.className = 'dash-empty-list';
      unsupported.forEach((entry) => {
        const li = document.createElement('li');
        li.className = 'dash-empty-item';

        const labelText =
          entry.label || (entry.representationId ? `id=${entry.representationId}` : 'Representation');
        let reason =
          entry.reason ||
          (entry.type === 'SegmentBase'
            ? 'Uses SegmentBase (single-file) structure.'
            : entry.type === 'SegmentList'
            ? 'Uses SegmentList structure.'
            : 'Segment addressing not detected.');

        const finalLabel = entry.type === 'SegmentBase' ? `${labelText} (single-file)` : labelText;

        if (entry.url) {
          const link = document.createElement('a');
          link.className = 'dash-empty-link';
          link.href = entry.url;
          link.dataset.manifestLink = '1';
          link.dataset.manifestTarget = entry.url;
          link.textContent = finalLabel;
          li.appendChild(link);
        } else {
          const labelSpan = document.createElement('span');
          labelSpan.className = 'dash-empty-title';
          labelSpan.textContent = finalLabel;
          li.appendChild(labelSpan);
        }

        if (entry.type === 'SegmentBase') {
          reason = '';
        }

        if (reason) {
          const reasonSpan = document.createElement('span');
          reasonSpan.className = 'dash-empty-reason';
          reasonSpan.textContent = ` — ${reason}`;
          li.appendChild(reasonSpan);
        }

        list.appendChild(li);
      });
      dashState.list.appendChild(list);
    }
    if (dashState.panel) {
      dashState.panel.style.display = unsupported.length ? 'block' : 'none';
      dashState.panel.open = unsupported.length > 0;
    }
    return;
  }

  const contexts = data.contexts;
  dashState.list.innerHTML = '';

  const fragment = document.createDocumentFragment();
  contexts.forEach((ctx, index) => {
    const base = computeContextBase(ctx, data, dashState.selectedBase);
    const details = document.createElement('details');
    details.className = 'dash-rep';
    details.dataset.ctxIndex = String(index);
    if (index === 0) details.open = true;

    const summary = document.createElement('summary');
    const segmentCount = ctx.groups.reduce((sum, group) => sum + group.segments.length, 0);
    summary.textContent = `${ctx.label} (${segmentCount} segment${segmentCount === 1 ? '' : 's'})`;
    details.appendChild(summary);

    if (ctx.initTemplate) {
      const initUrl = resolveTemplateUrl(ctx.initTemplate, {
        baseUrl: base,
        representationId: ctx.representationId,
        bandwidth: ctx.bandwidth,
        number: ctx.startNumber,
        time: 0,
      });
      if (initUrl) {
        const initDiv = document.createElement('div');
        initDiv.className = 'dash-init';
        const initLink = document.createElement('a');
        initLink.href = initUrl;
        initLink.textContent = 'Initialization segment';
        initLink.dataset.manifestLink = '1';
        initLink.dataset.manifestTarget = initUrl;
        initDiv.appendChild(initLink);
        details.appendChild(initDiv);
      }
    }

    const segmentsWrapper = document.createElement('div');
    segmentsWrapper.className = 'dash-segment-list';

    ctx.groups.forEach((group) => {
      group.segments.forEach((seg) => {
        const segmentUrl = resolveTemplateUrl(ctx.mediaTemplate, {
          baseUrl: base,
          representationId: ctx.representationId,
          bandwidth: ctx.bandwidth,
          number: seg.number,
          time: seg.time,
        });
        if (!segmentUrl) return;
        const item = document.createElement('div');
        item.className = 'dash-segment-item';
        const link = document.createElement('a');
        link.href = segmentUrl;
        link.textContent = `#${seg.number}`;
        link.dataset.manifestLink = '1';
        link.dataset.manifestTarget = segmentUrl;
        item.appendChild(link);
        if (Number.isFinite(seg.time)) {
          const meta = document.createElement('span');
          meta.className = 'dash-segment-meta';
          meta.textContent = `t=${formatSegmentTime(seg.time, ctx.timescale)}`;
          item.appendChild(meta);
        }
        segmentsWrapper.appendChild(item);
      });
    });

    details.appendChild(segmentsWrapper);
    fragment.appendChild(details);
  });

  dashState.list.appendChild(fragment);
  if (dashState.summary) {
    const totalSegments = contexts.reduce(
      (sum, ctx) => sum + ctx.groups.reduce((inner, group) => inner + group.segments.length, 0),
      0
    );
    if (totalReps > 0 && totalSegments > 0) {
      dashState.summary.textContent = `Representations (${totalReps}), Segments (${totalSegments})`;
    } else {
      dashState.summary.textContent =
        totalReps > 0 ? `Representations (${totalReps})` : 'Representations (0)';
    }
  }
}

function decorateSegmentTemplateSpans() {
  if (!dashState.data) return;
  const templateNodes = collectSegmentTemplateAttrNodes();
  const contexts = dashState.data.contexts;
  const count = Math.min(templateNodes.length, contexts.length);
  for (let i = 0; i < count; i += 1) {
    const info = templateNodes[i];
    const targetSpans = [];
    if (info.attrs.media) targetSpans.push(info.attrs.media);
    if (info.attrs.initialization) targetSpans.push(info.attrs.initialization);
    if (!targetSpans.length) continue;
    const handler = (event) => {
      event.preventDefault();
      openDashRepresentation(i);
    };
    targetSpans.forEach((span) => {
      span.classList.add('dash-template-link');
      span.title = 'Click to view segments';
      span.addEventListener('click', handler);
      dashState.mediaHandlers.push({ span, handler });
    });
  }
}

function openDashRepresentation(index) {
  if (!dashState.list) return;
  const details = dashState.list.querySelector(`details[data-ctx-index="${index}"]`);
  if (!details) {
    renderDashInspector();
  }
  const target = dashState.list.querySelector(`details[data-ctx-index="${index}"]`);
  if (!target) return;
  if (dashState.panel) dashState.panel.open = true;
  target.open = true;
  target.classList.add('dash-rep--highlight');
  target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => target.classList.remove('dash-rep--highlight'), 800);
}

function collectSegmentTemplateAttrNodes() {
  const tagSpans = Array.from(codeEl.querySelectorAll('.token.tag')).filter((span) => span.textContent === 'SegmentTemplate');
  return tagSpans.map((tagSpan) => {
    const attrs = {};
    let node = tagSpan.nextSibling;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.includes('>')) break;
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.classList.contains('token') && node.classList.contains('attr-name')) {
          const name = node.textContent;
          const valueSpan = findNextAttrValueSpan(node);
          if (valueSpan) attrs[name] = valueSpan;
        }
      }
      node = node.nextSibling;
    }
    return { templateSpan: tagSpan, attrs };
  });
}

function findNextAttrValueSpan(attrNameSpan) {
  let node = attrNameSpan.nextSibling;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('token') && node.classList.contains('attr-value')) {
      return node;
    }
    node = node.nextSibling;
  }
  return null;
}

function computeContextBase(ctx, data, selectedBase) {
  let base = selectedBase === 'auto' ? ctx.autoBase : selectedBase;
  if (!base) base = data.manifestBase;
  ctx.baseParts.forEach((part) => {
    base = resolveAgainstBase(base, part);
  });
  return base;
}

function buildDashData(xmlText, manifestUrl) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  } catch {
    return null;
  }
  if (!doc || doc.getElementsByTagName('parsererror').length) return null;

  const mpd = doc.documentElement;
  if (!mpd) return null;

  const manifestBase = deriveManifestBase(manifestUrl);

  const baseOptions = [];
  const seenBase = new Set();
  const unsupportedSegments = [];
  Array.from(mpd.children || []).forEach((child) => {
    if (child.localName === 'BaseURL') {
      const text = (child.textContent || '').trim();
      if (!text) return;
      const resolved = resolveAgainstBase(manifestBase, text);
      if (seenBase.has(resolved)) return;
      seenBase.add(resolved);
      const service = child.getAttribute('serviceLocation');
      const label = service ? `${service} (${resolved})` : resolved;
      baseOptions.push({ value: resolved, label });
    }
  });

  const contexts = [];
  let totalRepresentations = 0;
  const representations = collectElementsByLocalName(mpd, 'Representation');
  representations.forEach((repEl) => {
    totalRepresentations += 1;
    const ctx = createSegmentTemplateContext(repEl, manifestBase, mpd, unsupportedSegments);
    if (ctx) contexts.push(ctx);
  });

  if (!contexts.length && !unsupportedSegments.length) return { manifestBase, baseOptions: [], contexts: [], totalRepresentations };

  return { manifestBase, baseOptions, contexts, unsupportedSegments, totalRepresentations };
}

function createSegmentTemplateContext(representation, manifestBase, mpdEl, unsupportedSegments = null) {
  if (!representation) return null;
  const segmentInfo = identifySegmentInfoForRepresentation(representation);

  const period = findAncestorByLocalName(representation, 'Period');
  const adaptation = findAncestorByLocalName(representation, 'AdaptationSet');

  const mpdBase = getPrimaryBaseUrl(mpdEl);
  const periodBase = getPrimaryBaseUrl(period);
  const adaptationBase = getPrimaryBaseUrl(adaptation);
  const representationBase = getPrimaryBaseUrl(representation);

  const baseParts = [];
  if (periodBase) baseParts.push(periodBase);
  if (adaptationBase) baseParts.push(adaptationBase);
  if (representationBase) baseParts.push(representationBase);

  const autoBase = mpdBase ? resolveAgainstBase(manifestBase, mpdBase) : manifestBase;
  const resolveBaseUrl = () => {
    try {
      return baseParts.reduce((acc, part) => resolveAgainstBase(acc, part), autoBase);
    } catch {
      return autoBase;
    }
  };

  const contentType = (adaptation && adaptation.getAttribute('contentType')) || '';
  const width = representation.getAttribute('width');
  const height = representation.getAttribute('height');
  const bandwidth = representation.getAttribute('bandwidth');
  const repId = representation.getAttribute('id');
  const codec = (representation.getAttribute('codecs') || '').trim();
  const langAttr = (adaptation && adaptation.getAttribute('lang')) || representation.getAttribute('lang') || '';
  const adaptationLabel = getChildText(adaptation, 'Label');
  const representationLabel = getChildText(representation, 'Label');

  const labelTokens = [];
  if (adaptationLabel) labelTokens.push(adaptationLabel);
  if (representationLabel && representationLabel !== adaptationLabel) labelTokens.push(representationLabel);

  const trimmedLang = langAttr ? langAttr.trim() : '';
  let languageLabel = '';
  if (labelTokens.length && trimmedLang) languageLabel = `${labelTokens.join(' · ')} · ${trimmedLang}`;
  else if (labelTokens.length) languageLabel = labelTokens.join(' · ');
  else if (trimmedLang) languageLabel = trimmedLang;

  const labelParts = [];
  if (contentType) labelParts.push(contentType);
  if (languageLabel) labelParts.push(languageLabel);
  if (width && height) labelParts.push(`${width}x${height}`);
  if (codec) labelParts.push(codec);
  if (bandwidth) {
    const bwNumber = Number.parseInt(bandwidth, 10);
    labelParts.push(Number.isFinite(bwNumber) ? `${bwNumber.toLocaleString()}bps` : `${bandwidth}bps`);
  }
  if (repId) labelParts.push(`id=${repId}`);
  const label = labelParts.length ? labelParts.join(' · ') : 'Representation';

  if (!segmentInfo || segmentInfo.type !== 'SegmentTemplate') {
    if (unsupportedSegments) {
      unsupportedSegments.push({
        representationId: repId || '',
        label,
        type: segmentInfo ? segmentInfo.type : 'none',
        reason:
          !segmentInfo
            ? 'No SegmentTemplate/SegmentList/SegmentBase found.'
            : segmentInfo.type === 'SegmentBase'
            ? 'Uses SegmentBase (single-file) addressing.'
            : segmentInfo.type === 'SegmentList'
            ? 'Uses SegmentList addressing.'
            : 'SegmentTemplate is unavailable.',
        url: resolveBaseUrl(),
      });
    }
    return null;
  }

  const templateInfo = resolveSegmentTemplateForRepresentation(representation);
  if (!templateInfo || !templateInfo.mediaTemplate) {
    if (unsupportedSegments) {
      unsupportedSegments.push({
        representationId: repId || '',
        label,
        type: 'SegmentTemplate',
        reason: 'SegmentTemplate is missing a @media attribute.',
        url: resolveBaseUrl(),
      });
    }
    return null;
  }

  const {
    mediaTemplate,
    initTemplate,
    startNumber,
    timescale,
    presentationTimeOffset,
    timelineEl,
    templateBase,
  } = templateInfo;

  if (templateBase) baseParts.push(templateBase);

  const pto = Number.isFinite(presentationTimeOffset) ? presentationTimeOffset : 0;
  const groups = expandSegmentGroups(timelineEl, startNumber, pto);

  return {
    label,
    representationId: repId || '',
    bandwidth: bandwidth || '',
    mediaTemplate,
    initTemplate,
    startNumber,
    timescale: timescale || null,
    autoBase,
    baseParts,
    groups,
    codec,
    languageLabel,
    contentType
  };
}

function identifySegmentInfoForRepresentation(representation) {
  let current = representation;
  while (current) {
    const templateEl = findFirstChildByLocalName(current, 'SegmentTemplate');
    if (templateEl) return { type: 'SegmentTemplate', element: templateEl };
    const listEl = findFirstChildByLocalName(current, 'SegmentList');
    if (listEl) return { type: 'SegmentList', element: listEl };
    const baseEl = findFirstChildByLocalName(current, 'SegmentBase');
    if (baseEl) return { type: 'SegmentBase', element: baseEl };
    current = current.parentElement;
  }
  return null;
}

function resolveSegmentTemplateForRepresentation(representation) {
  const templates = [];
  let current = representation;
  while (current) {
    const templateEl = findFirstChildByLocalName(current, 'SegmentTemplate');
    if (templateEl) templates.push(templateEl);
    current = current.parentElement;
  }

  if (!templates.length) return null;

  const getAttr = (name) => {
    for (let i = 0; i < templates.length; i += 1) {
      const tmpl = templates[i];
      if (tmpl.hasAttribute(name)) return tmpl.getAttribute(name);
    }
    return '';
  };

  const mediaTemplate = getAttr('media');
  if (!mediaTemplate) return null;

  const templateEl = templates[0];
  const initTemplate = getAttr('initialization');
  const startNumber = parsePositiveInt(getAttr('startNumber')) || 1;
  const timescale = parsePositiveInt(getAttr('timescale'));
  const ptoRaw = getAttr('presentationTimeOffset');
  const presentationTimeOffset = Number.parseInt(ptoRaw || '0', 10);
  const timelineEl = templates.map((tmpl) => findFirstChildByLocalName(tmpl, 'SegmentTimeline')).find(Boolean) || null;
  const templateBase = getPrimaryBaseUrl(templateEl);

  return {
    mediaTemplate,
    initTemplate,
    startNumber,
    timescale,
    presentationTimeOffset,
    timelineEl,
    templateBase
  };
}

function expandSegmentGroups(timelineEl, startNumber, timelineStart) {
  const groups = [];
  if (!timelineEl) return groups;

  const sNodes = collectElementsByLocalName(timelineEl, 'S');
  if (!sNodes.length) return groups;

  let segmentNumber = startNumber;
  let currentTime = timelineStart || 0;

  sNodes.forEach((sNode) => {
    const duration = parsePositiveInt(sNode.getAttribute('d'));
    if (!duration) {
      groups.push({ segments: [] });
      return;
    }

    const repeatCount = parseRepeatCount(sNode.getAttribute('r'));

    const timeAttr = sNode.getAttribute('t');
    if (timeAttr !== null) {
      const parsedTime = Number.parseInt(timeAttr, 10);
      if (Number.isFinite(parsedTime)) currentTime = parsedTime;
    }

    const group = { segments: [] };
    for (let i = 0; i < repeatCount; i += 1) {
      const segTime = currentTime + i * duration;
      group.segments.push({ number: segmentNumber, time: segTime, duration });
      segmentNumber += 1;
    }

    currentTime += repeatCount * duration;
    groups.push(group);
  });

  return groups;
}

function parseRepeatCount(value) {
  if (value === null || value === undefined) return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  if (parsed < 0) return 1;
  return parsed + 1;
}

function getPrimaryBaseUrl(element) {
  if (!element) return '';
  for (let i = 0; i < element.children.length; i += 1) {
    const child = element.children[i];
    if (child.localName === 'BaseURL') {
      const text = (child.textContent || '').trim();
      if (text) return text;
    }
  }
  return '';
}

function collectElementsByLocalName(root, localName) {
  const results = [];
  if (!root) return results;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.localName === localName) results.push(node);
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
    }
  }
  return results;
}

function findFirstChildByLocalName(node, localName) {
  if (!node) return null;
  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i];
    if (child.localName === localName) return child;
  }
  return null;
}

function findAncestorByLocalName(node, localName) {
  let current = node ? node.parentElement : null;
  while (current) {
    if (current.localName === localName) return current;
    current = current.parentElement;
  }
  return null;
}

function getChildText(element, localName) {
  if (!element) return '';
  for (let i = 0; i < element.children.length; i += 1) {
    const child = element.children[i];
    if (child.localName === localName) {
      const text = (child.textContent || '').trim();
      if (text) return text;
    }
  }
  return '';
}

function deriveManifestBase(manifestUrl) {
  try {
    const url = new URL(manifestUrl);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/[^/]*$/, '');
    return url.href;
  } catch {
    return manifestUrl;
  }
}

function resolveAgainstBase(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

function parsePositiveInt(value) {
  if (value === null || value === undefined) return null;
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function resolveTemplateUrl(template, { baseUrl, representationId, bandwidth, number, time }) {
  if (!template) return null;
  const replaced = template.replace(/\$(RepresentationID|Bandwidth|Number|Time)(%0\d+d)?\$/g, (_match, token, format) => {
    let value = '';
    switch (token) {
      case 'RepresentationID':
        value = representationId || '';
        break;
      case 'Bandwidth':
        value = bandwidth || '';
        break;
      case 'Number':
        value = Number.isFinite(number) ? number : '';
        break;
      case 'Time':
        value = Number.isFinite(time) ? time : '';
        break;
      default:
        value = '';
    }
    if (format) {
      const widthMatch = /%0(\d+)d/.exec(format);
      if (widthMatch) {
        const width = Number.parseInt(widthMatch[1], 10);
        if (Number.isFinite(width)) {
          value = String(value).padStart(width, '0');
        }
      }
    }
    return value;
  });
  return resolveAgainstBase(baseUrl, replaced);
}


function formatSegmentTime(time, timescale) {
  if (!Number.isFinite(time)) return '';
  if (!timescale || !Number.isFinite(timescale) || timescale <= 0) return time.toString();
  const seconds = time / timescale;
  if (!Number.isFinite(seconds)) return time.toString();
  if (seconds >= 1) return `${seconds.toFixed(3).replace(/\.?0+$/, '')}s`;
  return `${(seconds * 1000).toFixed(1).replace(/\.?0+$/, '')}ms`;
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
  try {
    performance.clearResourceTimings();
  } catch (err) {
    console.warn('Failed to clear resource timings', err);
  }
  const t0 = performance.now();
  const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  const t1 = performance.now();
  const ct = r.headers.get('content-type') || '';
  const bufferPromise = r.arrayBuffer();
  const buffer = await bufferPromise;
  const t2 = performance.now();

  let timingEntry = null;
  let fetchEntries = [];
  try {
    const entries = performance.getEntriesByType('resource');
    if (entries && entries.length) {
      const resolvedUrl = r.url || url;
      const exactMatches = entries.filter((entry) => entry.name === resolvedUrl || entry.name === url);
      fetchEntries = exactMatches.length ? exactMatches : entries.filter((entry) => entry.initiatorType === 'fetch');
      if (fetchEntries.length) timingEntry = fetchEntries[fetchEntries.length - 1];
    }
  } catch (err) {
    console.warn('Failed to read resource timings', err);
  }
  try {
    performance.clearResourceTimings();
  } catch {
    // ignore
  }

  const fallbackResponse = t1 - t0;
  const fallbackTotal = t2 - t0;
  let responseMs = Number.isFinite(fallbackResponse) ? fallbackResponse : null;
  let totalNetworkMs = Number.isFinite(fallbackTotal) ? fallbackTotal : null;
  let redirectMs = null;
  let downloadMs = null;
  if (timingEntry) {
    const { startTime, requestStart, responseStart, responseEnd, duration, redirectStart, redirectEnd } = timingEntry;
    const timingResponse =
      Number.isFinite(responseStart) && Number.isFinite(requestStart) && responseStart > 0 && requestStart > 0 && responseStart >= requestStart
        ? responseStart - requestStart
        : null;
    const timingTotal =
      Number.isFinite(responseEnd) && Number.isFinite(startTime) && responseEnd > 0 && startTime > 0 && responseEnd >= startTime
        ? responseEnd - startTime
        : Number.isFinite(duration) && duration > 0
        ? duration
        : null;
    const hasTimingResponse = Number.isFinite(timingResponse) && timingResponse >= 0;
    const hasTimingTotal = Number.isFinite(timingTotal) && timingTotal >= 0;
    if (hasTimingResponse) responseMs = timingResponse;
    if (hasTimingTotal) totalNetworkMs = timingTotal;
    if (!hasTimingResponse && hasTimingTotal) responseMs = timingTotal;
    if (hasTimingTotal && hasTimingResponse) downloadMs = Math.max(timingTotal - timingResponse, 0);
    const timingRedirect =
      Number.isFinite(redirectEnd) && Number.isFinite(redirectStart) && redirectEnd > redirectStart && redirectStart > 0
        ? redirectEnd - redirectStart
        : null;
    if (Number.isFinite(timingRedirect) && timingRedirect > 0) redirectMs = timingRedirect;
  }
  if (fetchEntries.length > 1) {
    const redirectDur = fetchEntries
      .slice(0, -1)
      .reduce((sum, entry) => (Number.isFinite(entry.duration) && entry.duration > 0 ? sum + entry.duration : sum), 0);
    if (redirectDur > 0 && !Number.isFinite(redirectMs)) redirectMs = redirectDur;
  }

  if (!Number.isFinite(responseMs) || responseMs < 0) responseMs = Number.isFinite(totalNetworkMs) ? totalNetworkMs : fallbackResponse;
  if (!Number.isFinite(totalNetworkMs) || totalNetworkMs < 0) totalNetworkMs = fallbackTotal;
  if (!Number.isFinite(downloadMs) || downloadMs < 0) downloadMs = null;
  if (!Number.isFinite(redirectMs) || redirectMs <= 0) redirectMs = null;

  const processingMs = t2 - t1;
  return {
    status: r.status,
    contentType: ct,
    buffer,
    durationMs: responseMs,
    totalDurationMs: totalNetworkMs,
    processingMs,
  };
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
  const finiteResponse = Number.isFinite(durationMs) ? durationMs : null;
  if (finiteResponse !== null) add('Response time', `${formatDuration(finiteResponse)}`);
  // Total time and Processing time intentionally omitted to declutter meta panel
}

function updateBackButton() {
  if (!backBtn) return;
  const hasHistory = navigationStack.length > 0;
  backBtn.style.display = hasHistory ? 'inline-flex' : 'none';
  backBtn.disabled = !hasHistory;
}

function pushCurrentState() {
  if (!hasLoadedManifest || !lastLoadedUrl) return;
  const top = navigationStack[navigationStack.length - 1];
  if (top && top.url === lastLoadedUrl && top.mode === lastLoadedMode) return;
  const snapshot = {
    url: lastLoadedUrl,
    text: lastLoadedText,
    buffer: lastLoadedBuffer ? lastLoadedBuffer.slice(0) : null,
    mode: lastLoadedMode,
    contentType: lastLoadedContentType,
    meta: lastResponseMeta ? { ...lastResponseMeta } : null,
    selectedMode: modeSelect.value,
    validation: currentValidationView
      ? {
          sourceMode: currentValidationView.sourceMode,
          url: currentValidationView.url,
          result: {
            errors: currentValidationView.result.errors.map((entry) => ({ ...entry })),
            warnings: currentValidationView.result.warnings.map((entry) => ({ ...entry })),
            info: currentValidationView.result.info.map((entry) => ({ ...entry })),
          },
        }
      : null,
  };
  navigationStack.push(snapshot);
  updateBackButton();
}

function renderLoadedView({ mode, text, buffer, url, meta, validation }) {
  cleanupDashDecorations();
  if (mode === 'validation') {
    renderValidationView(validation);
    updateActionButtons(mode);
    return;
  }
  if (mode === 'dash') {
    codeEl.className = 'language-plain';
    codeEl.innerHTML = highlightDASH(text, url);
    decorateDashManifest(text, url);
  } else if (mode === 'hls') {
    codeEl.className = 'language-plain';
    codeEl.innerHTML = highlightHLS(text, url);
  } else if (mode === 'json') {
    codeEl.className = 'language-json';
    codeEl.innerHTML = highlightJSON(text);
  } else if (mode === 'mp4' || mode === 'segments') {
    const bufView =
      buffer instanceof Uint8Array
        ? buffer
        : buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : null;
    if (bufView) {
      renderMp4View(bufView, url);
    } else {
      codeEl.className = 'language-plain';
      codeEl.textContent = 'Segment data unavailable.';
    }
  } else {
    codeEl.className = 'language-plain';
    codeEl.innerHTML = escapeHTML(text || '');
  }

  if (meta) {
    renderMeta(meta);
    lastResponseMeta = { ...meta };
  } else {
    metaEl.innerHTML = '';
    lastResponseMeta = null;
  }

  updateActionButtons(mode);
}

function renderValidationView(view) {
  const validation = view || null;
  currentValidationView = validation;

  metaEl.innerHTML = '';
  const addMeta = (label, value) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<strong>${label}:</strong><span>${value}</span>`;
    metaEl.appendChild(div);
  };

  if (!validation || !validation.result) {
    addMeta('Validation', 'No data');
    codeEl.className = 'validation-results';
    codeEl.textContent = 'Validation data unavailable.';
    return;
  }

  const { sourceMode, result } = validation;
  const errorCount = result.errors.length;
  const warningCount = result.warnings.length;
  const infoCount = result.info.length;

  addMeta('Mode', sourceMode ? sourceMode.toUpperCase() : '—');
  const statusLabel = errorCount
    ? 'Failed'
    : warningCount
    ? 'Warnings'
    : 'Passed';
  addMeta('Status', statusLabel);
  addMeta('Errors', errorCount);
  addMeta('Warnings', warningCount);
  addMeta('Info', infoCount);
  if (validation.mediaPlaylists && validation.mediaPlaylists.length) {
    addMeta('Child playlists', validation.mediaPlaylists.length);
  }

  const container = document.createElement('div');
  container.className = 'validation-container';

  const summary = document.createElement('div');
  summary.className = 'validation-summary';
  summary.textContent = `Errors: ${errorCount} · Warnings: ${warningCount} · Info: ${infoCount}`;
  const banner = document.createElement('div');
  banner.className = 'validation-banner';
  banner.innerHTML =
    '<strong>Experimental:</strong> HLS/DASH validation is experimental and may produce incomplete results.';
  container.appendChild(banner);
  container.appendChild(summary);

  const sectionsWrapper = document.createElement('div');
  sectionsWrapper.className = 'validation-sections';

  const sections = [
    { label: 'Errors', items: result.errors, kind: 'error' },
    { label: 'Warnings', items: result.warnings, kind: 'warning' },
    { label: 'Info', items: result.info, kind: 'info' },
  ];

  sections.forEach(({ label, items, kind }) => {
    const section = document.createElement('section');
    section.className = `validation-section kind-${kind}`;

    const heading = document.createElement('h3');
    heading.textContent = `${label} (${items.length})`;
    section.appendChild(heading);

    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'validation-empty';
      empty.textContent = `No ${label.toLowerCase()} detected.`;
      section.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'validation-list';
      items.forEach((entry) => {
        const li = document.createElement('li');
        li.className = 'validation-item';
        const msg = document.createElement('span');
        msg.className = 'message';
        msg.textContent = entry.message || '';
        li.appendChild(msg);
        if (Number.isFinite(entry.line)) {
          const meta = document.createElement('span');
          meta.className = 'meta';
          meta.textContent = `Line ${entry.line}`;
          li.appendChild(meta);
        }
        list.appendChild(li);
      });
      section.appendChild(list);
    }

    sectionsWrapper.appendChild(section);
  });

  if (!errorCount && !warningCount && !infoCount) {
    const successSection = document.createElement('section');
    successSection.className = 'validation-section kind-success';
    const successHeading = document.createElement('h3');
    successHeading.textContent = 'Summary';
    const successMessage = document.createElement('p');
    successMessage.className = 'validation-empty';
    successMessage.textContent = 'No issues detected.';
    successSection.appendChild(successHeading);
    successSection.appendChild(successMessage);
    sectionsWrapper.appendChild(successSection);
  }

  container.appendChild(sectionsWrapper);

  if (validation.mediaPlaylists && validation.mediaPlaylists.length) {
    const childrenSection = document.createElement('section');
    childrenSection.className = 'validation-section kind-info';
    const heading = document.createElement('h3');
    heading.textContent = `Child Playlists (${validation.mediaPlaylists.length})`;
    childrenSection.appendChild(heading);

    const childList = document.createElement('div');
    childList.className = 'validation-children';
    validation.mediaPlaylists.forEach((entry) => {
      const child = document.createElement('details');
      child.className = 'validation-child';
      const summary = document.createElement('summary');
      summary.textContent = entry.uri || 'Playlist';
      child.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'validation-child-body';

      const childResult = entry.result || createValidationResultFallback();
      const statusInfo = document.createElement('p');
      const childErrors = childResult.errors ? childResult.errors.length : 0;
      const childWarnings = childResult.warnings ? childResult.warnings.length : 0;
      statusInfo.textContent = `Errors: ${childErrors}, Warnings: ${childWarnings}`;
      body.appendChild(statusInfo);

      if (childResult.errors && childResult.errors.length) {
        const errList = document.createElement('ul');
        errList.className = 'validation-child-list validation-child-list--error';
        childResult.errors.forEach((err) => {
          const li = document.createElement('li');
          li.textContent = err.message || '';
          errList.appendChild(li);
        });
        body.appendChild(errList);
      }
      if (childResult.warnings && childResult.warnings.length) {
        const warnList = document.createElement('ul');
        warnList.className = 'validation-child-list validation-child-list--warning';
        childResult.warnings.forEach((warn) => {
          const li = document.createElement('li');
          li.textContent = warn.message || '';
          warnList.appendChild(li);
        });
        body.appendChild(warnList);
      }

      child.appendChild(body);
      childList.appendChild(child);
    });

    childrenSection.appendChild(childList);
    container.appendChild(childrenSection);
  }

  codeEl.className = 'validation-results';
  codeEl.innerHTML = '';
  codeEl.appendChild(container);
}

function createValidationResultFallback() {
  return { errors: [], warnings: [], info: [] };
}

function restoreSnapshot(snapshot) {
  if (!snapshot) return;
  urlInput.value = snapshot.url || '';
  const appliedMode = snapshot.mode === 'segments' ? 'segments' : snapshot.selectedMode || 'auto';
  modeSelect.value = appliedMode;
  hasLoadedManifest = true;
  lastLoadedUrl = snapshot.url;
  lastLoadedText = snapshot.text || '';
  lastLoadedBuffer = snapshot.buffer ? snapshot.buffer.slice(0) : null;
  lastLoadedMode = snapshot.mode || 'auto';
  lastLoadedContentType = snapshot.contentType || '';
  lastResponseMeta = snapshot.meta ? { ...snapshot.meta } : null;
  if (snapshot.validation && snapshot.validation.result) {
    currentValidationView = {
      sourceMode: snapshot.validation.sourceMode || 'dash',
      url: snapshot.validation.url || '',
      result: {
        errors: Array.isArray(snapshot.validation.result.errors)
          ? snapshot.validation.result.errors.map((entry) => ({ ...entry }))
          : [],
        warnings: Array.isArray(snapshot.validation.result.warnings)
          ? snapshot.validation.result.warnings.map((entry) => ({ ...entry }))
          : [],
        info: Array.isArray(snapshot.validation.result.info)
          ? snapshot.validation.result.info.map((entry) => ({ ...entry }))
          : [],
      },
    };
  } else {
    currentValidationView = null;
  }
  renderLoadedView({
    mode: lastLoadedMode,
    text: lastLoadedText,
    buffer: lastLoadedBuffer,
    url: lastLoadedUrl,
    meta: lastResponseMeta,
    validation: currentValidationView,
  });
}

function updateActionButtons(mode) {
  copyManifestUrlBtn.removeAttribute('disabled');
  copyManifestUrlBtn.title = '';
  downloadManifestBtn.removeAttribute('disabled');
  downloadManifestBtn.title = '';

  if (mode === 'validation') {
    copyManifestBtn.setAttribute('disabled', 'true');
    copyManifestBtn.title = 'Copying is unavailable while viewing validation results.';
    copyManifestBtn.textContent = '⧉ Copy Manifest as text';
    copyManifestUrlBtn.setAttribute('disabled', 'true');
    copyManifestUrlBtn.title = 'Copy manifest URL is unavailable while viewing validation results.';
    downloadManifestBtn.setAttribute('disabled', 'true');
    downloadManifestBtn.title = 'Downloading is unavailable while viewing validation results.';
    downloadManifestBtn.textContent = '⇣ Download Manifest';
    if (validateBtn) {
      validateBtn.style.display = 'inline-flex';
      validateBtn.disabled = false;
      validateBtn.textContent = 'Return to Manifest';
      validateBtn.title = 'Return to the manifest view';
    }
    return;
  }

  const isBinary = mode === 'mp4' || mode === 'segments';
  if (isBinary) {
    copyManifestBtn.setAttribute('disabled', 'true');
    copyManifestBtn.title = 'Copying text is not available for MP4/fragmented segment data.';
  } else {
    copyManifestBtn.removeAttribute('disabled');
    copyManifestBtn.title = '';
  }
  copyManifestBtn.textContent = '⧉ Copy Manifest as text';
  copyManifestUrlBtn.textContent = isBinary ? '⧉ Copy Segment URL' : '⧉ Copy Manifest URL';
  downloadManifestBtn.textContent = isBinary ? '⇣ Download Segment' : '⇣ Download Manifest';
  if (validateBtn) {
    if (mode === 'dash' || mode === 'hls') {
      validateBtn.style.display = 'inline-flex';
      validateBtn.disabled = false;
      const modeLabel = mode === 'dash' ? 'DASH' : 'HLS';
      validateBtn.textContent = `Validate ${modeLabel}`;
      validateBtn.title = `Validate the loaded ${modeLabel} manifest`;
    } else {
      validateBtn.style.display = 'none';
      validateBtn.disabled = true;
    }
  }
}


async function load(options = {}) {
  const url = urlInput.value.trim();
  if (!url) return;
  const ua = uaInput.value.trim();
  const previousUrl = lastLoadedUrl;
  const previousMode = lastLoadedMode;
  const hadPrevious = hasLoadedManifest;
  try {
    codeEl.textContent = 'Loading…';
    codeEl.className = 'language-plain';
    copyManifestBtn.textContent = '⧉ Copy Manifest as text';
    copyManifestBtn.removeAttribute('disabled');
    copyManifestBtn.title = '';
    copyManifestUrlBtn.textContent = '⧉ Copy Manifest URL';
    downloadManifestBtn.textContent = '⇣ Download Manifest';
    updateActionButtons(null);
    const { status, contentType, buffer, durationMs, totalDurationMs, processingMs } = await fetchWithOptionalUA(url, ua);
    lastLoadedContentType = contentType;
    const byteArray = new Uint8Array(buffer);
    const selectedMode = modeSelect.value;
    let mode = selectedMode;
    let text = '';

    if (selectedMode === 'auto') {
      if (isLikelyMp4(url, contentType, byteArray)) {
        mode = 'mp4';
      } else {
        const decoder = new TextDecoder('utf-8', { fatal: false });
        text = decoder.decode(byteArray);
        mode = detectMode(url, text, contentType);
      }
    } else if (selectedMode === 'segments' || selectedMode === 'mp4') {
      mode = selectedMode === 'segments' ? 'segments' : 'mp4';
    } else {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      text = decoder.decode(byteArray);
      mode = selectedMode;
    }

    let shouldPushHistory = options.pushHistory || false;
    if (!shouldPushHistory && hadPrevious) {
      if (previousUrl !== url || previousMode !== mode) {
        shouldPushHistory = true;
      }
    }
    if (shouldPushHistory) pushCurrentState();

    lastLoadedUrl = url;
    lastLoadedText = text;
    lastLoadedBuffer = buffer;
    lastLoadedMode = mode;
    hasLoadedManifest = true;
    currentValidationView = null;

    const meta = {
      status,
      contentType,
      bytes: byteArray.length,
      mode,
      durationMs,
      totalDurationMs,
      processingMs,
    };
    renderLoadedView({
      mode,
      text,
      buffer,
      url,
      meta,
      validation: null,
    });

    chrome.storage.sync.set({ customUA: ua });
  } catch (e) {
    codeEl.textContent = 'Error: ' + (e && e.message ? e.message : String(e));
    hasLoadedManifest = false;
    lastLoadedUrl = '';
    lastLoadedText = '';
    lastLoadedBuffer = null;
    lastLoadedMode = 'auto';
    lastLoadedContentType = '';
    lastResponseMeta = null;
    currentValidationView = null;
    updateActionButtons(null);
    cleanupDashDecorations();
  }
  updateBackButton();
}


refreshBtn.addEventListener('click', () => load());

copyManifestBtn.addEventListener('click', async () => {
  if (copyManifestBtn.disabled || lastLoadedMode === 'mp4' || lastLoadedMode === 'segments') {
    alert('Copying text is not available for MP4/fragmented segment data.');
    return;
  }
  if (!hasLoadedManifest) {
    alert('Load a manifest first.');
    return;
  }
  try {
    let plain = lastLoadedText;
    if (!plain) {
      plain = codeEl.innerText; // fallback; innerText preserves newlines
    }
    if (!plain) {
      alert('Nothing to copy yet.');
      return;
    }
    await navigator.clipboard.writeText(plain);
    copyManifestBtn.textContent = '✓ Copied';
    setTimeout(() => (copyManifestBtn.textContent = '⧉ Copy Manifest as text'), 1200);
  } catch (e) {
    alert('Copy failed: ' + e.message);
  }
});

downloadManifestBtn.addEventListener('click', () => {
  if (!hasLoadedManifest) {
    alert('Load a manifest first.');
    return;
  }
  let blob;
  if ((lastLoadedMode === 'mp4' || lastLoadedMode === 'segments') && lastLoadedBuffer) {
    const type = lastLoadedContentType || 'video/mp4';
    blob = new Blob([lastLoadedBuffer], { type });
  } else {
    blob = new Blob([lastLoadedText], { type: 'text/plain;charset=utf-8' });
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  let filename = 'manifest.txt';
  if (lastLoadedUrl) {
    try {
      const parsed = new URL(lastLoadedUrl);
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length) filename = segments[segments.length - 1];
    } catch {
      // keep default filename
    }
  }
  if (!filename) filename = (lastLoadedMode === 'mp4' || lastLoadedMode === 'segments') ? 'segment.mp4' : 'manifest.txt';
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

copyManifestUrlBtn.addEventListener('click', async () => {
  if (!lastLoadedUrl) {
    alert('Load a manifest first.');
    return;
  }
  try {
    await navigator.clipboard.writeText(lastLoadedUrl);
    copyManifestUrlBtn.textContent = '✓ URL Copied';
    setTimeout(() => {
      copyManifestUrlBtn.textContent =
        (lastLoadedMode === 'mp4' || lastLoadedMode === 'segments') ? '⧉ Copy Segment URL' : '⧉ Copy Manifest URL';
    }, 1200);
  } catch (e) {
    alert('Copy failed: ' + e.message);
  }
});

urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
uaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

codeEl.addEventListener('click', (event) => {
  if (maybeHandleManifestLinkClick(event)) event.preventDefault();
});

if (backBtn) {
  backBtn.addEventListener('click', () => {
    if (!navigationStack.length) return;
    const snapshot = navigationStack.pop();
    restoreSnapshot(snapshot);
    updateBackButton();
  });
  updateBackButton();
}

function maybeHandleManifestLinkClick(event) {
  const link = event.target.closest && event.target.closest('a[data-manifest-link="1"]');
  if (!link) return false;
  if (event.defaultPrevented) return false;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const targetAttr = link.getAttribute('data-manifest-target');
  const href = targetAttr ? decodeHTML(targetAttr) : link.href || link.getAttribute('href');
  if (!href) return false;
  urlInput.value = href;
  modeSelect.value = 'auto';
  load({ pushHistory: true });
  return true;
}

const MP4_CONTAINER_BOXES = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'stsd',
  'edts',
  'mvex',
  'moof',
  'traf',
  'mfra',
  'udta',
  'meta',
  'ilst',
  'dinf',
  'tref',
  'sinf',
  'schi',
  'ipro',
  'meco',
  'mere',
  'strk',
  'strd',
  'stri',
  'dref'
]);

const MP4_EPOCH_OFFSET = 2082844800n;

function renderMp4View(byteArray, url) {
  const bytes = byteArray instanceof Uint8Array ? byteArray : new Uint8Array(byteArray);
  const { boxes, warnings } = parseMp4Structure(bytes);

  codeEl.className = 'mp4-view';
  const wrapper = document.createElement('div');
  wrapper.className = 'mp4-viewer';

  const header = document.createElement('div');
  header.className = 'mp4-viewer-header';

  const urlLink = document.createElement('a');
  urlLink.href = url;
  urlLink.textContent = url;
  urlLink.target = '_blank';
  urlLink.rel = 'noopener noreferrer';
  header.appendChild(urlLink);

  const count = document.createElement('span');
  count.className = 'mp4-header-meta';
  count.textContent = `${boxes.length} top-level box${boxes.length === 1 ? '' : 'es'}`;
  header.appendChild(count);

  wrapper.appendChild(header);

  if (warnings.length) {
    const warningEl = document.createElement('div');
    warningEl.className = 'mp4-warning';
    warningEl.textContent = warnings.join(' • ');
    wrapper.appendChild(warningEl);
  }

  const main = document.createElement('div');
  main.className = 'mp4-viewer-main';

  const tree = document.createElement('div');
  tree.className = 'mp4-tree';

  const details = document.createElement('div');
  details.className = 'mp4-details';
  details.innerHTML = '<div class="mp4-placeholder">Select a box to see its fields.</div>';

  main.appendChild(tree);
  main.appendChild(details);
  wrapper.appendChild(main);

  codeEl.replaceChildren(wrapper);

  if (!boxes.length) {
    tree.innerHTML = '<div class="mp4-placeholder">No ISO BMFF boxes detected in this resource.</div>';
    return;
  }

  const boxesById = new Map();
  (function register(list) {
    list.forEach((box) => {
      boxesById.set(box.id, box);
      if (box.children && box.children.length) register(box.children);
    });
  })(boxes);

  function buildTree(list, depth) {
    const frag = document.createDocumentFragment();
    list.forEach((box) => {
      const group = document.createElement('div');
      group.className = 'mp4-tree-group';
      group.dataset.boxId = box.id;

      const row = document.createElement('div');
      row.className = 'mp4-tree-row';
      row.dataset.boxId = box.id;
      row.style.paddingLeft = `${depth * 16}px`;

      const toggle = document.createElement('button');
      toggle.className = 'mp4-toggle';
      toggle.dataset.action = 'toggle';
      toggle.dataset.boxId = box.id;
      toggle.setAttribute('aria-expanded', 'false');
      if (box.children && box.children.length) {
        toggle.textContent = '▸';
      } else {
        toggle.textContent = '';
        toggle.disabled = true;
        toggle.classList.add('mp4-toggle--empty');
      }
      row.appendChild(toggle);

      const typeSpan = document.createElement('span');
      typeSpan.className = 'mp4-node-type';
      typeSpan.textContent = box.type;
      row.appendChild(typeSpan);

      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'mp4-node-size';
      sizeSpan.textContent = `${box.size.toLocaleString()} bytes`;
      row.appendChild(sizeSpan);

      const offsetSpan = document.createElement('span');
      offsetSpan.className = 'mp4-node-offset';
      offsetSpan.textContent = `@${box.start}`;
      row.appendChild(offsetSpan);

      group.appendChild(row);

      if (box.children && box.children.length) {
        const childContainer = document.createElement('div');
        childContainer.className = 'mp4-children';
        childContainer.dataset.parentId = box.id;
        childContainer.hidden = true;
        childContainer.appendChild(buildTree(box.children, depth + 1));
        group.appendChild(childContainer);
      }

      frag.appendChild(group);
    });
    return frag;
  }

  tree.appendChild(buildTree(boxes, 0));

  let selectedRow = null;

  function toggleBox(boxId, forceOpen) {
    const group = tree.querySelector(`.mp4-tree-group[data-box-id="${boxId}"]`);
    if (!group) return;
    const childContainer = group.querySelector(':scope > .mp4-children');
    if (!childContainer) return;
    const toggle = group.querySelector(':scope > .mp4-tree-row .mp4-toggle');
    const shouldOpen = forceOpen !== undefined ? forceOpen : childContainer.hidden;
    childContainer.hidden = !shouldOpen;
    if (toggle) {
      toggle.textContent = shouldOpen ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', String(shouldOpen));
    }
  }

  function openAncestors(box) {
    let current = box;
    while (current && current.parentId) {
      toggleBox(current.parentId, true);
      current = boxesById.get(current.parentId);
    }
  }

  function renderDetails(box) {
    details.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = `${box.type} box`;
    details.appendChild(title);

    const table = document.createElement('table');
    const tbody = document.createElement('tbody');

    const rows = [
      { name: 'type', value: `'${box.type}'` },
      { name: 'size', value: `${box.size.toLocaleString()} bytes` },
      { name: 'start', value: box.start },
      { name: 'end', value: box.end }
    ];
    if (box.uuid) rows.push({ name: 'uuid', value: box.uuid });
    box.details.forEach((detail) => rows.push(detail));

    rows.forEach(({ name, value }) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = name;
      const td = document.createElement('td');
      td.textContent = formatDetailDisplay(value);
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    details.appendChild(table);
  }

  function selectBox(boxId) {
    const box = boxesById.get(boxId);
    if (!box) return;
    openAncestors(box);
    const row = tree.querySelector(`.mp4-tree-row[data-box-id="${boxId}"]`);
    if (!row) return;
    if (selectedRow) selectedRow.classList.remove('selected');
    row.classList.add('selected');
    selectedRow = row;
    renderDetails(box);
  }

  tree.addEventListener('click', (event) => {
    const toggleBtn = event.target.closest('button[data-action="toggle"]');
    if (toggleBtn) {
      event.stopPropagation();
      toggleBox(toggleBtn.dataset.boxId);
      return;
    }
    const row = event.target.closest('.mp4-tree-row');
    if (!row) return;
    selectBox(row.dataset.boxId);
  });

  const first = boxes[0];
  if (first) {
    selectBox(first.id);
    if (first.children && first.children.length) {
      toggleBox(first.id, true);
    }
  }
}

function parseMp4Structure(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const warnings = [];
  let idCounter = 0;

  function parseRange(start, end, parentId, parentType) {
    const items = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      let headerSize = 8;
      let type = fourCC(bytes, offset + 4);

      if (!type.trim()) break;

      if (size === 1) {
        if (offset + 16 > end) {
          warnings.push(`Large box size declared at ${offset} exceeds buffer length.`);
          break;
        }
        size = Number(readUint64(view, offset + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }

      if (size < headerSize) {
        warnings.push(`Invalid size for box ${type} at offset ${offset}.`);
        break;
      }

      let boxEnd = offset + size;
      if (boxEnd > end) {
        warnings.push(`Box ${type} at offset ${offset} truncated (expected ${size} bytes).`);
        boxEnd = end;
        size = boxEnd - offset;
      }

      if (size <= 0) break;

      let uuid = null;
      if (type === 'uuid') {
        if (offset + headerSize + 16 <= boxEnd) {
          const uuidBytes = bytes.subarray(offset + headerSize, offset + headerSize + 16);
          uuid = formatUuid(uuidBytes);
          headerSize += 16;
        } else {
          warnings.push(`UUID box at offset ${offset} missing identifier bytes.`);
        }
      }

      const box = {
        id: `box-${idCounter++}`,
        type,
        start: offset,
        size,
        end: offset + size,
        headerSize,
        uuid,
        parentId,
        children: [],
        details: []
      };

      const payloadOffset = offset + headerSize;
      const payloadSize = Math.max(0, box.end - payloadOffset);

      const { details, childOffset } = extractBoxDetails(box, view, bytes, payloadOffset, payloadSize);
      box.details = details;

      const childStart = payloadOffset + Math.min(childOffset, payloadSize);
      const isContainer = MP4_CONTAINER_BOXES.has(type) || parentType === 'stsd';
      if (isContainer && childStart + 8 <= box.end) {
        box.children = parseRange(childStart, box.end, box.id, type);
      }

      items.push(box);
      offset += size;
    }
    return items;
  }

  const boxes = parseRange(0, bytes.length, null, null);
  return { boxes, warnings };
}

function extractBoxDetails(box, view, bytes, payloadOffset, payloadSize) {
  const details = [];
  let cursor = payloadOffset;
  let remaining = payloadSize;
  let childOffset = 0;

  const addDetail = (name, value) => {
    if (value === null || value === undefined || value === '') return;
    details.push({ name, value });
  };

  const ensure = (len) => remaining >= len;
  const skipBytes = (len) => {
    if (!ensure(len)) {
      cursor = payloadOffset + payloadSize;
      remaining = 0;
      return false;
    }
    cursor += len;
    remaining -= len;
    return true;
  };
  const readUint8 = () => {
    if (!ensure(1)) return null;
    const val = view.getUint8(cursor);
    cursor += 1;
    remaining -= 1;
    return val;
  };
  const readUint16 = () => {
    if (!ensure(2)) return null;
    const val = view.getUint16(cursor);
    cursor += 2;
    remaining -= 2;
    return val;
  };
  const readUint32 = () => {
    if (!ensure(4)) return null;
    const val = view.getUint32(cursor);
    cursor += 4;
    remaining -= 4;
    return val;
  };
  const readInt32 = () => {
    if (!ensure(4)) return null;
    const val = view.getInt32(cursor);
    cursor += 4;
    remaining -= 4;
    return val;
  };
  const readUint64Val = () => {
    if (!ensure(8)) return null;
    const val = readUint64(view, cursor);
    cursor += 8;
    remaining -= 8;
    return val;
  };
  const readString = (len) => {
    if (!ensure(len)) return '';
    const slice = bytes.subarray(cursor, cursor + len);
    cursor += len;
    remaining -= len;
    let result = '';
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === 0) {
        result = String.fromCharCode(...slice.subarray(0, i));
        break;
      }
    }
    if (!result) result = String.fromCharCode(...slice);
    // eslint-disable-next-line no-control-regex -- explicit removal of trailing NUL bytes
    return result.replace(/\u0000+$/, '');
  };

  const parseVisualSampleEntry = () => {
    if (!skipBytes(6)) return;
    const dataRefIndex = readUint16();
    if (dataRefIndex !== null) addDetail('data_reference_index', dataRefIndex);
    skipBytes(2); // pre_defined
    skipBytes(2); // reserved
    skipBytes(12); // pre_defined/reserved
    const width = readUint16();
    const height = readUint16();
    if (width !== null) addDetail('width', width);
    if (height !== null) addDetail('height', height);
    const horiz = readUint32();
    if (horiz !== null) addDetail('horiz_resolution', formatFixed1616(horiz));
    const vert = readUint32();
    if (vert !== null) addDetail('vert_resolution', formatFixed1616(vert));
    skipBytes(4); // reserved
    const frameCount = readUint16();
    if (frameCount !== null) addDetail('frame_count', frameCount);
    if (ensure(32)) {
      const nameLength = bytes[cursor];
      const rawName = bytes.subarray(cursor + 1, cursor + 1 + Math.min(nameLength, 31));
      let compressor = String.fromCharCode(...rawName);
      const nullPos = compressor.indexOf('\0');
      if (nullPos !== -1) compressor = compressor.slice(0, nullPos);
      cursor += 32;
      remaining -= 32;
      if (compressor) addDetail('compressor_name', compressor);
    } else {
      skipBytes(32);
    }
    const depth = readUint16();
    if (depth !== null) addDetail('depth', depth);
    skipBytes(2); // pre_defined
    markChildOffset();
  };

  const parseAudioSampleEntry = () => {
    if (!skipBytes(6)) return;
    const dataRefIndex = readUint16();
    if (dataRefIndex !== null) addDetail('data_reference_index', dataRefIndex);
    const version = readUint16();
    if (version !== null) addDetail('version', version);
    skipBytes(2); // revision level
    skipBytes(4); // vendor
    const channelCount = readUint16();
    if (channelCount !== null) addDetail('channel_count', channelCount);
    const sampleSize = readUint16();
    if (sampleSize !== null) addDetail('sample_size', sampleSize);
    skipBytes(4); // pre_defined + reserved
    const sampleRateRaw = readUint32();
    if (sampleRateRaw !== null) {
      const sampleRate = Math.round(sampleRateRaw / 65536);
      addDetail('sample_rate', sampleRate);
    }
    markChildOffset();
  };

  const markChildOffset = () => {
    childOffset = Math.max(childOffset, cursor - payloadOffset);
  };

  const readFullBoxHeader = () => {
    if (!ensure(4)) return null;
    const version = readUint8();
    const flag1 = readUint8();
    const flag2 = readUint8();
    const flag3 = readUint8();
    if (version === null || flag1 === null || flag2 === null || flag3 === null) return null;
    const flags = (flag1 << 16) | (flag2 << 8) | flag3;
    addDetail('version', version);
    addDetail('flags', formatHex(flags, 6));
    markChildOffset();
    return { version, flags };
  };

  switch (box.type) {
    case 'ftyp':
    case 'styp': {
      const major = readString(4);
      if (major) addDetail('major_brand', `'${major}'`);
      const minor = readUint32();
      if (minor !== null) addDetail('minor_version', minor);
      const brands = [];
      while (remaining >= 4) {
        const brand = readString(4);
        if (!brand) break;
        brands.push(`'${brand}'`);
      }
      if (brands.length) addDetail('compatible_brands', brands.join(', '));
      markChildOffset();
      break;
    }
    case 'mvhd': {
      const full = readFullBoxHeader();
      if (!full) break;
      if (full.version === 1) {
        const creation = readUint64Val();
        if (creation !== null) addDetail('creation_time', formatMp4Date(creation));
        const modification = readUint64Val();
        if (modification !== null) addDetail('modification_time', formatMp4Date(modification));
        const timescale = readUint32();
        if (timescale !== null) addDetail('timescale', timescale);
        const duration = readUint64Val();
        if (duration !== null) addDetail('duration', formatBigInt(duration));
      } else {
        const creation = readUint32();
        if (creation !== null) addDetail('creation_time', formatMp4Date(BigInt(creation)));
        const modification = readUint32();
        if (modification !== null) addDetail('modification_time', formatMp4Date(BigInt(modification)));
        const timescale = readUint32();
        if (timescale !== null) addDetail('timescale', timescale);
        const duration = readUint32();
        if (duration !== null) addDetail('duration', formatBigInt(BigInt(duration)));
      }
      const rate = readUint32();
      if (rate !== null) addDetail('rate', formatFixed1616(rate));
      const volume = readUint16();
      if (volume !== null) addDetail('volume', formatFixed88(volume));
      skipBytes(10);
      skipBytes(36);
      skipBytes(24);
      const nextTrackId = readUint32();
      if (nextTrackId !== null) addDetail('next_track_id', nextTrackId);
      markChildOffset();
      break;
    }
    case 'tkhd': {
      const full = readFullBoxHeader();
      if (!full) break;
      const creation = full.version === 1 ? readUint64Val() : readUint32();
      if (creation !== null) addDetail('creation_time', formatMp4Date(typeof creation === 'bigint' ? creation : BigInt(creation)));
      const modification = full.version === 1 ? readUint64Val() : readUint32();
      if (modification !== null) addDetail('modification_time', formatMp4Date(typeof modification === 'bigint' ? modification : BigInt(modification)));
      const trackId = readUint32();
      if (trackId !== null) addDetail('track_id', trackId);
      skipBytes(4);
      const durationRaw = full.version === 1 ? readUint64Val() : readUint32();
      if (durationRaw !== null) addDetail('duration', formatBigInt(typeof durationRaw === 'bigint' ? durationRaw : BigInt(durationRaw)));
      skipBytes(8);
      const layer = readUint16();
      if (layer !== null) addDetail('layer', layer);
      const alternate = readUint16();
      if (alternate !== null) addDetail('alternate_group', alternate);
      const vol = readUint16();
      if (vol !== null) addDetail('volume', formatFixed88(vol));
      skipBytes(2);
      skipBytes(36);
      const widthRaw = readUint32();
      const heightRaw = readUint32();
      if (widthRaw !== null) addDetail('width', (widthRaw / 65536).toFixed(2));
      if (heightRaw !== null) addDetail('height', (heightRaw / 65536).toFixed(2));
      markChildOffset();
      break;
    }
    case 'mdhd': {
      const full = readFullBoxHeader();
      if (!full) break;
      const creation = full.version === 1 ? readUint64Val() : readUint32();
      if (creation !== null) addDetail('creation_time', formatMp4Date(typeof creation === 'bigint' ? creation : BigInt(creation)));
      const modification = full.version === 1 ? readUint64Val() : readUint32();
      if (modification !== null) addDetail('modification_time', formatMp4Date(typeof modification === 'bigint' ? modification : BigInt(modification)));
      const timescale = readUint32();
      if (timescale !== null) addDetail('timescale', timescale);
      const duration = full.version === 1 ? readUint64Val() : readUint32();
      if (duration !== null) addDetail('duration', formatBigInt(typeof duration === 'bigint' ? duration : BigInt(duration)));
      const languageBits = readUint16();
      if (languageBits !== null) addDetail('language', decodeIso639(languageBits));
      readUint16();
      markChildOffset();
      break;
    }
    case 'hdlr': {
      const full = readFullBoxHeader();
      if (!full) break;
      skipBytes(4);
      const handler = readString(4);
      if (handler) addDetail('handler_type', `'${handler}'`);
      skipBytes(12);
      if (remaining > 0) {
        const name = readString(remaining);
        if (name) addDetail('name', name);
      }
      markChildOffset();
      break;
    }
    case 'stsd': {
      const full = readFullBoxHeader();
      if (!full) break;
      const entryCount = readUint32();
      if (entryCount !== null) addDetail('entry_count', entryCount);
      markChildOffset();
      break;
    }
    case 'mehd': {
      const full = readFullBoxHeader();
      if (!full) break;
      const duration = full.version === 1 ? readUint64Val() : readUint32();
      if (duration !== null) addDetail('fragment_duration', formatBigInt(typeof duration === 'bigint' ? duration : BigInt(duration)));
      markChildOffset();
      break;
    }
    case 'trex': {
      const full = readFullBoxHeader();
      if (!full) break;
      const trackId = readUint32();
      if (trackId !== null) addDetail('track_id', trackId);
      const descIdx = readUint32();
      if (descIdx !== null) addDetail('default_sample_description_index', descIdx);
      const defDuration = readUint32();
      if (defDuration !== null) addDetail('default_sample_duration', defDuration);
      const defSize = readUint32();
      if (defSize !== null) addDetail('default_sample_size', defSize);
      const defFlags = readUint32();
      if (defFlags !== null) addDetail('default_sample_flags', formatHex(defFlags));
      markChildOffset();
      break;
    }
    case 'mfhd': {
      const full = readFullBoxHeader();
      if (!full) break;
      const seq = readUint32();
      if (seq !== null) addDetail('sequence_number', seq);
      markChildOffset();
      break;
    }
    case 'tfdt': {
      const full = readFullBoxHeader();
      if (!full) break;
      const value = full.version === 1 ? readUint64Val() : readUint32();
      if (value !== null) addDetail('base_media_decode_time', formatBigInt(typeof value === 'bigint' ? value : BigInt(value)));
      markChildOffset();
      break;
    }
    case 'tfhd': {
      const full = readFullBoxHeader();
      if (!full) break;
      const flags = full.flags || 0;
      const trackId = readUint32();
      if (trackId !== null) addDetail('track_id', trackId);
      if (flags & 0x000001) {
        const baseOffset = readUint64Val();
        if (baseOffset !== null) addDetail('base_data_offset', formatBigInt(baseOffset));
      }
      if (flags & 0x000002) {
        const sampleDesc = readUint32();
        if (sampleDesc !== null) addDetail('sample_description_index', sampleDesc);
      }
      if (flags & 0x000008) {
        const sampleDuration = readUint32();
        if (sampleDuration !== null) addDetail('default_sample_duration', sampleDuration);
      }
      if (flags & 0x000010) {
        const sampleSize = readUint32();
        if (sampleSize !== null) addDetail('default_sample_size', sampleSize);
      }
      if (flags & 0x000020) {
        const sampleFlags = readUint32();
        if (sampleFlags !== null) addDetail('default_sample_flags', formatHex(sampleFlags));
      }
      markChildOffset();
      break;
    }
    case 'trun': {
      const full = readFullBoxHeader();
      if (!full) break;
      const flags = full.flags || 0;
      const sampleCount = readUint32();
      if (sampleCount !== null) addDetail('sample_count', sampleCount);
      if (flags & 0x000001) {
        const dataOffset = readInt32();
        if (dataOffset !== null) addDetail('data_offset', dataOffset);
      }
      if (flags & 0x000004) {
        const firstFlags = readUint32();
        if (firstFlags !== null) addDetail('first_sample_flags', formatHex(firstFlags));
      }
      markChildOffset();
      break;
    }
    case 'sidx': {
      const full = readFullBoxHeader();
      if (!full) break;
      const refId = readUint32();
      if (refId !== null) addDetail('reference_id', refId);
      const timescale = readUint32();
      if (timescale !== null) addDetail('timescale', timescale);
      if (full.version === 1) {
        const earliest = readUint64Val();
        if (earliest !== null) addDetail('earliest_presentation_time', formatBigInt(earliest));
        const firstOffset = readUint64Val();
        if (firstOffset !== null) addDetail('first_offset', formatBigInt(firstOffset));
      } else {
        const earliest32 = readUint32();
        if (earliest32 !== null) addDetail('earliest_presentation_time', earliest32);
        const firstOffset32 = readUint32();
        if (firstOffset32 !== null) addDetail('first_offset', firstOffset32);
      }
      const reserved = readUint16();
      if (reserved !== null) addDetail('reserved', formatHex(reserved, 4));
      const refCount = readUint16();
      if (refCount !== null) addDetail('reference_count', refCount);
      markChildOffset();
      break;
    }
    case 'pssh': {
      const full = readFullBoxHeader();
      if (!full) break;
      if (ensure(16)) {
        const systemIdBytes = bytes.subarray(cursor, cursor + 16);
        cursor += 16;
        remaining -= 16;
        addDetail('system_id', formatUuid(systemIdBytes));
      }
      if (full.version > 0) {
        const kidCount = readUint32();
        if (kidCount !== null) {
          const kids = [];
          for (let i = 0; i < kidCount && ensure(16); i++) {
            const kidBytes = bytes.subarray(cursor, cursor + 16);
            cursor += 16;
            remaining -= 16;
            kids.push(formatUuid(kidBytes));
          }
          if (kids.length) addDetail('kids', kids.join(', '));
        }
      }
      const dataSize = readUint32();
      if (dataSize !== null && ensure(dataSize)) {
        cursor += dataSize;
        remaining -= dataSize;
        addDetail('data_size', `${dataSize.toLocaleString()} bytes`);
      }
      markChildOffset();
      break;
    }
    case 'encv':
    case 'avc1':
    case 'avc3':
    case 'hvc1':
    case 'hev1':
    case 'mp4v':
    case 's263':
    case 'vp08':
    case 'vp09': {
      parseVisualSampleEntry();
      break;
    }
    case 'enca':
    case 'mp4a':
    case 'ac-3':
    case 'ec-3':
    case 'ac-4':
    case 'dtsc':
    case 'dtse':
    case 'dtsh':
    case 'dtsl': {
      parseAudioSampleEntry();
      break;
    }
    case 'hvcC': {
      const configurationVersion = readUint8();
      if (configurationVersion !== null) addDetail('configuration_version', configurationVersion);
      const profileData = readUint8();
      if (profileData !== null) {
        const profileSpace = profileData >> 6;
        const tierFlag = (profileData >> 5) & 0x01;
        const profileIdc = profileData & 0x1f;
        addDetail('profile_space', profileSpace);
        addDetail('tier_flag', tierFlag);
        addDetail('profile_idc', profileIdc);
      }
      const compatibility = readUint32();
      if (compatibility !== null) addDetail('profile_compatibility', formatHex(compatibility));
      if (ensure(6)) {
        const constraintBytes = bytes.subarray(cursor, cursor + 6);
        cursor += 6;
        remaining -= 6;
        const constraintHex = Array.from(constraintBytes, (b) => b.toString(16).padStart(2, '0')).join('');
        addDetail('constraint_indicator', `0x${constraintHex}`);
      }
      const levelIdc = readUint8();
      if (levelIdc !== null) addDetail('level_idc', levelIdc);
      const segmentation = readUint16();
      if (segmentation !== null) addDetail('min_spatial_segmentation_idc', segmentation & 0x0fff);
      const parallelism = readUint8();
      if (parallelism !== null) addDetail('parallelism_type', parallelism & 0x03);
      const chromaByte = readUint8();
      if (chromaByte !== null) addDetail('chroma_format', chromaByte & 0x03);
      const bitDepthLuma = readUint8();
      if (bitDepthLuma !== null) addDetail('bit_depth_luma', (bitDepthLuma & 0x07) + 8);
      const bitDepthChroma = readUint8();
      if (bitDepthChroma !== null) addDetail('bit_depth_chroma', (bitDepthChroma & 0x07) + 8);
      const averageFrameRate = readUint16();
      if (averageFrameRate !== null) addDetail('average_frame_rate', averageFrameRate);
      const temporalInfo = readUint8();
      if (temporalInfo !== null) {
        addDetail('constant_frame_rate', temporalInfo >> 6);
        addDetail('num_temporal_layers', (temporalInfo >> 3) & 0x07);
        addDetail('temporal_id_nested', (temporalInfo >> 2) & 0x01);
        addDetail('nalu_length_size', (temporalInfo & 0x03) + 1);
      }
      const numArrays = readUint8();
      if (numArrays !== null) {
        addDetail('array_count', numArrays);
        let totalNalUnits = 0;
        for (let i = 0; i < numArrays; i++) {
          if (!ensure(3)) break;
          const arrayHeader = readUint8();
          if (arrayHeader === null) break;
          const numNalus = readUint16();
          if (numNalus === null) break;
          for (let j = 0; j < numNalus; j++) {
            const nalSize = readUint16();
            if (nalSize === null) {
              remaining = 0;
              break;
            }
            if (!skipBytes(nalSize)) {
              remaining = 0;
              break;
            }
            totalNalUnits += 1;
          }
        }
        addDetail('total_nalus', totalNalUnits);
      }
      break;
    }
    case 'fiel': {
      const fieldCount = readUint8();
      const fieldOrdering = readUint8();
      if (fieldCount !== null) addDetail('field_count', fieldCount);
      if (fieldOrdering !== null) addDetail('field_order', fieldOrdering);
      break;
    }
    case 'colr': {
      const colourType = readString(4);
      if (colourType) addDetail('colour_type', `'${colourType}'`);
      if (colourType === 'nclc' || colourType === 'nclx') {
        const primaries = readUint16();
        const transfer = readUint16();
        const matrix = readUint16();
        if (primaries !== null) addDetail('colour_primaries', primaries);
        if (transfer !== null) addDetail('transfer_characteristics', transfer);
        if (matrix !== null) addDetail('matrix_coefficients', matrix);
        if (colourType === 'nclx') {
          const fullRange = readUint8();
          if (fullRange !== null) addDetail('full_range_flag', (fullRange >> 7) & 0x01);
        }
      } else if (remaining > 0) {
        addDetail('payload_bytes', `${remaining.toLocaleString()} bytes`);
        skipBytes(remaining);
      }
      break;
    }
    case 'pasp': {
      const hSpacing = readUint32();
      const vSpacing = readUint32();
      if (hSpacing !== null) addDetail('h_spacing', hSpacing);
      if (vSpacing !== null) addDetail('v_spacing', vSpacing);
      break;
    }
    case 'btrt': {
      const bufferSize = readUint32();
      const maxBitrate = readUint32();
      const avgBitrate = readUint32();
      if (bufferSize !== null) addDetail('buffer_size_db', bufferSize);
      if (maxBitrate !== null) addDetail('max_bitrate', maxBitrate);
      if (avgBitrate !== null) addDetail('avg_bitrate', avgBitrate);
      break;
    }
    case 'frma': {
      const original = readString(4);
      if (original) addDetail('original_format', `'${original}'`);
      break;
    }
    case 'schm': {
      const full = readFullBoxHeader();
      if (!full) break;
      const schemeType = readString(4);
      if (schemeType) addDetail('scheme_type', `'${schemeType}'`);
      const schemeVersion = readUint32();
      if (schemeVersion !== null) addDetail('scheme_version', schemeVersion);
      if (full.flags & 0x000001) {
        const uri = readString(remaining);
        if (uri) addDetail('scheme_uri', uri);
      }
      markChildOffset();
      break;
    }
    case 'tenc': {
      const full = readFullBoxHeader();
      if (!full) break;
      if (full.version === 1) {
        const cryptBlock = readUint8();
        const skipBlock = readUint8();
        const isProtected = readUint8();
        const perSample = readUint8();
        if (cryptBlock !== null) addDetail('default_crypt_byte_block', cryptBlock);
        if (skipBlock !== null) addDetail('default_skip_byte_block', skipBlock);
        if (isProtected !== null) addDetail('default_isProtected', isProtected);
        if (perSample !== null) addDetail('default_Per_Sample_IV_Size', perSample);
        if (ensure(16)) {
          const kidBytes = bytes.subarray(cursor, cursor + 16);
          cursor += 16;
          remaining -= 16;
          addDetail('default_KID', formatUuid(kidBytes));
        }
        if (isProtected === 1 && perSample === 0) {
          const constantIvSize = readUint8();
          if (constantIvSize !== null) {
            addDetail('default_constant_IV_size', constantIvSize);
            if (ensure(constantIvSize)) {
              const ivBytes = bytes.subarray(cursor, cursor + constantIvSize);
              cursor += constantIvSize;
              remaining -= constantIvSize;
              const ivHex = Array.from(ivBytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
              addDetail('default_constant_IV', `[${ivHex}]`);
            }
          }
        }
      } else {
        skipBytes(1); // reserved
        const isProtected = readUint8();
        if (isProtected !== null) addDetail('default_isProtected', isProtected);
        const perSample = readUint8();
        if (perSample !== null) addDetail('default_Per_Sample_IV_Size', perSample);
        if (ensure(16)) {
          const kidBytes = bytes.subarray(cursor, cursor + 16);
          cursor += 16;
          remaining -= 16;
          addDetail('default_KID', formatUuid(kidBytes));
        }
        if (perSample === 0) {
          const constantIvSize = readUint8();
          if (constantIvSize !== null) {
            addDetail('default_constant_IV_size', constantIvSize);
            if (ensure(constantIvSize)) {
              const ivBytes = bytes.subarray(cursor, cursor + constantIvSize);
              cursor += constantIvSize;
              remaining -= constantIvSize;
              const ivHex = Array.from(ivBytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
              addDetail('default_constant_IV', `[${ivHex}]`);
            }
          }
        }
      }
      markChildOffset();
      break;
    }
    case 'meta': {
      const full = readFullBoxHeader();
      if (!full) break;
      skipBytes(4);
      markChildOffset();
      break;
    }
    case 'dref': {
      const full = readFullBoxHeader();
      if (!full) break;
      const entryCount = readUint32();
      if (entryCount !== null) addDetail('entry_count', entryCount);
      markChildOffset();
      break;
    }
    case 'mdat': {
      if (payloadSize > 0) addDetail('payload_bytes', `${payloadSize.toLocaleString()} bytes`);
      break;
    }
    default: {
      if (payloadSize > 0) {
        addDetail('payload_bytes', `${payloadSize.toLocaleString()} bytes`);
      }
      break;
    }
  }

  return { details, childOffset };
}

function readUint64(view, offset) {
  if (typeof view.getBigUint64 === 'function') {
    return view.getBigUint64(offset);
  }
  const high = BigInt(view.getUint32(offset));
  const low = BigInt(view.getUint32(offset + 4));
  return (high << 32n) | low;
}

function formatMp4Date(value) {
  if (value === null || value === undefined) return '';
  const val = typeof value === 'bigint' ? value : BigInt(value);
  if (val === 0n) return '0';
  const unixSeconds = val - MP4_EPOCH_OFFSET;
  try {
    const ms = unixSeconds * 1000n;
    if (ms > BigInt(Number.MAX_SAFE_INTEGER) || ms < BigInt(Number.MIN_SAFE_INTEGER)) {
      return val.toString();
    }
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return val.toString();
    return `${val.toString()} (${date.toISOString()})`;
  } catch {
    return val.toString();
  }
}

function formatBigInt(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : String(value);
  return String(value);
}

function formatFixed1616(raw) {
  if (raw === null || raw === undefined) return '';
  return (raw / 65536).toFixed(4);
}

function formatFixed88(raw) {
  if (raw === null || raw === undefined) return '';
  return (raw / 256).toFixed(2);
}

function formatHex(value, digits = 8) {
  if (value === null || value === undefined) return '';
  const big = typeof value === 'bigint' ? value : BigInt(value);
  return `0x${big.toString(16).padStart(digits, '0')}`;
}

function decodeIso639(bits) {
  if (bits === null || bits === undefined) return '';
  const c1 = ((bits >> 10) & 0x1f) + 0x60;
  const c2 = ((bits >> 5) & 0x1f) + 0x60;
  const c3 = (bits & 0x1f) + 0x60;
  return `${String.fromCharCode(c1, c2, c3)}`;
}

function formatUuid(bytes) {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fourCC(bytes, offset) {
  if (offset + 4 > bytes.length) return '';
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function formatDetailDisplay(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(formatDetailDisplay).join(', ');
  return String(value);
}

// Auto-load if URL provided
if (urlInput.value) load();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatDuration,
    isLikelyMp4,
    detectMode,
    deriveManifestBase,
    resolveAgainstBase,
    parseRepeatCount,
    formatMp4Date,
    formatBigInt,
    formatHex,
    decodeIso639,
    formatUuid,
    buildDashData,
    parseMp4Structure,
  };
}
