#!/usr/bin/env python3

# Allow direct execution
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gzip
import http.cookiejar
import http.server
import io
import time

import pytest

from test.helper import http_server_port, start_http_server, validate_and_send
from yt_dlp.cookies import YoutubeDLCookieJar
from yt_dlp.networking import Request
from yt_dlp.networking.exceptions import (
    CertificateVerifyError,
    HTTPError,
    RequestError,
    TransportError,
    UnsupportedRequest,
)

TEST_DIR = os.path.dirname(os.path.abspath(__file__))
PAYLOAD = b'<html><video src="/vid.mp4" /></html>'


class FetchTestRequestHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, format, *args):
        pass

    def _send(self, body, status=200, headers=None, length=None):
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header('Content-Length', str(len(body) if length is None else length))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/slow-body':
            self._send(b'12345', length=10)
            self.wfile.flush()
            time.sleep(3)
            self.wfile.write(b'67890')
        elif self.path == '/gzip':
            self._send(gzip.compress(PAYLOAD, mtime=0), headers={'Content-Encoding': 'gzip'})
        elif self.path == '/plain':
            self._send(PAYLOAD)
        elif self.path == '/large':
            self._send(b'x' * (4 << 20))
        elif self.path == '/set-cookie-redirect':
            self._send(b'', 302, {'Set-Cookie': 'hop=1; path=/', 'Location': '/headers'})
        elif self.path == '/redirect-other-host':
            self._send(b'', 302, {'Location': f'http://localhost:{self.server.server_address[1]}/headers'})
        elif self.path == '/redirect-bad-location':
            self._send(b'', 302, {'Location': 'http://[invalid/'})
        elif self.path == '/headers':
            self._send(str(self.headers).encode())
        else:
            self._send(b'', 404)

    def do_POST(self):
        self._send(self.rfile.read(int(self.headers.get('Content-Length', 0))))


@pytest.mark.parametrize('handler', ['Fetch'], indirect=True)
class TestFetchRequestHandler:
    @classmethod
    def setup_class(cls):
        cls.http_httpd = start_http_server(FetchTestRequestHandler, http.server.ThreadingHTTPServer)
        cls.url = f'http://127.0.0.1:{http_server_port(cls.http_httpd)}'
        cls.https_httpd = start_http_server(
            FetchTestRequestHandler, http.server.ThreadingHTTPServer,
            certfile=os.path.join(TEST_DIR, 'testcert.pem'))
        cls.https_url = f'https://127.0.0.1:{http_server_port(cls.https_httpd)}'

    @pytest.mark.parametrize('kwargs', [
        {'verify': False},
        {'legacy_ssl_support': True},
        {'source_address': '127.0.0.1'},
        {'client_cert': {'client_certificate': 'client.crt'}},
    ])
    def test_unsupported_options(self, handler, kwargs):
        with handler(**kwargs) as rh, pytest.raises(UnsupportedRequest):
            rh.validate(Request(f'{self.url}/plain'))

    def test_verify_cert(self, handler):
        with handler() as rh, pytest.raises(CertificateVerifyError):
            validate_and_send(rh, Request(f'{self.https_url}/plain'))

    def test_requires_run_sync(self, handler, monkeypatch):
        monkeypatch.setattr('yt_dlp.networking._fetch.can_run_sync', lambda: False)
        with handler() as rh, pytest.raises(RequestError, match='runPythonAsync'):
            validate_and_send(rh, Request(f'{self.url}/plain'))

    def test_streaming(self, handler):
        with handler(timeout=10) as rh:
            res = validate_and_send(rh, Request(f'{self.url}/slow-body'))
            start = time.monotonic()
            assert res.read(5) == b'12345'
            assert time.monotonic() - start < 2
            assert res.read() == b'67890'
            assert res.closed

    def test_body_read_timeout(self, handler):
        with handler(timeout=1) as rh:
            res = validate_and_send(rh, Request(f'{self.url}/slow-body'))
            assert res.read(5) == b'12345'
            with pytest.raises(TransportError):
                res.read()

    def test_large_body_in_blocks(self, handler):
        with handler() as rh:
            res = validate_and_send(rh, Request(f'{self.url}/large'))
            total = 0
            while block := res.read(1 << 20):
                assert len(block) <= 1 << 20
                total += len(block)
            assert total == 4 << 20
            assert res.closed

    def test_decoded_body_drops_content_length(self, handler):
        with handler() as rh:
            res = validate_and_send(rh, Request(f'{self.url}/gzip'))
            assert res.headers.get('Content-Encoding') == 'gzip'
            assert res.headers.get('Content-Length') is None
            assert res.read() == PAYLOAD

            res = validate_and_send(rh, Request(f'{self.url}/plain'))
            assert res.headers.get('Content-Length') == str(len(PAYLOAD))
            assert res.read() == PAYLOAD

    def test_http_error_body(self, handler):
        with handler() as rh, pytest.raises(HTTPError) as exc_info:
            validate_and_send(rh, Request(f'{self.url}/missing'))
        assert exc_info.value.status == 404
        assert exc_info.value.response.read() == b''

    @pytest.mark.parametrize('make_data', [
        lambda: b'request body',
        lambda: io.BytesIO(b'request body'),
        lambda: iter([b'request ', b'body']),
    ])
    def test_request_body(self, handler, make_data):
        with handler() as rh:
            res = validate_and_send(rh, Request(f'{self.url}/echo', data=make_data()))
            assert res.read() == b'request body'

    def test_cookies_across_redirect(self, handler):
        cookiejar = YoutubeDLCookieJar()
        with handler(cookiejar=cookiejar) as rh:
            data = validate_and_send(rh, Request(f'{self.url}/set-cookie-redirect')).read()
        assert b'cookie: hop=1' in data.lower()
        assert [c.name for c in cookiejar] == ['hop']

    def test_cookie_jar_sent_with_request(self, handler):
        cookiejar = YoutubeDLCookieJar()
        cookiejar.set_cookie(http.cookiejar.Cookie(
            0, 'jar', '1', None, False, '127.0.0.1', True,
            False, '/', True, False, None, False, None, None, {}))
        with handler(cookiejar=cookiejar) as rh:
            data = validate_and_send(rh, Request(f'{self.url}/headers')).read()
        assert b'cookie: jar=1' in data.lower()

    def test_authorization_kept_on_same_origin_redirect(self, handler):
        with handler() as rh:
            res = validate_and_send(rh, Request(
                f'{self.url}/set-cookie-redirect', headers={'Authorization': 'Bearer secret'}))
            assert b'Bearer secret' in res.read()

    def test_authorization_stripped_on_cross_origin_redirect(self, handler):
        with handler() as rh:
            res = validate_and_send(rh, Request(
                f'{self.url}/redirect-other-host', headers={'Authorization': 'Bearer secret'}))
            assert res.url.startswith('http://localhost:')
            assert b'secret' not in res.read()

    def test_bad_redirect_location(self, handler):
        with handler() as rh, pytest.raises(HTTPError) as exc_info:
            validate_and_send(rh, Request(f'{self.url}/redirect-bad-location'))
        assert exc_info.value.status == 302
