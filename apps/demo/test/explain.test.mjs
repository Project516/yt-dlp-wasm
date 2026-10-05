import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explain } from '../src/explain.js';

const BOT = new Error('ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser');

test('the bot check suggests loading cookies when none are loaded', () => {
  const { title, detail } = explain(BOT, { usingDemoProxy: true });
  assert.equal(title, 'The site asked for a bot check');
  assert.match(detail, /the demo proxy/);
  assert.match(detail, /load a cookies file/);
});

test('the bot check suggests fresh cookies when some are loaded', () => {
  const { detail } = explain(BOT, { usingDemoProxy: false, hasCookies: true });
  assert.match(detail, /your proxy/);
  assert.match(detail, /fresh cookies/);
});

test('a bad cookies file gets its own message', () => {
  const error = new Error("ERROR: '/yt-dlp-wasm/cookies.txt' does not look like a Netscape format cookies file");
  assert.equal(explain(error, { usingDemoProxy: true }).title, 'That is not a cookies.txt file');
});
