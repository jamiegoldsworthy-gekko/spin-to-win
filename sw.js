/* ============================================================
   Spin The Wheel — Offline-Capable Kiosk PWA Service Worker
   Subpath-safe (works at ./ under /spin-to-win/ on GitHub Pages or /)
   Strategies:
   - ./index.html / navigation : Network-First with timeout -> Shell Cache fallback
   - ./fonts/*                 : Precached on install + Cache-First
   - ./themes/*                : Network-First (cache: 'no-store' + timeout + JSON
                                 integrity check) with automatic pruning of deleted
                                 folder themes; offline cache fallback; preserves
                                 Firestore-synced custom theme_assets logos
   - App icons / manifest /
     Firebase SDK modules      : Precached + Cache-First
   ============================================================ */

const APP_VERSION  = 'v1.2.0';
const SHELL_CACHE  = `spin-wheel-shell-${APP_VERSION}`;
const FONTS_CACHE  = `spin-wheel-fonts-${APP_VERSION}`;
const THEMES_CACHE = `spin-wheel-themes-${APP_VERSION}`;
const VALID_CACHES = [SHELL_CACHE, FONTS_CACHE, THEMES_CACHE];

const NET_TIMEOUT_CACHED_MS = 2200;
const NET_TIMEOUT_COLD_MS   = 5000;

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
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function fetchWithTimeout(input, init = {}, timeoutMs = NET_TIMEOUT_COLD_MS) {
  if (typeof AbortController === 'undefined') {
    return fetch(input, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

/* Verify JSON integrity before writing to cache so captive portals never poison theme JSON */
async function validateAndParseJsonResponse(res, relOrPath) {
  if (!isValidAssetResponse(res, relOrPath)) return null;
  try {
    const parsed = await res.clone().json();
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch (_) {
    return null;
  }
}

async function precacheOptionalRelUrls(cache, relUrls) {
  await Promise.allSettled(
    relUrls.map(async (rel) => {
      try {
        const fullUrl = scopeUrl(rel);
        const res = await fetchWithTimeout(fullUrl, { cache: 'no-store' }, NET_TIMEOUT_COLD_MS);
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
    const idxRes = await fetchWithTimeout(idxUrl, { cache: 'no-store' }, NET_TIMEOUT_COLD_MS);
    const data = await validateAndParseJsonResponse(idxRes, './themes/index.json');
    if (!data) return;

    await themeCache.put(idxUrl, idxRes.clone());
    const ids = parseThemeIndexIds(data);
    await pruneDeletedThemesFromCache(themeCache, ids);

    await Promise.allSettled(
      ids.map(async (id) => {
        const enc = encodeURIComponent(id);
        const themeRel = `./themes/${enc}/theme.json`;
        const themeUrl = scopeUrl(themeRel);
        try {
          const tRes = await fetchWithTimeout(themeUrl, { cache: 'no-store' }, NET_TIMEOUT_COLD_MS);
          const tJson = await validateAndParseJsonResponse(tRes, themeRel);
          if (tJson) {
            await themeCache.put(themeUrl, tRes.clone());
          }
        } catch (_) {}

        for (const imgName of ['header-logo.png', 'center-logo.png']) {
          const imgRel = `./themes/${enc}/${imgName}`;
          const imgUrl = scopeUrl(imgRel);
          try {
            const existing = await themeCache.match(imgUrl, { ignoreSearch: true });
            if (existing && existing.headers.get('X-Theme-Source') === 'firestore') continue;
            const imgRes = await fetchWithTimeout(imgUrl, { cache: 'no-store' }, NET_TIMEOUT_COLD_MS);
            if (isValidAssetResponse(imgRes, imgRel)) {
              await themeCache.put(imgUrl, imgRes);
            }
          } catch (_) {}
        }
      })
    );
  } catch (_) {
    // Offline during install or index.json unavailable — preserve existing cache
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
          const res = await fetchWithTimeout(fullUrl, { cache: 'no-store' }, NET_TIMEOUT_COLD_MS);
          if (res && res.ok) await shellCache.put(fullUrl, res);
        })
      );

      await Promise.allSettled(
        FIREBASE_SDK_URLS.map(async (url) => {
          const res = await fetchWithTimeout(url, { mode: 'cors' }, NET_TIMEOUT_COLD_MS);
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
  } else if (data.type === 'FORCE_REFRESH_THEMES') {
    event.waitUntil(warmThemesCache());
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

  // 1. Firebase Modular SDK on gstatic.com -> Cache-First (with network timeout)
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(
      (async () => {
        const shellCache = await caches.open(SHELL_CACHE);
        const cached = await shellCache.match(req);
        if (cached) return cached;
        try {
          const netRes = await fetchWithTimeout(req, { mode: 'cors' }, NET_TIMEOUT_COLD_MS);
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

  // 2. Navigation / ./index.html -> Network-First with timeout -> Shell Cache fallback
  if (req.mode === 'navigate' || rel === './' || rel === './index.html') {
    event.respondWith(
      (async () => {
        const shellCache = await caches.open(SHELL_CACHE);
        const cached = (await shellCache.match(shellIndexUrl)) || (await shellCache.match(shellRootUrl));
        const timeoutMs = cached ? NET_TIMEOUT_CACHED_MS : NET_TIMEOUT_COLD_MS;
        try {
          const netRes = await fetchWithTimeout(req, { cache: 'no-store' }, timeoutMs);
          const ct = (netRes && netRes.headers.get('content-type') || '').toLowerCase();
          if (netRes && netRes.ok && ct.includes('text/html')) {
            const htmlBody = await netRes.clone().text();
            if (htmlBody.includes('id="wheel"') && htmlBody.includes('spin-wheel')) {
              await Promise.all([
                shellCache.put(shellRootUrl, netRes.clone()),
                shellCache.put(shellIndexUrl, netRes.clone())
              ]);
              return netRes;
            }
          }
        } catch (_) {
          // Offline or timed-out Wi-Fi — fall through to cache
        }
        return (
          cached ||
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
          const netRes = await fetchWithTimeout(req, {}, NET_TIMEOUT_COLD_MS);
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

  // 4. ./themes/* -> Network-First (cache: 'no-store' + timeout + JSON validation) + prune deleted;
  //    falls back to cache offline; preserves Firestore-uploaded custom theme_assets logos
  if (rel.startsWith('./themes/')) {
    event.respondWith(
      (async () => {
        const themeCache = await caches.open(THEMES_CACHE);
        const cached = await themeCache.match(canonicalUrl, { ignoreSearch: true });

        // Locally uploaded / Firestore-synced custom logos take priority online & offline
        if (cached && cached.headers.get('X-Theme-Source') === 'firestore') {
          return cached;
        }

        const timeoutMs = cached ? NET_TIMEOUT_CACHED_MS : NET_TIMEOUT_COLD_MS;
        try {
          const netRes = await fetchWithTimeout(canonicalUrl, { cache: 'no-store' }, timeoutMs);
          if (rel.endsWith('.json')) {
            const parsed = await validateAndParseJsonResponse(netRes, rel);
            if (parsed) {
              await themeCache.put(canonicalUrl, netRes.clone());
              if (rel === './themes/index.json') {
                event.waitUntil(
                  pruneDeletedThemesFromCache(themeCache, parseThemeIndexIds(parsed)).catch(() => {})
                );
              }
              return netRes;
            }
          } else if (isValidAssetResponse(netRes, rel)) {
            await themeCache.put(canonicalUrl, netRes.clone());
            return netRes;
          }

          if (netRes && netRes.status === 404) {
            if (cached && cached.headers.get('X-Theme-Source') !== 'firestore') {
              await themeCache.delete(canonicalUrl);
            }
            return netRes;
          }
        } catch (_) {
          // Offline or timed-out network — fall through to cached copy
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
      const fetchPromise = fetchWithTimeout(req, {}, NET_TIMEOUT_COLD_MS)
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
