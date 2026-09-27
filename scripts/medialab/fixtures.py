#!/usr/bin/env python3
"""Deterministic fake-capture media for the Bridge media lab.

Chromium's fake capture devices can read a WAV (audio) and a Y4M (video)
file. Every lab client gets its own fixtures so a receiver can prove WHICH
sender it is hearing and seeing, not just that some packets arrived:

  audio  a pure sine tone at a per-client frequency (440 Hz + 220 Hz * i)
  video  640x480 @ 30 fps; the top quarter is a solid per-client identity
         colour, the rest moving bars plus a moving noise patch so the
         encoder has real work (bitrate adaptation is content dependent)

usage: fixtures.py <out-dir> <client-index> [<client-index> ...]
"""

import math
import os
import random
import struct
import sys
import wave

RATE = 48000
SECONDS = 10
W, H, FPS, FRAMES = 640, 480, 30, 60
BAND = H // 4

# Identity colours (Y, U, V) chosen far apart in chroma.
COLOURS = [
    (82, 90, 240),    # red
    (145, 54, 34),    # green
    (41, 240, 110),   # blue
    (210, 16, 146),   # yellow
    (107, 202, 222),  # magenta
    (170, 166, 16),   # cyan
    (120, 200, 60),   # violet-ish
    (160, 60, 200),   # orange-ish
]


def tone_hz(index):
    return 440 + 220 * index


def write_wav(path, freq):
    frames = bytearray()
    for n in range(RATE * SECONDS):
        v = int(0.3 * 32767 * math.sin(2 * math.pi * freq * n / RATE))
        frames += struct.pack('<h', v)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))


def write_y4m(path, colour, seed):
    rnd = random.Random(seed)
    y_id, u_id, v_id = colour
    band_y = bytes([y_id]) * (W * BAND)
    band_uv_u = bytes([u_id]) * ((W // 2) * (BAND // 2))
    band_uv_v = bytes([v_id]) * ((W // 2) * (BAND // 2))
    rest_uv = bytes([128]) * ((W // 2) * ((H - BAND) // 2))
    bar = bytes([60]) * 40 + bytes([200]) * 40
    with open(path, 'wb') as f:
        f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
        for frame in range(FRAMES):
            rows = []
            for block in range((H - BAND) // 8):
                shift = (frame * 8 + block * 13) % 80
                line = (bar * (W // 80 + 2))[shift:shift + W]
                rows.append(line * 8)
            y = bytearray(band_y + b''.join(rows))
            assert len(y) == W * H
            # Moving 192x144 noise patch below the identity band.
            px = (frame * 7) % (W - 192)
            py = BAND + (frame * 3) % (H - BAND - 144)
            for r in range(144):
                start = (py + r) * W + px
                y[start:start + 192] = bytes(rnd.getrandbits(8) for _ in range(192))
            f.write(b'FRAME\n')
            f.write(bytes(y))
            f.write(band_uv_u + rest_uv)
            f.write(band_uv_v + rest_uv)


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for arg in sys.argv[2:]:
        i = int(arg)
        wav = os.path.join(out, f'tone-{i}.wav')
        y4m = os.path.join(out, f'video-{i}.y4m')
        if not os.path.exists(wav):
            write_wav(wav, tone_hz(i))
        if not os.path.exists(y4m):
            write_y4m(y4m, COLOURS[i % len(COLOURS)], seed=i)
        print(f'{i} {tone_hz(i)} {wav} {y4m}')


if __name__ == '__main__':
    main()
