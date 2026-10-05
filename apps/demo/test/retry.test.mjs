import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagged, retryFlagged } from '../src/retry.js';

const BOT = new Error('ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser');

function failing(errors, value = 'info') {
  let calls = 0;
  const fn = async () => {
    const error = errors[calls++];
    if (error) throw error;
    return value;
  };
  fn.calls = () => calls;
  return fn;
}

test('flagged matches the bot check and a 429 from the site, not from the proxy', () => {
  assert.ok(flagged(BOT));
  assert.ok(flagged(new Error('ERROR: [youtube] abc: Unable to download webpage: HTTP Error 429: Too Many Requests')));
  assert.ok(!flagged(new Error('CORS proxy error 429: Rate limit exceeded')));
  assert.ok(!flagged(new Error('HTTP Error 404: Not Found')));
});

test('a flagged failure is retried until it succeeds', async () => {
  const fn = failing([BOT, BOT]);
  const retries = [];
  assert.equal(await retryFlagged(fn, { delay: 0, onRetry: (n, total) => retries.push([n, total]) }), 'info');
  assert.equal(fn.calls(), 3);
  assert.deepEqual(retries, [[1, 3], [2, 3]]);
});

test('the last flagged failure is thrown after the retries run out', async () => {
  const fn = failing([BOT, BOT, BOT, BOT]);
  await assert.rejects(retryFlagged(fn, { delay: 0 }), BOT);
  assert.equal(fn.calls(), 4);
});

test('other failures are not retried', async () => {
  const notFound = new Error('HTTP Error 404: Not Found');
  const fn = failing([notFound]);
  await assert.rejects(retryFlagged(fn, { delay: 0 }), notFound);
  assert.equal(fn.calls(), 1);
});

test('a canceled run stops retrying', async () => {
  let canceled = false;
  const fn = failing([BOT, BOT]);
  await assert.rejects(retryFlagged(fn, { delay: 0, onRetry: () => { canceled = true; }, canceled: () => canceled }), BOT);
  assert.equal(fn.calls(), 1);
});
