import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explain } from '../src/explain.js';

const BOT = new Error('ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser');

test('the bot check suggests loading cookies when none are loaded', () => {
  const { title, detail } = explain(BOT, { usingDemoProxy: true });
  assert.equal(title, 'The site asked for a bot check');
  assert.match(detail, /shared addresses the demo proxy/);
  assert.match(detail, /load a cookies file/);
});

test('the bot check suggests fresh cookies when some are loaded', () => {
  const { detail } = explain(BOT, { usingDemoProxy: false, hasCookies: true });
  assert.match(detail, /the addresses your proxy fetches from/);
  assert.doesNotMatch(detail, /shared/);
  assert.match(detail, /fresh cookies/);
});

test('proxy refusals only suggest a custom proxy to demo proxy users', () => {
  for (const status of ['429: Rate limit exceeded', '403: Origin not allowed']) {
    const error = new Error(`ERROR: CORS proxy error ${status}`);
    assert.match(explain(error, { usingDemoProxy: true }).detail, /use a custom proxy/i);
    assert.doesNotMatch(explain(error, { usingDemoProxy: false }).detail, /custom proxy/);
  }
});

test('a bad cookies file gets its own message', () => {
  const error = new Error("ERROR: '/.yt-dlp-wasm/cookies.txt' does not look like a Netscape format cookies file");
  assert.equal(explain(error, { usingDemoProxy: true }).title, 'That is not a cookies.txt file');
});
