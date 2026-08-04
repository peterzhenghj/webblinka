/**
 * WebAssembly JavaScript Promise Integration reached Stage 4 in 2025 and ships
 * unflagged in Chrome 137+, but TypeScript's lib.dom still has no declaration
 * for it. We only ever feature-detect it -- Pyodide is what actually uses it.
 */
declare namespace WebAssembly {
  const Suspending: (new <T extends (...args: never[]) => unknown>(fn: T) => unknown) | undefined;
}
