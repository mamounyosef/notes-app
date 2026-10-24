"""One comparison picture per task: the original, then models (rows) by engines (columns).

Usage: python scripts/diagram-bench/contact-sheet.py scripts/diagram-bench/config.json
Writes "Comparison - <task>.png" into the benchmark folder.
"""
import json
import re
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
out = Path(cfg["out"])
safe = lambda s: re.sub(r'[<>:"/\\|?*]+', "-", str(s)).strip()
CELL_W, CELL_H, HEAD, LEFT, PAD = 420, 520, 40, 230, 10
font = ImageFont.truetype("segoeui.ttf", 18)
small = ImageFont.truetype("segoeui.ttf", 14)
BG, FG, DIM = (27, 27, 29), (230, 230, 230), (150, 150, 150)
COL = {"ok": (152, 195, 121), "wrong engine": (229, 192, 123)}


def fit(img, w, h):
    img = img.convert("RGB")
    img.thumbnail((w, h))
    return img


for t in cfg["tasks"]:
    tdir = out / safe(f"{t['order']} {t['name']}")
    rows = []
    for m in cfg["models"]:
        if m.get("tasks") and t["id"] not in m["tasks"]:
            continue
        cells = []
        for e in cfg["engines"]:
            mf = tdir / safe(e["name"]) / f"{safe(m['name'])} - meta.json"
            meta = json.loads(mf.read_text(encoding="utf-8")) if mf.exists() else None
            cells.append((e, meta, mf.parent))
        if any(c[1] and c[1]["status"] != "error" for c in cells):
            rows.append((m, cells))
    if not rows:
        continue
    ref = Image.open(out / "References" / f"{safe(t['name'])}.png") if t.get("ref") else None
    ref_h = CELL_H if ref else 60
    W = LEFT + CELL_W * len(cfg["engines"]) + PAD
    H = HEAD + ref_h + PAD + len(rows) * (CELL_H + 30) + PAD
    sheet = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    d.text((PAD, 8), f"{t['order']}. {t['name']}", fill=FG, font=font)
    y = HEAD
    if ref:
        d.text((PAD, y + 4), "Original", fill=FG, font=font)
        sheet.paste(fit(ref, CELL_W * 2, ref_h - PAD), (LEFT, y))
    else:
        d.text((PAD, y + 4), "Text prompt: " + t["prompt"][:160], fill=DIM, font=small)
    y += ref_h + PAD
    for i, e in enumerate(cfg["engines"]):
        d.text((LEFT + i * CELL_W + 6, y), e["name"], fill=FG, font=font)
    y += 28
    for m, cells in rows:
        d.text((PAD, y + 6), m["name"], fill=FG, font=small)
        for i, (e, meta, folder) in enumerate(cells):
            x = LEFT + i * CELL_W
            d.rectangle((x + 2, y, x + CELL_W - 4, y + CELL_H - 4), outline=(60, 60, 64))
            if not meta:
                d.text((x + 10, y + 10), "not run", fill=DIM, font=small)
                continue
            status = meta["status"]
            if status != "error" and meta.get("drawings"):
                dr = meta["drawings"][0]
                p = folder / (dr.get("big") or dr["png"])
                if p.exists():
                    sheet.paste(fit(Image.open(p), CELL_W - 12, CELL_H - 34), (x + 6, y + 4))
            label = status if status != "error" else "service error (quota)"
            d.text((x + 8, y + CELL_H - 26), f"{label} · {meta.get('seconds', '?')}s", fill=COL.get(status.replace(" (timed out)", ""), (224, 108, 117)), font=small)
        y += CELL_H + 2
    sheet.save(out / f"Comparison - {safe(t['name'])}.png")
    print("wrote", out / f"Comparison - {safe(t['name'])}.png", sheet.size)
