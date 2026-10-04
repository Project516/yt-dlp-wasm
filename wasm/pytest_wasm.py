"""pytest plugin run-tests.mjs loads under Pyodide.

Tests that start `sys.executable` get it run in this interpreter instead,
on a fresh import of yt_dlp, since wasm can't spawn processes.
"""
import contextlib
import io
import os
import runpy
import subprocess
import sys
import traceback
import warnings

from yt_dlp.utils._wasm import HostPopen, register_program

_FRESH_MODULES = ('yt_dlp', 'devscripts')


def _is_fresh(name):
    return name.split('.')[0] in _FRESH_MODULES


@contextlib.contextmanager
def _fresh_modules():
    saved = {name: mod for name, mod in sys.modules.items() if _is_fresh(name)}
    for name in saved:
        del sys.modules[name]
    try:
        yield
    finally:
        for name in [name for name in sys.modules if _is_fresh(name)]:
            del sys.modules[name]
        sys.modules.update(saved)


def _run_python(args, stdin, cwd, env):
    argv = args[1:]
    out, err = io.BytesIO(), io.BytesIO()
    stdout = io.TextIOWrapper(out, encoding='utf-8', write_through=True)
    stderr = io.TextIOWrapper(err, encoding='utf-8', write_through=True)
    old_cwd, old_argv, old_path, old_stdin = os.getcwd(), sys.argv, sys.path[:], sys.stdin
    returncode = 0
    try:
        os.chdir(cwd or old_cwd)
        with (
            _fresh_modules(),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
            warnings.catch_warnings(),
        ):
            warnings.simplefilter('default')
            sys.stdin = io.TextIOWrapper(io.BytesIO(stdin), encoding='utf-8')
            try:
                if argv[0] == '-c':
                    sys.argv = ['-c', *argv[2:]]
                    exec(compile(argv[1], '<string>', 'exec'), {'__name__': '__main__'})
                elif argv[0] == '-m':
                    sys.argv = argv[1:]
                    sys.path.insert(0, os.getcwd())
                    runpy.run_module(argv[1], run_name='__main__', alter_sys=True)
                else:
                    sys.argv = argv
                    sys.path.insert(0, os.path.dirname(os.path.abspath(argv[0])))
                    runpy.run_path(argv[0], run_name='__main__')
            except SystemExit as e:
                if e.code is None or isinstance(e.code, int):
                    returncode = e.code or 0
                else:
                    print(e.code, file=sys.stderr)
                    returncode = 1
            except BaseException:
                traceback.print_exc()
                returncode = 1
    finally:
        sys.stdin = old_stdin
        sys.argv, sys.path[:] = old_argv, old_path
        os.chdir(old_cwd)
    return out.getvalue(), err.getvalue(), returncode


subprocess.Popen = HostPopen
register_program(sys.executable, _run_python)
