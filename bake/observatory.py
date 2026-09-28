"""Observatory: cylindrical base, ribbed dome, gallery, lit annex, steel lattice tower and beam.
Baked in Cycles with the same material setup as the car (wear, dust, streaks); exports the glb and textures.
  blender -b --factory-startup -P bake/observatory.py -- <docs/data> <build/check> [resolution]
The origin is the center of the site at ground level. Front (-Y) faces the road.
"""
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blib as B  # noqa: E402
import car as C  # noqa: E402

C.OZ = 0.0            # dust height is measured from the ground

R_DRUM = 13.5
H_DRUM = 9.0
R_DOME = 14.0


def mats():
    M = {}
    M['wall'] = C.material('wall', (0.3, 0.3, 0.29), 0.75, wear=0.3, dust=0.9, scuff=0.6, streak=0.75)
    M['dome'] = C.material('dome', (0.36, 0.36, 0.35), 0.5, metal=0.25, wear=0.4, dust=0.5, scuff=0.8, streak=0.6)
    M['rib'] = C.material('rib', (0.2, 0.2, 0.2), 0.55, metal=0.6, wear=0.5, dust=0.4, streak=0.4)
    M['steel'] = C.material('steel2', (0.08, 0.08, 0.08), 0.55, metal=0.7, wear=0.6, dust=0.5)
    M['rust'] = C.material('rust', (0.12, 0.05, 0.025), 0.8, metal=0.2, wear=0.2, dust=0.6)
    M['conc'] = C.material('conc', (0.2, 0.19, 0.18), 0.9, dust=1.0, scuff=0.4)
    M['roof'] = C.material('roof', (0.07, 0.065, 0.06), 0.85, dust=0.8)
    M['win'] = C.material('win', (0.8, 0.7, 0.5), 0.2, dust=0.0, emit=(1.0, 0.72, 0.42), emit_k=1.0)
    M['glassd'] = C.material('glassd', (0.02, 0.022, 0.025), 0.1, dust=0.2)
    return M


def ring(name, r, z0, z1, mat, seg=64, r1=None, thick=0.0):
    """Cylindrical band (outer face only, or with thickness)"""
    r1 = r if r1 is None else r1
    prof = [(r, z0), (r1, z1)] if not thick else [(r - thick, z0), (r, z0), (r1, z1), (r1 - thick, z1)]
    return B.lathe(name, prof, mat, seg=seg, axis='Z')


