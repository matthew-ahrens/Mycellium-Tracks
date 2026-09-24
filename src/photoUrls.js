/* Stable, cached signed URLs for the private 'photos' bucket (2026-09-24).
 *
 * Before: every app load re-signed every photo for 6 hours. A new signed
 * URL is a new URL to the browser, so nothing was ever served from cache -
 * each load re-downloaded every image. That (plus serving full originals
 * into small tiles) is what ran the Supabase egress over the free cap.
 *
 * Now: URLs are signed for 7 days and remembered in localStorage. The same
 * path keeps the same URL until it's within a day of expiring, so the
 * browser (and Supabase's CDN) can reuse the bytes it already has. Files
 * are uploaded with a 1-year cache-control, and paths never get reused
 * (every upload gets a fresh timestamped name), so long caching is safe.
 *
 * The cache is wiped on sign-out so a shared computer doesn't keep another
 * account's links around.
 */
import { supabase } from './supabaseClient';

const KEY = 'sd_signed_urls_v1';
const TTL_SEC = 7 * 24 * 3600;       // how long each signed URL is valid
const REFRESH_MS = 24 * 3600 * 1000; // re-sign once less than a day is left

let mem = null;
const readCache = () => {
    if (mem) return mem;
    try { mem = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { mem = {}; }
    return mem;
};
const writeCache = () => {
    try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* private mode / full - just won't persist */ }
};

export function clearSignedUrlCache() {
    mem = {};
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') clearSignedUrlCache();
});

/* paths -> { [path]: signedUrl }. Only paths that are missing or close to
   expiring hit the network, in one batch. Expired entries are pruned. */
export async function getSignedUrls(paths) {
    const cache = readCache();
    const now = Date.now();
    for (const [p, v] of Object.entries(cache)) if (!v || v.exp <= now) delete cache[p];

    const unique = [...new Set(paths.filter(Boolean))];
    const need = unique.filter((p) => !cache[p] || cache[p].exp - now < REFRESH_MS);
    if (need.length) {
        const { data, error } = await supabase.storage.from('photos').createSignedUrls(need, TTL_SEC);
        if (error) console.error(error);
        const exp = now + TTL_SEC * 1000;
        (data ?? []).forEach((s) => { if (s.signedUrl && s.path) cache[s.path] = { url: s.signedUrl, exp }; });
        writeCache();
    }
    const out = {};
    unique.forEach((p) => { if (cache[p]) out[p] = cache[p].url; });
    return out;
}

export async function getSignedUrl(path) {
    if (!path) return null;
    return (await getSignedUrls([path]))[path] ?? null;
}

/* One-off, uncached short link for the full-size original - only fetched
   when someone taps "Full size", so there's nothing to gain by caching. */
export async function getOriginalUrl(path) {
    const { data, error } = await supabase.storage.from('photos').createSignedUrl(path, 3600);
    if (error) { console.error(error); return null; }
    return data?.signedUrl ?? null;
}

/* Which stored file to show at each size. Older rows (before the backfill)
   only have storage_path, so everything falls back to it. */
export const thumbPathOf = (p) => p?.thumb_path || p?.display_path || p?.storage_path || null;
export const displayPathOf = (p) => p?.display_path || p?.storage_path || null;

export const CACHE_CONTROL = '31536000'; // 1 year - paths are never reused
