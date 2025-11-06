// MV3 background
// - Auto-open viewer for .m3u8/.mpd (early onBeforeNavigate + fallback onCommitted)
// - Temporary custom User-Agent via Declarative Net Request (DNR) dynamic rules
// - Downloads fallback: cancel forced downloads of .mpd/.m3u8 and open viewer
// - No webRequest / webRequestBlocking

// -------------------------------
// State & storage helpers
// -------------------------------
const state = { customUA: "" };

chrome.storage.sync.get({ customUA: "" }, (res) => {
  state.customUA = res.customUA || "";
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.customUA) {
    state.customUA = changes.customUA.newValue || "";
  }
});

// One-time migration: default autoOpenViewer = true
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (res) => {
    if (!Object.prototype.hasOwnProperty.call(res, "autoOpenViewer")) {
      chrome.storage.sync.set({ autoOpenViewer: true });
    }
  });
});

// Promise helper
function getSync(defaults) {
  return new Promise((resolve) => chrome.storage.sync.get(defaults, resolve));
}

// -------------------------------
// UA override via DNR (per-request, temporary)
// -------------------------------
function buildExactUrlRule(url, ua, id) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "User-Agent", operation: "set", value: ua }],
    },
    condition: {
      regexFilter: `^${escaped}$`,
      resourceTypes: ["xmlhttprequest", "other"],
    },
  };
}

async function applyUARuleForUrl(url, ua) {
  const ruleId = Math.floor(Date.now() % 2147483647);
  const rule = buildExactUrlRule(url, ua, ruleId);
  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
  setTimeout(() => {
    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
  }, 5000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "APPLY_UA_RULE" && typeof msg.url === "string") {
    const ua = (msg.ua && msg.ua.trim()) || state.customUA || "";
    if (!ua) {
      sendResponse({ ok: false, error: "No User-Agent set" });
      return true;
    }
    applyUARuleForUrl(msg.url, ua)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true; // async response
  }
  if (msg?.type === "GET_UA") {
    sendResponse({ ua: state.customUA || "" });
    return true;
  }
  return false;
});

// -------------------------------
function isExtensionUrl(u) {
  try { return new URL(u).protocol === "chrome-extension:"; } catch { return false; }
}
function looksLikeManifestUrl(u) {
  try {
    const { pathname } = new URL(u);
    return /\.m3u8($|\?)/i.test(pathname) || /\.mpd($|\?)/i.test(pathname);
  } catch { return false; }
}
function viewerUrlFor(u) {
  return chrome.runtime.getURL(`viewer.html?u=${encodeURIComponent(u)}`);
}

// Track tabs we've redirected to prevent loops
const redirectingTabs = new Set();

// EARLY redirect (prevents most .mpd downloads)
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  try {
    if (details.frameId !== 0 || details.tabId < 0) return;
    if (isExtensionUrl(details.url)) return;

    const { autoOpenViewer = true } = await getSync({ autoOpenViewer: true });
    if (!autoOpenViewer) return;
    if (!looksLikeManifestUrl(details.url)) return;

    if (redirectingTabs.has(details.tabId)) return;
    redirectingTabs.add(details.tabId);

    chrome.tabs.update(details.tabId, { url: viewerUrlFor(details.url) }, () => {
      setTimeout(() => redirectingTabs.delete(details.tabId), 1000);
    });
  } catch {
    redirectingTabs.delete(details.tabId);
  }
});

// Fallback redirect
chrome.webNavigation.onCommitted.addListener(async (details) => {
  try {
    if (details.frameId !== 0 || details.tabId < 0) return;
    if (isExtensionUrl(details.url)) return;

    const { autoOpenViewer = true } = await getSync({ autoOpenViewer: true });
    if (!autoOpenViewer) return;
    if (!looksLikeManifestUrl(details.url)) return;

    if (redirectingTabs.has(details.tabId)) return;
    redirectingTabs.add(details.tabId);

    chrome.tabs.update(details.tabId, { url: viewerUrlFor(details.url) }, () => {
      setTimeout(() => redirectingTabs.delete(details.tabId), 1000);
    });
  } catch {
    redirectingTabs.delete(details.tabId);
  }
});

// Cleanup on errors
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId === 0) redirectingTabs.delete(details.tabId);
});

// -------------------------------
// Downloads fallback (handles servers that force download)
// Requires "downloads" permission in manifest
// -------------------------------
chrome.downloads.onCreated.addListener(async (item) => {
  try {
    const { autoOpenViewer = true } = await getSync({ autoOpenViewer: true });
    if (!autoOpenViewer) return;

    const url = item?.finalUrl || item?.url;
    if (!url || !looksLikeManifestUrl(url)) return;

    // Cancel the download and open viewer instead
    chrome.downloads.cancel(item.id, () => {
      chrome.tabs.create({ url: viewerUrlFor(url) });
    });
  } catch {
    // ignore
  }
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildExactUrlRule,
    looksLikeManifestUrl,
  };
}
