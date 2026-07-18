// Localizes brand-site-images bucket URLs into build-output assets.
// getImage() downloads each remote image once at build time, optimizes it,
// and emits it under /_astro/ — so the deployed site never requests
// *.supabase.co (acceptance criterion, scope §5.3) while the bucket remains
// the single source of truth for what images exist.

import { getImage } from 'astro:assets';
import { getImagesByAsin } from './supabase.js';

const singleCache = new Map();

// Storage/Cloudflare occasionally drops one of the build's many concurrent
// dimension probes (FailedToFetchRemoteImageDimensions), failing an otherwise
// healthy build. Retry before giving up.
async function getImageWithRetry(options, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getImage(options);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

/** Full public URL for a path inside the brand-site-images bucket. */
export function bucketUrl(path) {
  return `${import.meta.env.SUPABASE_URL}/storage/v1/object/public/brand-site-images/${path}`;
}

/** Local optimized path for a bucket-relative path (logo, hero, tiles). */
export function localBucketImage(path, width = 800, format = 'webp') {
  return localImage(bucketUrl(path), width, format);
}

/** Local optimized path for one bucket URL (e.g. the brand logo).
    `format` stays webp for page imagery; favicons/touch icons pass 'png'
    (Safari/iOS don't reliably accept webp icons). */
export async function localImage(remoteUrl, width = 800, format = 'webp') {
  const key = `${remoteUrl}#${width}#${format}`;
  if (!singleCache.has(key)) {
    singleCache.set(
      key,
      getImageWithRetry({ src: remoteUrl, inferSize: true, width, format }).then((img) => img.src)
    );
  }
  return singleCache.get(key);
}

let localMapPromise;

/** Map<asin, string[]> of build-local image paths, ordered by position. */
export function getLocalImagesByAsin() {
  localMapPromise ??= getImagesByAsin().then(async (remoteMap) => {
    const map = new Map();
    for (const [asin, urls] of remoteMap) {
      map.set(asin, await Promise.all(urls.map((u) => localImage(u))));
    }
    return map;
  });
  return localMapPromise;
}
