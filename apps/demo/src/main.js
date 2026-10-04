import { createYtDlp } from '@project516/yt-dlp-wasm';
import './style.css';
import { explain } from './explain.js';
import { formatBytes, formatDuration, formatEta } from './format.js';

const wheels = import.meta.glob('../../../packages/yt-dlp-wasm/dist/*.whl', { query: '?url', import: 'default', eager: true });
const [wheelURL] = Object.values(wheels);

const DEMO_PROXY = import.meta.env.VITE_DEMO_PROXY_URL || 'https://yt-dlp-demo-proxy.project516.dev';
const STORAGE_KEY = 'yt-dlp-wasm-demo';
const MAX_LOG_LINES = 2000;

const VIDEO_OPTIONS = {
  format: 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b',
  merge_output_format: 'mp4',
};
const audioOptions = (codec) => ({
  format: codec === 'm4a' ? 'ba[ext=m4a]/ba/b' : 'ba/b',
  postprocessors: [{ key: 'FFmpegExtractAudio', preferredcodec: codec, preferredquality: '192' }],
});

const STAGES = ['runtime', 'info', 'download', 'process'];
const STAGE_LABELS = { runtime: 'Loading the runtime', info: 'Fetching info', download: 'Downloading', process: 'Processing', done: 'Done' };
const PROCESS_LABELS = { Merger: 'Merging video and audio', ExtractAudio: 'Converting the audio' };

const $ = (id) => document.getElementById(id);
const form = $('form');
const urlInput = $('url');
const goButton = $('go');
const cancelButton = $('cancel');
const errorBox = $('error');
const mediaBox = $('media');
const stageList = $('stages');
const bar = $('bar');
const logPanel = $('log-panel');
const proxyPanel = $('proxy-panel');
const logEl = $('log');

// Settings

function loadSettings() {
  try {
    return { mode: 'demo', url: '', key: '', ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
  } catch {
    return { mode: 'demo', url: '', key: '' };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* private mode: settings last for this page only */ }
}

const settings = loadSettings();
const proxyModes = document.querySelectorAll('input[name="proxy-mode"]');

function showSettings() {
  for (const radio of proxyModes) radio.checked = radio.value === settings.mode;
  $('own-fields').hidden = settings.mode !== 'own';
  $('proxy-url').value = settings.url;
  $('proxy-key').value = settings.key;
}

function readSettings() {
  settings.mode = document.querySelector('input[name="proxy-mode"]:checked').value;
  settings.url = $('proxy-url').value.trim();
  settings.key = $('proxy-key').value;
  $('own-fields').hidden = settings.mode !== 'own';
  saveSettings(settings);
}

proxyPanel.addEventListener('input', readSettings);
showSettings();

const usingDemoProxy = () => settings.mode === 'demo';

// Log

const logLines = [];

function onLog(line) {
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  if (logPanel.open) logEl.append(`${line}\n`);
}

logPanel.addEventListener('toggle', () => {
  if (logPanel.open) logEl.textContent = logLines.map((line) => `${line}\n`).join('');
});

$('copy-log').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(logLines.join('\n'));
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Could not copy';
  }
  setTimeout(() => { button.textContent = 'Copy log'; }, 2000);
});

$('show-log').addEventListener('click', () => {
  logPanel.open = true;
  logEl.focus();
});

// Runtime instance

let instance;

function getYtDlp(proxy) {
  const key = JSON.stringify(proxy);
  if (instance?.key === key) return instance.promise;
  instance?.ytdlp?.terminate();
  const entry = { key, ytdlp: null };
  entry.promise = createYtDlp({ ...proxy, wheelURL, onLog }).then((ytdlp) => {
    entry.ytdlp = ytdlp;
    return ytdlp;
  }, (error) => {
    if (instance === entry) instance = undefined;
    throw error;
  });
  instance = entry;
  return entry.promise;
}

