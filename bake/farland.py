"""Distant ranges: mountains outside the map (12 km square), built the same way as the nearby rim (ridge shapes, then droplet erosion).
Writes heights on an 8 m grid (uint16, delta, deflate); three.js turns them into a coarse mesh and a normal map.
Inside the map (1 km square) it dips below the near terrain (which draws on top in three.js).
  python bake/farland.py <docs/data> <build/check>
"""
import json
import os
import sys
import zlib

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import world as W  # noqa: E402
from terrain import erode, save_png  # noqa: E402
from scipy.ndimage import gaussian_filter, zoom  # noqa: E402

SIZE = 12288.0
N = 1537              # 8 m grid


def base(X, Y):
    r = np.hypot(X, Y)
    wx = X / 2600 + 0.4 * W.fbm(X / 5000, Y / 5000, 3, 161)
    wy = Y / 2600 + 0.4 * W.fbm(X / 5000 + 3.1, Y / 5000, 3, 162)
    m = W.ridged_mf(wx, wy, 7, 121)
    # from rim height nearby (200-350 m) rising to higher ranges farther out (up to about 900 m)
    t = W.smooth(1000, 6000, r)
    h = (60 + 380 * t) * m / 1.7 + 40 * t
    # rolling hills everywhere: keep the gaps between ranges from going flat (large and small undulation)
    hills = 140 * W.ridged_mf(X / 1500, Y / 1500, 4, 171, gain=1.0) / 1.5 + 30 * (W.pnoise(X / 420, Y / 420, 173) - 0.5)
    h = np.maximum(h, 0) + hills * (0.5 + 0.5 * t)
    return h


def main():
    argv = sys.argv[1:]
    out = argv[0] if argv else 'docs/data'
    chk = argv[1] if len(argv) > 1 else 'build/check'
    c = np.linspace(-SIZE / 2, SIZE / 2, N)
    X, Y = np.meshgrid(c, c)
    H = base(X, Y)
    cur = H.copy()
    for step, per, lim in ((8, 30, (220, 6)), (4, 24, (110, 5)), (2, 18, (45, 4)), (1, 12, (16, 3))):
        cc = cur[::step, ::step]
        d = erode(cc, SIZE / (cc.shape[0] - 1), drops=int(cc.size * per), seed=31 + step, lim=lim)
        if step > 1:
            d = zoom(d, (N - 1) / (cc.shape[0] - 1), order=1)[:N, :N]
            d = gaussian_filter(d, step * 0.55)
        cur = cur + d
    # blend with the near terrain (1 km square, 1 m grid): match its height at 960-1024 m from center, dip below it inside 880 m
    from scipy.ndimage import map_coordinates
    Hn = np.load(os.path.join(chk, 'terrain.npz'))['H']
    cheb = np.maximum(np.abs(X), np.abs(Y))
    m = cheb < 1030
    ci = np.clip((Y[m] + W.SIZE / 2) / (W.SIZE / (W.N - 1)), 0, W.N - 1)
    cj = np.clip((X[m] + W.SIZE / 2) / (W.SIZE / (W.N - 1)), 0, W.N - 1)
    near = np.zeros_like(cur); near[m] = map_coordinates(Hn, [ci, cj], order=1)
    w = 1 - W.smooth(1005, 1120, cheb)
    cur = cur * (1 - w) + near * w
    cur = cur - (1 - W.smooth(860, 900, cheb)) * 500
    hmin, hmax = float(cur.min()) - 1, float(cur.max()) + 1
    q = np.round((cur - hmin) / (hmax - hmin) * 65535).astype(np.int32)
    dq = np.diff(q, axis=1, prepend=0).astype(np.int16).astype('<i2')
    open(os.path.join(out, 'far.bin'), 'wb').write(zlib.compress(dq.tobytes(), 9))
    json.dump(dict(size=SIZE, n=N, hmin=hmin, hmax=hmax), open(os.path.join(out, 'far.json'), 'w'))
    gy, gx = np.gradient(cur, SIZE / (N - 1))
    nn = np.stack([-gx, -gy, np.ones_like(cur)], -1); nn /= np.linalg.norm(nn, axis=-1, keepdims=True)
    L = np.array([-0.6, -0.5, 0.6]); L /= np.linalg.norm(L)
    s = np.clip(nn @ L, 0, 1)
    save_png(os.path.join(chk, 'far_top.png'), (np.stack([s, s, s], -1) * 255).astype(np.uint8)[::-1][::2, ::2].copy())
    # distant forest: impostor-only trees 1.0-2.8 km out (density varies with ridges and gullies, none above the tree line)
    rng = np.random.default_rng(41)
    cell = SIZE / (N - 1)
    gyy, gxx = np.gradient(cur, cell)
    sl = np.hypot(gxx, gyy)
    Hs = gaussian_filter(cur, 3)
    lap = (np.roll(Hs, 3, 0) + np.roll(Hs, -3, 0) + np.roll(Hs, 3, 1) + np.roll(Hs, -3, 1) - 4 * Hs) / (9 * cell * cell)
    step = 6.0
    g = np.arange(-2600, 2600, step)
    TX, TY = np.meshgrid(g, g)
    TX = TX + rng.uniform(-0.45, 0.45, TX.shape) * step; TY = TY + rng.uniform(-0.45, 0.45, TY.shape) * step
    TX, TY = TX.ravel(), TY.ravel()
    ch = np.maximum(np.abs(TX), np.abs(TY))
    TX, TY = TX[ch > 1000], TY[ch > 1000]
    fi = (TY + SIZE / 2) / cell; fj = (TX + SIZE / 2) / cell
    from scipy.ndimage import map_coordinates
    th = map_coordinates(cur, [fi, fj], order=1); ts = map_coordinates(sl, [fi, fj], order=1); tl = map_coordinates(lap, [fi, fj], order=1)
    alpine = W.smooth(250, 310, th - tl * 1500 + 40 * W.fbm(TX / 200, TY / 200, 3, 91))
    dens = np.clip(1.5 - ts * 0.45, 0.25, 1.0) * np.clip(0.8 + tl * 25, 0.35, 1.1) * (1 - alpine)
    keep = rng.random(TX.shape) < dens
    TX, TY, th = TX[keep], TY[keep], th[keep]
    kind = np.where(rng.random(TX.shape) < 0.55, 0, np.where(rng.random(TX.shape) < 0.6, 1, 3))
    scl = rng.lognormal(0.0, 0.28, TX.shape).clip(0.45, 1.6)
    # 8 bytes per tree: x, height, z (int16 in 10 cm units), rotation and scale (uint8)
    arr = np.zeros((len(TX), 4), '<i2')
    arr[:, 0] = np.round(TX * 10); arr[:, 1] = np.round((th - 0.3) * 10); arr[:, 2] = np.round(-TY * 10)
    rot = (rng.uniform(0, 256, TX.shape)).astype(np.uint8)
    sb = np.clip(np.round(scl / 1.6 * 63), 1, 63).astype(np.uint8) | (kind.astype(np.uint8) << 6)
    arr[:, 3] = (rot.astype(np.int32) | (sb.astype(np.int32) << 8)).astype(np.uint16).view('<i2')
    open(os.path.join(out, 'fartrees.bin'), 'wb').write(zlib.compress(arr.tobytes(), 9))
    print('FAR', round(hmin), round(hmax), os.path.getsize(os.path.join(out, 'far.bin')), 'trees', len(arr))


if __name__ == '__main__':
    main()
