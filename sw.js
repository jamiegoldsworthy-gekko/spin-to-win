/* ============================================================
   Spin The Wheel — Offline-Capable Kiosk PWA Service Worker
   Subpath-safe (works at ./ under /spin-to-win/ on GitHub Pages or /)
   Strategies:
   - ./index.html / navigation : Network-First (offline fallback to Shell Cache)
   - ./fonts/*                 : Precached on install + Cache-First
   - ./themes/*                : Cache-First for Firestore-synced custom logos,
                                 Stale-While-Revalidate for static theme files
   - App icons / manifest /
     Firebase SDK modules      : Precached + Cache-First
   ============================================================ */

const SHELL_CACHE  = 'spin-wheel-shell-v2';
const FONTS_CACHE  = 'spin-wheel-fonts-v2';
const THEMES_CACHE = 'spin-wheel-themes-v2';
const VALID_CACHES = [SHELL_CACHE, FONTS_CACHE, THEMES_CACHE];

function getScopeBase() {
  return (self.registration && self.registration.scope)
    ? self.registration.scope
    : new URL('./', self.location.href).href;
}

function scopeUrl(relPath) {
  return new URL(relPath, getScopeBase()).href;
}

function relFromScope(reqUrlStr) {
  const base = new URL(getScopeBase());
  const u = new URL(reqUrlStr);
  if (u.origin !== base.origin) return null;
  const scopePath = base.pathname.endsWith('/') ? base.pathname : (base.pathname + '/');
  if (u.pathname === scopePath || u.pathname === scopePath.slice(0, -1)) {
    return './';
  }
  if (u.pathname.startsWith(scopePath)) {
    return './' + u.pathname.slice(scopePath.length);
  }
  return null;
}

const SHELL_REL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon.svg'
];

const FIREBASE_SDK_URLS = [
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js'
];

const FONT_PRECACHE_REL_URLS = [
  './fonts/ProductSans-Regular.ttf',
  './fonts/ProductSans-Italic.ttf',
  './fonts/ProductSans-Bold.ttf',
  './fonts/ProductSans-BoldItalic.ttf',
  './fonts/ProductSans-Medium.ttf',
  './fonts/ProductSans-MediumItalic.ttf',
  './fonts/ProductSans-Black.ttf',
  './fonts/ProductSans-BlackItalic.ttf',
  './fonts/ProductSans-Light.ttf',
  './fonts/ProductSans-LightItalic.ttf',
  './fonts/ProductSans-Thin.ttf',
  './fonts/ProductSans-ThinItalic.ttf'
];

function isValidAssetResponse(res, relOrPath) {
  if (!res || !res.ok || res.status !== 200) return false;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) return false;
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(relOrPath)) {
    return ct.startsWith('image/') || ct === 'application/octet-stream';
  }
  return true;
}

async function precacheOptionalRelUrls(cache, relUrls) {
  await Promise.allSettled(
    relUrls.map(async (rel) => {
      try {
        const fullUrl = scopeUrl(rel);
        const res = await fetch(fullUrl, { cache: 'no-cache' });
        if (isValidAssetResponse(res, rel)) {
          await cache.put(fullUrl, res);
        }
      } catch (_) {
        // Ignore missing optional manual-drop files or offline install
      }
    })
  );
}