function proxySettings() {
  const url = settings.mode === 'demo' ? DEMO_PROXY : settings.url;
  if (!url) throw new UserError('Enter your proxy URL', 'Add it in the proxy settings, or switch to the demo proxy.', $('proxy-url'));
  if (!/^https?:\/\//.test(url)) throw new UserError('The proxy URL is not valid', 'It must start with https://.', $('proxy-url'));
  return { corsProxy: url, corsProxyKey: settings.mode === 'own' && settings.key ? settings.key : undefined };
}

class UserError extends Error {
  constructor(title, detail, target) {
    super(detail);
    this.title = title;
    this.target = target;
  }
}

// UI state

function setStage(stage) {
  const current = STAGES.indexOf(stage);
  stageList.hidden = false;
  STAGES.forEach((name, index) => {
    const item = stageList.querySelector(`[data-stage="${name}"]`);
    if (stage === 'done' || index < current) item.dataset.state = 'done';
    else if (index === current) item.dataset.state = 'current';
    else delete item.dataset.state;
    if (index === current) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  $('announce').textContent = STAGE_LABELS[stage];
}

function showError(title, detail) {
  errorBox.querySelector('.error-title').textContent = title;
  errorBox.querySelector('.error-detail').textContent = detail;
  errorBox.hidden = false;
}

function showMedia(info) {
  $('media-title').textContent = info.title ?? 'Untitled';
  $('media-meta').textContent = [info.uploader ?? info.channel, formatDuration(info.duration)].filter(Boolean).join(' / ');
  const thumb = $('thumb');
  thumb.hidden = true;
  thumb.onload = () => { thumb.hidden = false; };
  thumb.onerror = () => { thumb.hidden = true; };
  if (info.thumbnail) thumb.src = info.thumbnail;
  else thumb.removeAttribute('src');
  mediaBox.hidden = false;
}

function resetView() {
  errorBox.hidden = true;
  mediaBox.hidden = true;
  stageList.hidden = true;
  $('done').hidden = true;
  $('canceled').hidden = true;
  bar.removeAttribute('value');
  $('download-detail').textContent = '';
  $('process-detail').textContent = '';
  logLines.length = 0;
  logEl.textContent = '';
}

function setBusy(busy) {
  goButton.disabled = busy;
  cancelButton.hidden = !busy;
  form.setAttribute('aria-busy', String(busy));
}

let blobUrl;

function saveFile(file) {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(new Blob([file.data], { type: file.mimeType }));
  const link = $('done-link');
  link.href = blobUrl;
  link.download = file.name;
  $('done-name').textContent = file.name;
  $('done-size').textContent = `(${formatBytes(file.data.byteLength)})`;
  $('done').hidden = false;
  link.click();
}

// Download

let current;

function progressHandler(run) {
  let finishedParts = 0;
  return (event) => {
    if (run.canceled) return;
    if (event.type === 'download') {
      if (event.status === 'finished') {
        finishedParts++;
        bar.value = 1;
        return;
      }
      if (event.status !== 'downloading') return;
      const { downloadedBytes, totalBytes, speed, eta } = event;
      if (totalBytes) bar.value = downloadedBytes / totalBytes;
      else bar.removeAttribute('value');
      $('download-detail').textContent = [
        finishedParts ? `Part ${finishedParts + 1}` : '',
        totalBytes ? `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}` : formatBytes(downloadedBytes),
        speed ? `${formatBytes(speed)}/s` : '',
        formatEta(eta),
      ].filter(Boolean).join(', ');
    } else if (event.postprocessor !== 'MoveFiles') {
      setStage('process');
      $('process-detail').textContent = PROCESS_LABELS[event.postprocessor] ?? 'Processing with ffmpeg';
    }
  };
}

async function start(url, kind, codec) {
  const run = { canceled: false };
  current = run;
  resetView();
  setBusy(true);
  try {
    let parsed;
    try {
      parsed = new URL(url);
    } catch { /* checked below */ }
    if (!/^https?:$/.test(parsed?.protocol)) throw new UserError('Enter a link', 'It must start with https://.', urlInput);
    const proxy = proxySettings();

    setStage('runtime');
    const ytdlp = await getYtDlp(proxy);
    if (run.canceled) return;

    setStage('info');
    const info = await ytdlp.extractInfo(url, { noplaylist: true });
    if (run.canceled) return;
    if (info._type === 'playlist') throw new UserError('This link is a playlist', 'Paste the link of one video.');
    showMedia(info);

    setStage('download');
    const options = {
      noplaylist: true,
      playlist_items: '1',
      outtmpl: '%(title).120B.%(ext)s',
      ...(kind === 'audio' ? audioOptions(codec) : VIDEO_OPTIONS),
    };
    const [file] = await ytdlp.download(info.webpage_url || url, options, { onProgress: progressHandler(run) });
    if (run.canceled) return;
    if (!file) throw new UserError('No file was produced', 'Open the log to see what yt-dlp did.');

    setStage('done');
    saveFile(file);
  } catch (error) {
    if (run.canceled) return;
    stageList.hidden = true;
    if (error instanceof UserError) {
      showError(error.title, error.message);
      const panel = error.target?.closest('details');
      if (panel) panel.open = true;
      error.target?.focus();
    } else {
      const { title, detail } = explain(error, { usingDemoProxy: usingDemoProxy() });
      showError(title, detail);
    }
    $('show-log').hidden = !logLines.length;
  } finally {
    if (current === run) setBusy(false);
  }
}

function cancel() {
  current.canceled = true;
  setBusy(false);
  resetView();
  $('canceled').hidden = false;
  // terminate() is the only way to stop a running download, so start a fresh runtime
  if (instance?.ytdlp) {
    instance.ytdlp.terminate();
    instance = undefined;
    getYtDlp(proxySettings()).catch(() => {});
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  start(String(data.get('url')).trim(), data.get('kind'), data.get('codec'));
});

cancelButton.addEventListener('click', cancel);

form.addEventListener('change', () => {
  $('audio-field').hidden = new FormData(form).get('kind') !== 'audio';
});
