import sys

import pytest

from yt_dlp.extractor.youtube.jsc._builtin import host
from yt_dlp.extractor.youtube.jsc._builtin.host import HostJCP
from yt_dlp.extractor.youtube.jsc.provider import JsChallengeProviderError

emscripten_only = pytest.mark.skipif(sys.platform != 'emscripten', reason='requires the Pyodide host')


@pytest.fixture
def jcp(ie, logger):
    return HostJCP(ie, logger, None)


class TestHostJCP:
    @pytest.mark.skipif(sys.platform == 'emscripten', reason='native only')
    def test_unavailable_natively(self, jcp):
        assert not jcp.is_available()

    def test_unavailable_without_host(self, jcp, monkeypatch):
        monkeypatch.setattr(host, '_get_host', lambda: None)
        assert not jcp.is_available()

    @emscripten_only
    def test_available(self, jcp):
        assert jcp.is_available()

    @emscripten_only
    def test_run_js_stdout(self, jcp):
        assert jcp._run_js_runtime('console.log("a"); console.log(JSON.stringify({b: 1}))') == 'a\n{"b":1}\n'

    @emscripten_only
    def test_run_js_error(self, jcp):
        with pytest.raises(JsChallengeProviderError, match='boom'):
            jcp._run_js_runtime('throw new Error("boom")')
