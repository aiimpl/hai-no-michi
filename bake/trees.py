"""Conifers: build trunk, whorled branches and foliage cards; export near (LOD0) and mid-range (LOD1) glb files.
Far impostors (shot from 8x8 hemisphere directions) are made by impostor.py.
  blender -b --factory-startup -P bake/trees.py -- <docs/data> <build/check>
Foliage card UVs point into the 2x2 cells of the foliage.py atlas. Trunk UVs are in meters (bark is drawn in three.js).
Color attribute col: R = inner-crown darkness (0 dark to 1 outer), G = sway amount (0 trunk to 1 branch tip), B = per-tree random
"""
import math
import os
import random
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blib as B  # noqa: E402

CARD = 0.64
SLOT = {'spruce': (0, 0), 'hemlock': (0, 1), 'young': (1, 0), 'fern': (1, 1)}   # (row, column); row 0 is the top

# species: height, crown start (fraction of height), max branch length, branch droop, foliage cell, card size, trunk radius
KINDS = {
    'spruce': dict(H=24.0, crown=0.3, lmax=3.8, droop=0.26, card='spruce', cs=1.2, r0=0.30, whorl=0.34, per=8, hang=0.35),
    'hemlock': dict(H=20.0, crown=0.22, lmax=3.9, droop=0.45, card='hemlock', cs=1.25, r0=0.28, whorl=0.32, per=8, hang=0.7),
    'young': dict(H=8.5, crown=0.05, lmax=2.2, droop=0.16, card='young', cs=0.95, r0=0.12, whorl=0.28, per=7, hang=0.2),
    'tall': dict(H=31.0, crown=0.4, lmax=4.3, droop=0.3, card='spruce', cs=1.35, r0=0.42, whorl=0.4, per=8, hang=0.4),
}


def slot_uv(card, u, v):
    r, c = SLOT[card]
    return (c * 0.5 + u * 0.5, (1 - r) * 0.5 + v * 0.5)


class Mesh:
    """Accumulate vertices, UVs, colors and custom normals, then build one mesh at the end"""
    def __init__(self):
        self.v, self.f, self.uv, self.col, self.n = [], [], [], [], []

    def add(self, pts, faces, uvs, cols, nrms):
        o = len(self.v)
        self.v += pts; self.uv += uvs; self.col += cols; self.n += nrms
        self.f += [[o + i for i in f] for f in faces]

    def build(self, name):
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(p) for p in self.v], [], self.f)
        me.update()
        uvl = me.uv_layers.new(name='uv')
        ca = me.color_attributes.new('col', 'BYTE_COLOR', 'CORNER')
        for p in me.polygons:
            for li in p.loop_indices:
                vi = me.loops[li].vertex_index
                uvl.data[li].uv = self.uv[vi]
                ca.data[li].color = (*self.col[vi], 1.0)
        me.shade_smooth()
        me.normals_split_custom_set_from_vertices([tuple(Vector(n).normalized()) for n in self.n])
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def trunk(M, K, rng, sides, seed):
    H, r0 = K['H'], K['r0']
    rings = int(H / 0.8) + 4
    lean = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * 0.012
    axis = []
    for i in range(rings + 1):
        t = i / rings
        z = H * t
        wob = Vector((math.sin(z * 0.37 + seed) * 0.06, math.cos(z * 0.29 + seed * 2) * 0.06, 0)) * (0.3 + t)
        axis.append(Vector((0, 0, z)) + lean * z + wob)
    pts, faces, uvs, cols, nrms = [], [], [], [], []
    for i, c in enumerate(axis):
        t = i / rings
        r = r0 * (1 - t) ** 0.85 + 0.015
        r *= 1.0 + 0.55 * max(0.0, 1 - c.z / 1.2) ** 2          # root flare
        for k in range(sides + 1):
            a = 2 * math.pi * k / sides
            rr = r * (1 + 0.06 * math.sin(a * 3 + seed) * max(0.0, 1 - c.z / 2))
            p = c + Vector((math.cos(a) * rr, math.sin(a) * rr, 0))
            pts.append(p); nrms.append((math.cos(a), math.sin(a), 0.15))
            uvs.append((a / (2 * math.pi) * 2 * math.pi * r0, c.z))     # meters (circumference, height)
            cols.append((0.35 + 0.65 * t, 0.0, seed % 1.0))
    for i in range(rings):
        for k in range(sides):
            a = i * (sides + 1) + k
            faces.append([a, a + 1, a + sides + 2, a + sides + 1])
    M.add(pts, faces, uvs, cols, nrms)
    return axis


