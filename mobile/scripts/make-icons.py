"""Android launcher icons and splash from the desktop icon (build/icon.ico).

Usage: python mobile/scripts/make-icons.py
"""
import os
import sys
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.abspath(os.path.join(here, '..', '..'))
res = os.path.join(repo, 'mobile', 'android', 'app', 'src', 'main', 'res')
src = Image.open(os.path.join(repo, 'build', 'icon.ico'))
src.size = max(src.info.get('sizes'))
src = src.convert('RGBA')
BG = (27, 27, 27, 255)  # the app's dark background

DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def fit(img, size, scale):
    """The icon scaled to `scale` of a size x size transparent square."""
    inner = int(size * scale)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.alpha_composite(img.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    return out


for d, k in DENS.items():
    folder = os.path.join(res, f'mipmap-{d}')
    os.makedirs(folder, exist_ok=True)
    legacy = int(48 * k)
    fit(src, legacy, 1.0).save(os.path.join(folder, 'ic_launcher.png'))
    fit(src, legacy, 1.0).save(os.path.join(folder, 'ic_launcher_round.png'))
    # Adaptive icon foreground: 108 dp canvas, the visible circle is the middle 66 dp.
    fg = int(108 * k)
    fit(src, fg, 0.62).save(os.path.join(folder, 'ic_launcher_foreground.png'))

with open(os.path.join(res, 'values', 'ic_launcher_background.xml'), 'w', encoding='utf8') as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1B1B1B</color>\n</resources>\n')

# Splash: the icon small on the dark background, for every splash folder.
for name in os.listdir(res):
    if not name.startswith('drawable'):
        continue
    p = os.path.join(res, name, 'splash.png')
    if not os.path.exists(p):
        continue
    w, h = Image.open(p).size
    out = Image.new('RGBA', (w, h), BG)
    s = int(min(w, h) * 0.22)
    out.alpha_composite(src.resize((s, s), Image.LANCZOS), ((w - s) // 2, (h - s) // 2))
    out.convert('RGB').save(p)
print('icons and splash written')
sys.exit(0)
