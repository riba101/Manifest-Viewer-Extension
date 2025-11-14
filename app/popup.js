document.addEventListener('DOMContentLoaded', () => {
  const urlEl          = document.getElementById('url');
  const openBtn        = document.getElementById('open');
  const compatBtn      = document.getElementById('compat');
  const openHeadersBtn = document.getElementById('openHeaders');
  const autoOpenEl     = document.getElementById('autoOpenToggle');


  const versionEl    = document.getElementById('popup-version');
  const versionWrap  = document.getElementById('popup-version-section');
  
  if (versionEl) {
    const hide = () => { if (versionWrap) versionWrap.style.display = 'none'; };
    try {
      // Get the version from the manifest
      const manifest = chrome.runtime.getManifest();
      const v = manifest && typeof manifest.version === 'string' ? manifest.version.trim() : '';
      if (v) {
        versionEl.textContent = v;
        if (versionWrap) versionWrap.style.display = '';
      } else {
        hide();
      }
    } catch (e) {
      console.error("Failed to load manifest version", e);
      hide();
    }
  }

  // Guard: only error on required elements; warn for optional ones
  const required = { urlEl, openBtn, compatBtn, autoOpenEl };
  Object.entries(required).forEach(([k, v]) => {
    if (!v) console.error(`[popup] Missing required element: ${k} (check popup.html IDs)`);
  });


  // Load saved settings (default autoOpenViewer = true)
  chrome.storage.sync.get({ autoOpenViewer: true }, (res) => {
    if (autoOpenEl) autoOpenEl.checked = !!res.autoOpenViewer;
  });

  // Auto-save when checkbox toggles
  if (autoOpenEl) {
    autoOpenEl.addEventListener('change', () => {
      chrome.storage.sync.set({ autoOpenViewer: !!autoOpenEl.checked });
    });
  }

  // Open viewer tab
  function openViewer() {
    const url = urlEl ? urlEl.value.trim() : "";
    const q = new URLSearchParams();
    if (url) q.set('u', url);
    const query = q.toString();
    const viewerUrl = query ? `viewer.html?${query}` : 'viewer.html';
    chrome.tabs.create({ url: chrome.runtime.getURL(viewerUrl) });
  }

  function openCompat() {
    const page = chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL('compat.html') : 'compat.html';
    try { chrome.tabs.create({ url: page }); } catch { window.open(page, '_blank'); }
  }

  // Open viewer tab and auto-open the headers panel
  function openViewerHeaders() {
    const url = urlEl ? urlEl.value.trim() : "";
    const q = new URLSearchParams();
    if (url) q.set('u', url);
    q.set('headers', '1');
    const viewerUrl = `viewer.html?${q.toString()}`;
    chrome.tabs.create({ url: chrome.runtime.getURL(viewerUrl) });
  }

  if (openBtn) openBtn.addEventListener('click', openViewer);
  if (compatBtn) compatBtn.addEventListener('click', openCompat);
  if (openHeadersBtn) openHeadersBtn.addEventListener('click', openViewerHeaders);

  // Enter to open
  if (urlEl) urlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openViewer();
  });
});
