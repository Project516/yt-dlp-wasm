"""Subprocess stand-in for emscripten, where processes can't be spawned.

Programs are Python callables registered by name:
    program(args, stdin: bytes, cwd, env) -> (stdout: bytes, stderr: bytes, returncode)
"""
import errno
import io
import os
import subprocess

_PROGRAMS = {}


def register_program(name, program):
    _PROGRAMS[name] = program


def find_program(name):
    name = os.fspath(name)
    return _PROGRAMS.get(name) or _PROGRAMS.get(os.path.basename(name))


class HostPopen:
    """The subset of `subprocess.Popen` yt-dlp uses. The program runs to completion
    on `communicate`, `wait` or `poll`, so pipes can't be streamed."""

    def __init__(self, args, bufsize=-1, executable=None, stdin=None, stdout=None, stderr=None,
                 cwd=None, env=None, shell=False, text=None, encoding=None, errors=None,
                 universal_newlines=None, startupinfo=None, **kwargs):
        if isinstance(args, (str, bytes, os.PathLike)):
            args = [args]
        self.args = [os.fsdecode(a) for a in args]
        exe = os.fsdecode(executable or self.args[0])
        self._program = find_program(exe)
        if shell or not self._program:
            raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), exe)

        self._cwd, self._env = cwd, env
        self._targets = (stdout, stderr)
        self._text = bool(text or universal_newlines or encoding or errors)
        self._encoding, self._errors = encoding or 'utf-8', errors or 'strict'
        self.stdin = self.stdout = self.stderr = None
        self.pid = None
        self.returncode = None
        self._output = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.wait()

    def _run(self, input=None):
        if self._output is None:
            if isinstance(input, str):
                input = input.encode(self._encoding, self._errors)
            out, err, self.returncode = self._program(self.args, input or b'', self._cwd, self._env)
            if self._targets[1] == subprocess.STDOUT:
                out, err = out + err, b''
            self._output = tuple(self._deliver(data, target) for data, target in zip((out, err), self._targets))
        return self._output

    def _deliver(self, data, target):
        if target == subprocess.PIPE:
            return data.decode(self._encoding, self._errors) if self._text else data
        if isinstance(target, int) and target >= 0:
            os.write(target, data)
        elif target not in (None, subprocess.DEVNULL, subprocess.STDOUT):
            if isinstance(target, io.TextIOBase):
                target.write(data.decode(self._encoding, self._errors))
            else:
                target.write(data)
        return None

    def communicate(self, input=None, timeout=None):
        return self._run(input)

    def wait(self, timeout=None):
        self._run()
        return self.returncode

    def poll(self):
        return self.wait()

    def send_signal(self, sig):
        pass

    def terminate(self):
        pass

    def kill(self):
        pass
