"""World shape: caldera rim, lake, outer forest slopes, distant mountains.
Pure numpy; imported by both the Blender scripts (placement, baking) and the exporter (terrain.py).
Axes match Blender: z up, meters. Passed to three.js as (x, z, -y).
"""
import numpy as np

SIZE = 2048.0          # terrain side length (m), centered on the origin
N = 2049               # grid points per side (1 m spacing)
WATER = 0.0            # lake surface height

RIM_R = 330.0          # mean radius of the rim (road)
CREST = 30.0           # mean rim height
ROAD_HALF = 3.6        # road half-width
OBS_ANG = np.radians(58.0)     # observatory bearing (counter-clockwise from the x axis)
OBS_OFF = 30.0         # offset outward from the road (annex front about 6 m from the road)
OBS_PAD = 40.0         # observatory site radius


def hash2(ix, iy, seed):
    h = np.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453
    return h - np.floor(h)


def vnoise(x, y, seed=0):
    ix, iy = np.floor(x), np.floor(y)
    fx, fy = x - ix, y - iy
    ux, uy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a = hash2(ix, iy, seed)
    b = hash2(ix + 1, iy, seed)
    c = hash2(ix, iy + 1, seed)
    d = hash2(ix + 1, iy + 1, seed)
    return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy


def pnoise(x, y, seed=0):
    """Gradient (Perlin) noise: shows less grid alignment than value noise. Remapped from -1..1 to 0..1"""
    ix, iy = np.floor(x), np.floor(y)
    fx, fy = x - ix, y - iy

    def grad(i, j, dx, dy):
        a = hash2(i, j, seed + 0.37) * 6.283185307
        return np.cos(a) * dx + np.sin(a) * dy
    u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
    n00 = grad(ix, iy, fx, fy); n10 = grad(ix + 1, iy, fx - 1, fy)
    n01 = grad(ix, iy + 1, fx, fy - 1); n11 = grad(ix + 1, iy + 1, fx - 1, fy - 1)
    n = (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v
    return np.clip(n * 0.72 + 0.5, 0, 1)


def ridged_mf(x, y, octaves, seed, gain=1.6):
    """Ridged multifractal: rotates coordinates per octave to hide grid alignment. Sharp peaks, rounded valleys"""
    m, amp, wgt = 0.0, 1.0, 1.0
    for i in range(octaves):
        a = 0.62 * i + 0.3
        ca, sa = np.cos(a), np.sin(a)
        f = 2.07 ** i
        px, py = (x * ca - y * sa) * f + i * 13.1, (x * sa + y * ca) * f - i * 7.7
        r = 1 - np.abs(2 * pnoise(px, py, seed + i * 7) - 1)
        r = r * r * wgt
        m = m + r * amp
        wgt = np.clip(r * gain, 0, 1)
        amp *= 0.5
    return m


def fbm(x, y, octaves=5, seed=0):
    v, amp, f = 0.0, 0.5, 1.0
    for i in range(octaves):
        v = v + amp * (vnoise(x * f, y * f, seed + i * 13) - 0.5)
        f *= 2.03
        amp *= 0.5
    return v


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def ang_noise(th, freqs, seed):
    """Smooth variation by bearing only (always wraps seamlessly)"""
    v = 0.0
    for k, (f, a) in enumerate(freqs):
        ph = hash2(np.float64(k), np.float64(seed), 3.0) * 6.2832
        v = v + a * np.sin(f * th + ph)
    return v


def rim_radius(th):
    return RIM_R + ang_noise(th, [(2, 14.0), (3, 9.0), (5, 5.0), (8, 2.0)], 1)


def crest_height(th):
    return CREST + ang_noise(th, [(1, 7.0), (3, 4.0), (6, 2.0), (11, 0.8)], 2)


def road_polyline(step=1.0):
    """Road centerline (full loop). Returns points, bearings and arc length"""
    th = np.linspace(0, 2 * np.pi, 8192, endpoint=False)
    r = rim_radius(th)
    p = np.stack([r * np.cos(th), r * np.sin(th)], 1)
    seg = np.linalg.norm(np.roll(p, -1, 0) - p, axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    L = s[-1]
    ss = np.arange(0, L, step)
    tt = np.interp(ss, s, np.concatenate([th, [2 * np.pi]]))
    rr = rim_radius(tt)
    x, y = rr * np.cos(tt), rr * np.sin(tt)
    z = crest_height(tt)
    return dict(x=x, y=y, z=z, th=tt, s=ss, length=L)


def polar_road(x, y):
    """Per point: bearing, lateral distance from the road (outward positive), arc length along the road"""
    th = np.arctan2(y, x) % (2 * np.pi)
    r = np.hypot(x, y)
    rc = rim_radius(th)
    # correct the lateral distance stretched by road curvature (dr/ds slope)
    e = 1e-3
    drdt = (rim_radius(th + e) - rim_radius(th - e)) / (2 * e)
    cosk = rc / np.sqrt(rc * rc + drdt * drdt)
    v = (r - rc) * cosk
    return th, v, rc


def obs_center():
    rc = rim_radius(OBS_ANG) + OBS_OFF
    return rc * np.cos(OBS_ANG), rc * np.sin(OBS_ANG)


def polar(th_deg, r):
    """Bearing (deg) and radius -> (x, y)"""
    t = np.radians(th_deg)
    return (r * np.cos(t), r * np.sin(t))


# ---- Landmarks -----------------------------------------------------------------------
# lakeside shrine: a cape jutting into the lake and shallows with a torii (bearing 118 deg; the north shore stays sunlit into the evening, with the sunset beyond the torii to the south)
CAPE_TH = 118.0
CAPE_R0, CAPE_R1 = 282.0, 236.0          # cape base and tip (radius)
TORII_R = 222.0                          # torii (in the shallows)
# Jigokudani: a hollow on the outer slope (bearing 200 deg, radius 540 m)
JIGOKU = polar(200.0, 540.0)
JIGOKU_R = (120.0, 80.0)                 # ellipse radii of the hollow
# pass over the outer rim: outer mountain at bearing 97 deg; the pass is at radius 930 m
PASS = polar(97.0, 930.0)
PASS_Z = 64.0


def jigoku_features():
    """Jigokudani pools (x, y, radius) and vents (x, y, strength), scattered on the valley floor with a fixed seed (kept off the road)"""
    rng = np.random.default_rng(17)
    b = next(b for b in BRANCHES if b['name'] == 'jigoku')
    road, _ = catmull([polar(th, rim_radius(np.radians(th)) + dr) for th, dr in b['pts']], 2.0)
    def off_road(x, y, r):
        return np.min(np.hypot(road[:, 0] - x, road[:, 1] - y)) > r + 12
    pools, vents = [], []
    while len(pools) < 9:
        a, r = rng.uniform(0, 2 * np.pi), np.sqrt(rng.uniform(0, 1)) * 0.62
        x, y = JIGOKU[0] + np.cos(a) * r * JIGOKU_R[0], JIGOKU[1] + np.sin(a) * r * JIGOKU_R[1]
        rad = rng.uniform(3.0, 8.5)
        if off_road(x, y, rad) and all(np.hypot(x - p[0], y - p[1]) > p[2] + rad + 6 for p in pools):
            pools.append((x, y, rad))
    while len(vents) < 16:
        a, r = rng.uniform(0, 2 * np.pi), np.sqrt(rng.uniform(0, 1)) * 0.75
        x, y = JIGOKU[0] + np.cos(a) * r * JIGOKU_R[0], JIGOKU[1] + np.sin(a) * r * JIGOKU_R[1]
        if off_road(x, y, 0):
            vents.append((x, y, rng.uniform(0.4, 1.0)))
    for p in pools[:5]:                               # steam from the rims of the large pools too
        vents.append((p[0] + p[2] * 0.6, p[1], 0.8))
    return pools, vents



def cape_mask(x, y):
    """Cape ridge (0..1) and the shallows around it (0..1)"""
    t = np.radians(CAPE_TH)
    ax, ay = np.cos(t), np.sin(t)
    along = x * ax + y * ay                      # radial
    across = -x * ay + y * ax
    u = np.clip((CAPE_R0 - along) / (CAPE_R0 - CAPE_R1), 0, 1)
    inside = (along < CAPE_R0 + 10) & (along > CAPE_R1 - 30)
    w = 13.0 * (1 - 0.45 * u) + 3.0 * fbm(x / 20, y / 20, 3, 61)
    ridge = np.where(inside, 1 - smooth(w * 0.55, w, np.abs(across)), 0.0) * smooth(CAPE_R1 - 16, CAPE_R1 + 4, along)
    shelf_d = np.hypot(np.maximum(np.abs(across) - w * 0.4, 0), np.maximum(CAPE_R1 - 6 - along, 0))
    shelf = np.where(along < CAPE_R0 + 20, 1 - smooth(8.0, 30.0, shelf_d), 0.0) * smooth(CAPE_R1 - 60, CAPE_R1 - 20, along)
    return ridge, shelf


def base_height(x, y):
    """Natural terrain before the roads are carved"""
    th, v, rc = polar_road(x, y)
    r = np.hypot(x, y)
    crest = crest_height(th)
    # inside: steep drop from the rim, easing at the shore, down to the lake bed
    din = np.maximum(-v, 0)
    shore = 46.0 + ang_noise(th, [(4, 9.0), (7, 5.0)], 5)
    t = np.clip(din / shore, 0, 1)
    h_in = crest * (1 - t) ** 1.6 * (1 - 0.15 * t)
    h_in = np.where(din > shore, -np.minimum((din - shore) * 0.35, 28.0), h_in)
    # outside: gentle forest slopes, a valley, then distant mountains; higher toward the pass bearing
    dout = np.maximum(v, 0)
    floor = 22.0 + 6.0 * fbm(x / 180, y / 180, 3, 31)
    h_out = crest - (crest - floor) * smooth(0, 300, dout) ** 0.85
    thd = np.degrees(th)
    massif = 1 + 0.9 * np.exp(-((((thd - 97) + 180) % 360 - 180) / 22) ** 2)
    # outer rim: only the large ridge forms here (gullies and ridge detail come from erosion in terrain.py).
    # 4 octaves of ridged noise on warped coordinates; coarse octaves strongest, fine ones only on ridges (sharp peaks, rounded valleys)
    wx = x / 640 + 0.45 * fbm(x / 1400, y / 1400, 3, 61)
    wy = y / 640 + 0.45 * fbm(x / 1400 + 3.7, y / 1400, 3, 62)
    m = ridged_mf(wx, wy, 6, 21)
    mount = (30 + 230 * m / 1.75) * smooth(620, 1000, r) ** 1.2 * massif
    h_out = h_out + mount
    h = np.where(v < 0, h_in, h_out)
    # relief
    h = h + fbm(x / 70, y / 70, 5, 7) * 9.0 * smooth(-10, 40, h) * (1 - 0.7 * smooth(650, 900, r))
    h = h + fbm(x / 9, y / 9, 3, 9) * 0.9
    # Jigokudani: elliptical hollow with a flat floor and occasional mounds
    q = np.hypot((x - JIGOKU[0]) / JIGOKU_R[0], (y - JIGOKU[1]) / JIGOKU_R[1])
    bowl = 1 - smooth(0.55, 1.15, q + 0.15 * fbm(x / 40, y / 40, 3, 71))
    h = h - 17.0 * bowl + 2.0 * fbm(x / 25, y / 25, 3, 73) * bowl
    # pools: shallow bowls with slightly raised rims; vents are small mounds
    for px, py, pr in POOLS:
        q = np.hypot(x - px, y - py) / pr
        h = h - 1.1 * (1 - smooth(0.7, 1.05, q)) + 0.35 * np.exp(-((q - 1.15) / 0.18) ** 2)
    for vx, vy, vs in VENTS:
        q = np.hypot(x - vx, y - vy)
        h = h + 0.9 * vs * np.exp(-(q / 2.5) ** 2) - 0.5 * vs * np.exp(-(q / 0.7) ** 2)
    # cape and shallows
    rg, sh = cape_mask(x, y)
    h = np.where(sh > 0, np.maximum(h, -0.9 + 0.5 * fbm(x / 12, y / 12, 2, 81)) * sh + h * (1 - sh), h)
    h = h * (1 - rg) + (1.5 + 0.6 * fbm(x / 15, y / 15, 2, 83)) * rg
    return h


def geothermal(x, y):
    """Jigokudani strength (0..1): used for ground paint, steam and vegetation"""
    q = np.hypot((x - JIGOKU[0]) / JIGOKU_R[0], (y - JIGOKU[1]) / JIGOKU_R[1])
    return 1 - smooth(0.6, 1.25, q + 0.2 * fbm(x / 35, y / 35, 3, 75))


# ---- Roads --------------------------------------------------------------------------
# the rim loop (0) and branch roads. Branches are (bearing deg, radius) points; switchbacks go back and forth between points
BRANCHES = [
    # lakeside: from the rim at 150 deg, switchback down the inner slope while bearing decreases, then along the beach to the cape (118 deg)
    dict(name='shore', start=150.0, corridor=14.0, pts=[(150.0, 0), (137.0, -12), (126.0, -17), (134.0, -26), (146.0, -31),
                                         (138.0, -39), (128.0, -46), (121.5, -49), (CAPE_TH, -62), (CAPE_TH, -88)]),
    dict(name='jigoku', start=196.0, corridor=16.0, pts=[(196.0, 0), (197.5, 40), (199.0, 95), (201.5, 150), (200.0, 190), (197.0, 215),
                                          (200.0, 240), (203.5, 222), (202.5, 195)]),
]


def catmull(P, step):
    """Smooth the control polyline with Catmull-Rom and resample every step m"""
    P = np.asarray(P, float)
    P = np.vstack([P[0] * 2 - P[1], P, P[-1] * 2 - P[-2]])
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        n = max(4, int(np.linalg.norm(p2 - p1) / 0.5))
        t = np.linspace(0, 1, n, endpoint=False)[:, None]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(P[-2][None])
    Q = np.vstack(out)
    seg = np.linalg.norm(np.diff(Q, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    ss = np.arange(0, s[-1], step)
    return np.stack([np.interp(ss, s, Q[:, 0]), np.interp(ss, s, Q[:, 1])], 1), ss


def grade_limit(z, step, g, fixed=1):
    """Forward and backward pass so neighbors differ by at most step*g. The first fixed points (the junction with the rim road) stay put"""
    z = z.copy()
    for _ in range(3):
        for i in range(len(z) - 2, fixed - 1, -1):
            z[i] = np.clip(z[i], z[i + 1] - step * g, z[i + 1] + step * g)
        for i in range(1, len(z)):
            z[i] = np.clip(z[i], z[i - 1] - step * g, z[i - 1] + step * g)
    return z


def roads(step=0.5):
    """Road centerlines: [{name, xy(N,2), z(N), s(N), closed}]. Index 0 is the rim loop"""
    ring = road_polyline(step)
    out = [dict(name='rim', xy=np.stack([ring['x'], ring['y']], 1), z=ring['z'], s=ring['s'], closed=True)]
    for b in BRANCHES:
        th0 = b['start']
        ctrl = []
        for th, dr in b['pts']:
            r = rim_radius(np.radians(th)) + dr
            ctrl.append(polar(th, r))
        xy, s = catmull(ctrl, step)
        z = base_height(xy[:, 0], xy[:, 1])
        # road height: smoothed terrain (about a 20 m window), grade capped at 11%; the junction matches the rim road height
        k = int(10 / step)
        zp = np.pad(z, k, mode='edge')
        win = np.exp(-np.linspace(-2.2, 2.2, 2 * k + 1) ** 2); win /= win.sum()
        z = np.convolve(zp, win, mode='valid')
        # the first 20 m stay at rim-road height (no step at the junction), then descend
        k0 = int(20 / step)
        z[:k0] = crest_height(np.radians(th0))
        z = grade_limit(z, step, b.get('grade', 0.11), fixed=k0)
        if b['name'] == 'shore':
            z = np.maximum(z, 1.3)                    # the beach road stays above the water
        out.append(dict(name=b['name'], xy=xy, z=z, s=s, closed=False))
    return out


POOLS, VENTS = jigoku_features()


ROAD_TITLES = {'rim': 'ON THE RIM ROAD', 'shore': 'DOWN TO THE LAKE', 'jigoku': 'INTO JIGOKUDANI', 'pass': 'OVER THE OUTER RIDGE'}


ZONES = {
    # sections per road: (distance along road m, name, caption). The rim road uses bearing (deg)
    'rim': [(330.0, "The ash road", "Below, the lake keeps the sky."),
            (28.0, "Station road", "Someone still grades this road."),
            (36.0, "The observatory", "Its dome has not turned in years."),
            (80.0, "The north rim", "Wind comes over the lip and falls."),
            (170.0, "Pumice flats", "White stones, light as bread."),
            (250.0, "The burnt slope", "Old fire, new spruce.")],
    'shore': [(0.0, "Nine bends", "The road folds down to the water."),
              (330.0, "The lake shore", "Black sand, and a boat nobody takes out."),
              (390.0, "Mizu-no-yashiro", "A gate that stands in the lake.")],
    'jigoku': [(0.0, "Down from the rim", "The trees thin. The air smells of eggs."),
               (160.0, "Jigokudani", "The ground breathes here.")],
    'pass': [(0.0, "Toward the outer ridge", "Spruce gives way to stone."),
             (560.0, "Above the trees", "Grass, stone, and a long way down."),
             (880.0, "Kaze-no-tōge", "The whole caldera, and the wind.")],
}
