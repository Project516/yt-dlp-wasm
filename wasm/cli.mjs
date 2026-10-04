#!/usr/bin/env node
// Runs yt-dlp on Pyodide: `node cli.mjs [yt-dlp args]` acts like `yt-dlp [args]`.
// The current directory is mounted at its real path, so only paths under it are writable.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from './host-node.mjs';
import { loadYtdlpPyodide } from './load.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cwd = process.cwd();

const py = await loadYtdlpPyodide({ env: { ...process.env } });
const inside = (dir, parent) => dir === parent || dir.startsWith(parent + path.sep);
const mounts = [...new Set([root, cwd])].filter((dir) => ![root, cwd].some((other) => other !== dir && inside(dir, other)));
for (const dir of mounts) {
  py.FS.mkdirTree(dir);
  py.mountNodeFS(dir, dir);
}
py.registerJsModule('yt_dlp_host', createHost({ FS: py.FS }));

py.globals.set('ROOT', root);
py.globals.set('CWD', cwd);
py.globals.set('ARGV', py.toPy(process.argv.slice(2)));
const code = await py.runPythonAsync(`
import os, sys
os.chdir(CWD)
sys.path.insert(0, ROOT)
import yt_dlp
try:
    yt_dlp.main(ARGV)
    rc = 0
except SystemExit as e:
    rc = e.code if isinstance(e.code, int) else int(e.code is not None)
rc
`);
process.exit(code);
