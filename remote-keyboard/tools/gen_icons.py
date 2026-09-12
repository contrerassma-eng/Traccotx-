#!/usr/bin/env python3
"""Genera los PNG del ícono (Android < 8) y el banner de TV sin dependencias externas.

Uso:  python3 tools/gen_icons.py
"""
import os
import struct
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "src", "main", "res")
ACCENT = (0x38, 0xBD, 0xF8)
DARK = (0x0F, 0x17, 0x2A)
WHITE = (0xFF, 0xFF, 0xFF)
SS = 3  # supermuestreo para suavizar bordes


def png(path, w, h, pixel):
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    pr, pg, pb, pa = pixel(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)
                    r += pr * pa; g += pg * pa; b += pb * pa; a += pa
            n = SS * SS
            if a > 0:
                row += bytes((int(r / a), int(g / a), int(b / a), int(255 * a / n)))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    out += chunk(b"IDAT", zlib.compress(raw, 9))
    out += chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(out)


def in_rrect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def keyboard(x, y, s):
    """Dibuja el teclado en un cuadro de lado s (coordenadas 0..s). Devuelve color o None."""
    u = s / 108.0
    # cuerpo
    if in_rrect(x, y, 24 * u, 38 * u, 84 * u, 70 * u, 6 * u):
        col = WHITE
        keys = []
        keys += [(31 + 7 * i, 43, 5) for i in range(7)]
        keys += [(34 + 7 * i, 50, 5) for i in range(6)]
        keys += [(34, 57, 5), (41, 57, 26), (69, 57, 5)]
        for kx, ky, kw in keys:
            if kx * u <= x <= (kx + kw) * u and ky * u <= y <= (ky + 5) * u:
                col = DARK
        return col
    # punto y ondas wifi
    if (x - 54 * u) ** 2 + (y - 29 * u) ** 2 <= (2.5 * u) ** 2:
        return WHITE
    for rad in (10, 17):
        d = ((x - 54 * u) ** 2 + (y - 32 * u) ** 2) ** 0.5
        if abs(d - rad * u) <= 1.3 * u and y <= 32 * u and abs(x - 54 * u) <= rad * u * 0.75:
            return WHITE
    return None


def icon(size):
    def pixel(x, y):
        # fondo redondeado (estilo ícono clásico)
        if not in_rrect(x, y, 0, 0, size, size, size * 0.18):
            return (0, 0, 0, 0)
        # zona segura del ícono adaptativo: 66/108 → escalar para usar toda la caja
        scale = 108.0 / 72.0
        kx = (x - size / 2) * scale + size / 2
        ky = (y - size / 2) * scale + size / 2
        col = keyboard(kx, ky, size)
        return (*(col or ACCENT), 1.0)
    return pixel


def banner(w, h):
    def pixel(x, y):
        s = h * 1.15
        kx = x - (w / 2 - s / 2)
        ky = y - (h / 2 - s / 2)
        col = keyboard(kx, ky, s)
        return (*(col or ACCENT), 1.0)
    return pixel


if __name__ == "__main__":
    for folder, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        png(os.path.join(ROOT, f"mipmap-{folder}", "ic_launcher.png"), size, size, icon(size))
        print("mipmap-%s/ic_launcher.png" % folder)
    png(os.path.join(ROOT, "drawable-xhdpi", "tv_banner.png"), 320, 180, banner(320, 180))
    print("drawable-xhdpi/tv_banner.png")
