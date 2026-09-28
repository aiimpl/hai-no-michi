"""Foliage card art: build conifer sprays (every twig and needle) and fern fronds in Blender, shoot them from straight above
into color (with alpha) and normal textures, packed as 4 cells (2x2) in one atlas.
  blender -b --factory-startup -P bake/foliage.py -- <docs/data> <build/check> [resolution]
Cells: top-left = spruce-like spray, top-right = drooping hemlock-like spray, bottom-left = young bright spray, bottom-right = fern frond
"""
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blib as B  # noqa: E402

CARD = (0.64, 0.64)      # size covered by one cell (m)


def quad(bm, col, p, q, w0, w1, z0, z1, c):
    """Thin quad from p to q (base width w0, tip width w1)"""
    dx, dy = q[0] - p[0], q[1] - p[1]
    l = math.hypot(dx, dy) or 1e-6
    nx, ny = -dy / l, dx / l
    bm.faces.new([bm.verts.new((p[0] + nx * w0, p[1] + ny * w0, z0)), bm.verts.new((q[0] + nx * w1, q[1] + ny * w1, z1)),
                  bm.verts.new((q[0] - nx * w1, q[1] - ny * w1, z1)), bm.verts.new((p[0] - nx * w0, p[1] - ny * w0, z0))])
    col[len(col)] = c


NEEDLE = {
    # needle length, width, spacing, spread (deg), twig length ratio, color (dark, light)
    'spruce': dict(nl=0.021, nw=0.0014, step=0.0028, spread=(40, 82), twig=0.46, dark=(0.024, 0.052, 0.020), light=(0.13, 0.22, 0.05)),
    'hemlock': dict(nl=0.016, nw=0.0017, step=0.0024, spread=(66, 90), twig=0.52, dark=(0.020, 0.048, 0.018), light=(0.11, 0.20, 0.045)),
    'young': dict(nl=0.019, nw=0.0015, step=0.0027, spread=(45, 85), twig=0.42, dark=(0.05, 0.10, 0.03), light=(0.24, 0.34, 0.07)),
}


def spray(bm, col, rng, P, x0, y0, ang, L, level, tip0, z):
    """Build a spray recursively. level 0 = main axis, 1 = twig, 2 = sub-twig. tip0 = how tip-like the base of this branch is (drives color)"""
    x1, y1 = x0 + L * math.cos(ang), y0 + L * math.sin(ang)
    w = (0.0030, 0.0018, 0.0011)[level]
    quad(bm, col, (x0, y0), (x1, y1), w, w * 0.5, z, z, (0.075, 0.05, 0.03))
    # needles on both sides of the stem, shorter and lighter toward the tip
    n = max(2, int(L / P['step']))
    for j in range(n):
        t = (j + rng.random() * 0.6) / n
        px, py = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        tip = min(1.0, tip0 + (1 - tip0) * t ** 1.6)
        for sgn in (-1, 1):
            a = ang + sgn * math.radians(rng.uniform(*P['spread']))
            nl = P['nl'] * rng.uniform(0.8, 1.15) * (1.0 - 0.35 * t ** 2)
            qx, qy = px + nl * math.cos(a), py + nl * math.sin(a)
            k = min(1.0, max(0.0, tip * 0.85 + rng.uniform(-0.12, 0.12)))
            c = tuple((P['dark'][i] + (P['light'][i] - P['dark'][i]) * k) * rng.uniform(0.85, 1.15) for i in range(3))
            zz = z + rng.uniform(-0.003, 0.004)
            quad(bm, col, (px, py), (qx, qy), P['nw'], P['nw'] * 0.35, zz, zz + 0.002, c)
    if level >= 2:
        return
    # side twigs: alternating, shorter toward the tip
    m = {0: 12, 1: 7}[level]
    for i in range(m):
        t = 0.1 + 0.82 * (i + rng.uniform(-0.2, 0.2)) / m
        bx, by = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        side = 1 if i % 2 == 0 else -1
        ln = L * P['twig'] * (1.0 - 0.72 * t) * rng.uniform(0.85, 1.15)
        a = ang + side * math.radians(rng.uniform(40, 58))
        spray(bm, col, rng, P, bx, by, a, ln, level + 1, tip0 + (1 - tip0) * t * 0.7, z + 0.004 * (level + 1))


