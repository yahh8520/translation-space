"""生成可复现的应用图标，不依赖外部图片或字体。"""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parent.parent


def rounded(x, y, left, top, right, bottom, radius):
    near_x = min(max(x, left + radius), right - radius)
    near_y = min(max(y, top + radius), bottom - radius)
    return left <= x <= right and top <= y <= bottom and (x - near_x) ** 2 + (y - near_y) ** 2 <= radius ** 2


def png(size, template=False):
    rows = bytearray()
    for row in range(size):
        rows.append(0)
        for col in range(size):
            x, y = (col + .5) / size, (row + .5) / size
            background = rounded(x, y, .02, .02, .98, .98, .22)
            # 两条相向的译文线与箭头构成标识，模板图仅保留前景。
            mark = rounded(x, y, .22, .31, .76, .39, .035) or rounded(x, y, .24, .61, .78, .69, .035)
            mark |= .64 < x < .80 and abs(y - .35) < (.80 - x) * .85
            mark |= .20 < x < .36 and abs(y - .65) < (x - .20) * .85
            mark |= rounded(x, y, .23, .46, .57, .51, .025)
            if mark:
                color = (28, 32, 29, 255) if template else (239, 239, 214, 255)
            elif background and not template:
                color = (35 + int(y * 8), 64 + int(y * 7), 53 + int(y * 5), 255)
            else:
                color = (0, 0, 0, 0)
            rows.extend(color)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b'')


(ROOT / 'assets').mkdir(exist_ok=True)
(ROOT / 'build').mkdir(exist_ok=True)
(ROOT / 'assets/icon.png').write_bytes(png(512))
(ROOT / 'assets/trayTemplate.png').write_bytes(png(64, True))
icons = bytearray()
for kind, size in [(b'icp4', 16), (b'icp5', 32), (b'icp6', 64), (b'ic07', 128), (b'ic08', 256), (b'ic09', 512), (b'ic10', 1024)]:
    data = png(size)
    icons.extend(kind + struct.pack('>I', len(data) + 8) + data)
(ROOT / 'build/icon.icns').write_bytes(b'icns' + struct.pack('>I', len(icons) + 8) + icons)
data = png(256)
(ROOT / 'build/icon.ico').write_bytes(struct.pack('<HHH', 0, 1, 1) + struct.pack('<BBBBHHII', 0, 0, 0, 0, 1, 32, len(data), 22) + data)
print('已生成应用与托盘图标。')
