import sys

# Trigger import of built-in providers
from ._builtin.bun import BunJCP as _BunJCP  # noqa: F401
from ._builtin.deno import DenoJCP as _DenoJCP  # noqa: F401
from ._builtin.node import NodeJCP as _NodeJCP  # noqa: F401
from ._builtin.quickjs import QuickJSJCP as _QuickJSJCP  # noqa: F401

if sys.platform == 'emscripten':
    from ._builtin.host import HostJCP as _HostJCP  # noqa: F401