def needle_cluster(bm, col, rng, kind):
    """Three long sprays fanned out in one cell (attached at the middle of the left edge), so the silhouette breaks up like feathers"""
    P = dict(NEEDLE[kind])
    P['twig'] = P['twig'] * 0.62
    fan = [(0.0, 0.6), (0.3, 0.48), (-0.32, 0.44)] if kind != 'young' else [(0.0, 0.58), (0.36, 0.4), (-0.3, 0.38)]
    for k, (a, ln) in enumerate(fan):
        a += rng.uniform(-0.05, 0.05)
        ox = 0.02 + 0.05 * k
        spray(bm, col, rng, P, ox, 0.0, a, min(ln, (0.62 - ox) / max(0.3, math.cos(a))), 0, 0.15 + 0.1 * k, -0.006 * k)


def fern_frond(bm, col, rng):
    """Fern frond: a gently arched rachis with pinnae shortening toward the tip, each made of lobed pinnules"""
    L = 0.6
    def axis(t):
        return 0.02 + L * t, 0.035 * math.sin(t * 2.6)
    for i in range(48):
        quad(bm, col, axis(i / 48), axis((i + 1) / 48), 0.0032 * (1 - i / 60), 0.0032 * (1 - (i + 1) / 60), 0.0, 0.0, (0.07, 0.11, 0.03))
    n = 28
    for i in range(n):
        t = 0.05 + 0.93 * i / n
        px, py = axis(t)
        pl = (0.17 * math.sin(math.pi * min(1.0, 0.12 + t * 1.05)) ** 0.7 * (1.0 - 0.45 * t) + 0.01) * rng.uniform(0.92, 1.06)
        for sgn in (-1, 1):
            ang = sgn * math.radians(64 + 12 * t) + math.radians(10)
            # pinna: long pointed leaf with fine serrations and a slightly eared base
            seg = 18
            wmax = 0.0105 * (0.85 + 0.35 * (1 - t))
            teeth = max(5, int(pl / 0.008))
            bend = sgn * math.radians(10)
            prev = None
            for j in range(seg + 1):
                s_ = j / seg
                a_ = ang + bend * s_
                cx, cy = px + pl * s_ * math.cos(a_), py + pl * s_ * math.sin(a_)
                w = wmax * (math.sin(math.pi * min(1.0, 0.18 + s_ * 0.9)) ** 0.8) * (1.0 - 0.8 * s_ ** 2)
                w *= 1.0 - 0.22 * abs(math.sin(s_ * math.pi * teeth))
                nx, ny = -math.sin(a_), math.cos(a_)
                L_ = bm.verts.new((cx + nx * w, cy + ny * w, 0.0015 + 0.004 * s_))
                R_ = bm.verts.new((cx - nx * w, cy - ny * w, 0.0015 + 0.004 * s_))
                if prev:
                    bm.faces.new([prev[0], L_, R_, prev[1]])
                    k = rng.uniform(-0.08, 0.08)
                    shade = 0.8 + 0.35 * s_
                    col[len(col)] = (0.05 * shade + 0.04 * k, (0.16 + 0.06 * (1 - t)) * shade + 0.08 * k, 0.028 * shade)
                prev = (L_, R_)
            # midrib: follows the curve of the pinna, stopping short of the tip
            for j in range(8):
                s0, s1 = j / 10, (j + 1) / 10
                a0, a1 = ang + bend * s0, ang + bend * s1
                quad(bm, col, (px + pl * s0 * math.cos(a0), py + pl * s0 * math.sin(a0)),
                     (px + pl * s1 * math.cos(a1), py + pl * s1 * math.sin(a1)), 0.0008, 0.0006, 0.008, 0.008, (0.06, 0.13, 0.03))


