export const JSPI_MESSAGE = 'yt-dlp-wasm needs JavaScript Promise Integration (JSPI), which this runtime does not '
  + 'support. Use Chrome 137 or later, Firefox 153 or later, Safari 27 or later, or Node.js 25 or later.';

export function hasJspi() {
  return typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
}

export function assertJspi() {
  if (!hasJspi()) throw new Error(JSPI_MESSAGE);
}
