// Runs ffmpeg and ffprobe on ffmpeg.wasm for `yt_dlp_host.run_ffmpeg`. The core
// has its own filesystem, so each command gets a fresh core instance holding
// copies of the files it names, at the same paths. Files the command creates
// are copied back to the Pyodide filesystem.

const PROGRAMS = { ffmpeg: 'exec', ffprobe: 'ffprobe' };

// `done` is called with the compiled module so the wasm is compiled once.
export const coreFactory = (createFFmpegCore, module) => (options) => createFFmpegCore({
  ...options,
  instantiateWasm(imports, done) {
    WebAssembly.instantiate(module, imports).then((instance) => done(instance, module));
    return {};
  },
});

function collector() {
  let buffer = new Uint8Array(4096);
  let length = 0;
  return {
    write(byte) {
      if (length === buffer.length) {
        const grown = new Uint8Array(length * 2);
        grown.set(buffer);
        buffer = grown;
      }
      buffer[length++] = byte;
    },
    bytes: () => buffer.subarray(0, length),
  };
}

function resolvePath(cwd, file) {
  const parts = [];
  for (const part of (file.startsWith('/') ? file : `${cwd}/${file}`).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}

const dirname = (file) => file.slice(0, file.lastIndexOf('/')) || '/';

function modeOf(FS, file) {
  try {
    return FS.stat(file).mode;
  } catch {
    return 0;
  }
}

// MEMFS contents are returned without a copy.
function readBytes(FS, file) {
  const { contents, usedBytes } = FS.lookupPath(file, { follow: true }).node;
  return contents instanceof Uint8Array ? contents.subarray(0, usedBytes) : FS.readFile(file);
}

function* filesIn(FS, dir) {
  for (const name of FS.readdir(dir)) {
    const file = dir === '/' ? `/${name}` : `${dir}/${name}`;
    if (FS.isFile(modeOf(FS, file))) yield file;
  }
}

// ffmpeg quoting as written by FFmpegPostProcessor._quote_for_ffmpeg
function concatEntries(list, dir) {
  const entries = [];
  for (const line of new TextDecoder().decode(list).split('\n')) {
    const match = /^\s*file\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[1].replace(/^'|'$/g, '').replaceAll("'\\''", "'");
    entries.push(resolvePath(dir, name.replace(/^file:/, '')));
  }
  return entries;
}

export function createFfmpegRunner({ FS: pyFS, createCore }) {
  return async function run(program, args, cwd, stdin) {
    const out = collector();
    const err = collector();
    let stdinPos = 0;
    const core = await createCore({
      stdin: () => (stdinPos < stdin.length ? stdin[stdinPos++] : null),
      stdout: (byte) => out.write(byte & 0xff),
      stderr: (byte) => err.write(byte & 0xff),
    });
    const coreFS = core.FS;
    const dirs = new Set();
    const copied = new Map();

    const mirrorDir = (dir) => {
      if (dirs.has(dir)) return;
      if (dir !== '/') coreFS.mkdirTree(dir);
      dirs.add(dir);
    };
    const copyIn = (file) => {
      if (copied.has(file) || !pyFS.isFile(modeOf(pyFS, file))) return false;
      mirrorDir(dirname(file));
      coreFS.writeFile(file, readBytes(pyFS, file), { canOwn: true });
      const { contents, usedBytes } = coreFS.lookupPath(file).node;
      copied.set(file, { contents, usedBytes });
      return true;
    };

    mirrorDir(cwd);
    coreFS.chdir(cwd);
    const concatList = args.findIndex((arg, i) => arg === '-f' && args[i + 1] === 'concat');
    for (const [i, arg] of args.entries()) {
      if (arg.startsWith('-')) continue;
      const file = resolvePath(cwd, arg.replace(/^file:/, ''));
      if (copyIn(file)) {
        if (concatList >= 0 && args.indexOf('-i', concatList) === i - 1) {
          concatEntries(readBytes(pyFS, file), dirname(file)).forEach(copyIn);
        }
      } else if (pyFS.isDir(modeOf(pyFS, dirname(file)))) {
        mirrorDir(dirname(file));
      }
    }

    if (program === 'ffprobe') {
      // ffprobe returns its status without setting `ret` unless it calls exit
      const probe = core._ffprobe;
      core._ffprobe = (...probeArgs) => {
        const status = probe(...probeArgs);
        if (core.ret < 0) core.ret = status;
        return status;
      };
    }
    let code;
    try {
      code = await core[PROGRAMS[program]](...args);
    } catch (error) {
      for (const byte of new TextEncoder().encode(`${error}\n`)) err.write(byte);
      code = 1;
    }

    try {
      for (const dir of dirs) {
        for (const file of filesIn(coreFS, dir)) {
          const node = coreFS.lookupPath(file).node;
          const before = copied.get(file);
          if (before?.contents === node.contents && before.usedBytes === node.usedBytes) continue;
          pyFS.writeFile(file, node.contents?.subarray(0, node.usedBytes) ?? new Uint8Array(0), { canOwn: true });
        }
      }
    } finally {
      for (const dir of dirs) {
        for (const file of filesIn(coreFS, dir)) coreFS.unlink(file);
      }
    }
    return { stdout: out.bytes(), stderr: err.bytes(), code: code < 0 ? 1 : code };
  };
}
