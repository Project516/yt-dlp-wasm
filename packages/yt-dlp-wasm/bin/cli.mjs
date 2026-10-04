#!/usr/bin/env node
// `yt-dlp-wasm [yt-dlp args]` acts like `yt-dlp [args]`, on Pyodide.
// The current directory is mounted at its real path, so only paths under it are writable.
import { createYtDlp } from '../src/node.mjs';

const ytdlp = await createYtDlp({ env: { ...process.env } });
process.exit(await ytdlp.run(process.argv.slice(2)));
