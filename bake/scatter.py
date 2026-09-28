"""Placement: scatter trees, ferns, grass, rocks and snags per biome from the terrain grid (build/check/terrain.npz).
  python bake/scatter.py <docs/data> <build/check>        (run after terrain.py)
Tables are deflated float32 rows of [x, y, z, rotation, scale, kind] (three.js axes, y up).
Biomes: rim and outer forest, inner lake slopes (conifers) / Jigokudani (no live trees, white snags, white rocks) /
      the pass (above 78 m: low twisted trees, rocks, grass) / shore (no trees within 6 m of water) / shrine cape and observatory site kept clear
"""
import json
import os
import sys
import zlib

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import world as W  # noqa: E402
from terrain import save_png  # noqa: E402


class Grid:
    def __init__(self, path):
        g = np.load(path)
        self.H, self.d, self.geo = g['H'], g['d'], g['geo']
        gy, gx = np.gradient(self.H)
        self.slope = np.hypot(gx, gy)
        from scipy.ndimage import gaussian_filter
        Hs = gaussian_filter(self.H, 6)
        self.lap = (np.roll(Hs, 8, 0) + np.roll(Hs, -8, 0) + np.roll(Hs, 8, 1) + np.roll(Hs, -8, 1) - 4 * Hs) / 64.0   # concave is positive

    def at(self, A, x, y):
        cell = W.SIZE / (W.N - 1)
        fx = np.clip((x + W.SIZE / 2) / cell, 0, W.N - 1.001)
        fy = np.clip((y + W.SIZE / 2) / cell, 0, W.N - 1.001)
        i, j = fy.astype(int), fx.astype(int)
        u, v = fx - j, fy - i
        return (A[i, j] * (1 - u) + A[i, j + 1] * u) * (1 - v) + (A[i + 1, j] * (1 - u) + A[i + 1, j + 1] * u) * v


def jitter_grid(step, r_max, rng):
    n = int(2 * r_max / step)
    g = (np.arange(n) - n / 2 + 0.5) * step
    X, Y = np.meshgrid(g, g)
    X = X + rng.uniform(-0.45, 0.45, X.shape) * step
    Y = Y + rng.uniform(-0.45, 0.45, Y.shape) * step
    return X.ravel(), Y.ravel()


