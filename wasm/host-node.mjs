// The `yt_dlp_host` module Python imports under Pyodide in Node.js.
// Each capability here needs a matching browser implementation.
import { spawn } from 'node:child_process';

const JS_TIMEOUT_MS = 120_000;

// Runs the script on `node --permission -` and resolves with its stdout.
function runJs(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--permission', '-'], { timeout: JS_TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    proc.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    proc.stdin.on('error', () => {});
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      if (signal) reject(new Error(`JS process killed by ${signal} (timeout ${JS_TIMEOUT_MS} ms)`));
      else if (code) reject(new Error(`JS process exited with code ${code}: ${stderr.trim()}`));
      else resolve(stdout);
    });
    proc.stdin.end(script);
  });
}

export function createHost() {
  return { run_js: runJs };
}