def build(M):
    P = []
    add = P.append
    # concrete pad
    add(B.box('apron', (0, 0, -0.15), (46, 40, 0.4), M['conc'], 0.05))
    # Base: plinth, wall, top rim
    add(ring('plinth', R_DRUM + 0.6, 0.0, 0.8, M['conc'], thick=0.6))
    add(B.lathe('drum', [(R_DRUM, 0.8), (R_DRUM, H_DRUM), (R_DRUM - 0.4, H_DRUM), (R_DRUM - 0.4, 0.8)], M['wall'], seg=96, axis='Z'))
    add(B.lathe('cornice', [(R_DRUM - 0.2, H_DRUM - 0.1), (R_DRUM + 0.35, H_DRUM - 0.1), (R_DRUM + 0.35, H_DRUM + 0.35), (R_DRUM - 0.2, H_DRUM + 0.35)], M['rib'], seg=96, axis='Z'))
    # vertical panel seams on the wall, and tall lit windows (two pairs on the road side)
    for k in range(32):
        a = 2 * math.pi * k / 32
        add(B.box('pilaster', (math.cos(a) * (R_DRUM + 0.05), math.sin(a) * (R_DRUM + 0.05), H_DRUM / 2 + 0.4),
                  (0.25, 0.18, H_DRUM - 0.8), M['wall'], 0.03, rot=[((0, 0, 1), a)]))
    for a_deg in (-100, -92, -70, -62):
        a = math.radians(a_deg)
        c = (math.cos(a) * (R_DRUM + 0.03), math.sin(a) * (R_DRUM + 0.03), 5.2)
        add(B.box('winframe', c, (0.2, 1.05, 4.2), M['steel'], 0.03, rot=[((0, 0, 1), a)]))
        c2 = (math.cos(a) * (R_DRUM + 0.1), math.sin(a) * (R_DRUM + 0.1), 5.2)
        add(B.box('window', c2, (0.08, 0.72, 3.8), M['win'], 0.0, rot=[((0, 0, 1), a)]))
    # door
    a = math.radians(-81)
    add(B.box('door', (math.cos(a) * (R_DRUM + 0.05), math.sin(a) * (R_DRUM + 0.05), 1.9), (0.2, 2.4, 2.6), M['steel'], 0.04, rot=[((0, 0, 1), a)]))
    # gallery and railing
    add(ring('gallery', R_DRUM + 1.6, H_DRUM + 0.05, H_DRUM + 0.3, M['steel'], thick=1.6))
    for k in range(72):
        a = 2 * math.pi * k / 72
        x, y = math.cos(a) * (R_DRUM + 1.5), math.sin(a) * (R_DRUM + 1.5)
        add(B.tube('post', [(x, y, H_DRUM + 0.3), (x, y, H_DRUM + 1.35)], 0.03, M['steel'], seg=6))
    for z in (H_DRUM + 0.8, H_DRUM + 1.35):
        pts = [(math.cos(2 * math.pi * k / 96) * (R_DRUM + 1.5), math.sin(2 * math.pi * k / 96) * (R_DRUM + 1.5), z) for k in range(97)]
        add(B.tube('rail', pts, 0.035, M['steel'], seg=6))
    # Dome: skin, meridian and latitude ribs, two bands of the closed slit
    z0 = H_DRUM + 0.35
    prof = [(R_DOME * math.cos(t), z0 + R_DOME * math.sin(t)) for t in np.linspace(0, math.pi / 2, 28)]
    add(B.lathe('dome', prof, M['dome'], seg=128, axis='Z'))
    for k in range(28):
        a = 2 * math.pi * k / 28
        pts = [(math.cos(a) * (R_DOME + 0.12) * math.cos(t), math.sin(a) * (R_DOME + 0.12) * math.cos(t), z0 + (R_DOME + 0.12) * math.sin(t))
               for t in np.linspace(0, math.pi / 2 - 0.04, 24)]
        add(B.tube('meridian', pts, 0.09, M['rib'], seg=6))
    for t in (0.18, 0.4, 0.62, 0.86, 1.1, 1.33):
        rr = (R_DOME + 0.12) * math.cos(t)
        pts = [(math.cos(2 * math.pi * k / 120) * rr, math.sin(2 * math.pi * k / 120) * rr, z0 + (R_DOME + 0.12) * math.sin(t)) for k in range(121)]
        add(B.tube('parallel', pts, 0.08, M['rib'], seg=6))
    for off in (-1.3, 1.3):     # slit (faces away from the road)
        pts = []
        for t in np.linspace(0.0, math.pi / 2, 30):
            r = R_DOME + 0.3
            pts.append((off, r * math.cos(t), z0 + r * math.sin(t)))
        add(B.tube('slit', pts, 0.22, M['rib'], seg=8))
    add(B.lathe('cap', [(0.0, z0 + R_DOME + 0.35), (1.6, z0 + R_DOME + 0.1), (1.6, z0 + R_DOME - 0.3)], M['rib'], seg=32, axis='Z'))
    # Annex: on the road side (-Y), flat overhanging roof, row of lit windows
    ax, ay = 6.0, -R_DRUM - 6.0
    add(B.box('annex', (ax, ay, 2.5), (20.0, 9.0, 5.0), M['wall'], 0.05))
    add(B.box('annex_roof', (ax, ay - 0.6, 5.2), (21.6, 10.8, 0.35), M['roof'], 0.03))
    add(B.box('annex_fascia', (ax, ay - 5.95, 5.1), (21.6, 0.18, 0.55), M['rust'], 0.02))
    for k in range(6):
        x = ax - 7.5 + k * 3.0
        add(B.box('awin_f', (x, ay - 4.52, 2.4), (1.3, 0.12, 1.9), M['steel'], 0.02))
        add(B.box('awin', (x, ay - 4.58, 2.4), (1.05, 0.05, 1.6), M['win']))
    for k in range(4):
        add(B.tube('pipe', [(ax + 10.1, ay - 3 + k * 1.8, 0.3), (ax + 10.1, ay - 3 + k * 1.8, 5.0)], 0.08, M['rust'], seg=8))
    # Tower: square steel tower (tapering upward), cross bracing, top platform, beam to the dome
    tx, ty = -R_DRUM - 9.0, 4.0
    H = 44.0
    def corner(z, sx, sy):
        w = 1.9 - 0.9 * z / H
        return (tx + sx * w, ty + sy * w, z)
    cs = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    for sx, sy in cs:
        add(B.tube('leg', [corner(0, sx, sy), corner(H, sx, sy)], 0.16, M['steel'], seg=8))
    n = 14
    for i in range(n):
        za, zb = H * i / n, H * (i + 1) / n
        for j in range(4):
            a, b = cs[j], cs[(j + 1) % 4]
            add(B.tube('brace', [corner(za, *a), corner(zb, *b)], 0.06, M['steel'], seg=6))
            add(B.tube('brace', [corner(za, *b), corner(zb, *a)], 0.06, M['steel'], seg=6))
            add(B.tube('hbar', [corner(zb, *a), corner(zb, *b)], 0.07, M['steel'], seg=6))
    add(B.box('platform', (tx, ty, H + 0.2), (5.5, 5.5, 0.3), M['steel'], 0.03))
    add(B.box('hut', (tx, ty, H + 1.6), (3.0, 3.0, 2.6), M['rust'], 0.05))
    add(B.tube('mast', [(tx, ty, H + 2.9), (tx, ty, H + 9.0)], 0.07, M['steel'], seg=6))
    # beam (from mid-tower to the shoulder of the dome)
    zb = 17.0
    for off in (-0.7, 0.7):
        add(B.tube('bridge', [(tx + 1.2, ty + off, zb), (-R_DOME * 0.62, ty * 0.3 + off, z0 + R_DOME * 0.62 + 0.4)], 0.14, M['steel'], seg=8))
    for k in range(10):
        t = k / 9
        p0 = (tx + 1.2 + t * (-R_DOME * 0.62 - tx - 1.2), ty + t * (ty * 0.3 - ty), zb + t * (z0 + R_DOME * 0.62 + 0.4 - zb))
        add(B.tube('bridge_r', [(p0[0], p0[1] - 0.7, p0[2]), (p0[0], p0[1] + 0.7, p0[2])], 0.06, M['steel'], seg=6))
    return P


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv else 'docs/data'
    chk = argv[1] if len(argv) > 1 else 'build/check'
    size = int(argv[2]) if len(argv) > 2 else 2048
    B.reset()
    B.gpu_cycles(16)
    M = mats()
    ob = C.finish(B.join('observatory', build(M)))
    bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    print('OBS tris', sum(len(p.vertices) - 2 for p in ob.data.polygons))
    C.unwrap_all([ob], size)
    base = C.bake_pass([ob], 'base', size)
    rough = C.bake_pass([ob], 'rough', size)
    metal = C.bake_pass([ob], 'metal', size)
    emit = C.bake_pass([ob], 'emit', size)
    ao = C.bake_pass([ob], 'ao', size, samples=64)
    C.save_png(os.path.join(out, 'obs_base.png'), base[..., :3], True)
    C.save_png(os.path.join(out, 'obs_orm.png'), np.stack([ao[..., 0], rough[..., 0], metal[..., 0]], -1), False)
    C.save_png(os.path.join(out, 'obs_emit.png'), emit[..., :3], True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(chk, 'observatory.blend'))
    C.export_glb(os.path.join(out, 'observatory.glb'), [ob])
    print('OBS done', os.path.getsize(os.path.join(out, 'observatory.glb')))


if __name__ == '__main__':
    main()
