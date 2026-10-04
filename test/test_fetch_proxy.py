#!/usr/bin/env python3

# Allow direct execution
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import http.cookiejar
import http.server
import json

import pytest

from test.helper import http_server_port, start_http_server, validate_and_send
from yt_dlp.cookies import YoutubeDLCookieJar
from yt_dlp.networking import Request
from yt_dlp.networking.exceptions import HTTPError, RequestError, TransportError

pytestmark = pytest.mark.skipif(
    sys.platform != 'emscripten', reason='the CORS proxy is used by the fetch request handler, which needs emscripten')

ORIGIN = 'https://app.example'
PAYLOAD = bytes(range(256)) * 4


class ProxyTargetRequestHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, format, *args):
        pass

    def _send(self, body, status=200, headers=None, reason=None):
        self.send_response(status, reason)
        for name, value in (headers or []):
            self.send_header(name, value)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self):
        path = self.path.split('?')[0]
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if path == '/echo':
            self._send(json.dumps({
                'method': self.command,
                'path': self.path,
                'headers': {k.lower(): v for k, v in self.headers.items()},
                'body': body.decode(),
            }).encode())
        elif path == '/payload':
            self._send(PAYLOAD)
        elif path == '/large':
            self._send(b'x' * (4 << 20))
        elif path == '/range':
            start, _, end = self.headers['Range'].removeprefix('bytes=').partition('-')
            start, end = int(start), int(end)
            self._send(PAYLOAD[start:end + 1], 206, [('Content-Range', f'bytes {start}-{end}/{len(PAYLOAD)}')])
        elif path == '/cookies':
            self._send(b'', headers=[('Set-Cookie', 'a=1; path=/'), ('Set-Cookie', 'b=2; path=/')])
        elif path.startswith('/redirect/'):
            self._send(b'', int(path.split('/')[2]), [('Location', '/echo')])
        elif path == '/cookie-redirect':
            self._send(b'', 302, [('Set-Cookie', 'hop=1; path=/'), ('Location', '/echo')])
        elif path == '/teapot':
            self._send(b'short and stout', 418, reason="I'm a teapot")
        elif path == '/missing':
            self._send(b'not here', 404)
        else:
            self._send(b'', 500)

    do_GET = do_POST = do_PUT = _handle


@pytest.fixture
def start_proxy(handler, monkeypatch):
    import yt_dlp_test_host
    from pyodide.ffi import run_sync

    ids = []

    def start(env=None, origin=ORIGIN, key=None):
        reply = run_sync(yt_dlp_test_host.startProxy(
            json.dumps({'ALLOWED_ORIGINS': ORIGIN} if env is None else env), origin))
        ids.append(reply.id)
        url = f'http://127.0.0.1:{reply.port}/'
        monkeypatch.setenv('YTDLP_CORS_PROXY', url)
        if key:
            monkeypatch.setenv('YTDLP_CORS_PROXY_KEY', key)
        return url

    yield start
    for proxy_id in ids:
        run_sync(yt_dlp_test_host.stopProxy(proxy_id))


def raw_fetch(url, method, headers):
    from pyodide.code import run_js
    from pyodide.ffi import run_sync

    fetch = run_js('''(async (url, method, headers) => {
        const response = await fetch(url, {method, headers: JSON.parse(headers)});
        return JSON.stringify([response.status, Object.fromEntries(response.headers)]);
    })''')
    status, response_headers = json.loads(run_sync(fetch(url, method, json.dumps(headers))))
    return status, response_headers