def card(M, card_name, origin, d, up, size, bend, ao, sway, rnd, n_seg=2):
    """Foliage card extending from its attachment point origin along d. bend is the tip droop (m)"""
    side = up.cross(d).normalized()
    upn = d.cross(side).normalized()
    pts, uvs, cols, nrms, faces = [], [], [], [], []
    for i in range(n_seg + 1):
        s = i / n_seg
        for j, v in enumerate((-0.5, 0.5)):
            p = origin + d * (s * size) + side * (v * size) - upn * (bend * s * s)
            pts.append(p)
            uvs.append(slot_uv(card_name, s, v + 0.5))
            # normals: blend card-up with outward-from-trunk (shades like a rounded crown)
            out = Vector((p.x, p.y, 0.0)).normalized() if (p.x or p.y) else Vector((0, 0, 1))
            n = (upn * 0.45 + out * 0.55 + Vector((0, 0, 0.25))).normalized()
            nrms.append(tuple(n))
            cols.append((ao, sway * (0.4 + 0.6 * s), rnd))
    for i in range(n_seg):
        a = i * 2
        faces.append([a, a + 2, a + 3, a + 1])
    M.add(pts, faces, uvs, cols, nrms)


def branches(M, K, rng, axis, lod, seed):
    H = K['H']
    zc = H * K['crown']
    whorl = K['whorl'] * (2.1 if lod else 1.0)
    per = K['per'] - (2 if lod else 0)
    cs = K['cs'] * (1.55 if lod else 1.0)
    rnd = (seed * 0.618) % 1.0
    bark_col = (0.1, 0.0, rnd)
    z = zc
    wi = 0
    while z < H - 0.6:
        t = (z - zc) / (H - zc)
        # crown outline: longer toward the bottom, pointed at the top; slightly shorter and rounded at the very bottom
        prof = (1 - t) ** 0.95 * (1 - 0.35 * max(0.0, 0.12 - t) / 0.12)
        L = K['lmax'] * prof + 0.35
        c = axis[min(len(axis) - 1, int(z / H * (len(axis) - 1)))]
        phase = rng.uniform(0, 2 * math.pi)
        for b in range(per):
            az = phase + 2 * math.pi * b / per + rng.uniform(-0.25, 0.25)
            l = L * rng.uniform(0.8, 1.1)
            rise = math.radians(18 - 34 * (1 - t) + rng.uniform(-6, 6))      # upward near the top, downward near the bottom
            d0 = Vector((math.cos(az) * math.cos(rise), math.sin(az) * math.cos(rise), math.sin(rise)))
            base = c + Vector((math.cos(az), math.sin(az), 0)) * 0.05
            droop = K['droop'] * l * (0.6 + 0.8 * (1 - t))
            # branch core (near LOD only; thin 4-sided tube)
            if not lod:
                tip = base + d0 * l - Vector((0, 0, droop))
                w = 0.012 + 0.025 * l / K['lmax']
                sd = d0.cross(Vector((0, 0, 1))).normalized()
                ptsb = [base + sd * w, base - sd * w, tip + sd * w * 0.3, tip - sd * w * 0.3,
                        base + Vector((0, 0, w)), tip + Vector((0, 0, w * 0.3))]
                M.add(ptsb, [[0, 2, 3, 1], [4, 5, 2, 0], [1, 3, 5, 4]], [(0, 0)] * 6, [bark_col] * 6,
                      [(0, 0, 1)] * 6)
            # lay foliage cards along the branch (darker near the trunk)
            n = max(1, int(l / (0.27 * cs))) + (0 if lod else 1)
            for k in range(n):
                s = 0.22 + 0.78 * k / max(1, n - 1) if n > 1 else 0.6
                p = base + d0 * (l * s) - Vector((0, 0, droop * s * s))
                dd = (d0 + Vector((0, 0, -droop / max(l, 0.1) * 2 * s))).normalized()
                yaw = rng.uniform(-0.7, 0.7)
                dd = (Matrix.Rotation(yaw, 3, 'Z') @ dd).normalized()
                # droop outer cards more (a curtain of hanging sprays)
                if rng.random() < K['hang'] * s:
                    dd = (dd + Vector((0, 0, -rng.uniform(0.9, 2.2)))).normalized()
                up = (Matrix.Rotation(rng.uniform(-0.5, 0.5), 3, dd) @ Vector((0, 0, 1))).normalized()
                size = CARD * cs * rng.uniform(0.85, 1.15) * (0.75 + 0.35 * prof)
                ao = min(1.0, 0.25 + 0.75 * s) * (0.55 + 0.45 * t)
                card(M, K['card'], p - dd * size * 0.15, dd, up, size, size * K['droop'] * 0.5, ao, s, rng.random())
        z += whorl * rng.uniform(0.85, 1.15)
        wi += 1
    # filler: dark cards around the trunk (so the sky does not show through the crown)
    z = zc + 0.4
    while z < H - 1.5:
        t = (z - zc) / (H - zc)
        c = axis[min(len(axis) - 1, int(z / H * (len(axis) - 1)))]
        for k in range(3 if lod else 4):
            az = rng.uniform(0, 2 * math.pi)
            d = Vector((math.cos(az), math.sin(az), rng.uniform(-0.5, 0.1))).normalized()
            up = (Matrix.Rotation(rng.uniform(-0.6, 0.6), 3, d) @ Vector((0, 0, 1))).normalized()
            size = CARD * cs * (1.0 + 1.2 * (1 - t))
            card(M, K['card'], c + d * 0.1, d, up, size, size * 0.2, 0.12 + 0.2 * t, 0.2, rng.random())
        z += (1.6 if lod else 0.8) * rng.uniform(0.8, 1.2)
    # leader: a few upward-facing cards
    top = axis[-1]
    for k in range(4 if not lod else 2):
        az = 2 * math.pi * k / 4 + rng.uniform(-0.3, 0.3)
        d = Vector((math.cos(az) * 0.35, math.sin(az) * 0.35, 1)).normalized()
        card(M, K['card'], top - Vector((0, 0, 1.1)), d, Vector((math.cos(az), math.sin(az), 0)), CARD * K['cs'] * 0.9, 0.0, 1.0, 1.0, rnd)


