"""Terrain and road export: carve the road network into the natural terrain (world.base_height) and write it out for the web.
  python bake/terrain.py <docs/data> <build/check>      (numpy and scipy; no Blender needed)
Outputs
  height.bin   heights on a 1 m grid (uint16, per-row delta, deflate)
  road.bin     road field for shaders (4 x half float: lateral distance m, distance along road mod 64, road index, Jigokudani strength)
  roads.json   road centerlines (x, height, z and length every 2 m) and section names (the car looks up the nearest road)
  terrain.json size, height range, observatory, etc.
  build/check/terrain.npz  heights and road distance for placement (scatter.py)
"""
import json
import os
import struct
import sys
import zlib

import numpy as np
from scipy.ndimage import distance_transform_edt, gaussian_filter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import world as W  # noqa: E402


def save_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[i].tobytes() for i in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


def sample(A, x, y):
    cell = W.SIZE / (W.N - 1)
    j, i = int(round((x + W.SIZE / 2) / cell)), int(round((y + W.SIZE / 2) / cell))
    return float(A[i, j])


def erode(H, cell, drops=1_200_000, batch=6_000, steps=48, seed=7, lim=(45, 15)):
    """Droplet erosion: drop many droplets on the slopes at once; they erode and carry sediment as they flow and deposit it as they slow.
    Gullies branch downhill, ridges sharpen, and sediment collects in valley floors. Returns the height change (m)"""
    n = H.shape[0]
    h = H.astype(np.float64).copy().ravel()
    rng = np.random.default_rng(seed)
    inertia, cap_k, min_cap, k_er, k_dep, evap, grav = 0.08, 5.0, 0.01, 0.35, 0.3, 0.025, 9.8

    def sample(px, py):
        ix = np.clip(px.astype(np.int64), 0, n - 2); iy = np.clip(py.astype(np.int64), 0, n - 2)
        u = px - ix; v = py - iy
        i00 = iy * n + ix
        a, b, c, d = h[i00], h[i00 + 1], h[i00 + n], h[i00 + n + 1]
        hh = a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
        gx = (b - a) * (1 - v) + (d - c) * v
        gy = (c - a) * (1 - u) + (d - b) * u
        return hh, gx, gy, i00, u, v

    def splat(i00, u, v, amt):
        np.add.at(h, i00, amt * (1 - u) * (1 - v)); np.add.at(h, i00 + 1, amt * u * (1 - v))
        np.add.at(h, i00 + n, amt * (1 - u) * v); np.add.at(h, i00 + n + 1, amt * u * v)

    for bi in range(drops // batch):
        px = rng.uniform(1, n - 2, batch); py = rng.uniform(1, n - 2, batch)
        dx = np.zeros(batch); dy = np.zeros(batch)
        vel = np.ones(batch); water = np.ones(batch); sed = np.zeros(batch)
        alive = np.ones(batch, bool)
        for _ in range(steps):
            h0, gx, gy, i00, u, v = sample(px, py)
            dx = dx * inertia - gx * (1 - inertia); dy = dy * inertia - gy * (1 - inertia)
            ln = np.hypot(dx, dy)
            alive &= ln > 1e-9
            ln = np.where(ln > 1e-9, ln, 1)
            dx /= ln; dy /= ln
            nx, ny = px + dx, py + dy
            alive &= (nx > 1) & (nx < n - 2) & (ny > 1) & (ny < n - 2)
            h1 = sample(np.clip(nx, 1, n - 2), np.clip(ny, 1, n - 2))[0]
            dh = h1 - h0
            cap = np.maximum(-dh * vel * water * cap_k, min_cap)
            dep = (sed > cap) | (dh > 0)
            amt_dep = np.where(dh > 0, np.minimum(dh, sed), (sed - cap) * k_dep)
            amt_er = np.minimum(np.minimum((cap - sed) * k_er, np.maximum(-dh, 0)), 0.004 * cell)   # a droplet erodes at most 0.4% of the cell size per step
            amt = np.where(dep, amt_dep, -amt_er) * alive
            splat(i00, u, v, amt)
            sed = sed - amt
            vel = np.minimum(np.sqrt(np.maximum(vel * vel - dh * grav / cell * 0.5, 0)), 6.0)
            water *= 1 - evap
            px, py = np.where(alive, nx, px), np.where(alive, ny, py)
            if not alive.any():
                break
        if bi % 20 == 0:
            np.clip(h, H.ravel() - lim[0], H.ravel() + lim[1], out=h)
    out = np.clip(h.reshape(n, n), H - lim[0], H + lim[1])
    # slumping: relax slopes steeper than the angle of repose (40 deg); edges do not wrap
    tn = np.tan(np.radians(40))
    for _ in range(6):
        for a_, b_ in ((0, 1), (1, 0), (1, 1), (1, -1)):
            d = cell * np.hypot(a_, b_)
            P = out[0:n - a_, max(0, -b_):n - max(0, b_)]            # (i, j)
            Q = out[a_:n, max(0, b_):n + min(0, b_)]                 # (i + a, j + b)
            diff = P - Q
            ex = np.clip(np.abs(diff) - tn * d, 0, None) * np.sign(diff) * 0.25
            P -= ex
            Q += ex
    return out - H


def erode_multi(H, size, seed=7):
    """Layer erosion from coarse to fine grids: 16 m cuts main valleys, 8 m side valleys, 4 m gullies. H is on the 1 m grid"""
    from scipy.ndimage import zoom
    n = H.shape[0]
    cur = H.copy()
    for step, per, lim in ((16, 24, (80, 30)), (8, 22, (45, 18)), (4, 16, (18, 8)), (2, 10, (6, 3))):
        c = cur[::step, ::step]
        d = erode(c, size / (c.shape[0] - 1), drops=int(c.size * per), seed=seed + step, lim=lim)
        d = zoom(d, (n - 1) / (c.shape[0] - 1), order=1)[:n, :n]
        d = gaussian_filter(d, step * 0.55)                 # hide the coarse grid corners
        cur = cur + d
    return cur - H


def build():
    """Compute grid heights and the road field (also called from scatter.py)"""
    c = np.linspace(-W.SIZE / 2, W.SIZE / 2, W.N)
    X, Y = np.meshgrid(c, c)                 # rows = y (south to north), columns = x
    H0 = np.zeros_like(X)
    for i in range(0, W.N, 256):
        H0[i:i + 256] = W.base_height(X[i:i + 256], Y[i:i + 256])
    # erode the outer rim and forest slopes with droplets, coarse to fine: 16 m, 8 m, 4 m, 2 m
    dH = erode_multi(H0, W.SIZE)
    rr = np.hypot(X, Y)
    th = np.arctan2(Y, X) % (2 * np.pi)
    wmask = W.smooth(W.rim_radius(th) + 25, W.rim_radius(th) + 110, rr)       # only outside the rim road
    geo = W.geothermal(X, Y)
    H0 = H0 + dH * wmask * (1 - geo)

    R = W.roads(0.5)
    P = np.vstack([r['xy'] for r in R])
    Z = np.concatenate([r['z'] for r in R])
    S = np.concatenate([r['s'] for r in R])
    ID = np.concatenate([np.full(len(r['z']), k) for k, r in enumerate(R)])
    T = np.vstack([np.gradient(r['xy'], axis=0) for r in R])
    T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-9
    # rasterize centerline points, then use a distance transform to give every cell its nearest point
    cell = W.SIZE / (W.N - 1)
    gi = np.clip(np.round((P[:, 1] + W.SIZE / 2) / cell).astype(int), 0, W.N - 1)
    gj = np.clip(np.round((P[:, 0] + W.SIZE / 2) / cell).astype(int), 0, W.N - 1)
    label = -np.ones((W.N, W.N), np.int64)
    label[gi, gj] = np.arange(len(P))
    _, (ii, jj) = distance_transform_edt(label < 0, return_indices=True)
    near = label[ii, jj]
    dx, dy = X - P[near, 0], Y - P[near, 1]
    d = np.hypot(dx, dy)
    side = np.sign(T[near, 0] * dy - T[near, 1] * dx)       # positive to the left of travel
    v = d * np.where(side == 0, 1, side)
    # around branch roads, pull the terrain toward the road (so roads sit naturally along valleys and ridges).
    # the pull uses a per-road blurred height field, so there are no steps between switchback legs
    cellm = W.SIZE / (W.N - 1)
    for k, b in enumerate(W.BRANCHES, start=1):
        on = ((ID[near] == k) & (d < W.ROAD_HALF)).astype(np.float64)
        sig = b['corridor'] / 2.2 / cellm
        wsum = gaussian_filter(on, sig)
        zs = gaussian_filter(on * Z[near], sig) / np.maximum(wsum, 1e-6)
        wc = np.clip(wsum / max(wsum.max(), 1e-6) * 2.2, 0, 1) * 0.85
        H0 = H0 + (zs - H0) * wc
    # carving: on the road use the road height; spread upper and lower bounds outward at the embankment slope (max 29 deg) and clamp the terrain between them.
    # matching only the nearest road would leave a step where the nearest section switches between two legs
    onroad = d < W.ROAD_HALF
    road_z = Z[near] - 0.012 * d * d
    lo = np.where(onroad, road_z, -1e9)
    hi = np.where(onroad, road_z, 1e9)
    kx = 0.55 * cellm
    kd = kx * np.sqrt(2)
    for _ in range(70):
        for dy_, dx_, kk in ((0, 1, kx), (0, -1, kx), (1, 0, kx), (-1, 0, kx), (1, 1, kd), (1, -1, kd), (-1, 1, kd), (-1, -1, kd)):
            sl = np.roll(np.roll(lo, dy_, 0), dx_, 1) - kk
            sh = np.roll(np.roll(hi, dy_, 0), dx_, 1) + kk
            np.maximum(lo, sl, out=lo)
            np.minimum(hi, sh, out=hi)
    Hc = np.clip(H0, lo, hi)
    # keep fine natural relief on cut and fill slopes (no flat planes); weaker right beside the road
    detail = H0 - gaussian_filter(H0, 5)
    Hc = Hc + detail * np.where(Hc != H0, 1.0, 0.0) * W.smooth(W.ROAD_HALF + 2, W.ROAD_HALF + 10, d)
    bad = lo > hi
    Hc[bad] = 0.5 * (lo[bad] + hi[bad])
    # round the 2 m shoulder (no sharp road edge)
    shoulder = W.smooth(W.ROAD_HALF, W.ROAD_HALF + 2.0, d)
    H = np.where(onroad, road_z, Hc * shoulder + np.clip(Hc, road_z - 0.3, road_z + 0.3) * (1 - shoulder))
    # observatory site
    ox, oy = W.obs_center()
    pd = np.hypot(X - ox, Y - oy)
    wp = 1 - W.smooth(W.OBS_PAD, W.OBS_PAD + 22, pd)
    H = H * (1 - wp) + (W.crest_height(W.OBS_ANG) + 0.6) * wp
    return dict(X=X, Y=Y, H=H, v=v, d=d, s=S[near], rid=ID[near], roads=R)


def main():
    argv = sys.argv[1:]
    out = argv[0] if argv else "docs/data"
    chk = argv[1] if len(argv) > 1 else "build/check"
    os.makedirs(out, exist_ok=True)
    os.makedirs(chk, exist_ok=True)
    G = build()
    H = G['H']
    hmin, hmax = float(H.min()) - 1, float(H.max()) + 1
    q = np.round((H - hmin) / (hmax - hmin) * 65535).astype(np.int32)
    dq = np.diff(q, axis=1, prepend=0).astype(np.int16).astype("<i2")
    open(os.path.join(out, "height.bin"), "wb").write(zlib.compress(dq.tobytes(), 9))
    # road field for shaders (half-float RGBA)
    geo = np.zeros_like(H)
    for i in range(0, W.N, 256):
        geo[i:i + 256] = W.geothermal(G['X'][i:i + 256], G['Y'][i:i + 256])
    field = np.stack([np.clip(G['v'], -32, 32), G['s'] % 64.0, G['rid'].astype(float), geo], -1).astype(np.float16)
    open(os.path.join(out, "road.bin"), "wb").write(zlib.compress(field.view('<u2').tobytes(), 9))
    # roads for the car: centerlines every 2 m (three.js axes) and sections
    roads = []
    for r in G['roads']:
        k = 4
        xy, z, s = r['xy'][::k], r['z'][::k], r['s'][::k]
        roads.append(dict(name=r['name'], title=W.ROAD_TITLES[r['name']], closed=r['closed'], length=round(float(r['s'][-1]), 2),
                          pts=[[round(float(a), 2), round(float(c), 2), round(float(-b), 2), round(float(e), 1)] for (a, b), c, e in zip(xy, z, s)],
                          zones=[dict(at=a, name=n, sub=t) for a, n, t in W.ZONES[r['name']]]))
    json.dump(roads, open(os.path.join(out, "roads.json"), "w"))
    ox, oy = W.obs_center()
    rim = W.road_polyline(1.0)
    meta = dict(size=W.SIZE, n=W.N, hmin=hmin, hmax=hmax, water=W.WATER, road_half=W.ROAD_HALF,
                road_length=float(rim["length"]),
                obs=[float(ox), float(oy), float(W.crest_height(W.OBS_ANG) + 0.6)], obs_ang=float(W.OBS_ANG),
                cape=dict(th=W.CAPE_TH, r0=W.CAPE_R0, r1=W.CAPE_R1, torii=W.TORII_R),
                jigoku=[float(W.JIGOKU[0]), float(W.JIGOKU[1])], pass_=[float(W.PASS[0]), float(W.PASS[1]), W.PASS_Z],
                # Jigokudani: pools [x, water height (bowl bottom + 0.8 m), z, radius] and vents [x, height, z, strength] (three.js axes)
                pools=[[round(float(px), 2), round(float(sample(H, px, py) + 0.8), 2), round(float(-py), 2), round(float(pr), 2)] for px, py, pr in W.POOLS],
                vents=[[round(float(vx), 2), round(float(sample(H, vx, vy)), 2), round(float(-vy), 2), round(float(vs), 2)] for vx, vy, vs in W.VENTS])
    json.dump(meta, open(os.path.join(out, "terrain.json"), "w"))
    np.savez_compressed(os.path.join(chk, "terrain.npz"), H=H.astype(np.float32), d=G['d'].astype(np.float32),
                        v=G['v'].astype(np.float32), rid=G['rid'].astype(np.int8), geo=geo.astype(np.float32))
    # check image: shading x height color; roads red, lake blue, Jigokudani yellow
    gy, gx = np.gradient(H)
    nx, ny, nz = -gx, -gy, np.ones_like(H)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    L = np.array([-0.5, -0.4, 0.75]); L /= np.linalg.norm(L)
    sh = np.clip((nx * L[0] + ny * L[1] + nz * L[2]) / ln, 0, 1)
    t = np.clip((H - hmin) / (hmax - hmin), 0, 1)
    col = np.stack([0.35 + 0.5 * t, 0.45 + 0.35 * t, 0.3 + 0.3 * t], -1) * sh[..., None]
    col = col * (1 - geo[..., None] * 0.5) + np.array([0.8, 0.7, 0.2]) * geo[..., None] * 0.5
    col[(H < W.WATER) & (np.hypot(G['X'], G['Y']) < 430)] = [0.15, 0.3, 0.45]
    col[G['d'] < W.ROAD_HALF] = [0.8, 0.2, 0.15]
    img = (np.clip(col, 0, 1)[::-1] * 255).astype(np.uint8)
    save_png(os.path.join(chk, "terrain_top.png"), img[::2, ::2].copy())
    sizes = {f: os.path.getsize(os.path.join(out, f)) for f in ("height.bin", "road.bin", "roads.json", "terrain.json")}
    print("TERRAIN", "h", round(hmin, 1), round(hmax, 1), {r['name']: round(float(r['s'][-1])) for r in G['roads']}, sizes)
    for r in G['roads'][1:]:
        g = np.abs(np.diff(r['z'])) / 0.5
        dz = r['z'] - W.base_height(r['xy'][:, 0], r['xy'][:, 1])
        print("  ", r['name'], "max grade", round(float(g.max()) * 100, 1), "%", "z", round(float(r['z'].min()), 1), "..", round(float(r['z'].max()), 1),
              "cut", round(float(dz.min()), 1), "fill", round(float(dz.max()), 1))


if __name__ == '__main__':
    main()