@pytest.mark.parametrize('handler', ['Fetch'], indirect=True)
class TestFetchProxy:
    @classmethod
    def setup_class(cls):
        cls.httpd = start_http_server(ProxyTargetRequestHandler, http.server.ThreadingHTTPServer)
        cls.url = f'http://127.0.0.1:{http_server_port(cls.httpd)}'

    @classmethod
    def teardown_class(cls):
        cls.httpd.shutdown()

    def echo(self, rh, path='/echo', **kwargs):
        return json.loads(validate_and_send(rh, Request(f'{self.url}{path}', **kwargs)).read())

    def test_proxy_url_needs_http_scheme(self, handler, monkeypatch):
        monkeypatch.setenv('YTDLP_CORS_PROXY', 'proxy.example')
        with handler() as rh, pytest.raises(RequestError, match='http or https URL'):
            validate_and_send(rh, Request(f'{self.url}/payload'))

    def test_response_url_is_target(self, handler, start_proxy):
        start_proxy()
        with handler() as rh:
            res = validate_and_send(rh, Request(f'{self.url}/payload'))
            assert res.url == f'{self.url}/payload'
            assert res.status == 200
            assert res.reason == 'OK'
            assert res.read() == PAYLOAD

    def test_forbidden_headers_reach_target(self, handler, start_proxy):
        start_proxy()
        headers = {'User-Agent': 'proxy-test', 'Referer': 'https://ref.example/', 'Origin': 'https://o.example', 'Cookie': 'x=1'}
        with handler() as rh:
            received = self.echo(rh, headers=headers)['headers']
        assert received['user-agent'] == 'proxy-test'
        assert received['referer'] == 'https://ref.example/'
        assert received['origin'] == 'https://o.example'
        assert received['cookie'] == 'x=1'
        assert 'x-ytdlp-headers' not in received

    def test_non_ascii_header_value(self, handler, start_proxy):
        start_proxy()
        with handler() as rh:
            assert self.echo(rh, headers={'X-Name': 'caf\xe9'})['headers']['x-name'] == 'caf\xe9'

    def test_status_and_reason(self, handler, start_proxy):
        start_proxy()
        with handler() as rh, pytest.raises(HTTPError) as exc_info:
            validate_and_send(rh, Request(f'{self.url}/teapot'))
        assert exc_info.value.status == 418
        assert exc_info.value.reason == "I'm a teapot"
        assert exc_info.value.response.read() == b'short and stout'

    def test_http_error_body(self, handler, start_proxy):
        start_proxy()
        with handler() as rh, pytest.raises(HTTPError) as exc_info:
            validate_and_send(rh, Request(f'{self.url}/missing'))
        assert exc_info.value.status == 404
        assert exc_info.value.response.read() == b'not here'

    def test_target_unreachable(self, handler, start_proxy):
        start_proxy()
        with handler() as rh, pytest.raises(TransportError, match='CORS proxy error 502'):
            validate_and_send(rh, Request('http://127.0.0.1:1/'))

    @pytest.mark.parametrize('make_data', [
        lambda: b'request body',
        lambda: iter([b'request ', b'body']),
    ])
    def test_request_body(self, handler, start_proxy, make_data):
        start_proxy()
        with handler() as rh:
            received = self.echo(rh, data=make_data(), headers={'Content-Type': 'text/plain'})
        assert received['method'] == 'POST'
        assert received['body'] == 'request body'
        assert received['headers']['content-type'] == 'text/plain'

    def test_large_body_in_blocks(self, handler, start_proxy):
        start_proxy()
        with handler() as rh:
            res = validate_and_send(rh, Request(f'{self.url}/large'))
            total = 0
            while block := res.read(1 << 20):
                assert len(block) <= 1 << 20
                total += len(block)
        assert total == 4 << 20

    def test_range(self, handler, start_proxy):
        start_proxy()
        with handler() as rh:
            res = validate_and_send(rh, Request(f'{self.url}/range', headers={'Range': 'bytes=10-19'}))
            assert res.status == 206
            assert res.headers['Content-Range'] == f'bytes 10-19/{len(PAYLOAD)}'
            assert res.read() == PAYLOAD[10:20]

    def test_set_cookie_headers(self, handler, start_proxy):
        start_proxy()
        cookiejar = YoutubeDLCookieJar()
        with handler(cookiejar=cookiejar) as rh:
            validate_and_send(rh, Request(f'{self.url}/cookies')).read()
            assert sorted(c.name for c in cookiejar) == ['a', 'b']
            assert self.echo(rh)['headers']['cookie'] in ('a=1; b=2', 'b=2; a=1')

    def test_cookies_across_redirect(self, handler, start_proxy):
        start_proxy()
        cookiejar = YoutubeDLCookieJar()
        with handler(cookiejar=cookiejar) as rh:
            received = self.echo(rh, '/cookie-redirect', headers={'Cookie': 'sent=1'})
        assert received['path'] == '/echo'
        assert received['headers']['cookie'] == 'hop=1'
        assert [c.name for c in cookiejar] == ['hop']

    def test_cookie_jar_sent_with_request(self, handler, start_proxy):
        start_proxy()
        cookiejar = YoutubeDLCookieJar()
        cookiejar.set_cookie(http.cookiejar.Cookie(
            0, 'jar', '1', None, False, '127.0.0.1', True,
            False, '/', True, False, None, False, None, None, {}))
        with handler(cookiejar=cookiejar) as rh:
            assert self.echo(rh)['headers']['cookie'] == 'jar=1'

    @pytest.mark.parametrize('status, method, body', [
        (301, 'GET', ''),
        (302, 'GET', ''),
        (303, 'GET', ''),
        (307, 'POST', 'data'),
        (308, 'POST', 'data'),
    ])
    def test_redirect_method(self, handler, start_proxy, status, method, body):
        start_proxy()
        with handler() as rh:
            received = self.echo(rh, f'/redirect/{status}', data=b'data', headers={'Content-Type': 'text/plain'})
        assert received['path'] == '/echo'
        assert received['method'] == method
        assert received['body'] == body
        assert ('content-type' in received['headers']) == bool(body)

    def test_redirect_keeps_put(self, handler, start_proxy):
        start_proxy()
        with handler() as rh:
            received = self.echo(rh, '/redirect/307', method='PUT', data=b'data')
        assert received['method'] == 'PUT'

    @pytest.mark.parametrize('env, origin, key, match', [
        ({'ALLOWED_ORIGINS': ORIGIN}, 'https://evil.example', None, '403.*Origin not allowed'),
        ({'ALLOWED_ORIGINS': ORIGIN}, None, None, '403.*Origin not allowed'),
        ({}, ORIGIN, None, '403.*Origin not allowed'),
        ({'ALLOWED_ORIGINS': '*'}, ORIGIN, None, '403.*Origin not allowed'),
        ({'ALLOWED_ORIGINS': ORIGIN, 'REQUIRE_ACCESS_KEY': 'true'}, ORIGIN, None, '403.*ACCESS_KEY is not set'),
        ({'ALLOWED_ORIGINS': ORIGIN, 'ACCESS_KEY': 'secret'}, ORIGIN, None, '403.*Invalid access key'),
        ({'ALLOWED_ORIGINS': ORIGIN, 'ACCESS_KEY': 'secret'}, ORIGIN, 'wrong', '403.*Invalid access key'),
    ])
    def test_refused(self, handler, start_proxy, env, origin, key, match):
        start_proxy(env, origin, key)
        with handler() as rh, pytest.raises(RequestError, match=match):
            validate_and_send(rh, Request(f'{self.url}/payload'))

    @pytest.mark.parametrize('env, origin, key', [
        ({'ALLOWED_ORIGINS': f'https://other.example, {ORIGIN}'}, ORIGIN, None),
        ({'ALLOWED_ORIGINS': 'http://localhost:*'}, 'http://localhost:5173', None),
        ({'ALLOWED_ORIGINS': ORIGIN, 'ACCESS_KEY': 'secret'}, ORIGIN, 'secret'),
        ({'ALLOWED_ORIGINS': '*', 'ACCESS_KEY': 'secret'}, 'https://any.example', 'secret'),
        ({'ALLOWED_ORIGINS': '*', 'ACCESS_KEY': 'secret'}, None, 'secret'),
    ])
    def test_accepted(self, handler, start_proxy, env, origin, key):
        start_proxy(env, origin, key)
        with handler() as rh:
            assert validate_and_send(rh, Request(f'{self.url}/payload')).read() == PAYLOAD

    def test_localhost_wildcard_matches_ports_only(self, handler, start_proxy):
        start_proxy({'ALLOWED_ORIGINS': 'http://localhost:*'}, 'http://localhost.evil.example')
        with handler() as rh, pytest.raises(RequestError, match='Origin not allowed'):
            validate_and_send(rh, Request(f'{self.url}/payload'))

    def test_preflight(self, handler, start_proxy):
        proxy = start_proxy()
        status, headers = raw_fetch(proxy, 'OPTIONS', {'Origin': ORIGIN, 'Access-Control-Request-Method': 'POST'})
        assert status == 204
        assert headers['access-control-allow-origin'] == ORIGIN
        assert headers['access-control-allow-methods'] == 'POST'
        assert 'x-ytdlp-headers' in headers['access-control-allow-headers'].lower()

    def test_response_exposes_ytdlp_headers(self, handler, start_proxy):
        proxy = start_proxy()
        status, headers = raw_fetch(f'{proxy}?url={self.url}/payload', 'GET', {'Origin': ORIGIN})
        assert status == 200
        assert headers['access-control-allow-origin'] == ORIGIN
        assert headers['access-control-expose-headers'].lower() == 'x-ytdlp-status, x-ytdlp-reason, x-ytdlp-response-headers'

    @pytest.mark.parametrize('target', ['file:///etc/passwd', 'ftp://127.0.0.1/', 'not a url'])
    def test_non_http_target_refused(self, handler, start_proxy, target):
        proxy = start_proxy()
        status, _ = raw_fetch(f'{proxy}?url={target}', 'GET', {'Origin': ORIGIN})
        assert status == 400
