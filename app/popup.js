document.addEventListener('DOMContentLoaded', () => {
  const urlEl        = document.getElementById('url');
  const openBtn      = document.getElementById('open');
  const saveBtn      = document.getElementById('saveSettings');
  const autoOpenEl   = document.getElementById('autoOpenToggle');


  const versionEl    = document.getElementById('popup-version');
  
  if (versionEl) {
    try {
      // Get the version from the manifest
      const manifest = chrome.runtime.getManifest();
      versionEl.textContent = manifest.version || '...';
    } catch (e) {
      console.error("Failed to load manifest version", e);
      versionEl.textContent = 'N/A';
    }
  }

  // Guard: log a clear error if markup changed
  const req = { urlEl, openBtn, saveBtn, autoOpenEl };
  Object.entries(req).forEach(([k, v]) => {
    if (!v) console.error(`[popup] Missing element: ${k} (check popup.html IDs)`);
  });

  // Load saved settings (default autoOpenViewer = true)
  chrome.storage.sync.get({ autoOpenViewer: true }, (res) => {
    if (autoOpenEl) autoOpenEl.checked = !!res.autoOpenViewer;
  });

  // Save defaults (auto-open)
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      chrome.storage.sync.set({
        autoOpenViewer: autoOpenEl ? autoOpenEl.checked : true
      });
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

  if (openBtn) openBtn.addEventListener('click', openViewer);

  // Enter to open
  if (urlEl) urlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openViewer();
  });
});
