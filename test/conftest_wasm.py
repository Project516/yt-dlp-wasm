"""Fork-owned pytest plugin that adapts upstream's tests to wasm, so the test files stay close to upstream.

Registered by the root conftest.py.
"""
import sys

import pytest

from test.wasm_helper import stop_sidecar_servers
from yt_dlp.cookies import YoutubeDLCookieJar
from yt_dlp.networking.exceptions import UnsupportedRequest

EMSCRIPTEN = sys.platform == 'emscripten'

NO_SOCKETS_HANDLERS = ('Urllib', 'Requests', 'Websockets', 'CurlCFFI')
NO_SOCKETS_MODULES = ('test_http_proxy.py', 'test_socks.py', 'test_websockets.py')
# These Urllib tests do not use the network
NO_SOCKETS_ALLOWED = (
    'test_networking.py::TestUrllibRequestHandler::test_file_urls',
    'test_networking.py::TestUrllibRequestHandler::test_data_uri_auto_close',
    'test_networking.py::TestUrllibRequestHandler::test_data_uri_partial_read_then_full_read',
    'test_networking.py::TestUrllibRequestHandler::test_data_uri_partial_read_greater_than_response_then_full_read',
)

# Classes upstream parametrizes over its handlers, which also run for Fetch
FETCH_CLASSES = (
    'test_networking.py::TestHTTPRequestHandler',
    'test_networking.py::TestClientCertificate',
)

# Rows added to upstream's `handler,...` parametrizations, by test
FETCH_VALIDATION_CASES = {
    'test_networking.py::TestRequestHandlerValidation::test_no_proxy': [
        ('Fetch', UnsupportedRequest, 'http'),
    ],
    'test_networking.py::TestRequestHandlerValidation::test_empty_proxy': [
        ('Fetch', 'http'),
    ],
    'test_networking.py::TestRequestHandlerValidation::test_invalid_proxy_url': [
        ('Fetch', 'http'),
    ],
    'test_networking.py::TestRequestHandlerValidation::test_url_scheme': [
        ('Fetch', scheme, fail, {}) for scheme, fail in [
            ('http', False),
            ('https', False),
            ('data', UnsupportedRequest),
            ('ws', UnsupportedRequest),
        ]
    ],
    'test_networking.py::TestRequestHandlerValidation::test_proxy_scheme': [
        ('Fetch', 'http', scheme, UnsupportedRequest) for scheme in ('http', 'https', 'socks5')
    ],
    'test_networking.py::TestRequestHandlerValidation::test_proxy_key': [
        ('Fetch', 'http', 'all', 'http', UnsupportedRequest),
        ('Fetch', 'http', 'unrelated', 'http', False),
    ],
    'test_networking.py::TestRequestHandlerValidation::test_extension': [
        ('Fetch', 'http', extensions, fail) for extensions, fail in [
            ({'cookiejar': 'notacookiejar'}, AssertionError),
            ({'cookiejar': YoutubeDLCookieJar()}, False),
            ({'timeout': 1}, False),
            ({'timeout': 'notatimeout'}, AssertionError),
            ({'unsupported': 'value'}, UnsupportedRequest),
            ({'legacy_ssl': False}, False),
            ({'legacy_ssl': True}, UnsupportedRequest),
            ({'legacy_ssl': 'notabool'}, AssertionError),
            ({'keep_header_casing': False}, False),
            ({'keep_header_casing': True}, UnsupportedRequest),
            ({'keep_header_casing': 'notabool'}, AssertionError),
        ]
    ],
}

FETCH_SKIPS = {
    'test_networking.py::TestClientCertificate': 'fetch does not support client certificates',
    'test_networking.py::TestHTTPRequestHandler::test_verify_cert': 'fetch cannot disable certificate verification',
    'test_networking.py::TestHTTPRequestHandler::test_ssl_error': 'fetch cannot disable certificate verification',
    'test_networking.py::TestHTTPRequestHandler::test_legacy_ssl_extension': 'fetch does not support legacy SSL',
    'test_networking.py::TestHTTPRequestHandler::test_legacy_ssl_support': 'fetch does not support legacy SSL',
    'test_networking.py::TestHTTPRequestHandler::test_source_address': 'fetch cannot bind a source address',
    'test_networking.py::TestHTTPRequestHandler::test_gzip_trailing_garbage': 'fetch rejects trailing data after a gzip stream',
}

WASM_SKIPS = {
    'test_InfoExtractor.py::TestInfoExtractor::test_get_netrc_login_info': '--netrc-cmd needs a shell, which wasm does not have',
    'test_downloader_external.py::TestFFmpegFD': 'ffmpeg.wasm cannot open network inputs',
    'test_utils.py::TestUtil::test_locked_file': 'wasm has no other processes to hold a lock',
}


def _key(node):
    return f'{node.path.name}::{node.nodeid.partition("::")[2].partition("[")[0]}'


def _under(key, prefix):
    return key == prefix or key.startswith(f'{prefix}::')


def _skip_reason(key, table):
    return next((reason for prefix, reason in table.items() if _under(key, prefix)), None)


def _is_handler_parametrize(mark):
    return mark.name == 'parametrize' and str(mark.args[0]).split(',')[0].strip() == 'handler'


def _with_rows(mark, rows):
    values = list(mark.args[1])
    new_rows = [row for row in rows if row not in values]
    if not new_rows:
        return mark
    return pytest.mark.parametrize(mark.args[0], [*values, *new_rows], **mark.kwargs).mark


@pytest.hookimpl(tryfirst=True)
def pytest_generate_tests(metafunc):
    key = _key(metafunc.definition)
    if any(_under(key, prefix) for prefix in FETCH_CLASSES):
        rows = ['Fetch']
    elif key in FETCH_VALIDATION_CASES:
        rows = FETCH_VALIDATION_CASES[key]
    else:
        return
    for node in metafunc.definition.listchain():
        node.own_markers[:] = [
            _with_rows(mark, rows) if _is_handler_parametrize(mark) else mark
            for mark in node.own_markers
        ]


def pytest_collection_modifyitems(items):
    if not EMSCRIPTEN:
        return
    no_sockets_skip = pytest.mark.skip(reason='needs sockets and threads, which are not available in wasm')
    for item in items:
        key = _key(item)
        handler = item.callspec.params.get('handler') if hasattr(item, 'callspec') else None
        reason = _skip_reason(key, WASM_SKIPS)
        if reason is None and handler == 'Fetch':
            reason = _skip_reason(key, FETCH_SKIPS)
        if reason is not None:
            item.add_marker(pytest.mark.skip(reason=reason))
        elif item.path.name in NO_SOCKETS_MODULES or (
            handler in NO_SOCKETS_HANDLERS and not any(_under(key, name) for name in NO_SOCKETS_ALLOWED)
        ):
            item.add_marker(no_sockets_skip)


@pytest.fixture(autouse=True, scope='class')
def stop_servers():
    yield
    stop_sidecar_servers()