async function warmThemesCache() {
  const themeCache = await caches.open(THEMES_CACHE);
  try {
    const idxUrl = scopeUrl('./themes/index.json');
    const idxRes = await fetch(idxUrl, { cache: 'no-cache' });
    if (!isValidAssetResponse(idxRes, './themes/index.json')) return;
    await themeCache.put(idxUrl, idxRes.clone());

    const data = await idxRes.json();
    const ids = Array.isArray(data) ? data : (data && Array.isArray(data.themes) ? data.themes : []);

    const relAssets = [];
    for (const id of ids) {
      if (!id || typeof id !== 'string') continue;
      relAssets.push(`./themes/${id}/theme.json`);
      relAssets.push(`./themes/${id}/header-logo.png`);
      relAssets.push(`./themes/${id}/center-logo.png`);
    }

    await Promise.allSettled(
      relAssets.map(async (rel) => {
        const fullUrl = scopeUrl(rel);
        // Never overwrite custom logos synced from Firestore
        const existing = await themeCache.match(fullUrl, { ignoreSearch: true });
        if (existing && existing.headers.get('X-Theme-Source') === 'firestore') return;
        const res = await fetch(fullUrl, { cache: 'no-cache' });
        if (isValidAssetResponse(res, rel)) {
          await themeCache.put(fullUrl, res);
        }
      })
    );
  } catch (_) {
    // Offline during install or index.json unavailable
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const [shellCache, fontCache] = await Promise.all([
        caches.open(SHELL_CACHE),
        caches.open(FONTS_CACHE)
      ]);

      // Precache core app shell using subpath-resolved URLs
      await Promise.allSettled(
        SHELL_REL_URLS.map(async (rel) => {
          const fullUrl = scopeUrl(rel);
          const res = await fetch(fullUrl, { cache: 'no-cache' });
          if (res && res.ok) await shellCache.put(fullUrl, res);
        })
      );

      // Precache Firebase modular SDK for 100% offline boot
      await Promise.allSettled(
        FIREBASE_SDK_URLS.map(async (url) => {
          const res = await fetch(url, { mode: 'cors' });
          if (res && res.ok) await shellCache.put(url, res);
        })
      );

      // Precache dropped ./fonts/*.ttf files & ./themes/* folders
      await Promise.all([
        precacheOptionalRelUrls(fontCache, FONT_PRECACHE_REL_URLS),
        warmThemesCache()
      ]);

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (!VALID_CACHES.includes(key)) {
            return caches.delete(key);
          }
        })
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'WARM_ASSETS') {
    event.waitUntil(
      (async () => {
        const fontCache = await caches.open(FONTS_CACHE);
        await Promise.all([
          precacheOptionalRelUrls(fontCache, FONT_PRECACHE_REL_URLS),
          warmThemesCache()
        ]);
      })()
    );
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Let Firestore / Auth API traffic bypass the Service Worker directly
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    (url.hostname.includes('google.com') && !url.hostname.includes('gstatic.com'))
  ) {
    return;
  }

  // 1. Firebase Modular SDK on gstatic.com -> Cache-First
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(
      (async () => {
        const shellCache = await caches.open(SHELL_CACHE);
        const cached = await shellCache.match(req);
        if (cached) return cached;
        try {
          const netRes = await fetch(req, { mode: 'cors' });
          if (netRes && netRes.ok) {
            await shellCache.put(req, netRes.clone());
          }
          return netRes;
        } catch (_) {
          return new Response('// Offline fallback', {
            status: 503,
            headers: { 'Content-Type': 'text/javascript' }
          });
        }
      })()
    );
    return;
  }

  const rel = relFromScope(req.url);
  if (!rel) return;

  const canonicalUrl = scopeUrl(rel);
  const shellIndexUrl = scopeUrl('./index.html');
  const shellRootUrl = scopeUrl('./');

  // 2. Navigation / ./index.html -> Network-First (with Shell Cache offline fallback)
  if (req.mode === 'navigate' || rel === './' || rel === './index.html') {
    event.respondWith(
      (async () => {
        const shellCache = await caches.open(SHELL_CACHE);
        try {
          const netRes = await fetch(req);
          if (netRes && netRes.ok) {
            await Promise.all([
              shellCache.put(shellRootUrl, netRes.clone()),
              shellCache.put(shellIndexUrl, netRes.clone())
            ]);
            return netRes;
          }
        } catch (_) {
          // Offline — fall through to cache
        }
        return (
          (await shellCache.match(shellIndexUrl)) ||
          (await shellCache.match(shellRootUrl)) ||
          new Response('Offline — please reconnect once to cache Spin The Wheel.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          })
        );
      })()
    );
    return;
  }

  // 3. ./fonts/* -> Cache-First (stores newly dropped .ttf files on first hit)
  if (rel.startsWith('./fonts/')) {
    event.respondWith(
      (async () => {
        const fontCache = await caches.open(FONTS_CACHE);
        const cached = await fontCache.match(canonicalUrl, { ignoreSearch: true });
        if (cached) return cached;
        try {
          const netRes = await fetch(req);
          if (isValidAssetResponse(netRes, rel)) {
            await fontCache.put(canonicalUrl, netRes.clone());
          }
          return netRes;
        } catch (_) {
          return new Response('', { status: 404, statusText: 'Font Not Cached' });
        }
      })()
    );
    return;
  }

  // 4. ./themes/* -> Cache-First for Firestore-synced logos; Stale-While-Revalidate for static theme files
  if (rel.startsWith('./themes/')) {
    event.respondWith(
      (async () => {
        const themeCache = await caches.open(THEMES_CACHE);
        const cached = await themeCache.match(canonicalUrl, { ignoreSearch: true });

        // Custom logos synced via Firestore & written into SW cache take priority offline & online
        if (cached && cached.headers.get('X-Theme-Source') === 'firestore') {
          return cached;
        }

        const networkFetch = (async () => {
          try {
            const netRes = await fetch(canonicalUrl, { cache: 'no-cache' });
            if (isValidAssetResponse(netRes, rel)) {
              const latestCached = await themeCache.match(canonicalUrl, { ignoreSearch: true });
              if (!latestCached || latestCached.headers.get('X-Theme-Source') !== 'firestore') {
                await themeCache.put(canonicalUrl, netRes.clone());
              }
            }
            return netRes;
          } catch (_) {
            return null;
          }
        })();

        if (cached) {
          event.waitUntil(networkFetch);
          return cached;
        }

        const fresh = await networkFetch;
        return fresh || new Response('', { status: 404, statusText: 'Theme Asset Not Available Offline' });
      })()
    );
    return;
  }

  // 5. Manifest, icons, and any other local static assets -> Stale-While-Revalidate
  event.respondWith(
    (async () => {
      const shellCache = await caches.open(SHELL_CACHE);
      const cached = await shellCache.match(canonicalUrl, { ignoreSearch: true });
      const fetchPromise = fetch(req)
        .then((netRes) => {
          if (netRes && netRes.ok) {
            shellCache.put(canonicalUrl, netRes.clone());
          }
          return netRes;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(fetchPromise);
        return cached;
      }
      return (await fetchPromise) || new Response('', { status: 404 });
    })()
  );
});
