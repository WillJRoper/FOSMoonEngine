/**
 * URL helpers.
 *
 * Vite deployments may run under a non-root base path (e.g. GitHub Pages
 * `/engine/`). Any URL that points at `public/` assets must be prefixed by the
 * configured base path.
 */

/**
 * Prefix a public-asset path with Vite's `BASE_URL`.
 *
 * @param path - Asset path such as `assets/foo.png` or `/assets/foo.png`.
 * @returns A URL safe to use under any Vite base path.
 */
export function withBaseUrl(path: string): string {
  // If the path is already an absolute URL (http://, data:, blob:), pass
  // it through unchanged — only relative asset paths need the base prefix.
  if (
    /^[a-z]+:\/\//i.test(path) ||
    path.startsWith('data:') ||
    path.startsWith('blob:')
  ) {
    return path;
  }

  const base = import.meta.env.BASE_URL ?? '/';
  // Ensure the base ends with a trailing slash and the path doesn't start
  // with one, so concatenation always produces a clean URL.
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;

  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Append or replace a query param while preserving any hash fragment.
 */
export function withQueryParam(url: string, key: string, value: string): string {
  const hashIndex = url.indexOf('#');
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const pattern = new RegExp(`([?&])${escapeRegex(key)}=[^&#]*`);

  if (pattern.test(base)) {
    return `${base.replace(pattern, `$1${key}=${encodeURIComponent(value)}`)}${hash}`;
  }

  const separator = base.includes('?') ? '&' : '?';

  return `${base}${separator}${key}=${encodeURIComponent(value)}${hash}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
