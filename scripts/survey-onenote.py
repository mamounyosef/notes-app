"""Counts which OneNote features actually appear in the exported pages, so the
importer is written against real data rather than guesses.

    python scripts/survey-onenote.py [.onenote-export]
"""
import collections
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

NS = {"one": "http://schemas.microsoft.com/office/onenote/2013/onenote"}

export = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".onenote-export")
pages = sorted((export / "pages").glob("*.xml"))

tags = collections.Counter()
styles = collections.Counter()
inline = collections.Counter()
per_page = []

for f in pages:
    root = ET.parse(f).getroot()
    name = root.get("name") or "(untitled)"
    counts = collections.Counter()
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        tags[tag] += 1
        counts[tag] += 1
        if tag == "OE":
            s = el.get("style")
            if s:
                for part in s.split(";"):
                    if part.strip():
                        styles[part.split(":")[0].strip()] += 1
        if tag == "T" and el.text:
            for m in re.findall(r"<(\w+)", el.text):
                inline[m] += 1
            for m in re.findall(r"style='([^']*)'", el.text):
                for part in m.split(";"):
                    if part.strip():
                        inline["css:" + part.split(":")[0].strip()] += 1
    per_page.append((name, counts))

print(f"pages: {len(pages)}\n")
print("== element tags ==")
for t, n in tags.most_common():
    print(f"{n:7d}  {t}")

print("\n== OE style properties ==")
for t, n in styles.most_common():
    print(f"{n:7d}  {t}")

print("\n== inline markup inside text ==")
for t, n in inline.most_common(30):
    print(f"{n:7d}  {t}")

print("\n== per page ==")
for name, c in per_page:
    bits = []
    for k in ("Outline", "OE", "Image", "Table", "InkDrawing", "InkWord", "List", "Bullet",
              "Number", "Tag", "Hyperlink", "MediaFile", "FutureObject"):
        if c.get(k):
            bits.append(f"{k}={c[k]}")
    print(f"  {name[:48]:50s} {' '.join(bits)}")
