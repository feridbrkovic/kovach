"""Generate the Local Kovach brand files into the folder given as the first argument.

Needs: python3 with fonttools, uharfbuzz and brotli; rsvg-convert on PATH.
The .ico and .icns files are built from the PNGs (see docs/assets/brand/README.md).
"""
import io
import re
import os
import subprocess
import sys

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
# Space Grotesk WOFF files (500 and 700, latin), e.g. from the @fontsource/space-grotesk npm package.
FONTS = os.environ.get("SPACE_GROTESK_DIR", os.path.join(HERE, "font", "package", "files"))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

INK = "#16181D"
PAPER = "#F4F5F7"
EMBER = "#E8642C"
MUTED_LIGHT = "#5B606B"
MUTED_DARK = "#A9AEB8"

# Mark in a 64-unit box.
CHEVRON = "M14 21L19.5 15.5L36 32L19.5 48.5L14 43L25 32Z"
INGOT = "M34 42h17v7H34z"


def mark_paths(ink, ember=EMBER):
    return f'<path d="{CHEVRON}" fill="{ink}"/><path d="{INGOT}" fill="{ember}"/>'


class Face:
    def __init__(self, weight):
        path = os.path.join(FONTS, f"space-grotesk-latin-{weight}-normal.woff")
        self.tt = TTFont(path)
        self.tt.flavor = None  # decompress WOFF so the shaper can read it
        buf = io.BytesIO()
        self.tt.save(buf)
        self.tt = TTFont(io.BytesIO(buf.getvalue()))
        self.hb_font = hb.Font(hb.Face(buf.getvalue()))
        self.upem = self.tt["head"].unitsPerEm
        self.glyphs = self.tt.getGlyphSet()
        self.order = self.tt.getGlyphOrder()

    def run(self, text, size, x, baseline):
        """Return (svg path d, advance) for text set at `size` units, starting at x on `baseline`."""
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self.hb_font, buf, {"kern": True, "liga": True})
        k = size / self.upem
        pen = SVGPathPen(self.glyphs)
        cursor = 0
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            name = self.order[info.codepoint]
            gx = x + (cursor + pos.x_offset) * k
            tpen = TransformPen(pen, (k, 0, 0, -k, gx, baseline - pos.y_offset * k))
            self.glyphs[name].draw(tpen)
            cursor += pos.x_advance
        d = re.sub(r"-?\d+\.\d+", lambda m: f"{float(m.group()):.2f}".rstrip("0").rstrip("."), pen.getCommands())
        return d, cursor * k

    def cap_height(self):
        return self.tt["OS/2"].sCapHeight / self.upem


medium, bold = Face(500), Face(700)


def wordmark(muted, ink, *, with_mark=True):
    """Lockup: mark + 'Local Kovach'. Returns (inner svg, width, height) in units where the mark is 64."""
    cap = 31.0  # cap height in units, matches the mark's visual height
    size = cap / bold.cap_height()
    baseline = 48.0
    x = 51 + 13 if with_mark else 0  # mark ink ends at x=51
    d1, w1 = medium.run("Local", size, x, baseline)
    space = size * 0.24
    d2, w2 = bold.run("Kovach", size, x + w1 + space, baseline)
    width = x + w1 + space + w2 + 2
    inner = (mark_paths(ink) if with_mark else "") + f'<path d="{d1}" fill="{muted}"/><path d="{d2}" fill="{ink}"/>'
    return inner, width, 64


def svg(w, h, inner, view=None, title="Local Kovach"):
    vb = view or f"0 0 {w:g} {h:g}"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:g}" height="{h:g}" viewBox="{vb}" '
        f'role="img" aria-label="{title}"><title>{title}</title>{inner}</svg>\n'
    )


def write(name, text):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(text)


def png(src, dst, w, h=None):
    h = h or w
    subprocess.run(["rsvg-convert", "-w", str(w), "-h", str(h), "-o", os.path.join(OUT, dst), os.path.join(OUT, src)], check=True)


# Mark on its own (transparent background).
write("mark-light.svg", svg(64, 64, mark_paths(INK)))
write("mark-dark.svg", svg(64, 64, mark_paths(PAPER)))

# Wordmark lockups.
inner, w, h = wordmark(MUTED_LIGHT, INK)
write("wordmark-light.svg", svg(round(w - 12, 2), h, inner, view=f"12 0 {w - 12:.2f} {h}"))
inner, w, h = wordmark(MUTED_DARK, PAPER)
write("wordmark-dark.svg", svg(round(w - 12, 2), h, inner, view=f"12 0 {w - 12:.2f} {h}"))

# macOS app icon: 1024 canvas, 824 tile with the standard corner radius, mark centred.
s = 8.0
tx, ty = 512 - 32.5 * s, 512 - 32.25 * s
icon = (
    f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{INK}"/>'
    f'<g transform="translate({tx:g} {ty:g}) scale({s:g})">{mark_paths(PAPER)}</g>'
)
write("app-icon.svg", svg(1024, 1024, icon))
png("app-icon.svg", "app-icon-1024.png", 1024)

# Favicon: full-bleed tile so it reads on light and dark tabs.
fav = f'<rect width="64" height="64" rx="14" fill="{INK}"/><g transform="translate(8 8) scale(.75)">{mark_paths(PAPER)}</g>'
write("favicon.svg", svg(64, 64, fav))
for px in (16, 32, 48, 180, 512):
    png("favicon.svg", f"favicon-{px}.png", px)

# GitHub social preview, 1280x640.
inner, w, h = wordmark(MUTED_DARK, PAPER)
scale = 980 / w
tag_size = 34
d_tag, tag_w = medium.run("A coding agent for macOS that runs on your own machine.", tag_size, 0, 0)
social = (
    f'<rect width="1280" height="640" fill="{INK}"/>'
    f'<g transform="translate({(1280 - (w - 12) * scale) / 2 - 12 * scale:g} 210) scale({scale:g})">{inner}</g>'
    f'<g transform="translate({(1280 - tag_w) / 2:g} 470)"><path d="{d_tag}" fill="{MUTED_DARK}"/></g>'
)
write("social-preview.svg", svg(1280, 640, social))
png("social-preview.svg", "social-preview.png", 1280, 640)

print("ok", sorted(os.listdir(OUT)))
