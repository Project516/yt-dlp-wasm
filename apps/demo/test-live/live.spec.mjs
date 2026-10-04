import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const SITE = process.env.DEMO_URL || 'https://yt-dlp-wasm.project516.dev';
const RESULTS = path.resolve(import.meta.dirname, '../live-results');
const DOWNLOAD_TIMEOUT = 240_000;

// An 8 second public-domain clip, under 1 MB
const ARCHIVE_URL = 'https://archive.org/details/wonder_bread';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

// Starts a download on the live page and returns the saved file's name and size
async function download(page, url, kind) {
  await page.goto(SITE);
  if (kind === 'audio') {
    await page.getByRole('radio', { name: 'Audio' }).check();
    await page.getByLabel('Audio format').selectOption('mp3');
  }
  await page.getByLabel('Link').fill(url);

  const alert = page.getByRole('alert');
  const saved = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT });
  const failed = alert.waitFor({ state: 'visible', timeout: DOWNLOAD_TIMEOUT }).then(async () => {
    throw new Error(`The demo showed an error: ${(await alert.innerText()).replace(/\s+/g, ' ')}`);
  });
  saved.catch(() => {});
  failed.catch(() => {});
  await page.getByRole('button', { name: 'Download' }).click();

  const file = await Promise.race([saved, failed]);
  return {
    name: file.suggestedFilename(),
    size: fs.statSync(await file.path()).size,
    title: await page.locator('#media-title').textContent(),
  };
}

// Writes the result for the workflow summary and the issue. An informational case never throws
async function runCase(name, { blocking }, body) {
  const started = Date.now();
  let status = 'pass';
  let detail;
  let error;
  try {
    detail = await body();
  } catch (caught) {
    status = 'fail';
    error = caught;
    detail = String(caught.message).split('\n')[0].slice(0, 400);
  }
  fs.mkdirSync(RESULTS, { recursive: true });
  const seconds = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify({ name, blocking, status, detail, seconds }));
  if (error && blocking) throw error;
  if (error) test.info().annotations.push({ type: 'informational failure', description: detail });
}

test('audio downloads as mp3 from archive.org', async ({ page }) => {
  await runCase('audio', { blocking: true }, async () => {
    const { name, size, title } = await download(page, ARCHIVE_URL, 'audio');
    expect(name).toBe(`${title}.mp3`);
    expect(size).toBeGreaterThan(0);
    return `${name}, ${size} bytes`;
  });
});

test('video downloads from archive.org', async ({ page }) => {
  await runCase('video', { blocking: true }, async () => {
    const { name, size, title } = await download(page, ARCHIVE_URL, 'video');
    expect(name).toBe(`${title}.mp4`);
    expect(size).toBeGreaterThan(0);
    return `${name}, ${size} bytes`;
  });
});

// YouTube sometimes challenges datacenter IPs, so this case reports and never fails
test('audio downloads from YouTube', async ({ page }) => {
  await runCase('youtube', { blocking: false }, async () => {
    const { name, size, title } = await download(page, YOUTUBE_URL, 'audio');
    expect(name).toBe(`${title}.mp3`);
    expect(size).toBeGreaterThan(0);
    return `${name}, ${size} bytes`;
  });
});
