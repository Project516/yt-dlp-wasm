// The Python half of the library API, registered as `yt_dlp_wasm_api`.
// `call` takes and returns JSON so nothing needs converting between Python and JS.
export const PYTHON_API = String.raw`
import json
import os
import time
import traceback

import yt_dlp
from yt_dlp.utils import YoutubeDLError
from yt_dlp_wasm_events import emit

PROGRESS_INTERVAL = 0.1


def progress_hook():
    last = 0.0

    def hook(d):
        nonlocal last
        now = time.monotonic()
        if d.get('status') == 'downloading' and now - last < PROGRESS_INTERVAL:
            return
        last = now
        emit(json.dumps({
            'type': 'download',
            'status': d.get('status'),
            'downloadedBytes': d.get('downloaded_bytes'),
            'totalBytes': d.get('total_bytes') or d.get('total_bytes_estimate'),
            'speed': d.get('speed'),
            'eta': d.get('eta'),
            'filename': d.get('filename'),
        }, default=str))

    return hook


def postprocessor_hook():
    last = None

    def hook(d):
        nonlocal last
        event = json.dumps({
            'type': 'postprocessor',
            'status': d.get('status'),
            'postprocessor': d.get('postprocessor'),
            'filename': (d.get('info_dict') or {}).get('filepath'),
        }, default=str)
        # Some postprocessors report each stage twice
        if event != last:
            last = event
            emit(event)

    return hook


def run(request):
    os.chdir(request['cwd'])
    try:
        yt_dlp.main(request['argv'])
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else int(e.code is not None)
    return 0


def extract_info(request):
    with yt_dlp.YoutubeDL({'noprogress': True, **request['options']}) as ydl:
        return ydl.sanitize_info(ydl.extract_info(request['url'], download=False))


def download(request):
    files = []
    options = {
        'noprogress': True,
        **request['options'],
        'progress_hooks': [progress_hook()],
        'postprocessor_hooks': [postprocessor_hook()],
        'post_hooks': [files.append],
    }
    options['paths'] = {**options.get('paths', {}), 'home': request['home']}
    with yt_dlp.YoutubeDL(options) as ydl:
        ydl.download([request['url']])
    return list(dict.fromkeys(files))


OPERATIONS = {'run': run, 'extractInfo': extract_info, 'download': download}


def call(request):
    request = json.loads(request)
    try:
        return json.dumps({'result': OPERATIONS[request['op']](request)}, default=str)
    except Exception as e:
        error = {'type': type(e).__name__, 'message': str(e)}
        if not isinstance(e, YoutubeDLError):
            error['traceback'] = traceback.format_exc()
        return json.dumps({'error': error})
`;
