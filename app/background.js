// MV3 background
// - Auto-open viewer for .m3u8/.mpd (early onBeforeNavigate + fallback onCommitted)
// - Temporary custom User-Agent via Declarative Net Request (DNR) dynamic rules
// - Downloads fallback: cancel forced downloads of .mpd/.m3u8 and open viewer
// - No webRequest / webRequestBlocking

// Default to "not startup" so the service worker restarting mid-session
// doesn't permanently disable auto-open logic (onStartup only fires once
// when the browser launches).
let isStartup = false;
const startupTabs = new Set();

const STARTUP_NEW_TAB_CAPTURE_MS = 30000;
let startupCaptureUntil = 0;

function isDuringExtendedStartup() {
  if (!startupCaptureUntil) return false;
  if (Date.now() > startupCaptureUntil) {
    startupCaptureUntil = 0;
    return false;
  }
  return true;
}

// Absolute safety net: fully disable startup gating after the window elapses,
// even if something prevented our normal cleanup from running.
setTimeout(() => {
  if (isDuringExtendedStartup()) return;
  isStartup = false;
  startupTabs.clear();
  startupCaptureUntil = 0;
}, STARTUP_NEW_TAB_CAPTURE_MS + 10000);

// Skip auto-open during the startup window for restored tabs, but do not block
// user-initiated navigations forever. Once the user navigates intentionally or
// the startup window has expired, remove the tab from the startup set.
function shouldDeferForStartupTab(tabId, navigationDetails = null) {
  if (!startupTabs.has(tabId)) return false;

  const transitionType = navigationDetails?.transitionType || "";
  const qualifiers = Array.isArray(navigationDetails?.transitionQualifiers)
    ? navigationDetails.transitionQualifiers
    : [];
  const userInitiated =
    transitionType === "typed" ||
    transitionType === "generated" ||
    transitionType === "form_submit" ||
    qualifiers.includes("from_address_bar") ||
    qualifiers.includes("forward_back");

  if (userInitiated || !isDuringExtendedStartup()) {
    startupTabs.delete(tabId);
    return false;
  }

  return true;
}

function getTabUrlCandidate(tab) {
  if (!tab) return "";
  const pending = typeof tab.pendingUrl === "string" ? tab.pendingUrl.trim() : "";
  if (pending) return pending;
  const current = typeof tab.url === "string" ? tab.url.trim() : "";
  return current;
}

function isChromeInternalUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.startsWith("chrome://newtab")) return true;
  return (
    lower.startsWith("chrome://") ||
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("about:")
  );
}

function shouldFlagAsStartupTab(tab) {
  if (!tab || typeof tab.id !== "number") return false;
  if (startupTabs.has(tab.id)) return false;

  if (typeof tab.openerTabId === "number" && tab.openerTabId >= 0) {
    return false;
  }

  const url = getTabUrlCandidate(tab);
  if (!url) {
    return tab.discarded === true;
  }

  if (isChromeInternalUrl(url)) return false;

  return /^(https?|file|ftp):/i.test(url);
}

function rememberStartupTab(tab) {
  if (shouldFlagAsStartupTab(tab)) {
    startupTabs.add(tab.id);
  }
}

// -------------------------------
// State & storage helpers
// -------------------------------
const state = { customUA: "", uaEnabled: true };

chrome.storage.sync.get({ customUA: "", uaEnabled: true }, (res) => {
  state.customUA = res.customUA || "";
  state.uaEnabled = typeof res.uaEnabled === "boolean" ? res.uaEnabled : true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.customUA) {
    state.customUA = changes.customUA.newValue || "";
  }
  if (changes.uaEnabled) {
    state.uaEnabled = typeof changes.uaEnabled.newValue === "boolean" ? changes.uaEnabled.newValue : true;
  }
});

 // One-time migration: default autoOpenViewer = true
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (res) => {
    const updates = {};
    if (!Object.prototype.hasOwnProperty.call(res, "autoOpenViewer")) {
      updates.autoOpenViewer = true;
    }
    if (!Object.prototype.hasOwnProperty.call(res, "uaEnabled")) {
      updates.uaEnabled = true;
    }
    if (Object.keys(updates).length) {
      chrome.storage.sync.set(updates);
    }
  });
});

// Track tabs present at browser startup so we don't auto-open viewer in restored sessions
function captureStartupTabs() {
  try {
    if (!chrome.tabs || typeof chrome.tabs.query !== "function") {
      isStartup = false;
      return;
    }
    chrome.tabs.query({}, (tabs) => {
      try {
        (tabs || []).forEach(rememberStartupTab);
      } finally {
        // mark startup phase complete once we've captured initial tabs
        isStartup = false;
      }
    });
  } catch {
    isStartup = false;
  }
}

// Defensive cleanup on browser startup: remove any lingering dynamic rules
if (
  chrome &&
  chrome.runtime &&
  chrome.runtime.onStartup &&
  typeof chrome.runtime.onStartup.addListener === "function"
) {
  chrome.runtime.onStartup.addListener(async () => {
    isStartup = true;
    try {
      const existing = await getDynamicRules();
      if (existing && existing.length) {
        const ids = existing.map((r) => r.id);
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
      }
    } catch {
      // ignore
    }
    captureStartupTabs();
    startupCaptureUntil = Date.now() + STARTUP_NEW_TAB_CAPTURE_MS;
  });
} else {
  // If onStartup isn't available, disable startup gating
  isStartup = false;
}

// Keep startupTabs up to date
if (
  chrome &&
  chrome.tabs &&
  chrome.tabs.onRemoved &&
  typeof chrome.tabs.onRemoved.addListener === "function"
) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    startupTabs.delete(tabId);
  });
}

