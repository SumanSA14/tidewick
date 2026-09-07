import '@testing-library/jest-dom/vitest'

/**
 * Test setup, shared by both environments.
 *
 * This file runs for *every* test file, including the pure ones that use the
 * node environment and have no DOM at all - so every browser global has to be
 * feature-detected rather than assumed. Reaching for `Element` unguarded here
 * takes down the terrain and command suites, which have nothing to do with the
 * DOM and no obvious reason to care.
 */

// crypto.getRandomValues backs every id in the store.
if (!globalThis.crypto?.getRandomValues) {
  const webcrypto = await import('node:crypto')
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto.webcrypto })
}

if (typeof globalThis.Element !== 'undefined') {
  // jsdom implements the layout-free parts of the DOM only, so scrollIntoView
  // is simply absent. The slash menu calls it to keep the highlighted item in
  // view, which is correct in a browser and a crash in jsdom.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {}
  }
}

if (typeof globalThis.window !== 'undefined' && !globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
