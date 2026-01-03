document.addEventListener('DOMContentLoaded', () => {
  const urlEl          = document.getElementById('url');
  const openBtn        = document.getElementById('open');
  const compatBtn      = document.getElementById('compat');
  const openHeadersBtn = document.getElementById('openHeaders');
  const autoOpenEl     = document.getElementById('autoOpenToggle');
  const tabManifestRow     = document.getElementById('tabManifestRow');
  const tabManifestSelect  = document.getElementById('tabManifestSelect');
  const tabManifestOpenBtn = document.getElementById('openTabManifest');
  const notifyToggle       = document.getElementById('notifyToggle');
  const notifyRow          = document.getElementById('notifyRow');
  const manifestNotice      = document.getElementById('manifestNotice');
  const manifestNoticeLabel = document.getElementById('manifestNoticeLabel');
  const manifestNoticeOpen  = document.getElementById('manifestNoticeOpen');
  const manifestNoticeDismiss = document.getElementById('manifestNoticeDismiss');

  let activeTabId = null;
  let activeTabUrl = "";
  let latestManifestNotice = null;
  let notificationsEnabled = true;

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
    notifyToggle,
    tabManifestSelect,
    tabManifestOpenBtn,
  };
  Object.entries(required).forEach(([k, v]) => {
    if (!v) console.error(`[popup] Missing required element: ${k} (check popup.html IDs)`);
  });


  function requestNotificationPermissionIfNeeded(next) {
    if (!chrome?.permissions?.contains) {
      next(true);
      return;
    }
    chrome.permissions.contains({ permissions: ["notifications"] }, (alreadyGranted) => {
      if (chrome.runtime.lastError) {
        next(true);
        return;
      }
      if (alreadyGranted) {
        next(true);
        return;
      }
      if (!chrome.permissions.request) {
        next(false);
        return;
      }
      chrome.permissions.request({ permissions: ["notifications"] }, (granted) => {
        next(!!granted);
      });
    });
  }

  function syncNotificationToggleFromPermission(enabled) {
    requestNotificationPermissionIfNeeded((granted) => {
      notificationsEnabled = enabled && granted;
      if (notifyToggle) notifyToggle.checked = notificationsEnabled;
      if (!notificationsEnabled) {
        hideManifestNotice();
        clearTabManifestBadge();
        chrome.storage.sync.set({ notifyOnDetect: false });
      } else {
        chrome.storage.sync.set({ notifyOnDetect: true });
      }
    });
  }

  // Load saved settings (default autoOpenViewer = true, notifications = true)
  chrome.storage.sync.get({ autoOpenViewer: true, notifyOnDetect: true }, (res) => {
    if (autoOpenEl) autoOpenEl.checked = !!res.autoOpenViewer;
    const desiredNotify = res.notifyOnDetect !== false;
    syncNotificationToggleFromPermission(desiredNotify);
  });

  // Auto-save when checkbox toggles
  if (autoOpenEl) {
    autoOpenEl.addEventListener('change', () => {
      chrome.storage.sync.set({ autoOpenViewer: !!autoOpenEl.checked });
    });
  }
  if (notifyToggle) {
    notifyToggle.addEventListener('change', () => {
      const desired = !!notifyToggle.checked;
      if (!desired) {
        notificationsEnabled = false;
        chrome.storage.sync.set({ notifyOnDetect: false });
        hideManifestNotice();
        clearTabManifestBadge();
        return;
      }
      requestNotificationPermissionIfNeeded((granted) => {
        notificationsEnabled = granted;
        notifyToggle.checked = notificationsEnabled;
        chrome.storage.sync.set({ notifyOnDetect: notificationsEnabled });
        if (!notificationsEnabled) {
          hideManifestNotice();
          clearTabManifestBadge();
          return;
        }
        loadTabManifestOptions({ reuseActiveTab: true });
      });
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

  function getHostname(u = "") {
    try { return new URL(u).hostname || ""; } catch { return ""; }
  }

  function isBlockedTabUrl(u = "") {
    if (!u) return false;
    try {
      const parsed = new URL(u);
      if (parsed.protocol === "chrome-extension:") return true;
      const host = parsed.hostname || "";
      return host.toLowerCase() === "123-test.stream";
    } catch {
      return false;
    }
  }

  function matchesActiveTab(manifest = null) {
    if (!manifest) return false;
    const targetTabId = typeof manifest.tabId === "number" ? manifest.tabId : null;
    if (targetTabId !== null && activeTabId !== null) {
      return targetTabId === activeTabId;
    }
    const manifestHost = getHostname(manifest.pageUrl || manifest.url);
    const activeHost = getHostname(activeTabUrl);
    if (manifestHost && activeHost) return manifestHost === activeHost;
    return false;
  }

  function hideManifestNotice() {
    latestManifestNotice = null;
    if (manifestNotice) manifestNotice.classList.remove('show');
    if (manifestNoticeLabel) manifestNoticeLabel.textContent = "";
  }

  function showManifestNotice(manifest) {
    if (!notificationsEnabled || !manifest || !manifest.url || !manifestNotice || isFirefox) return;
    latestManifestNotice = manifest;
    if (manifestNoticeLabel) {
      manifestNoticeLabel.textContent = formatManifestLabel(manifest.url);
    }
    if (urlEl && !urlEl.value) {
      urlEl.value = manifest.url;
    }
    manifestNotice.classList.add('show');
  }

  function clearTabManifestBadge() {
    const tabId = typeof activeTabId === "number" ? activeTabId : null;
    if (tabId === null || isFirefox) return;
    try {
      chrome.runtime.sendMessage({ type: "CLEAR_TAB_MANIFEST_BADGE", tabId });
    } catch {
      // ignore
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
    if (tabManifestRow) {
      const shouldShowRow = loading || (Array.isArray(items) && items.length > 0);
      tabManifestRow.style.display = shouldShowRow ? 'flex' : 'none';
    }
  }

  function requestLatestManifestForTab(tabId, pageUrl) {
    if (isFirefox || notificationsEnabled === false) return;
    if (isBlockedTabUrl(pageUrl)) return;
    try {
      chrome.runtime.sendMessage(
        { type: "GET_LATEST_TAB_MANIFEST", tabId, pageUrl },
        (res) => {
          if (chrome.runtime.lastError) return;
          if (!res || res.ok !== true || !res.manifest) {
            hideManifestNotice();
            return;
          }
          const manifest = res.manifest;
          if (manifest && manifest.url && matchesActiveTab(manifest)) {
            showManifestNotice(manifest);
          }
        }
      );
    } catch (e) {
      console.error("[popup] Failed to request latest manifest", e);
    }
  }

  function requestTabManifestDownloads(tabId, pageUrl, { skipLoading = false } = {}) {
    if (isFirefox) return;
    if (!tabManifestSelect) return;
    if (isBlockedTabUrl(pageUrl)) {
      setTabManifestOptions({ items: [], loading: false, message: "" });
      hideManifestNotice();
      clearTabManifestBadge();
      return;
    }
    if (!skipLoading) setTabManifestOptions({ loading: true });
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
          if (notificationsEnabled && items.length) {
            const manifest = items[0];
            if (matchesActiveTab(manifest)) {
              showManifestNotice(manifest);
            }
          }
          if (!items.length) {
            hideManifestNotice();
          }
        }
      );
    } catch (e) {
      console.error("[popup] Failed to request tab manifests", e);
      setTabManifestOptions({ message: "Could not scan this tab right now" });
    }
  }

  function loadTabManifestOptions({ reuseActiveTab = false } = {}) {
    if (isFirefox) return;
    if (!tabManifestSelect) return;

    if (reuseActiveTab && (activeTabId !== null || activeTabUrl)) {
      if (isBlockedTabUrl(activeTabUrl)) {
        setTabManifestOptions({ items: [], loading: false, message: "" });
        hideManifestNotice();
        clearTabManifestBadge();
        return;
      }
      requestTabManifestDownloads(activeTabId, activeTabUrl);
      if (notificationsEnabled) requestLatestManifestForTab(activeTabId, activeTabUrl);
      return;
    }

    if (!chrome?.tabs?.query) {
      setTabManifestOptions({ message: "Tab access unavailable" });
      return;
    }

    setTabManifestOptions({ loading: true });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs.length ? tabs[0] : null;
      activeTabId = tab && typeof tab.id === "number" ? tab.id : null;
      activeTabUrl = tab && typeof tab.url === "string" ? tab.url : "";
      if (isBlockedTabUrl(activeTabUrl)) {
        setTabManifestOptions({ items: [], loading: false, message: "" });
        hideManifestNotice();
        clearTabManifestBadge();
        return;
      }
      requestTabManifestDownloads(activeTabId, activeTabUrl, { skipLoading: true });
      if (notificationsEnabled) requestLatestManifestForTab(activeTabId, activeTabUrl);
    });
  }

  if (openBtn) openBtn.addEventListener('click', openViewer);
  if (compatBtn) compatBtn.addEventListener('click', openCompat);
  if (openHeadersBtn) openHeadersBtn.addEventListener('click', openViewerHeaders);
  if (manifestNoticeOpen) {
    manifestNoticeOpen.addEventListener('click', () => {
      if (!latestManifestNotice || !latestManifestNotice.url) return;
      openViewer(latestManifestNotice.url, { autoHeaders: true });
      clearTabManifestBadge();
      hideManifestNotice();
    });
  }
  if (manifestNoticeDismiss) {
    manifestNoticeDismiss.addEventListener('click', () => {
      hideManifestNotice();
      clearTabManifestBadge();
    });
  }
  if (tabManifestOpenBtn) {
    tabManifestOpenBtn.addEventListener('click', () => {
      if (!tabManifestSelect || !tabManifestSelect.value) return;
      openViewer(tabManifestSelect.value, { autoHeaders: true });
      clearTabManifestBadge();
      hideManifestNotice();
    });
  }
  if (tabManifestSelect) {
    tabManifestSelect.addEventListener('change', () => {
      if (tabManifestOpenBtn) tabManifestOpenBtn.disabled = !tabManifestSelect.value;
      if (urlEl && tabManifestSelect.value) urlEl.value = tabManifestSelect.value;
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (isFirefox) return;
    if (!msg || msg.type !== "TAB_MANIFEST_DETECTED") return;
    const manifest = msg.manifest || msg;
    if (!manifest || !manifest.url) return;
    if (!matchesActiveTab(manifest)) return;
    if (notificationsEnabled) showManifestNotice(manifest);
    loadTabManifestOptions({ reuseActiveTab: true });
  });

  // Enter to open
  if (urlEl) urlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openViewer();
  });

  if (isFirefox) {
    if (tabManifestRow) tabManifestRow.style.display = 'none';
    if (manifestNotice) manifestNotice.style.display = 'none';
    if (notifyRow) notifyRow.style.display = 'none';
  } else {
    loadTabManifestOptions();
  }
});