if (
  chrome &&
  chrome.tabs &&
  chrome.tabs.onCreated &&
  typeof chrome.tabs.onCreated.addListener === "function"
) {
  chrome.tabs.onCreated.addListener((tab) => {
    if (!isDuringExtendedStartup()) return;
    rememberStartupTab(tab);
  });
}

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

// Promisified helper for reading existing dynamic rules
function getDynamicRules() {
  return new Promise((resolve) => {
    try {
      const api =
        chrome &&
        chrome.declarativeNetRequest &&
        chrome.declarativeNetRequest.getDynamicRules;
      if (typeof api === "function") {
        api(resolve);
      } else {
        resolve([]);
      }
    } catch {
      resolve([]);
    }
  });
}

// Generate a unique 31-bit positive rule id that doesn't collide with existing ids
function generateUniqueRuleId(existingIds) {
  const used = new Set(existingIds || []);
  for (let i = 0; i < 8; i += 1) {
    const buf = new Uint32Array(1);
    try {
      const g = typeof globalThis !== "undefined" ? globalThis : {};
      if (g.crypto && typeof g.crypto.getRandomValues === "function") {
        g.crypto.getRandomValues(buf);
      } else {
        buf[0] = Math.floor(Math.random() * 0x7fffffff);
      }
    } catch {
      buf[0] = Math.floor(Math.random() * 0x7fffffff);
    }
    const candidate = buf[0] & 0x7fffffff; // 31-bit positive
    if (candidate > 0 && !used.has(candidate)) return candidate;
  }
  // Fallback to linear search if random attempts somehow collide repeatedly
  let fallback = 1;
  while (used.has(fallback)) fallback += 1;
  return fallback;
}

async function applyUARuleForUrl(url, ua) {
  // Clear any stale dynamic rules first to prevent ID collisions and lingering overrides
  const existing = await getDynamicRules();
  if (existing && existing.length) {
    const ids = existing.map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  }

  const existingIds = existing ? existing.map((r) => r.id) : [];
  const ruleId = generateUniqueRuleId(existingIds);
  const rule = buildExactUrlRule(url, ua, ruleId);
  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });

  // Best-effort cleanup (service worker may be suspended before this fires; that's OK since we clear on next add).
  setTimeout(() => {
    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
  }, 5000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "APPLY_UA_RULE" && typeof msg.url === "string") {
    if (state.uaEnabled === false) {
      sendResponse({ ok: false, error: "User-Agent override disabled" });
      return true;
    }
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
function looksLikeManifestMime(mime) {
  const m = (mime || "").toLowerCase();
  if (!m) return false;
  return (
    m.includes("dash+xml") ||
    m.includes("vnd.apple.mpegurl") ||
    m.includes("x-mpegurl")
  );
}
function viewerUrlFor(u) {
  return chrome.runtime.getURL(`viewer.html?u=${encodeURIComponent(u)}`);
}

// Track tabs we've redirected to prevent loops
const redirectingTabs = new Set();
const handledDownloadIds = new Set();

// EARLY redirect (prevents most .mpd downloads)
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  try {
    if (isStartup && isDuringExtendedStartup()) return;
    if (details.frameId !== 0 || details.tabId < 0) return;
    if (isExtensionUrl(details.url)) return;
    if (shouldDeferForStartupTab(details.tabId, details)) return;

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
    if (isStartup && isDuringExtendedStartup()) return;
    if (details.frameId !== 0 || details.tabId < 0) return;
    if (isExtensionUrl(details.url)) return;
    if (shouldDeferForStartupTab(details.tabId, details)) return;

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
async function handleManifestDownload(item) {
  try {
    if (!item) return;
    const url = item.finalUrl || item.url || "";
    const mime = item.mime || "";
    if (!url && !mime) return;

    // Only skip startup gating when we know the tab is a restored startup tab within the window.
    const tabId = typeof item.tabId === "number" && item.tabId >= 0 ? item.tabId : null;
    if (isStartup && isDuringExtendedStartup()) return;
    if (tabId !== null && shouldDeferForStartupTab(tabId)) return;

    const { autoOpenViewer = true } = await getSync({ autoOpenViewer: true });
    if (!autoOpenViewer) return;

    if (!looksLikeManifestUrl(url) && !looksLikeManifestMime(mime)) return;

    // Prevent double-handling (e.g., onCreated + onDeterminingFilename)
    if (typeof item.id === "number") {
      if (handledDownloadIds.has(item.id)) return;
      handledDownloadIds.add(item.id);
      setTimeout(() => handledDownloadIds.delete(item.id), 5000);
    }

    const destination = viewerUrlFor(url || (item.filename || ""));
    const openViewer = () => {
      if (tabId !== null) {
        chrome.tabs.update(tabId, { url: destination }, () => {
          // Best-effort cleanup if the tab update fails
          if (chrome.runtime.lastError && typeof item.id === "number") {
            handledDownloadIds.delete(item.id);
          }
        });
      } else {
        chrome.tabs.create({ url: destination }, () => {
          if (chrome.runtime.lastError && typeof item.id === "number") {
            handledDownloadIds.delete(item.id);
          }
        });
      }
    };

    try {
      chrome.downloads.cancel(item.id, openViewer);
    } catch {
      openViewer();
    }
  } catch {
    // ignore
  }
}

chrome.downloads.onCreated.addListener((item) => {
  handleManifestDownload(item);
});

// Some Chrome builds surface a manifest download first via onDeterminingFilename; handle it too.
chrome.downloads.onDeterminingFilename?.addListener((item, suggest) => {
  handleManifestDownload(item);
  if (typeof suggest === "function") {
    try { suggest(); } catch { /* ignore */ }
  }
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildExactUrlRule,
    looksLikeManifestUrl,
  };
}
