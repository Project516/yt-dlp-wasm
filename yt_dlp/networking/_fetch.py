from __future__ import annotations

import sys

if sys.platform != 'emscripten':
    raise ImportError('The fetch request handler is only available on emscripten')

import io
import json
import os
import string
import urllib.parse
import urllib.request
from email.message import Message

import js
from pyodide.code import run_js
from pyodide.ffi import JsException, can_run_sync, run_sync, to_js

from ._helper import get_redirect_method
from .common import RequestHandler, Response, register_preference, register_rh
from .exceptions import (
    CertificateVerifyError,
    HTTPError,
    IncompleteRead,
    RequestError,
    SSLError,
    TransportError,
    UnsupportedRequest,
)
from ..utils import int_or_none
from ..utils.networking import normalize_url

_JS = run_js('''({
    isNode: typeof process !== 'undefined' && !!process.versions?.node,
    async fetch(url, init, timeout) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeout);
        try {
            let request;
            try {
                request = new Request(url, {...init, signal: controller.signal});
            } catch (error) {
                error.invalidRequest = true;
                throw error;
            }
            const response = await fetch(request);
            return {
                status: response.status,
                reason: response.statusText,
                url: response.url,
                headers: Array.from(response.headers),
                reader: response.body?.getReader(),
                controller,
            };
        } finally {
            clearTimeout(timer);
        }
    },
    async read(reader, controller, timeout) {
        const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeout);
        try {
            const {done, value} = await reader.read();
            return done ? undefined : value;
        } finally {
            clearTimeout(timer);
        }
    },
    cancel(reader) {
        reader.cancel().catch(() => {});
    },
})''')

_PROXY_ENV = 'YTDLP_CORS_PROXY'
_PROXY_KEY_ENV = 'YTDLP_CORS_PROXY_KEY'

_REDIRECT_STATUSES = (301, 302, 303, 307, 308)
_MAX_REDIRECTIONS = 10
_MAX_REPEATS = 4

# Node.js codes. Browsers report every TLS failure as a generic network error.
_CERTIFICATE_ERROR_CODES = frozenset({
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'CERT_REVOKED',
    'CERT_UNTRUSTED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'HOSTNAME_MISMATCH',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
})


def _check_can_run_sync():
    if not can_run_sync():
        raise RequestError(
            'The fetch request handler needs JavaScript Promise Integration. '
            'Python must be entered through runPythonAsync')


def _js_error_message(error: JsException):
    message = f'{error.name}: {error.message}'
    cause = getattr(error, 'cause', None)
    if cause is not None:
        detail = getattr(cause, 'code', None) or getattr(cause, 'message', None)
        if detail:
            message += f' ({detail})'
    return message


def _handle_js_error(error: JsException):
    cause = getattr(error, 'cause', None)
    code = getattr(cause, 'code', None)
    msg = _js_error_message(error)
    if code in _CERTIFICATE_ERROR_CODES:
        raise CertificateVerifyError(msg, cause=error) from error
    if isinstance(code, str) and code.startswith(('ERR_SSL_', 'ERR_TLS_')):
        raise SSLError(msg, cause=error) from error
    raise TransportError(msg, cause=error) from error


def _read_request_data(data):
    if data is None or isinstance(data, bytes):
        return data
    if isinstance(data, io.IOBase):
        return data.read()
    return b''.join(data)


def _redirect_url(url, location):
    # Same normalization as urllib's HTTPRedirectHandler, which treats header values as iso-8859-1
    parts = urllib.parse.urlparse(location)
    if not parts.path and parts.netloc:
        parts = parts._replace(path='/')
    location = urllib.parse.quote(
        urllib.parse.urlunparse(parts), encoding='iso-8859-1', safe=string.punctuation)
    return normalize_url(urllib.parse.urljoin(url, location))


def _should_strip_auth(old_url, new_url):
    # Same policy as requests: keep it within an origin and on an http to https upgrade
    old, new = urllib.parse.urlsplit(old_url), urllib.parse.urlsplit(new_url)
    if old.hostname != new.hostname:
        return True
    if old.scheme == 'http' and new.scheme == 'https' and old.port in (80, None) and new.port in (443, None):
        return False
    return old.scheme != new.scheme or old.port != new.port


