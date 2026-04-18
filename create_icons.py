#!/usr/bin/env python3
"""
TRarXiv アイコン生成スクリプト
実行: python3 create_icons.py
生成先: icons/icon{16,48,128}.png
"""

import os
import struct
import zlib

def create_png(size):
    BG     = (26,  86, 219)   # #1a56db  blue
    ACCENT = (96, 165, 250)   # #60a5fa  light blue
    WHITE  = (255, 255, 255)

    img = [BG] * (size * size)

    def px(x, y):
        return y * size + x

    def draw_rect(x0, y0, x1, y1, color):
        for y in range(max(0, y0), min(size, y1)):
            for x in range(max(0, x0), min(size, x1)):
                img[px(x, y)] = color

    # Rounded corners
    r = max(2, size // 8)
    s = size
    for y in range(s):
        for x in range(s):
            in_corner = (
                (x < r    and y < r    and (x-r)**2+(y-r)**2 > r*r) or
                (x >= s-r and y < r    and (x-(s-r-1))**2+(y-r)**2 > r*r) or
                (x < r    and y >= s-r and (x-r)**2+(y-(s-r-1))**2 > r*r) or
                (x >= s-r and y >= s-r and (x-(s-r-1))**2+(y-(s-r-1))**2 > r*r)
            )
            img[px(x, y)] = (0, 0, 0) if in_corner else BG

    # Draw "T"
    m     = size // 8
    thick = max(1, size // 8)
    cx    = size // 2
    draw_rect(m, m, size - m, m + thick * 2, WHITE)   # horizontal bar
    draw_rect(cx - thick, m, cx + thick, size - m, WHITE)  # vertical bar

    # Bottom accent line
    draw_rect(m, size - m - thick, size - m, size - m, ACCENT)

    # Encode PNG (RGB, no alpha)
    def make_png(pixels, w, h):
        def pack_row(y):
            row = b'\x00'
            for x in range(w):
                row += bytes(pixels[y * w + x][:3])
            return row

        raw = b''.join(pack_row(y) for y in range(h))
        compressed = zlib.compress(raw, 9)

        def chunk(name, data):
            c = name + data
            return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

        ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
        png  = b'\x89PNG\r\n\x1a\n'
        png += chunk(b'IHDR', ihdr)
        png += chunk(b'IDAT', compressed)
        png += chunk(b'IEND', b'')
        return png

    return make_png(img, size, size)


def main():
    os.makedirs('icons', exist_ok=True)
    for size in (16, 48, 128):
        data = create_png(size)
        path = f'icons/icon{size}.png'
        with open(path, 'wb') as f:
            f.write(data)
        print(f'Created {path} ({len(data)} bytes)')
    print('Done!')


if __name__ == '__main__':
    main()
