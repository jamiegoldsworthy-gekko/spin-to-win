/* ============================================================
   Spin The Wheel — Offline-Capable Kiosk PWA Service Worker
   Subpath-safe (works at ./ under /spin-to-win/ on GitHub Pages or /)
   Strategies:
   - ./index.html / navigation : Network-First (offline fallback to Shell Cache)
   - ./fonts/*                 : Precached on install + Cache-First
   - ./themes/*                : Network-First (cache: 'no-store') when online with
                                 automatic pruning of deleted folder themes when
                                 ./themes/index.json refreshes; offline cache fallback;
                                 preserves Firestore-synced custom theme_assets logos
   - App icons / manifest /
     Firebase SDK modules      : Precached + Cache-First
   ============================================================ */

const APP_VERSION  = 'v1.1.0';
const SHELL_CACHE  = `spin-wheel-shell-${APP_VERSION}`;
const FONTS_CACHE  = `spin-wheel-fonts-${APP_VERSION}`;
const THEMES_CACHE = `spin-wheel-themes-${APP_VERSION}`;
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

function parseThemeIndexIds(data) {
  const rawList = Array.isArray(data)
    ? data
    : (data && Array.isArray(data.themes) ? data.themes : []);
  const ids = [];
  for (const item of rawList) {
    const id = (typeof item === 'string')
      ? item.trim()
      : (item && typeof item === 'object' && typeof item.id === 'string' ? item.id.trim() : '');
    if (id) ids.push(id);
  }
  return ids;
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
        const res = await fetch(fullUrl, { cache: 'no-store' });
        if (isValidAssetResponse(res, rel)) {
          await cache.put(fullUrl, res);
        }
      } catch (_) {
        // Ignore missing optional manual-drop files or offline install
      }
    })
  );
}

/* Purge cached ./themes/<old_id>/* entries removed from ./themes/index.json
   while preserving Firestore-synced custom theme_assets logos */
async function pruneDeletedThemesFromCache(themeCache, activeIds) {
  const activeSet = new Set(activeIds);
  const cachedRequests = await themeCache.keys();
  await Promise.allSettled(
    cachedRequests.map(async (cachedReq) => {
      const rel = relFromScope(cachedReq.url);
      if (!rel || !rel.startsWith('./themes/') || rel === './themes/index.json') return;

      // Match ./themes/<folderId>/<file>
      const rest = rel.slice('./themes/'.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx <= 0) return;
      const folderId = decodeURIComponent(rest.slice(0, slashIdx));

      // Preserve active custom theme IDs and Firestore-uploaded logos
      if (folderId.startsWith('custom_')) return;
      const cachedRes = await themeCache.match(cachedReq);
      if (cachedRes && cachedRes.headers.get('X-Theme-Source') === 'firestore') return;

      if (!activeSet.has(folderId)) {
        await themeCache.delete(cachedReq);
      }
    })
  );
}

async function warmThemesCache() {
  const themeCache = await caches.open(THEMES_CACHE);
  try {
    const idxUrl = scopeUrl('./themes/index.json');
    const idxRes = await fetch(idxUrl, { cache: 'no-store' });
    if (!isValidAssetResponse(idxRes, './themes/index.json')) return;
    await themeCache.put(idxUrl, idxRes.clone());

    const data = await idxRes.json();
    const ids = parseThemeIndexIds(data);
    await pruneDeletedThemesFromCache(themeCache, ids);

    const relAssets = [];
    for (const id of ids) {
      const enc = encodeURIComponent(id);
      relAssets.push(`./themes/${enc}/theme.json`);
      relAssets.push(`./themes/${enc}/header-logo.png`);
      relAssets.push(`./themes/${enc}/center-logo.png`);
      relAssets.push(`./themes/${enc}/centre-logo.png`);
    }

    await Promise.allSettled(
      relAssets.map(async (rel) => {
        const fullUrl = scopeUrl(rel);
        const existing = await themeCache.match(fullUrl, { ignoreSearch: true });
        if (existing && existing.headers.get('X-Theme-Source') === 'firestore') return;
        const res = await fetch(fullUrl, { cache: 'no-store' });
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

      await Promise.allSettled(
        SHELL_REL_URLS.map(async (rel) => {
          const fullUrl = scopeUrl(rel);
          const res = await fetch(fullUrl, { cache: 'no-store' });
          if (res && res.ok) await shellCache.put(fullUrl, res);
        })
      );

      await Promise.allSettled(
        FIREBASE_SDK_URLS.map(async (url) => {
          const res = await fetch(url, { mode: 'cors' });
          if (res && res.ok) await shellCache.put(url, res);
        })
      );

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
          const netRes = await fetch(req, { cache: 'no-store' });
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

  // 4. ./themes/* -> Network-First (cache: 'no-store') when online + prune deleted themes;
  //    falls back to cache when offline; preserves Firestore-uploaded custom theme_assets logos
  if (rel.startsWith('./themes/')) {
    event.respondWith(
      (async () => {
        const themeCache = await caches.open(THEMES_CACHE);
        const cached = await themeCache.match(canonicalUrl, { ignoreSearch: true });

        // Locally uploaded / Firestore-synced custom logos take priority online & offline
        if (cached && cached.headers.get('X-Theme-Source') === 'firestore') {
          return cached;
        }

        try {
          const netRes = await fetch(canonicalUrl, { cache: 'no-store' });
          if (isValidAssetResponse(netRes, rel)) {
            await themeCache.put(canonicalUrl, netRes.clone());
            if (rel === './themes/index.json') {
              const idxClone = netRes.clone();
              event.waitUntil(
                idxClone
                  .json()
                  .then((data) => pruneDeletedThemesFromCache(themeCache, parseThemeIndexIds(data)))
                  .catch(() => {})
              );
            }
            return netRes;
          }
          if (netRes && netRes.status === 404) {
            // If static asset was removed on GitHub, remove stale non-firestore cache entry
            if (cached && cached.headers.get('X-Theme-Source') !== 'firestore') {
              await themeCache.delete(canonicalUrl);
            }
            return netRes;
          }
        } catch (_) {
          // Offline — fall through to cached response below
        }

        return cached || new Response('', { status: 404, statusText: 'Theme Asset Not Available Offline' });
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
