#!/usr/bin/env python3
"""Runs yt-dlp test HTTP servers for the Pyodide test run, which cannot use sockets.

Reads one JSON command per line on stdin, writes one JSON reply per line on stdout.
Exits when stdin closes.
"""
import functools
import http.server
import importlib
import itertools
import json
import os
import sys


def start(module, handler, server, certfile, cafile):
    from test.helper import start_http_server

    handler_class = functools.reduce(getattr, handler.split('.'), importlib.import_module(module))
    return start_http_server(
        handler_class, getattr(http.server, server), certfile=certfile, cafile=cafile)


def main(root):
    out = sys.stdout
    sys.stdout = sys.stderr  # keep stdout for replies only
    os.chdir(root)
    sys.path.insert(0, root)

    servers = {}
    ids = itertools.count()
    for line in sys.stdin:
        command = json.loads(line)
        reply = {'id': command['id']}
        try:
            if command['op'] == 'start':
                httpd = start(
                    command['module'], command['handler'], command['server'],
                    command.get('certfile'), command.get('cafile'))
                reply['server'] = next(ids)
                reply['port'] = httpd.server_address[1]
                servers[reply['server']] = httpd
            elif command['op'] == 'stop':
                httpd = servers.pop(command['server'])
                httpd.shutdown()
                httpd.server_close()
        except Exception as e:
            reply['error'] = f'{type(e).__name__}: {e}'
        print(json.dumps(reply), file=out, flush=True)


if __name__ == '__main__':
    main(sys.argv[1])
