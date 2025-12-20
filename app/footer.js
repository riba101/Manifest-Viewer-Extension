function renderFooter(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="footer-content">
      <small class="footer-meta">
        <span>Made for the community with ❤️</span>
        <span class="version-sep version-sep-before" style="margin: 0 5px;">|</span>
        <span id="version-section">Version: <span id="viewer-version"></span></span>
        <span class="version-sep version-sep-after" style="margin: 0 5px;">|</span>
        <a
          href="https://github.com/riba101/Manifest-Viewer-Extension"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub repository"
          style="color: #fff; text-decoration: none; display: inline-flex; align-items: center;"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          width="22"
          height="22"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.001 8.001 0 0016 8c0-4.42-3.58-8-8-8z"
            ></path>
          </svg>
        </a>
      </small>
    </div>
  `;
}

      // <div class="supporters">
      //   <span class="supporters__label">Supported by</span>
      //   <a
      //     class="supporters__logo"
      //     href="https://example.com"
      //     target="_blank"
      //     rel="noopener noreferrer"
      //     aria-label="example.com"
      //   >
      //     <img src="supporters/logos/example.svg" alt="Example.com logo" />
      //   </a>
      // </div>

function addHostedLink(root) {
  const footerText = root.querySelector('.footer-meta') || root;
  if (!footerText) return;

  const createStoreIcon = (type) => {
    if (type === 'chrome') {
      return `<img src="https://developer.chrome.com/static/docs/webstore/branding/image/UV4C4ybeBTsZt43U4xis.png" alt="" aria-hidden="true" style="height: 22px; width: auto;" loading="lazy" />`;
    }
    if (type === 'firefox') {
      return `<img src="https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg" alt="" aria-hidden="true" style="height: 22px; width: auto;" loading="lazy" />`;
    }
    return '';
  };

  const isExtension = (() => {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.getManifest === 'function';
    } catch {
      return false;
    }
  })();

  const addSeparator = () => {
    const sep = document.createElement('span');
    sep.textContent = ' | ';
    sep.style.margin = '0 5px';
    footerText.appendChild(sep);
  };

  const createLink = (id, href, label, iconType, showLabel = true) => {
    const link = document.createElement('a');
    link.id = id;
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const icon = iconType ? createStoreIcon(iconType) : '';
    const visibleLabel = showLabel ? label : '';
    if (icon) {
      link.innerHTML = `${icon}${visibleLabel}`;
      link.style.display = 'inline-flex';
      link.style.alignItems = 'center';
    } else {
      link.textContent = visibleLabel;
    }
    link.setAttribute('aria-label', label);
    link.style.color = 'inherit';
    link.style.textDecoration = 'none';
    return link;
  };

  if (isExtension) {
    if (document.getElementById('hosted-link')) return;
    addSeparator();
    footerText.appendChild(createLink('hosted-link', 'https://123-test.stream', 'Open web app'));
    return;
  }

  if (document.getElementById('chrome-store-link') || document.getElementById('firefox-store-link')) return;

  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const ua = (nav && nav.userAgent) || '';
  const isFirefox = /firefox/i.test(ua);
  const isChromiumBrand = (() => {
    const data = nav && nav.userAgentData;
    if (data && Array.isArray(data.brands)) {
      return data.brands.some((b) => /chromium|chrome|edge/i.test(b.brand));
    }
    return /chrome|crios|chromium|edg/i.test(ua);
  })();

  let storeLink;
  if (isFirefox) {
    storeLink = {
      id: 'firefox-store-link',
      href: 'https://addons.mozilla.org/en-US/firefox/addon/manifest-viewer-dash-hls',
      label: 'Firefox Add-ons',
      icon: 'firefox',
    };
  } else if (isChromiumBrand) {
    storeLink = {
      id: 'chrome-store-link',
      href: 'https://chromewebstore.google.com/detail/manifest-viewer-dashhls/dbjifeanbhpnpjplnljacblipoobgccl',
      label: 'Chrome Web Store',
      icon: 'chrome',
    };
  }

  if (!storeLink) return;

  addSeparator();
  footerText.appendChild(createLink(storeLink.id, storeLink.href, storeLink.label, storeLink.icon, false));
}

function setFooterVersion() {
  const versionEl = document.getElementById('viewer-version');
  const versionSection = document.getElementById('version-section');
  const sepBefore = Array.from(document.querySelectorAll('.version-sep-before'));
  const sepAfter = Array.from(document.querySelectorAll('.version-sep-after'));
  const githubLink = document.querySelector('footer a[aria-label="GitHub repository"]');
  if (!versionEl) return;
  const hide = () => {
    if (versionSection) versionSection.style.display = 'none';
    sepBefore.forEach((s) => { s.style.display = 'none'; });
    if (sepAfter.length) {
      sepAfter.forEach((s) => { s.style.display = ''; });
    } else if (githubLink && githubLink.parentElement) {
      // ensure a single separator exists before the GitHub link
      const sep = document.createElement('span');
      sep.className = 'version-sep version-sep-after';
      sep.textContent = '|';
      sep.style.margin = '0 5px';
      githubLink.parentElement.insertBefore(sep, githubLink);
    }
  };
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
      const manifest = chrome.runtime.getManifest();
      const v = manifest && typeof manifest.version === 'string' ? manifest.version.trim() : '';
      if (v) {
        versionEl.textContent = v;
        if (versionSection) versionSection.style.display = '';
        sepBefore.forEach((s) => { s.style.display = ''; });
        sepAfter.forEach((s) => { s.style.display = ''; });
      } else {
        hide();
      }
    } else {
      hide();
    }
  } catch {
    hide();
  }
}

function initFooter() {
  const el = document.getElementById('app-footer');
  if (el) renderFooter(el);
  setFooterVersion();
  if (el) addHostedLink(el);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFooter);
} else {
  initFooter();
}
