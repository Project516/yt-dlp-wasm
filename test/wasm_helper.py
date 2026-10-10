import http.server
import ssl
import sys
import threading


class SidecarServer:
    """Server running in a CPython process because Pyodide has no sockets or threads"""

    def __init__(self, handler_class, server_class, certfile, cafile):
        import yt_dlp_test_host
        from pyodide.ffi import run_sync

        self._run_sync = run_sync
        self._host = yt_dlp_test_host
        reply = run_sync(yt_dlp_test_host.start(
            handler_class.__module__, handler_class.__qualname__, server_class.__name__, certfile, cafile))
        self._id = reply.server
        self.server_address = ('127.0.0.1', reply.port)
        _sidecar_servers.append(self)

    def shutdown(self):
        if self in _sidecar_servers:
            _sidecar_servers.remove(self)
            self._run_sync(self._host.stop(self._id))

    server_close = shutdown


_sidecar_servers = []


def stop_sidecar_servers():
    for server in _sidecar_servers[:]:
        server.shutdown()


def start_http_server(handler_class, server_class=http.server.HTTPServer, *, certfile=None, cafile=None):
    """Start a test server on 127.0.0.1 and return it. With `cafile`, clients must present a certificate."""
    if sys.platform == 'emscripten':
        return SidecarServer(handler_class, server_class, certfile, cafile)

    httpd = server_class(('127.0.0.1', 0), handler_class)
    if certfile:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        if cafile:
            context.verify_mode = ssl.CERT_REQUIRED
            context.load_verify_locations(cafile=cafile)
        context.load_cert_chain(certfile, None)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    httpd.server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    httpd.server_thread.start()
    return httpd
