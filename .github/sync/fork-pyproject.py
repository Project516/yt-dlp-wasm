#!/usr/bin/env python3
"""Re-applies the fork's edits to pyproject.toml after taking upstream's copy."""
import pathlib
import re
import sys
import tomllib

PATH = pathlib.Path('pyproject.toml')

URLS = '''[project.urls]
Documentation = "https://github.com/Project516/yt-dlp-wasm#readme"
Repository = "https://github.com/Project516/yt-dlp-wasm"
Tracker = "https://github.com/Project516/yt-dlp-wasm/issues"
'''

# (pattern, replacement) pairs. A pattern that does not match fails the sync.
EDITS = [
    (r'^license = .*$', 'license = "AGPL-3.0-or-later AND Unlicense"'),
    (r'^license-files = .*$', 'license-files = ["LICENSE", "LICENSE.upstream"]'),
    (r'^\[project\.urls\]\n(?:[^\[\n].*\n)*', URLS),
]
SDIST_LICENSE = '    "/LICENSE",  # included as license\n'
SDIST_LICENSE_UPSTREAM = '    "/LICENSE.upstream",  # included as license\n'


def main():
    text = PATH.read_text()
    for pattern, replacement in EDITS:
        text, count = re.subn(pattern, lambda _: replacement, text, flags=re.MULTILINE)
        if count != 1:
            sys.exit(f'pyproject.toml: {pattern!r} matched {count} times')
    if SDIST_LICENSE_UPSTREAM not in text:
        if text.count(SDIST_LICENSE) != 1:
            sys.exit('pyproject.toml: sdist include for /LICENSE not found')
        text = text.replace(SDIST_LICENSE, SDIST_LICENSE + SDIST_LICENSE_UPSTREAM)
    PATH.write_text(text)

    project = tomllib.loads(text)['project']
    assert project['license'] == 'AGPL-3.0-or-later AND Unlicense'
    assert project['urls']['Repository'] == 'https://github.com/Project516/yt-dlp-wasm'


if __name__ == '__main__':
    main()
