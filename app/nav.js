(function initNav(){
  const links = [
    { dest: 'viewer', label: 'Manifest Inspector' },
    { dest: 'diff', label: 'Manifest Difference Viewer' },
    { dest: 'compat', label: 'Browser Compatibility Checker' },
    { dest: 'probe', label: 'Segment Timeline Viewer' },
  ];

  const page = (document.body && document.body.dataset && document.body.dataset.page) || '';
  const targets = {
    viewer: 'viewer.html',
    diff: 'diff.html',
    compat: 'compat.html',
    probe: 'probe.html'
  };

  const isExt = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function';

  function buildNav() {
    const navEl = document.createElement('nav');
    navEl.className = 'app-nav';
    navEl.setAttribute('aria-label', 'Primary navigation');

    const brand = document.createElement('span');
    brand.className = 'app-nav__brand';
    brand.textContent = 'Streaming Manifest Toolkit';
    navEl.appendChild(brand);

    const linksWrap = document.createElement('div');
    linksWrap.className = 'app-nav__links';
    links.forEach(({ dest, label }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'app-nav__btn';
      btn.dataset.dest = dest;
      btn.textContent = label;
      linksWrap.appendChild(btn);
    });
    navEl.appendChild(linksWrap);

    const themeBtn = document.createElement('button');
    themeBtn.type = 'button';
    themeBtn.id = 'toggleTheme';
    themeBtn.className = 'app-nav__btn app-nav__theme';
    themeBtn.title = 'Toggle theme';
    themeBtn.setAttribute('aria-label', 'Toggle theme');
    themeBtn.textContent = '☀️/🌙';
    navEl.appendChild(themeBtn);

    return navEl;
  }

  let nav = document.querySelector('.app-nav');
  if (!nav) {
    nav = buildNav();
    const body = document.body || document.documentElement;
    if (body && body.firstChild) body.insertBefore(nav, body.firstChild);
    else if (body) body.appendChild(nav);
  }
  if (!nav) return;

  function navigate(dest) {
    const file = targets[dest];
    if (!file) return;
    const url = isExt ? chrome.runtime.getURL(file) : file;
    try {
      window.location.href = url;
    } catch (err) {
      try { window.open(url, '_self'); } catch {}
    }
  }

  function updateNavHeight() {
    const h = nav.offsetHeight || 0;
    document.documentElement.style.setProperty('--nav-height', `${h}px`);
  }

  nav.querySelectorAll('[data-dest]').forEach((btn) => {
    if (btn.dataset.dest === page) btn.classList.add('is-active');
    btn.addEventListener('click', () => navigate(btn.dataset.dest));
  });

  updateNavHeight();
  window.addEventListener('resize', () => requestAnimationFrame(updateNavHeight));
})();
