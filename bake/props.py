"""Scenery props: lakeside shrine (torii, main hall, stone lanterns), lakeshore pier, boathouse and boat, sulfur hut and boardwalk in Jigokudani, pass hut and jizo statue.
Baked in Cycles into one atlas with the same material setup as the car (wear, dust, chips, rain streaks); exports the glb and textures.
  blender -b --factory-startup -P bake/props.py -- <docs/data> <build/check> [resolution]
Props are exported as separate named objects (placement is decided in three.js). Each has its origin on the ground, front at -Y (Blender).
"""
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blib as B  # noqa: E402
import car as C  # noqa: E402

C.OZ = 0.0


def hull2(name, lo, hi, mat):
    """Hexahedron from 4 bottom points and 4 top points"""
    return B.hull(name, list(lo) + list(hi), mat)


def mats():
    M = {}
    M['shu'] = C.material('shu', (0.42, 0.075, 0.03), 0.62, wear=0.5, dust=0.35, scuff=0.4, chip=0.7, patch=0.2, streak=0.55)
    M['kuro'] = C.material('kuro', (0.018, 0.017, 0.016), 0.55, wear=0.4, dust=0.3, streak=0.3)
    M['wood'] = C.material('wood', (0.09, 0.075, 0.06), 0.85, wear=0.2, dust=0.4, scuff=0.5, streak=0.6)
    M['plank'] = C.material('plank', (0.07, 0.062, 0.055), 0.9, wear=0.2, dust=0.6, scuff=0.7, streak=0.4)
    M['patina'] = C.material('patina', (0.11, 0.2, 0.17), 0.6, metal=0.3, wear=0.3, dust=0.3, streak=0.7)
    M['stone'] = C.material('stone', (0.1, 0.1, 0.095), 0.9, wear=0.2, dust=0.8, scuff=0.3, streak=0.5)
    M['moss'] = C.material('moss', (0.035, 0.05, 0.022), 0.95, dust=0.2)
    M['rope'] = C.material('rope', (0.24, 0.2, 0.12), 0.95, dust=0.4)
    M['paper'] = C.material('paper', (0.62, 0.61, 0.57), 0.8, dust=0.3, streak=0.3)
    M['red'] = C.material('redcloth', (0.4, 0.03, 0.02), 0.9, dust=0.4)
    M['tin'] = C.material('tin', (0.16, 0.08, 0.04), 0.7, metal=0.4, wear=0.6, dust=0.6, scuff=0.4, chip=0.4, streak=0.6)
    M['sulfur'] = C.material('sulfurtin', (0.2, 0.15, 0.05), 0.8, metal=0.2, wear=0.4, dust=0.8, streak=0.8)
    M['glass'] = C.material('win2', (0.02, 0.022, 0.024), 0.15, dust=0.4)
    return M


