"""Copies the reference figures into scripts/diagram-bench/refs as PNG.

Usage: python scripts/diagram-bench/prep-refs.py <folder with 1.png 2.webp 3.webp 4.jpg>
DeepSeek's sheet also holds charts: only its first architecture (V4-Flash) is kept.
"""
import sys
from pathlib import Path
from PIL import Image

src = Path(sys.argv[1])
out = Path(__file__).parent / "refs"
out.mkdir(exist_ok=True)

Image.open(src / "1.png").convert("RGB").save(out / "des.png")
Image.open(src / "2.webp").convert("RGB").save(out / "llama3.png")
Image.open(src / "3.webp").convert("RGB").save(out / "transformer.png")
ds = Image.open(src / "4.jpg").convert("RGB")
w, h = ds.size
print("deepseek size", w, h)
# Left architecture panel: about 42% of the width, 47% of the height.
ds.crop((0, 0, int(w * 0.42), int(h * 0.47))).save(out / "deepseek-v4.png")
for f in sorted(out.glob("*.png")):
    print(f.name, Image.open(f).size)