def main():
    argv = sys.argv[1:]
    out = argv[0] if argv else 'docs/data'
    chk = argv[1] if len(argv) > 1 else 'build/check'
    G = Grid(os.path.join(chk, 'terrain.npz'))
    rng = np.random.default_rng(3)
    ox, oy = W.obs_center()
    ct = np.radians(W.CAPE_TH)
    cape = (W.CAPE_R1 * np.cos(ct), W.CAPE_R1 * np.sin(ct))

    def pack(x, y, rot, scl, kind):
        z = G.at(G.H, x, y)
        return np.stack([x, z, -y, rot, scl, kind], 1).astype('<f4')

    def mask(x, y, road_clear, pad_clear, max_slope=2.2):
        h, d, s, geo = G.at(G.H, x, y), G.at(G.d, x, y), G.at(G.slope, x, y), G.at(G.geo, x, y)
        lake = np.hypot(x, y) < 430
        ok = (d > road_clear) & ~(lake & (h < W.WATER + 1.2)) & (np.hypot(x - ox, y - oy) > W.OBS_PAD + pad_clear) & (s < max_slope)
        ok &= np.maximum(np.abs(x), np.abs(y)) < 995                              # inside the map edge
        ok &= np.hypot(x - cape[0], y - cape[1]) > 9 + pad_clear * 0.2           # shrine clearing (trees along the spine of the cape stay as the shrine grove)
        return ok, h, d, s, geo

    # trees: jittered 5.2 m grid. Density varies with noise; thinner by roads, far out, on the pass and in Jigokudani
    x0, y0 = jitter_grid(5.2, 1000, rng)
    keep0 = np.hypot(x0, y0) <= 640
    # the outer rim uses a denser 3.6 m grid so the canopy is continuous
    xm, ym = jitter_grid(3.0, 1024, rng)
    km = np.hypot(xm, ym) > 640
    x = np.concatenate([x0[keep0], xm[km]]); y = np.concatenate([y0[keep0], ym[km]])
    r = np.hypot(x, y)
    ok, h, d, s, geo = mask(x, y, 6.5, 12)
    # gaps between lakeside switchbacks are narrow, so allow trees 5 m from the road
    ok2, *_ = mask(x, y, 5.0, 12)
    near_shore = (r < 340) & (r > 250)
    ok = np.where(near_shore, ok2, ok)
    lake = r < 430
    dens = 0.62 + 0.55 * W.fbm(x / 140, y / 140, 3, 41)
    dens *= np.where((d < 16) & ~near_shore, 0.55, 1.0)
    # outer rim: forest avoids ridge tops and steep rock, reaches high up gullies. Tree line around 300 m
    lap = G.at(G.lap, x, y)
    dens *= np.clip(2.4 - s, 0.2, 1) * np.where(r > 600, np.clip(1.5 - s * 0.45, 0.25, 1.0), 1.0)
    dens *= np.where(r > 600, np.clip(0.8 + lap * 25.0, 0.35, 1.1), 1.0)
    dens *= np.where(lake & (h < 6.0), 0.0, 1.0)                               # no trees within 6 m of water
    alpine = W.smooth(250, 310, h + 40 * W.fbm(x / 150, y / 150, 3, 77) - lap * 1500)   # forest reaches higher in gullies (concave)
    dens *= 1 - alpine                                                          # no trees above the tree line
    dens *= 1 - W.smooth(0.2, 0.5, geo)
    keep = ok & (rng.random(x.shape) < dens)
    x, y, d, alp = x[keep], y[keep], d[keep], alpine[keep]
    u = rng.random(x.shape)
    kind = np.where(u < 0.4, 0, np.where(u < 0.7, 1, np.where(u < 0.85, 3, 2)))
    kind = np.where((d < 22) & (rng.random(x.shape) < 0.3), 2, kind)
    kind = np.where(alp > 0.3, 2, kind)                                         # near the tree line, short young trees
    # scale: uniform by the road, mixed on the mountain (lower and wind-stunted on ridges)
    rm = np.hypot(x, y) > 640
    scl = np.where(rm, rng.lognormal(0.0, 0.28, x.shape).clip(0.45, 1.6), rng.uniform(0.78, 1.22, x.shape))
    scl = scl * np.where(alp > 0.3, rng.uniform(0.4, 0.7, x.shape), 1.0)
    trees = pack(x, y, rng.uniform(0, 2 * np.pi, x.shape), scl, kind)

    # snags: white dead trunks around and inside Jigokudani
    x, y = jitter_grid(7.0, 1000, rng)
    ok, h, d, s, geo = mask(x, y, 5.0, 6)
    keep = ok & (geo > 0.15) & (rng.random(x.shape) < 0.55 * W.smooth(0.15, 0.5, geo))
    snags = pack(x[keep], y[keep], rng.uniform(0, 2 * np.pi, keep.sum()), rng.uniform(0.6, 1.2, keep.sum()), np.zeros(keep.sum()))

    def ground(step, band, p, kinds, sizes, clear=4.2, geo_ok=False, alpine_boost=0.0, r_max=1000, sand_ok=False):
        gx, gy = jitter_grid(step, r_max, rng)
        ok2, h2, d2, s2, geo2 = mask(gx, gy, clear, 3)
        pp = p * (0.6 + 0.8 * (W.fbm(gx / 30, gy / 30, 3, 51) + 0.5))
        pp = pp * (1 + alpine_boost * W.smooth(270, 330, h2))
        if not geo_ok:
            pp = pp * (1 - W.smooth(0.1, 0.4, geo2))
        if not sand_ok:
            pp = pp * W.smooth(2.6, 4.0, h2 * (np.hypot(gx, gy) < 430) + 99 * (np.hypot(gx, gy) >= 430))   # nothing grows on beach sand
        m = ok2 & (d2 < band) & (rng.random(gx.shape) < pp)
        gx, gy = gx[m], gy[m]
        k = rng.choice(len(kinds), gx.shape, p=[kk[1] for kk in kinds])
        kk = np.array([kd[0] for kd in kinds])[k]
        sc = rng.uniform(sizes[0], sizes[1], gx.shape)
        return pack(gx, gy, rng.uniform(0, 2 * np.pi, gx.shape), sc, kk)

    ferns = ground(2.2, 80, 0.36, [(0, 1.0)], (0.8, 1.5), clear=3.2, alpine_boost=-1.0)
    grass = ground(2.0, 60, 0.26, [(0, 1.0)], (0.6, 1.25), clear=0.0, alpine_boost=2.0)
    rocks = ground(9.0, 90, 0.35, [(0, 0.4), (1, 0.35), (2, 0.25)], (0.35, 1.6), alpine_boost=3.0, geo_ok=True, sand_ok=True)
    pumice = ground(4.5, 40, 0.3, [(0, 1.0)], (0.12, 0.45), clear=0.0, geo_ok=True, sand_ok=True)

    os.makedirs(out, exist_ok=True)
    sizes = {}
    for name, a in (('trees', trees), ('ferns', ferns), ('grass', grass), ('rocks', rocks), ('pumice', pumice), ('snags', snags)):
        open(os.path.join(out, f'{name}.bin'), 'wb').write(zlib.compress(a.tobytes(), 9))
        sizes[name] = len(a)
    json.dump(sizes, open(os.path.join(out, 'scatter.json'), 'w'))
    img = np.zeros((1024, 1024, 3), np.float32) + 0.08

    def dot(a, c):
        ix = ((a[:, 0] + 1024) / 2).astype(int).clip(0, 1023)
        iy = ((-a[:, 2] + 1024) / 2).astype(int).clip(0, 1023)
        img[1023 - iy, ix] = c
    dot(trees, (0.1, 0.45, 0.15)); dot(ferns, (0.5, 0.8, 0.2)); dot(rocks, (0.6, 0.6, 0.6)); dot(pumice, (1, 1, 1)); dot(snags, (0.9, 0.8, 0.5))
    save_png(os.path.join(chk, 'scatter_top.png'), (img * 255).astype(np.uint8))
    print('SCATTER', sizes)


if __name__ == '__main__':
    main()