def torii(M):
    P = []
    H, span = 5.4, 3.6                          # pillar height, pillar spacing
    for s in (-1, 1):
        x0 = s * span / 2
        # pillars lean slightly inward; black rounded stone footings
        P.append(B.tube('hashira', [(x0, 0, -0.9), (x0 * 0.965, 0, H)], 0.27, M['shu'], seg=16))
        P.append(B.lathe('kamebara', [(0.0, -0.9), (0.46, -0.9), (0.46, -0.1), (0.38, 0.12), (0.3, 0.2), (0.0, 0.22)], M['kuro'], seg=24, axis='Z', center=(x0, 0, 0)))
    # nuki (tie beam through the pillars), gakuzuka, shimaki, kasagi (upturned ends, black top)
    P.append(B.box('nuki', (0, 0, H - 1.25), (span + 1.4, 0.22, 0.34), M['shu'], 0.02))
    P.append(B.box('gakuzuka', (0, 0, H - 0.72), (0.34, 0.22, 0.75), M['shu'], 0.02))
    P.append(B.box('gaku', (0, -0.14, H - 0.75), (0.6, 0.06, 0.62), M['kuro'], 0.015))
    n = 24
    for name, zc, t, rise, mat, over in (('shimaki', H - 0.18, 0.3, 0.12, 'shu', 1.0), ('kasagi', H + 0.2, 0.34, 0.34, 'kuro', 1.35)):
        L = span + 2 * over
        pts = []
        for i in range(n + 1):
            x = -L / 2 + L * i / n
            u = abs(x) / (L / 2)
            pts.append((x, 0, zc + rise * u ** 3.2))
        # cross-section: a 0.5-wide box placed at each point
        for a, b in zip(pts[:-1], pts[1:]):
            c = ((a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2)
            ang = math.atan2(b[2] - a[2], b[0] - a[0])
            P.append(B.box(name, c, (math.hypot(b[0] - a[0], b[2] - a[2]) + 0.02, 0.5 if name == 'kasagi' else 0.42, t), M[mat], 0.01, rot=[((0, 1, 0), -ang)]))
    # shimenawa rope and shide streamers
    pts = [(-span / 2 + span * i / 20, -0.2, H - 1.55 - 0.3 * math.sin(math.pi * i / 20)) for i in range(21)]
    P.append(B.tube('shimenawa', pts, 0.07, M['rope'], seg=8))
    for k in range(4):
        x = -1.1 + k * 0.73
        z = H - 1.55 - 0.3 * math.sin(math.pi * (x + span / 2) / span)
        for j in range(4):   # shide: zigzag white paper
            P.append(B.box('shide', (x + (0.05 if j % 2 else -0.05), -0.22, z - 0.12 - j * 0.11), (0.12, 0.005, 0.1), M['paper']))
    return B.join('torii', P)


def honden(M):
    P = []
    # raised floor: stone footings, posts, deck
    W_, D_, FZ = 2.8, 3.2, 0.9
    for x in (-W_ / 2 + 0.15, W_ / 2 - 0.15):
        for y in (-D_ / 2 + 0.15, 0.0, D_ / 2 - 0.15):
            P.append(B.box('soseki', (x, y, 0.1), (0.36, 0.36, 0.25), M['stone'], 0.04))
            P.append(B.box('tsuka', (x, y, FZ / 2 + 0.1), (0.16, 0.16, FZ - 0.1), M['wood'], 0.01))
    P.append(B.box('yuka', (0, 0, FZ + 0.06), (W_ + 0.5, D_ + 0.5, 0.12), M['plank'], 0.01))
    # main body: plank walls and posts, lattice doors at the front
    P.append(B.box('kabe', (0, 0.2, FZ + 1.1), (W_ - 0.2, D_ - 0.6, 2.0), M['wood'], 0.02))
    for x in (-W_ / 2 + 0.1, W_ / 2 - 0.1):
        for y in (-D_ / 2 + 0.3, D_ / 2 - 0.1):
            P.append(B.box('hashira2', (x, y, FZ + 1.1), (0.16, 0.16, 2.1), M['wood'], 0.01))
    for k in range(9):
        P.append(B.box('koshi', (-0.9 + k * 0.225, -D_ / 2 + 0.28, FZ + 1.0), (0.035, 0.05, 1.6), M['wood']))
    for z in (FZ + 0.35, FZ + 1.0, FZ + 1.7):
        P.append(B.box('koshi_h', (0, -D_ / 2 + 0.28, z), (1.95, 0.05, 0.035), M['wood']))
    P.append(B.box('dark', (0, -D_ / 2 + 0.33, FZ + 1.0), (1.9, 0.02, 1.6), M['kuro']))
    # steps and offering box
    for k in range(4):
        P.append(B.box('dan', (0, -D_ / 2 - 0.35 - k * 0.28, FZ - 0.2 - k * 0.22), (1.3, 0.3, 0.08), M['plank'], 0.01))
    P.append(B.box('saisen', (0, -D_ / 2 - 1.6, 0.35), (0.9, 0.5, 0.6), M['wood'], 0.02))
    # roof: verdigris copper, upswept eaves, chigi and katsuogi
    RZ = FZ + 2.2
    for s in (-1, 1):
        n = 12
        for i in range(n):
            u0, u1 = i / n, (i + 1) / n
            def pt(u):
                x = s * (0.05 + u * (W_ / 2 + 0.95))
                z = RZ + 1.35 * (1 - u) - 0.25 * u * u + 0.18 * u ** 6
                return x, z
            (xa, za), (xb, zb) = pt(u0), pt(u1)
            P.append(hull2('yane', [(xa, -D_ / 2 - 0.9, za - 0.08), (xb, -D_ / 2 - 0.9, zb - 0.08), (xb, D_ / 2 + 0.7, zb - 0.08), (xa, D_ / 2 + 0.7, za - 0.08)],
                            [(xa, -D_ / 2 - 0.9, za), (xb, -D_ / 2 - 0.9, zb), (xb, D_ / 2 + 0.7, zb), (xa, D_ / 2 + 0.7, za)], M['patina']))
    P.append(B.box('munagi', (0, -0.1, RZ + 1.42), (0.3, D_ + 1.7, 0.22), M['patina'], 0.02))
    for y in (-D_ / 2 - 0.8, D_ / 2 + 0.6):
        for s in (-1, 1):
            P.append(B.box('chigi', (s * 0.35, y, RZ + 1.9), (0.1, 0.06, 1.3), M['patina'], 0.01, rot=[((0, 1, 0), s * 0.55)]))
    for k in range(5):
        P.append(B.tube('katsuogi', [(-0.28, -1.6 + k * 0.75, RZ + 1.6), (0.28, -1.6 + k * 0.75, RZ + 1.6)], 0.11, M['patina'], seg=12))
    # shimenawa
    pts = [(-1.1 + 2.2 * i / 16, -D_ / 2 + 0.05, FZ + 2.0 - 0.18 * math.sin(math.pi * i / 16)) for i in range(17)]
    P.append(B.tube('nawa', pts, 0.05, M['rope'], seg=8))
    return B.join('honden', P)


def toro(M):
    """Stone lantern: base, shaft, middle platform, light box (windows), curved cap, finial"""
    P = []
    P.append(B.box('kiso', (0, 0, 0.12), (0.8, 0.8, 0.24), M['stone'], 0.04))
    P.append(B.lathe('sao', [(0.0, 0.24), (0.2, 0.24), (0.16, 0.5), (0.15, 1.1), (0.2, 1.3), (0.0, 1.3)], M['stone'], seg=12, axis='Z'))
    P.append(B.box('chudai', (0, 0, 1.38), (0.62, 0.62, 0.18), M['stone'], 0.04))
    P.append(B.box('hibukuro', (0, 0, 1.72), (0.44, 0.44, 0.5), M['stone'], 0.03))
    for s in (-1, 1):
        P.append(B.box('mado', (0, s * 0.215, 1.74), (0.2, 0.03, 0.26), M['kuro']))
        P.append(B.box('mado', (s * 0.215, 0, 1.74), (0.03, 0.2, 0.26), M['kuro']))
    P.append(B.lathe('kasa', [(0.0, 1.98), (0.62, 1.98), (0.66, 2.03), (0.5, 2.1), (0.2, 2.3), (0.0, 2.34)], M['stone'], seg=6, axis='Z', smooth=False))
    P.append(B.lathe('hoju', [(0.0, 2.34), (0.1, 2.36), (0.13, 2.45), (0.06, 2.56), (0.0, 2.62)], M['stone'], seg=12, axis='Z'))
    P.append(B.lathe('koke', [(0.0, 2.1), (0.5, 2.1), (0.35, 2.18), (0.0, 2.24)], M['moss'], seg=6, axis='Z', smooth=False))
    return B.join('toro', P)


def pier(M):
    """Pier: planks on piles, with some planks missing. Origin at the shore, extending 18 m into the lake along -Y"""
    P = []
    L = 18.0
    for k in range(10):
        y = -k * 2.0
        for x in (-0.8, 0.8):
            P.append(B.tube('kui', [(x, y, -1.6), (x, y, 0.75 + (0.15 if k % 3 == 0 else 0))], 0.1, M['wood'], seg=8))
        P.append(B.box('keta', (0, y, 0.55), (1.9, 0.14, 0.14), M['wood'], 0.01))
    for x in (-0.8, 0.8):
        P.append(B.box('obiki', (x, -L / 2 + 0.5, 0.65), (0.12, L, 0.12), M['wood'], 0.01))
    rng = np.random.default_rng(4)
    for k in range(int(L / 0.24)):
        if rng.random() < 0.08:
            continue                              # missing plank
        y = -k * 0.24
        tilt = (rng.random() - 0.5) * 0.06
        P.append(B.box('ita', (rng.normal(0, 0.03), y, 0.74), (1.95 + rng.normal(0, 0.05), 0.2, 0.04), M['plank'], 0.005, rot=[((0, 1, 0), tilt)]))
    return B.join('pier', P)


def boathouse(M):
    P = []
    for x in (-2.2, 2.2):
        for y in (-3.0, 0.0, 3.0):
            P.append(B.tube('ashi', [(x, y, -1.2), (x, y, 0.4)], 0.12, M['wood'], seg=8))
    P.append(B.box('yuka', (0, 0, 0.45), (4.8, 6.6, 0.12), M['plank'], 0.01))
    for x in (-2.3, 2.3):
        P.append(B.box('kabe', (x, 0, 1.75), (0.08, 6.4, 2.5), M['plank'], 0.01))
    P.append(B.box('ushiro', (0, 3.2, 1.75), (4.6, 0.08, 2.5), M['plank'], 0.01))
    for k in range(16):
        P.append(B.box('shitami', (-2.36, -3.0 + k * 0.4, 1.75), (0.03, 0.05, 2.5), M['wood']))
        P.append(B.box('shitami', (2.36, -3.0 + k * 0.4, 1.75), (0.03, 0.05, 2.5), M['wood']))
    for s in (-1, 1):
        P.append(hull2('yane2', [(0, -3.6, 3.6), (s * 2.9, -3.6, 2.7), (s * 2.9, 3.6, 2.7), (0, 3.6, 3.6)],
                        [(0, -3.6, 3.66), (s * 2.9, -3.6, 2.76), (s * 2.9, 3.6, 2.76), (0, 3.6, 3.66)], M['tin']))
        for k in range(14):   # corrugation ridges
            u = (k + 0.5) / 14
            P.append(B.box('nami', (s * 1.45, -3.6 + u * 7.2, 3.2), (3.0, 0.04, 0.03), M['tin'], rot=[((0, 1, 0), s * 0.3)]))
    return B.join('boathouse', P)


def boat(M):
    """Rowboat: plank boat with a rounded hull"""
    prof = []
    n = 16
    for i in range(n + 1):
        t = i / n
        y = -2.4 + 4.8 * t
        w = 0.62 * math.sin(math.pi * min(1, t * 1.05)) ** 0.6
        prof.append((y, w))
    P = []
    for (y0, w0), (y1, w1) in zip(prof[:-1], prof[1:]):
        for s in (-1, 1):
            P.append(hull2('gen', [(s * w0 * 0.55, y0, 0.0), (s * w1 * 0.55, y1, 0.0), (s * w1, y1, 0.45), (s * w0, y0, 0.45)],
                            [(s * w0 * 0.55 + s * 0.03, y0, 0.0), (s * w1 * 0.55 + s * 0.03, y1, 0.0), (s * w1 + s * 0.03, y1, 0.47), (s * w0 + s * 0.03, y0, 0.47)], M['plank']))
        P.append(B.box('soko', (0, (y0 + y1) / 2, 0.02), (w0 * 1.1, y1 - y0 + 0.01, 0.04), M['plank']))
    for y in (-0.9, 0.5):
        P.append(B.box('seat', (0, y, 0.32), (1.05, 0.22, 0.05), M['wood']))
    return B.join('boat', P)


def shack(M):
    """Sulfur hut: rusty corrugated shed with yellow sulfur stains, chimney and pipes"""
    P = []
    P.append(B.box('dodai', (0, 0, 0.15), (4.6, 3.6, 0.3), M['stone'], 0.03))
    P.append(B.box('kabe', (0, 0, 1.5), (4.2, 3.2, 2.5), M['sulfur'], 0.02))
    for k in range(20):
        P.append(B.box('nami', (-2.1 + k * 0.22, -1.62, 1.5), (0.05, 0.04, 2.5), M['sulfur']))
    P.append(B.box('to', (-0.9, -1.64, 1.2), (0.9, 0.05, 1.95), M['tin'], 0.01))
    P.append(B.box('mado', (1.1, -1.63, 1.7), (0.8, 0.04, 0.6), M['glass']))
    P.append(hull2('yane3', [(-2.5, -2.0, 2.75), (2.5, -2.0, 2.75), (2.5, 2.0, 3.2), (-2.5, 2.0, 3.2)],
                    [(-2.5, -2.0, 2.81), (2.5, -2.0, 2.81), (2.5, 2.0, 3.26), (-2.5, 2.0, 3.26)], M['tin']))
    P.append(B.tube('entotsu', [(1.4, 0.8, 2.9), (1.4, 0.8, 4.4)], 0.13, M['tin'], seg=10))
    P.append(B.tube('pipe', B.bend([(2.1, -0.5, 0.6), (3.2, -0.5, 0.6), (3.2, -0.5, 0.1), (6.0, -0.5, 0.1)], 0.2), 0.09, M['tin'], seg=8))
    return B.join('shack', P)


def boardwalk(M):
    """One boardwalk segment (2 m long, 1.2 m wide), chained to reach the hot pools"""
    P = []
    for x in (-0.5, 0.5):
        P.append(B.tube('kui', [(x, 0.0, -0.5), (x, 0.0, 0.32)], 0.06, M['wood'], seg=6))
        P.append(B.box('obiki', (x, -1.0, 0.3), (0.1, 2.0, 0.1), M['wood']))
    for k in range(10):
        P.append(B.box('ita', (0, -0.1 - k * 0.2, 0.38), (1.2, 0.17, 0.035), M['plank'], 0.004))
    P.append(B.tube('tesuri', [(0.6, 0.0, 0.35), (0.6, 0.0, 1.0), (0.6, -2.0, 1.0)], 0.03, M['wood'], seg=6))
    return B.join('boardwalk', P)


def hut(M):
    """Mountain hut at the pass: stone lower walls, plank siding, steep gable roof weighed down with stones, chimney"""
    P = []
    P.append(B.box('ishigaki', (0, 0, 0.6), (6.4, 5.0, 1.2), M['stone'], 0.12, 2))
    rng = np.random.default_rng(9)
    for k in range(60):   # stonework: individual stones
        side = k % 4
        u = rng.uniform(-1, 1)
        z = rng.uniform(0.15, 1.1)
        if side < 2:
            c = (u * 3.1, (-2.52 if side == 0 else 2.52), z)
        else:
            c = ((-3.22 if side == 2 else 3.22), u * 2.4, z)
        P.append(B.box('ishi', c, (rng.uniform(0.35, 0.6), 0.12, rng.uniform(0.2, 0.32)) if side < 2 else (0.12, rng.uniform(0.35, 0.6), rng.uniform(0.2, 0.32)), M['stone'], 0.04))
    P.append(B.box('kabe', (0, 0, 2.2), (6.0, 4.6, 2.0), M['wood'], 0.02))
    P.append(B.box('to', (0, -2.32, 1.95), (1.0, 0.06, 1.9), M['plank'], 0.01))
    P.append(B.box('mado', (1.9, -2.31, 2.3), (0.9, 0.04, 0.7), M['glass']))
    for s in (-1, 1):
        P.append(hull2('yane4', [(0, -3.0, 5.4), (s * 3.6, -3.0, 3.0), (s * 3.6, 3.0, 3.0), (0, 3.0, 5.4)],
                        [(0, -3.0, 5.5), (s * 3.6, -3.0, 3.1), (s * 3.6, 3.0, 3.1), (0, 3.0, 5.5)], M['plank']))
        for k in range(7):
            u = (k + 0.5) / 7
            P.append(B.lathe('omoshi', [(0.0, 0.0), (0.2, 0.0), (0.24, 0.1), (0.15, 0.2), (0.0, 0.22)], M['stone'], seg=7,
                             axis='Z', center=(s * (0.6 + u * 2.6), rng.uniform(-2.4, 2.4), 5.45 - (0.6 + u * 2.6) * 0.667 + 0.05)))
    P.append(B.box('entotsu', (-1.6, 1.2, 5.3), (0.5, 0.5, 1.6), M['stone'], 0.04))
    return B.join('hut', P)


def jizo(M):
    """Jizo: round-headed stone figure with a red bib on a stone base"""
    P = []
    P.append(B.box('dai', (0, 0, 0.18), (0.7, 0.6, 0.36), M['stone'], 0.05))
    P.append(B.lathe('karada', [(0.0, 0.36), (0.26, 0.36), (0.25, 0.7), (0.2, 0.9), (0.14, 0.98), (0.0, 1.0)], M['stone'], seg=16, axis='Z'))
    P.append(B.lathe('atama', [(0.0, 0.98), (0.13, 1.0), (0.16, 1.1), (0.13, 1.22), (0.0, 1.26)], M['stone'], seg=16, axis='Z'))
    P.append(B.lathe('maekake', [(0.0, 0.62), (0.27, 0.66), (0.23, 0.9), (0.15, 0.97), (0.0, 0.97)], M['red'], seg=16, axis='Z'))
    P.append(B.lathe('koke', [(0.13, 1.18), (0.1, 1.24), (0.0, 1.27)], M['moss'], seg=16, axis='Z'))
    return B.join('jizo', P)


def signpost(M):
    """Junction signpost: log post with boards pointing toward each destination (lettering as dark carved grooves)"""
    P = []
    P.append(B.tube('hashira', [(0, 0, -0.3), (0, 0, 2.3)], 0.08, M['wood'], seg=10))
    P.append(B.lathe('kasa', [(0.0, 2.3), (0.14, 2.3), (0.0, 2.42)], M['wood'], seg=10, axis='Z', smooth=False))
    for z, ang in ((1.85, 0.0), (1.5, math.pi)):
        c, s = math.cos(ang), math.sin(ang)
        # board: 1 m from the post, tip cut to an arrow point
        L = 1.0
        for k in range(8):
            u0, u1 = k / 8, (k + 1) / 8
            w0 = 0.13 if u0 < 0.85 else 0.13 * (1 - (u0 - 0.85) / 0.15)
            w1 = 0.13 if u1 < 0.85 else 0.13 * (1 - (u1 - 0.85) / 0.15)
            x0, x1 = 0.08 + L * u0, 0.08 + L * u1
            lo = [(x0 * c, x0 * s - 0.02, z - w0), (x1 * c, x1 * s - 0.02, z - w1), (x1 * c, x1 * s + 0.02, z - w1), (x0 * c, x0 * s + 0.02, z - w0)]
            hi = [(x0 * c, x0 * s - 0.02, z + w0), (x1 * c, x1 * s - 0.02, z + w1), (x1 * c, x1 * s + 0.02, z + w1), (x0 * c, x0 * s + 0.02, z + w0)]
            P.append(hull2('ita', lo, hi, M['plank']))
        for k in range(5):   # carved letter grooves
            x = 0.25 + k * 0.13
            P.append(B.box('ji', (x * c, -0.022 * (1 if ang == 0 else -1), z), (0.06, 0.004, 0.13), M['kuro']))
    return B.join('signpost', P)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv else 'docs/data'
    chk = argv[1] if len(argv) > 1 else 'build/check'
    size = int(argv[2]) if len(argv) > 2 else 2048
    os.makedirs(chk, exist_ok=True)
    B.reset()
    B.gpu_cycles(16)
    M = mats()
    obs = [f(M) for f in (torii, honden, toro, pier, boathouse, boat, shack, boardwalk, hut, jizo, signpost)]
    for o in obs:
        C.finish(o)
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    print('PROPS', {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in obs})
    C.unwrap_all(obs, size)
    base = C.bake_pass(obs, 'base', size)
    rough = C.bake_pass(obs, 'rough', size)
    metal = C.bake_pass(obs, 'metal', size)
    ao = C.bake_pass(obs, 'ao', size, samples=64)
    C.save_png(os.path.join(out, 'props_base.png'), base[..., :3], True)
    C.save_png(os.path.join(out, 'props_orm.png'), np.stack([ao[..., 0], rough[..., 0], metal[..., 0]], -1), False)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(chk, 'props.blend'))
    C.export_glb(os.path.join(out, 'props.glb'), obs)
    print('PROPS done', os.path.getsize(os.path.join(out, 'props.glb')))


if __name__ == '__main__':
    main()
