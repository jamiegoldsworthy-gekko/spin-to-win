/* ============================================================
   Spin The Wheel — Offline-Capable Kiosk PWA Service Worker
   Strategies:
   - index.html / navigation : Network-First (offline fallback to Shell Cache)
   - /fonts/*                : Precached on install + Cache-First
   - /themes/*               : Cache-First for Firestore-synced custom logos,
                               Stale-While-Revalidate for static theme files
   - App icons / manifest /
     Firebase SDK modules    : Precached + Cache-First
   ============================================================ */

const SHELL_CACHE  = 'spin-wheel-shell-v1';
const FONTS_CACHE  = 'spin-wheel-fonts-v1';
const THEMES_CACHE = 'spin-wheel-themes-v1';
const VALID_CACHES = [SHELL_CACHE, FONTS_CACHE, THEMES_CACHE];

const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/icon.svg'
];

const FIREBASE_SDK_URLS = [
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js'
];

const FONT_PRECACHE_URLS = [
  '/fonts/ProductSans-Regular.ttf',
  '/fonts/ProductSans-Italic.ttf',
  '/fonts/ProductSans-Bold.ttf',
  '/fonts/ProductSans-BoldItalic.ttf',
  '/fonts/ProductSans-Medium.ttf',
  '/fonts/ProductSans-MediumItalic.ttf',
  '/fonts/ProductSans-Black.ttf',
  '/fonts/ProductSans-BlackItalic.ttf',
  '/fonts/ProductSans-Light.ttf',
  '/fonts/ProductSans-LightItalic.ttf',
  '/fonts/ProductSans-Thin.ttf',
  '/fonts/ProductSans-ThinItalic.ttf'
];

function isValidAssetResponse(res, pathname) {
  if (!res || !res.ok || res.status !== 200) return false;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) return false;
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(pathname)) {
    return ct.startsWith('image/') || ct === 'application/octet-stream';
  }
  return true;
}

async function precacheOptionalUrls(cache, urls) {
  await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        const pathname = new URL(url, self.location.origin).pathname;
        if (isValidAssetResponse(res, pathname)) {
          await cache.put(url, res);
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
    const idxRes = await fetch('/themes/index.json', { cache: 'no-cache' });
    if (!isValidAssetResponse(idxRes, '/themes/index.json')) return;
    const idxClone = idxRes.clone();
    await themeCache.put('/themes/index.json', idxClone);

    const data = await idxRes.json();
    const ids = Array.isArray(data) ? data : (data && Array.isArray(data.themes) ? data.themes : []);

    const assetUrls = [];
    for (const id of ids) {
      if (!id || typeof id !== 'string') continue;
      assetUrls.push(`/themes/${id}/theme.json`);
      assetUrls.push(`/themes/${id}/header-logo.png`);
      assetUrls.push(`/themes/${id}/center-logo.png`);
    }

    await Promise.allSettled(
      assetUrls.map(async (pathname) => {
        // Never overwrite custom logos synced from Firestore
        const existing = await themeCache.match(pathname, { ignoreSearch: true });
        if (existing && existing.headers.get('X-Theme-Source') === 'firestore') return;
        const res = await fetch(pathname, { cache: 'no-cache' });
        if (isValidAssetResponse(res, pathname)) {
          await themeCache.put(pathname, res);
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

      // Precache core app shell
      await Promise.allSettled(
        SHELL_URLS.map(async (url) => {
          const res = await fetch(url, { cache: 'no-cache' });
          if (res && res.ok) await shellCache.put(url, res);
        })
      );

      // Precache Firebase modular SDK for 100% offline boot
      await Promise.allSettled(
        FIREBASE_SDK_URLS.map(async (url) => {
          const res = await fetch(url, { mode: 'cors' });
          if (res && res.ok) await shellCache.put(url, res);
        })
      );

      // Precache dropped /fonts/*.ttf files & /themes/* folders
      await Promise.all([
        precacheOptionalUrls(fontCache, FONT_PRECACHE_URLS),
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
          precacheOptionalUrls(fontCache, FONT_PRECACHE_URLS),
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
    url.hostname.includes('google.com') && !url.hostname.includes('gstatic.com')
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

  // Only handle same-origin requests below
  if (url.origin !== self.location.origin) return;

  // 2. Navigation / index.html -> Network-First (with Shell Cache offline fallback)
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      (async () => {
        const shellCache = await caches.open(SHELL_CACHE);
        try {
          const netRes = await fetch(req);
          if (netRes && netRes.ok) {
            await Promise.all([
              shellCache.put('/', netRes.clone()),
              shellCache.put('/index.html', netRes.clone())
            ]);
            return netRes;
          }
        } catch (_) {
          // Offline — fall through to cache
        }
        return (
          (await shellCache.match('/index.html')) ||
          (await shellCache.match('/')) ||
          new Response('Offline — please reconnect once to cache Spin The Wheel.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          })
        );
      })()
    );
    return;
  }

  // 3. /fonts/* -> Cache-First (stores newly dropped .ttf files on first hit)
  if (url.pathname.startsWith('/fonts/')) {
    event.respondWith(
      (async () => {
        const fontCache = await caches.open(FONTS_CACHE);
        const cached = await fontCache.match(url.pathname, { ignoreSearch: true });
        if (cached) return cached;
        try {
          const netRes = await fetch(req);
          if (isValidAssetResponse(netRes, url.pathname)) {
            await fontCache.put(url.pathname, netRes.clone());
          }
          return netRes;
        } catch (_) {
          return new Response('', { status: 404, statusText: 'Font Not Cached' });
        }
      })()
    );
    return;
  }

  // 4. /themes/* -> Cache-First for Firestore-synced logos; Stale-While-Revalidate for static theme files
  if (url.pathname.startsWith('/themes/')) {
    event.respondWith(
      (async () => {
        const themeCache = await caches.open(THEMES_CACHE);
        const cached = await themeCache.match(url.pathname, { ignoreSearch: true });

        // Custom logos synced via Firestore & written into SW cache take priority offline & online
        if (cached && cached.headers.get('X-Theme-Source') === 'firestore') {
          return cached;
        }

        const networkFetch = (async () => {
          try {
            const netRes = await fetch(url.pathname, { cache: 'no-cache' });
            if (isValidAssetResponse(netRes, url.pathname)) {
              const latestCached = await themeCache.match(url.pathname, { ignoreSearch: true });
              if (!latestCached || latestCached.headers.get('X-Theme-Source') !== 'firestore') {
                await themeCache.put(url.pathname, netRes.clone());
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
      const cached = await shellCache.match(url.pathname, { ignoreSearch: true });
      const fetchPromise = fetch(req)
        .then((netRes) => {
          if (netRes && netRes.ok) {
            shellCache.put(url.pathname, netRes.clone());
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
