// Installs yt-dlp's dependencies into a Pyodide instance. `locked` and `pypi` add packages on top.
import pins from './pins.json' with { type: 'json' };

// Pyodide's own lockfile pins these.
const LOCKED = ['micropip', 'pycryptodome', 'brotli', 'certifi'];

// pins.json comes from upstream's requirements. micropip evaluates the environment markers in it.
export async function installDependencies(py, { locked = [], pypi = [] } = {}) {
  await py.loadPackage([...LOCKED, ...locked], { messageCallback: () => {} });
  await py.pyimport('micropip').install([...pins.pypi, ...pypi]);
}
