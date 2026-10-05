// Outside every directory the library mounts or returns, so the file stays in Pyodide's memory
export const COOKIES_PATH = '/yt-dlp-wasm/cookies.txt';

export function assertCookies(cookies) {
  if (cookies != null && typeof cookies !== 'string') {
    throw new TypeError('cookies must be the text of a Netscape cookies.txt file');
  }
}
