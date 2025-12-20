document.addEventListener('DOMContentLoaded', () => {
  const urlEl          = document.getElementById('url');
  const openBtn        = document.getElementById('open');
  const compatBtn      = document.getElementById('compat');
  const openHeadersBtn = document.getElementById('openHeaders');
  const autoOpenEl     = document.getElementById('autoOpenToggle');
  const tabManifestRow     = document.getElementById('tabManifestRow');
  const tabManifestSelect  = document.getElementById('tabManifestSelect');
  const tabManifestOpenBtn = document.getElementById('openTabManifest');


  const versionEl    = document.getElementById('popup-version');
  const versionWrap  = document.getElementById('popup-version-section');
  const isFirefox = typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent || "");
  
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
  const required = {
    urlEl,
    openBtn,
    compatBtn,
    autoOpenEl,
    tabManifestSelect,
    tabManifestOpenBtn,
  };
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
  function openViewer(manifestArg, options = {}) {
    const manifestUrl = typeof manifestArg === "string" ? manifestArg.trim() : "";
    const url = manifestUrl || (urlEl ? urlEl.value.trim() : "");
    if (urlEl && manifestUrl) urlEl.value = manifestUrl;
    const q = new URLSearchParams();
    if (url) q.set('u', url);
    const shouldPrefillHeaders =
      options.autoHeaders ||
      (tabManifestSelect && tabManifestSelect.value && tabManifestSelect.value === url);
    if (shouldPrefillHeaders) q.set('autoHeaders', '1');
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

  function formatManifestLabel(manifestUrl) {
    try {
      const parsed = new URL(manifestUrl);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const name = parts.length ? parts[parts.length - 1] : parsed.hostname;
      return `${name} - ${parsed.hostname}`;
    } catch {
      return manifestUrl;
    }
  }

  function setTabManifestOptions({ items = [], loading = false, message = "" } = {}) {
    if (!tabManifestSelect) return;

    tabManifestSelect.innerHTML = "";
    let disableSelect = false;
    if (loading) {
      tabManifestSelect.appendChild(new Option("Scanning current tab for manifests...", ""));
      disableSelect = true;
    } else if (message) {
      tabManifestSelect.appendChild(new Option(message, ""));
      disableSelect = true;
    } else if (!items.length) {
      tabManifestSelect.appendChild(new Option("No manifest downloads detected on this tab yet", ""));
      disableSelect = true;
    } else {
      items.forEach((item) => {
        if (!item || !item.url) return;
        const label = formatManifestLabel(item.url);
        tabManifestSelect.appendChild(new Option(label, item.url));
      });
    }

    tabManifestSelect.disabled = disableSelect;
    if (tabManifestOpenBtn) tabManifestOpenBtn.disabled = disableSelect || !tabManifestSelect.value;
  }

  function loadTabManifestOptions() {
    if (isFirefox) return;
    if (!tabManifestSelect) return;
    setTabManifestOptions({ loading: true });

    const sendRequest = (tabId, pageUrl) => {
      try {
        chrome.runtime.sendMessage(
          { type: "GET_TAB_MANIFEST_DOWNLOADS", tabId, pageUrl },
          (res) => {
            if (chrome.runtime.lastError) {
              setTabManifestOptions({ message: "Could not scan this tab right now" });
              return;
            }
            if (!res || res.ok !== true || !Array.isArray(res.downloads)) {
              setTabManifestOptions({ message: "Could not scan this tab right now" });
              return;
            }
            const items = res.downloads || [];
            setTabManifestOptions({
              items,
              message: items.length ? "" : "No manifest downloads detected on this tab yet",
            });
            if (items.length && urlEl && !urlEl.value) {
              urlEl.value = items[0].url;
            }
          }
        );
      } catch (e) {
        console.error("[popup] Failed to request tab manifests", e);
        setTabManifestOptions({ message: "Could not scan this tab right now" });
      }
    };

    if (!chrome?.tabs?.query) {
      setTabManifestOptions({ message: "Tab access unavailable" });
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs.length ? tabs[0] : null;
      const tabId = tab && typeof tab.id === "number" ? tab.id : null;
      const pageUrl = tab && typeof tab.url === "string" ? tab.url : "";
      sendRequest(tabId, pageUrl);
    });
  }

  if (openBtn) openBtn.addEventListener('click', openViewer);
  if (compatBtn) compatBtn.addEventListener('click', openCompat);
  if (openHeadersBtn) openHeadersBtn.addEventListener('click', openViewerHeaders);
  if (tabManifestOpenBtn) {
    tabManifestOpenBtn.addEventListener('click', () => {
      if (!tabManifestSelect || !tabManifestSelect.value) return;
      openViewer(tabManifestSelect.value, { autoHeaders: true });
    });
  }
  if (tabManifestSelect) {
    tabManifestSelect.addEventListener('change', () => {
      if (tabManifestOpenBtn) tabManifestOpenBtn.disabled = !tabManifestSelect.value;
      if (urlEl && tabManifestSelect.value) urlEl.value = tabManifestSelect.value;
    });
  }

  // Enter to open
  if (urlEl) urlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openViewer();
  });

  if (isFirefox) {
    if (tabManifestRow) tabManifestRow.style.display = 'none';
  } else {
    loadTabManifestOptions();
  }
});
