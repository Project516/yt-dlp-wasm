from __future__ import annotations

import sys

from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP
from yt_dlp.extractor.youtube.jsc.provider import (
    JsChallengeProvider,
    JsChallengeProviderError,
    JsChallengeRequest,
    register_preference,
    register_provider,
)
from yt_dlp.extractor.youtube.pot._provider import BuiltinIEContentProvider


def _get_host():
    """Returns the `yt_dlp_host` module if it can run JS, else None"""
    if sys.platform != 'emscripten':
        return None
    try:
        import yt_dlp_host
        from pyodide.ffi import can_run_sync
    except ImportError:
        return None
    if not hasattr(yt_dlp_host, 'run_js') or not can_run_sync():
        return None
    return yt_dlp_host


@register_provider
class HostJCP(EJSBaseJCP, BuiltinIEContentProvider):
    PROVIDER_NAME = 'host'
    JS_RUNTIME_NAME = 'host'

    def _run_js_runtime(self, stdin: str, /) -> str:
        from pyodide.ffi import JsException, run_sync

        host = _get_host()
        if not host:
            raise JsChallengeProviderError('The host cannot run JavaScript')
        self.logger.debug('Running script on the host JS engine')
        try:
            return run_sync(host.run_js(stdin))
        except JsException as e:
            raise JsChallengeProviderError(f'Error running host JavaScript: {e.message}') from e

    def is_available(self, /) -> bool:
        return self._available and _get_host() is not None


@register_preference(HostJCP)
def preference(provider: JsChallengeProvider, requests: list[JsChallengeRequest]) -> int:
    return 1100
