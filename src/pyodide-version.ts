/**
 * Kept in lockstep with the `pyodide` devDependency in package.json: the Node
 * test suite loads that copy from node_modules while the browser loads the same
 * version from the CDN, so a mismatch would mean tests and site run different
 * Pythons. Pyodide's runtime is ~10MB, which is why it is fetched rather than
 * committed; only our own ~1.4MB of wheels live in the repo.
 */
export const PYODIDE_VERSION = "314.0.3";

export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
