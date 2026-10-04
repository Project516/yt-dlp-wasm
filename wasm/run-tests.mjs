// Runs devscripts/run_tests.py inside Pyodide. Arguments pass through, e.g.
//   node run-tests.mjs core
//   node run-tests.mjs test/test_utils.py --pytest-args='-x'
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';
import { createHost } from './host-node.mjs';
import { createTestHost } from './test-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Pyodide's own lockfile pins these.
const LOCKED = ['micropip', 'pytest', 'pycryptodome', 'brotli', 'certifi'];
const PYPI = [
  'pytest-rerunfailures==16.4',
  'mutagen==1.48.1',
  'websockets==17.0.1',
  'yt-dlp-ejs==0.8.0',
];

const env = { HOME: '/home/pyodide' };
for (const key of ['CI', 'GITHUB_ACTIONS', 'HATCH_TEST_ARGS']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}

const py = await loadPyodide({ env });
py.FS.mkdirTree(root);
py.mountNodeFS(root, root);
py.registerJsModule('yt_dlp_host', createHost({ FS: py.FS }));
py.registerJsModule('yt_dlp_test_host', createTestHost(root));
await py.loadPackage(LOCKED, { messageCallback: () => {} });
await py.pyimport('micropip').install(PYPI);

py.globals.set('ROOT', root);
py.globals.set('ARGV', py.toPy(process.argv.slice(2)));
const code = await py.runPythonAsync(`
import os, runpy, sys
os.chdir(ROOT)
sys.path[:0] = [ROOT, os.path.join(ROOT, 'wasm')]
os.environ['PYTEST_PLUGINS'] = 'pytest_wasm'
sys.argv = ['devscripts/run_tests.py', *ARGV]
try:
    runpy.run_path('devscripts/run_tests.py', run_name='__main__')
    rc = 0
except SystemExit as e:
    rc = e.code if isinstance(e.code, int) else int(e.code is not None)
rc
`);
process.exit(code);
