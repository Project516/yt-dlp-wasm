// Installs yt-dlp's dependencies into a Pyodide instance. `locked` and `pypi` add packages on top.

// Pyodide's own lockfile pins these.
const LOCKED = ['micropip', 'pycryptodome', 'brotli', 'certifi'];
const PYPI = ['mutagen==1.48.1', 'websockets==17.0.1', 'yt-dlp-ejs==0.8.0'];

export async function installDependencies(py, { locked = [], pypi = [] } = {}) {
  await py.loadPackage([...LOCKED, ...locked], { messageCallback: () => {} });
  await py.pyimport('micropip').install([...PYPI, ...pypi]);
}