def make_tree(name, K, seed, lod):
    rng = random.Random(seed)
    Mt, Mf = Mesh(), Mesh()
    axis = trunk(Mt, K, rng, 7 if lod else 12, seed)
    branches(Mf, K, random.Random(seed + 1), axis, lod, seed)
    t = Mt.build(f'{name}_trunk')
    f = Mf.build(f'{name}_leaves')
    return t, f


def export(path, obs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_materials='PLACEHOLDER',
              export_normals=True, export_texcoords=True, export_yup=True)
    try:
        bpy.ops.export_scene.gltf(**kw, export_vertex_color='ACTIVE')
    except TypeError:
        bpy.ops.export_scene.gltf(**kw, export_colors=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv else 'docs/data'
    chk = argv[1] if len(argv) > 1 else 'build/check'
    B.reset()
    stats = {}
    all_obs = []
    for i, (name, K) in enumerate(KINDS.items()):
        for lod in (0, 1):
            t, f = make_tree(f'{name}_lod{lod}', K, 11 + i * 7, lod)
            t.location.x = f.location.x = i * 9.0        # spread out for checking (moved back to the origin for export)
            stats[f'{name}_lod{lod}'] = (len(t.data.polygons), len(f.data.polygons))
            all_obs += [t, f]
    for o in all_obs:
        o.location.x = 0
    for lod in (0, 1):
        export(os.path.join(out, f'trees_lod{lod}.glb'), [o for o in all_obs if f'_lod{lod}' in o.name])
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(chk, 'trees.blend'))
    print('TREES', stats, {f: os.path.getsize(os.path.join(out, f)) for f in ('trees_lod0.glb', 'trees_lod1.glb')})


if __name__ == '__main__':
    main()
