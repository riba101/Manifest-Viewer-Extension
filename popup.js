document.addEventListener('DOMContentLoaded', () => {
  const urlEl        = document.getElementById('url');
  const uaEl         = document.getElementById('ua');
  const openBtn      = document.getElementById('open');
  const saveBtn      = document.getElementById('saveUA');
  const autoOpenEl   = document.getElementById('autoOpenToggle');

  // Guard: log a clear error if markup changed
  const req = { urlEl, uaEl, openBtn, saveBtn, autoOpenEl };
  Object.entries(req).forEach(([k, v]) => {
    if (!v) console.error(`[popup] Missing element: ${k} (check popup.html IDs)`);
  });

  // Load saved settings (default autoOpenViewer = true)
  chrome.storage.sync.get({ customUA: "", autoOpenViewer: true }, (res) => {
    if (uaEl) uaEl.value = res.customUA || "";
    if (autoOpenEl) autoOpenEl.checked = !!res.autoOpenViewer;
  });

  // Save defaults (UA + auto-open)
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      chrome.storage.sync.set({
        customUA: uaEl ? uaEl.value.trim() : "",
        autoOpenViewer: autoOpenEl ? autoOpenEl.checked : true
      });
    });
  }

  // Open viewer tab
  function openViewer() {
    const url = urlEl ? urlEl.value.trim() : "";
    const ua  = uaEl ? uaEl.value.trim() : "";
    const q = new URLSearchParams();
    if (url) q.set('u', url);
    if (ua)  q.set('ua', ua);
    chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?${q.toString()}`) });
  }

  if (openBtn) openBtn.addEventListener('click', openViewer);

  // Enter to open
  if (urlEl) urlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openViewer();
  });
});
