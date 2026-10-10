const JSPI = 'yt-dlp-wasm needs JavaScript Promise Integration';

// Turns an error from the library into plain words and a next step.
export function explain(error, { usingDemoProxy, hasCookies = false }) {
  const raw = String(error?.message ?? error)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/^ERROR:\s*/, '')
    .trim();
  const proxy = usingDemoProxy ? 'the demo proxy' : 'your proxy';

  if (raw.startsWith(JSPI)) return { title: 'This browser is not supported', detail: raw };
  if (/CORS proxy error 429/.test(raw)) {
    return { title: 'The proxy is rate limited right now', detail: 'Wait a minute and try again, or use a custom proxy.' };
  }
  if (/CORS proxy error 403.*access key/i.test(raw)) {
    return { title: 'The proxy refused the access key', detail: 'Check the key in the proxy settings.' };
  }
  if (/CORS proxy error 403/.test(raw)) {
    return { title: 'The proxy does not allow this site', detail: 'Use a custom proxy, and add this site to its allowed origins.' };
  }
  if (/Failed to fetch|NetworkError|Load failed/.test(raw)) {
    return { title: `Could not reach ${proxy}`, detail: 'Check your connection and the proxy URL. A proxy that does not allow this site fails the same way.' };
  }
  if (/sign in to confirm|not a bot/i.test(raw)) {
    return {
      title: 'The site asked for a bot check',
      detail: hasCookies
        ? `It still flags the shared addresses ${proxy} fetches from. Export fresh cookies from a signed-in browser, or try again in a minute.`
        : `It flags the shared addresses ${proxy} fetches from on some requests. Try again in a minute, or load a cookies file from a signed-in account in the Cookies settings.`,
    };
  }
  if (/does not look like a Netscape format cookies file/.test(raw)) {
    return { title: 'That is not a cookies.txt file', detail: 'Export the cookies again in the Netscape cookies.txt format, or clear them in the Cookies settings.' };
  }
  if (/HTTP Error 429/.test(raw)) {
    return { title: 'The site is rate limiting the proxy', detail: `It limits the shared addresses ${proxy} fetches from. Try again in a minute.` };
  }
  if (/out of memory|RangeError|worker failed|allocation/i.test(raw)) {
    return { title: 'The browser ran out of memory', detail: 'This video is too large for this device. Try audio only.' };
  }
  if (/HTTP Error 404/.test(raw)) return { title: 'That page or file was not found', detail: raw };
  if (/Unsupported URL/.test(raw)) return { title: 'This link is not supported', detail: raw };
  return { title: 'The download failed', detail: raw };
}