def build(kind, rng):
    bm = bmesh.new()
    col = {}
    if kind == 'fern':
        fern_frond(bm, col, rng)
    else:
        needle_cluster(bm, col, rng, kind)
    me = bpy.data.meshes.new(kind)
    bm.to_mesh(me)
    bm.free()
    attr = me.color_attributes.new('col', 'FLOAT_COLOR', 'CORNER')
    cols = [col[i] for i in range(len(me.polygons))]
    for p in me.polygons:
        c = cols[p.index]
        for li in p.loop_indices:
            attr.data[li].color = (c[0], c[1], c[2], 1.0)
    ob = bpy.data.objects.new(kind, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def emit_material(mode):
    """mode: color = color attribute, normal = world normal packed to 0..1 (shot from above, so it is the card normal)"""
    m, nt = B.mat_new('emit_' + mode)
    em = B.N(nt, 'ShaderNodeEmission')
    if mode == 'color':
        a = B.N(nt, 'ShaderNodeVertexColor', layer_name='col')
        B.L(nt, a.outputs[0], em.inputs[0])
    else:
        g = B.N(nt, 'ShaderNodeNewGeometry')
        # treat faces as upward regardless of which side faces the camera
        sep = B.N(nt, 'ShaderNodeSeparateXYZ'); B.L(nt, g.outputs['Normal'], sep.inputs[0])
        ab = B.N(nt, 'ShaderNodeMath', operation='SIGN'); B.L(nt, sep.outputs['Z'], ab.inputs[0])
        sc = B.N(nt, 'ShaderNodeVectorMath', operation='SCALE'); B.L(nt, g.outputs['Normal'], sc.inputs[0]); B.L(nt, ab.outputs[0], sc.inputs['Scale'])
        mad = B.N(nt, 'ShaderNodeVectorMath', operation='MULTIPLY_ADD')
        B.L(nt, sc.outputs[0], mad.inputs[0]); mad.inputs[1].default_value = (0.5, 0.5, 0.5); mad.inputs[2].default_value = (0.5, 0.5, 0.5)
        B.L(nt, mad.outputs[0], em.inputs[0])
    B.L(nt, em.outputs[0], B.out_node(nt).inputs['Surface'])
    return m


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv else 'docs/data'
    chk = argv[1] if len(argv) > 1 else 'build/check'
    res = int(argv[2]) if len(argv) > 2 else 1024
    B.reset()
    scn = B.gpu_cycles(24)
    scn.cycles.use_denoising = False
    scn.render.film_transparent = True
    scn.view_settings.view_transform = 'Standard'
    scn.render.resolution_x = scn.render.resolution_y = res
    scn.render.image_settings.file_format = 'PNG'
    scn.render.image_settings.color_mode = 'RGBA'
    scn.render.image_settings.color_depth = '8'
    scn.render.filter_size = 1.2
    rng = random.Random(7)
    kinds = ['spruce', 'hemlock', 'young', 'fern']
    obs = [build(k, rng) for k in kinds]
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scn.collection.objects.link(cam); scn.camera = cam
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = CARD[0]
    cam.location = (CARD[0] / 2, 0.0, 1.0)
    mats = {m: emit_material(m) for m in ('color', 'normal')}
    tiles = {}
    for mode in ('color', 'normal'):
        scn.view_settings.view_transform = 'Standard'
        for ob in obs:
            ob.data.materials.clear(); ob.data.materials.append(mats[mode])
        for i, ob in enumerate(obs):
            for o in obs:
                o.hide_render = o is not ob
            path = os.path.join(chk, f'fol_{mode}_{kinds[i]}.png')
            scn.render.filepath = path
            # no color transform for normals (Standard still writes sRGB, so it is undone on read)
            bpy.ops.render.render(write_still=True)
            img = bpy.data.images.load(path)
            a = np.empty(res * res * 4, np.float32); img.pixels.foreach_get(a)
            tiles[(mode, i)] = a.reshape(res, res, 4)
    # pack into 2x2. Color stays sRGB; normals are converted back to linear before 8-bit output
    for mode in ('color', 'normal'):
        atlas = np.zeros((res * 2, res * 2, 4), np.float32)
        for i in range(4):
            r, c = divmod(i, 2)
            t = tiles[(mode, i)]
            if mode == 'normal':
                rgb = t[..., :3]
                t = t.copy()
                t[..., :3] = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
                t[..., 3] = tiles[('color', i)][..., 3]
            atlas[(1 - r) * res:(2 - r) * res, c * res:(c + 1) * res] = t   # image rows run bottom to top
        img = bpy.data.images.new(f'foliage_{mode}', res * 2, res * 2, alpha=True)
        img.colorspace_settings.name = 'Non-Color'
        img.pixels.foreach_set(atlas.ravel())
        img.filepath_raw = os.path.join(out, f'foliage_{mode}.png')
        img.file_format = 'PNG'
        img.save()
    print('FOLIAGE', {k: len(o.data.polygons) for k, o in zip(kinds, obs)})


if __name__ == '__main__':
    main()