class _CookieResponse:
    def __init__(self, headers: Message):
        self._headers = headers

    def info(self):
        return self._headers


class FetchBody(io.RawIOBase):
    """Reads a fetch response body on demand"""

    def __init__(self, reader, controller, timeout, expected_length):
        self._reader = reader
        self._controller = controller
        self._timeout = timeout
        self._expected_length = expected_length
        self._received = 0
        self._pending = []
        self._pending_length = 0
        self.eof = reader is None

    def readable(self):
        return True

    def _read_chunk(self):
        _check_can_run_sync()
        try:
            chunk = run_sync(_JS.read(self._reader, self._controller, self._timeout))
        except JsException as e:
            self.eof = True
            if self._is_incomplete() and e.name != 'TimeoutError':
                raise self._incomplete_read(e) from e
            _handle_js_error(e)
        if chunk is None:
            self.eof = True
            if self._is_incomplete():
                raise self._incomplete_read()
            return b''
        chunk = chunk.to_bytes()
        self._received += len(chunk)
        return chunk

    def _is_incomplete(self):
        return self._expected_length is not None and self._received < self._expected_length

    def _incomplete_read(self, cause=None):
        return IncompleteRead(
            partial=self._pending_length, expected=self._expected_length - self._received, cause=cause)

    @property
    def exhausted(self):
        return self.eof and not self._pending

    def read(self, amt=None):
        if amt is not None and amt < 0:
            amt = None
        while not self.eof and (amt is None or self._pending_length < amt):
            chunk = self._read_chunk()
            self._pending.append(chunk)
            self._pending_length += len(chunk)

        data = b''.join(self._pending)
        if amt is not None and len(data) > amt:
            data, rest = data[:amt], data[amt:]
            self._pending = [rest]
        else:
            self._pending = []
        self._pending_length = sum(map(len, self._pending))
        return data

    def close(self):
        if not self.closed and not self.eof and self._reader is not None:
            _JS.cancel(self._reader)
        self._pending = []
        super().close()


class FetchResponseAdapter(Response):
    def __init__(self, fp: FetchBody, url, headers: Message, status, reason):
        super().__init__(fp=fp, url=url, headers=headers, status=status, reason=reason)

    def read(self, amt=None):
        if self.closed:
            return b''
        data = self.fp.read(amt)
        if self.fp.exhausted:
            self.close()
        return data


