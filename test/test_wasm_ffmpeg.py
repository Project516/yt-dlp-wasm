#!/usr/bin/env python3

# Allow direct execution
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shutil
import subprocess

import pytest

from test.helper import FakeYDL
from yt_dlp.downloader.external import FFmpegFD
from yt_dlp.postprocessor.ffmpeg import (
    FFmpegConcatPP,
    FFmpegExtractAudioPP,
    FFmpegMergerPP,
    FFmpegPostProcessor,
    FFmpegPostProcessorError,
    FFmpegVideoRemuxerPP,
)
from yt_dlp.utils import Popen

pytestmark = pytest.mark.skipif(
    sys.platform != 'emscripten' or not FFmpegPostProcessor().available,
    reason='needs the ffmpeg bridge to the host')


def _ffmpeg(*args, cwd=None):
    _, stderr, returncode = Popen.run(
        ['ffmpeg', '-y', '-loglevel', 'error', *args], text=True, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.PIPE)
    assert returncode == 0, stderr


@pytest.fixture(scope='module')
def clips(tmp_path_factory):
    path = tmp_path_factory.mktemp('clips')
    video, audio = str(path / 'video.mp4'), str(path / 'audio.m4a')
    _ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video)
    _ffmpeg('-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac', audio)
    return video, audio


@pytest.fixture
def ydl():
    with FakeYDL() as ydl:
        yield ydl


def _streams(pp, path):
    return [stream['codec_type'] for stream in pp.get_metadata_object(path)['streams']]


def _merged(ydl, clips, tmp_path):
    video, audio = clips
    out = str(tmp_path / 'merged.mp4')
    info = {
        'filepath': out,
        'requested_formats': [
            {'vcodec': 'h264', 'acodec': 'none', 'protocol': 'https'},
            {'vcodec': 'none', 'acodec': 'aac', 'protocol': 'https'},
        ],
        '__files_to_merge': [video, audio],
    }
    FFmpegMergerPP(ydl).run(info)
    return out


def test_versions(ydl):
    versions = FFmpegPostProcessor.get_versions(ydl)
    assert versions['ffmpeg']
    assert versions['ffprobe']


def test_merge(ydl, clips, tmp_path):
    out = _merged(ydl, clips, tmp_path)
    assert sorted(_streams(FFmpegPostProcessor(ydl), out)) == ['audio', 'video']
    assert os.listdir(tmp_path) == ['merged.mp4']


def test_extract_audio(ydl, clips, tmp_path):
    pp = FFmpegPostProcessor(ydl)
    merged = _merged(ydl, clips, tmp_path)
    for codec, ext, codec_name in (('m4a', 'm4a', 'aac'), ('mp3', 'mp3', 'mp3')):
        path = str(tmp_path / f'{codec}-source.mp4')
        shutil.copy(merged, path)
        info = {'filepath': path, 'ext': 'mp4'}
        FFmpegExtractAudioPP(ydl, preferredcodec=codec).run(info)
        assert info['ext'] == ext
        assert _streams(pp, info['filepath']) == ['audio']
        assert pp.get_audio_codec(info['filepath']) == codec_name


def test_remux_to_mkv(ydl, clips, tmp_path):
    pp = FFmpegPostProcessor(ydl)
    merged = _merged(ydl, clips, tmp_path)
    info = {'filepath': merged, 'ext': 'mp4'}
    FFmpegVideoRemuxerPP(ydl, 'mkv').run(info)
    assert info['filepath'] == str(tmp_path / 'merged.mkv')
    assert 'matroska' in pp.get_metadata_object(info['filepath'])['format']['format_name']
    assert sorted(_streams(pp, info['filepath'])) == ['audio', 'video']


def test_relative_paths(ydl, clips, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    shutil.copy(clips[0], 'in.mp4')
    pp = FFmpegPostProcessor(ydl)
    pp.run_ffmpeg('in.mp4', 'out.mkv', ['-c', 'copy'])
    assert _streams(pp, 'out.mkv') == ['video']


@pytest.mark.parametrize('relative', [False, True])
def test_concat(ydl, clips, tmp_path, monkeypatch, relative):
    pp = FFmpegConcatPP(ydl)
    if relative:
        monkeypatch.chdir(tmp_path)
        shutil.copy(clips[0], 'in.mp4')
        in_files, out = ['in.mp4', 'in.mp4'], 'concat.mp4'
    else:
        in_files, out = [clips[0], clips[0]], str(tmp_path / 'concat.mp4')
    FFmpegPostProcessor.concat_files(pp, in_files, out)
    duration = float(pp.get_metadata_object(out)['format']['duration'])
    assert 1.8 < duration < 2.2
    assert not os.path.exists(f'{out}.concat')


def test_failure_reports_stderr(ydl, tmp_path):
    junk = tmp_path / 'junk.mp4'
    junk.write_bytes(b'not media')
    with pytest.raises(FFmpegPostProcessorError, match='Invalid data'):
        FFmpegPostProcessor(ydl).run_ffmpeg(str(junk), str(tmp_path / 'out.mkv'), [])
    assert not (tmp_path / 'out.mkv').exists()


def test_ffmpegfd_unavailable():
    assert not FFmpegFD.available()


def test_two_concat_lists(ydl, clips, tmp_path):
    parts = tmp_path / 'parts'
    parts.mkdir()
    lists = []
    for name, clip in (('v', clips[0]), ('a', clips[1])):
        shutil.copy(clip, parts / f'{name}.{clip.rpartition(".")[2]}')
        listing = tmp_path / f'{name}.txt'
        part = f'parts/{name}.{clip.rpartition(".")[2]}'
        listing.write_text(f"file '{part}'\nfile '{part}'\n")
        lists.append(str(listing))
    out = str(tmp_path / 'joined.mp4')
    _ffmpeg('-f', 'concat', '-safe', '0', '-i', lists[0], '-f', 'concat', '-safe', '0', '-i', lists[1],
            '-map', '0:v', '-map', '1:a', '-c', 'copy', out, cwd=str(tmp_path))
    pp = FFmpegPostProcessor(ydl)
    assert sorted(_streams(pp, out)) == ['audio', 'video']
    assert 1.8 < float(pp.get_metadata_object(out)['format']['duration']) < 2.2


def test_host_failure_is_oserror(monkeypatch):
    import types

    from pyodide.code import run_js

    failing = run_js("() => Promise.reject(new Error('core failed to load'))")
    monkeypatch.setitem(sys.modules, 'yt_dlp_host', types.SimpleNamespace(run_ffmpeg=lambda *args: failing()))
    with pytest.raises(OSError, match='core failed to load'):
        Popen.run(['ffmpeg', '-version'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
