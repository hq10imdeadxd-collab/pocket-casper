"""Draws Pocket Casper's home-screen icons: Casper's crescent on a full-bleed charcoal square.

iOS rounds the corners itself, so these are plain squares (a rounded tile would get double corners).
Run from anywhere: python tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

MOON = (50, 50, 31)      # same crescent as Casper (local_agent/assets/make_icon.py)
BITE = (64, 37.5, 26.5)
TOP, BOTTOM = (255, 255, 255), (168, 205, 240)
BG = (30, 30, 30)
OUT = Path(__file__).resolve().parent.parent / "icons"


def gradient(size):
    g = Image.new("RGB", (1, 256))
    for y in range(256):
        t = y / 255
        g.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return g.resize(size, Image.BICUBIC)


def render(px, inset=1.0):
    """inset < 1 shrinks the moon (maskable icons need it inside the centre 80%)."""
    s = px * 4
    k = s / 100 * inset
    off = s * (1 - inset) / 2
    img = Image.new("RGB", (s, s), BG)
    mask = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(mask)
    for (x, y, r), fill in ((MOON, 255), (BITE, 0)):
        d.ellipse([off + (x - r) * k, off + (y - r) * k, off + (x + r) * k, off + (y + r) * k], fill=fill)
    img.paste(gradient((s, s)), (0, 0), mask)
    return img.resize((px, px), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    render(180).save(OUT / "apple-touch-icon.png")
    render(192).save(OUT / "icon-192.png")
    render(512).save(OUT / "icon-512.png")
    render(512, inset=0.78).save(OUT / "icon-maskable-512.png")
    render(32).save(OUT / "favicon-32.png")
    print("icons written to", OUT)