@register_rh
class FetchRH(RequestHandler):

    """Fetch RequestHandler
    Sends requests with the host's fetch function, so it works in browsers and Node.js.
    https://developer.mozilla.org/docs/Web/API/Fetch_API
    """
    _SUPPORTED_URL_SCHEMES = ('http', 'https')
    _SUPPORTED_PROXY_SCHEMES = ()
    _SUPPORTED_FEATURES = ()
    RH_NAME = 'fetch'

    def _check_extensions(self, extensions):
        super()._check_extensions(extensions)
        extensions.pop('cookiejar', None)
        extensions.pop('timeout', None)
        for unsupported in ('legacy_ssl', 'keep_header_casing'):
            if not extensions.get(unsupported):
                extensions.pop(unsupported, None)

    def _validate(self, request):
        super()._validate(request)
        if not self.verify:
            raise UnsupportedRequest('Disabling certificate verification is not supported')
        if self.legacy_ssl_support:
            raise UnsupportedRequest('Legacy server connect is not supported')
        if any(self._client_cert.values()):
            raise UnsupportedRequest('Client certificates are not supported')
        if self.source_address:
            raise UnsupportedRequest('Binding a source address is not supported')

    def _send(self, request):
        _check_can_run_sync()
        cookiejar = self._get_cookiejar(request)
        timeout = self._calculate_timeout(request)
        method = request.method
        url = request.url
        data = _read_request_data(request.data)
        headers = {k: v for k, v in self._get_headers(request).items() if k.title() != 'Content-Length'}
        proxy = os.environ.get(_PROXY_ENV)
        # Browsers return opaque responses for manual redirects. A proxy reports them as data.
        follow_in_python = _JS.isNode or bool(proxy)
        origin_req_host = urllib.request.Request(url).origin_req_host

        visited = {}
        redirect_loop = False
        while True:
            cookie_request = urllib.request.Request(
                url, headers={k: v for k, v in headers.items() if k.title() == 'Cookie'},
                origin_req_host=origin_req_host, unverifiable=bool(visited))
            cookiejar.add_cookie_header(cookie_request)
            request_headers = dict(headers)
            if cookie := cookie_request.get_header('Cookie'):
                request_headers['Cookie'] = cookie

            res = self._fetch(url, method, request_headers, data, timeout, follow_in_python, proxy)
            cookiejar.extract_cookies(_CookieResponse(res.headers), cookie_request)

            if not (follow_in_python and res.status in _REDIRECT_STATUSES):
                break
            location = res.headers.get('Location')
            if not location:
                break
            try:
                new_url = _redirect_url(url, location)
            except ValueError:
                break
            if urllib.parse.urlparse(new_url).scheme not in self._SUPPORTED_URL_SCHEMES:
                break
            if visited.get(new_url, 0) >= _MAX_REPEATS or len(visited) >= _MAX_REDIRECTIONS:
                redirect_loop = True
                break
            visited[new_url] = visited.get(new_url, 0) + 1

            remove_headers = ['Cookie']
            new_method = get_redirect_method(method, res.status)
            if new_method != method:
                data = None
                remove_headers.extend(['Content-Length', 'Content-Type'])
            if _should_strip_auth(url, new_url):
                remove_headers.append('Authorization')
            headers = {k: v for k, v in headers.items() if k.title() not in remove_headers}
            method, url = new_method, new_url
            res.close()

        if not 200 <= res.status < 300:
            raise HTTPError(res, redirect_loop=redirect_loop)
        return res

    def _fetch(self, url, method, headers, data, timeout, follow_in_python, proxy):
        init = {
            'method': method,
            'redirect': 'manual' if follow_in_python else 'follow',
            'cache': 'no-store',
        }
        fetch_url = url
        if proxy:
            fetch_url = f'{proxy}?url={urllib.parse.quote(url, safe="")}'
            headers = {'X-Ytdlp-Headers': json.dumps(headers)}
            if key := os.environ.get(_PROXY_KEY_ENV):
                headers['X-Ytdlp-Key'] = key
        init['headers'] = list(headers.items())
        if data is not None:
            init['body'] = data

        try:
            res = run_sync(_JS.fetch(fetch_url, to_js(init, dict_converter=js.Object.fromEntries), int(timeout * 1000)))
        except JsException as e:
            if getattr(e, 'invalidRequest', False):
                raise RequestError(_js_error_message(e), cause=e) from e
            _handle_js_error(e)

        status, reason, raw_headers = res.status, res.reason, res.headers.to_py()
        if proxy:
            status, reason, raw_headers = self._unwrap_proxy_response(res, int(timeout * 1000))

        response_headers = Message()
        for name, value in raw_headers:
            response_headers.add_header(name, value)

        # fetch decodes the body, so Content-Length no longer describes it
        expected_length = int_or_none(response_headers.get('Content-Length'))
        if response_headers.get('Content-Encoding', 'identity').strip().lower() != 'identity':
            del response_headers['Content-Length']
            expected_length = None
        if method == 'HEAD':
            expected_length = None

        return FetchResponseAdapter(
            FetchBody(res.reader, res.controller, int(timeout * 1000), expected_length),
            url=url if follow_in_python else (res.url or url),
            headers=response_headers, status=status, reason=reason or None)

    @staticmethod
    def _unwrap_proxy_response(res, timeout_ms):
        proxy_headers = {name.lower(): value for name, value in res.headers.to_py()}
        if 'x-ytdlp-status' not in proxy_headers:
            body = FetchBody(res.reader, res.controller, timeout_ms, None)
            detail = body.read(500).decode(errors='replace')
            body.close()
            error_class = TransportError if res.status >= 500 else RequestError
            raise error_class(f'CORS proxy error {res.status}: {detail.strip() or res.reason}')
        return (
            int(proxy_headers['x-ytdlp-status']),
            proxy_headers.get('x-ytdlp-reason'),
            json.loads(proxy_headers.get('x-ytdlp-response-headers', '[]')))


@register_preference(FetchRH)
def fetch_preference(rh, request):
    return 200
