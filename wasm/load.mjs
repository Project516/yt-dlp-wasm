// Loads Pyodide with yt-dlp's dependencies. `locked` and `pypi` add packages on top.
import { loadPyodide } from 'pyodide';

// Pyodide's own lockfile pins these.
const LOCKED = ['micropip', 'pycryptodome', 'brotli', 'certifi'];
const PYPI = ['mutagen==1.48.1', 'websockets==17.0.1', 'yt-dlp-ejs==0.8.0'];

export async function loadYtdlpPyodide({ env, locked = [], pypi = [] }) {
  const py = await loadPyodide({ env });
  await py.loadPackage([...LOCKED, ...locked], { messageCallback: () => {} });
  await py.pyimport('micropip').install([...PYPI, ...pypi]);
  return py;
}
