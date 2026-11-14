"""Adds plain-color fallbacks before color-mix() declarations in mobile.css.

Android WebView before Chrome 111 does not know color-mix() and drops the
whole declaration; the line before it then still gives a sensible color.
Run again after editing mobile.css (it skips lines that already have one).
Usage: python mobile/scripts/css-fallbacks.py
"""
import os
import re

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'ui', 'mobile.css')
lines = open(path, encoding='utf8').read().split('\n')
MIX = re.compile(r'color-mix\(in srgb,\s*([^,()]+(?:\([^()]*\))?)\s+(\d+)%\s*,\s*([^()]+?(?:\([^()]*\))?)\s*\)')


def plain(value: str) -> str:
    def rep(m):
        a, pct, b = m.group(1).strip(), int(m.group(2)), m.group(3).strip()
        if b == 'transparent' and pct < 50:
            return 'transparent'
        return a if pct >= 50 else b
    return MIX.sub(rep, value)


out = []
for i, line in enumerate(lines):
    m = re.match(r'^(\s+)([a-z-]+):\s*(.*color-mix.*);\s*$', line)
    if m and not m.group(2).startswith('--'):
        fb = f'{m.group(1)}{m.group(2)}: {plain(m.group(3))};'
        if 'color-mix' not in fb and (not out or out[-1].strip() != fb.strip()):
            out.append(fb)
    out.append(line)
open(path, 'w', encoding='utf8').write('\n'.join(out))
print('fallbacks added:', len(out) - len(lines))
