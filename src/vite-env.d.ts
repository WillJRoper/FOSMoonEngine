/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MANIFEST_SOURCE?: 'local' | 'online';
  readonly VITE_LOCKED_SCALE_ID?: string;
}

/**
 * Module declaration for importing `.yaml` files as raw strings.
 *
 * The `?raw` query tells Vite to return the file contents as a plain string
 * rather than parsing or transforming them. This lets us use the `yaml` library
 * at runtime instead of relying on Vite's built-in YAML handling.
 *
 * Usage: `import data from './file.yaml?raw'`
 */
declare module '*.yaml?raw' {
  const content: string;

  export default content;
}

/**
 * Module declaration for importing `.yml` files as raw strings.
 *
 * Same behavior as `*.yaml?raw` — we support both extensions for flexibility.
 *
 * Usage: `import data from './file.yml?raw'`
 */
declare module '*.yml?raw' {
  const content: string;

  export default content;
}
