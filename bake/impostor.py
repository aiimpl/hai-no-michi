"""Tree impostors: shoot the near trees (LOD0) orthographically from an 8x8 set of hemisphere directions.
Two maps: color (including inner-crown darkening) and normal (tree space, packed to 0..1). The 4 species are laid out 2x2.
  blender -b build/check/trees.blend -P bake/impostor.py -- <docs/data> <build/check> [pixels per cell]
Direction mapping (hemi-octahedral): e in [0,1]^2 -> t=2e-1, p=((t.x+t.y)/2, (t.x-t.y)/2), y=1-|p.x|-|p.y|, d=normalize(p.x, y, p.y)
(three.js axes with y up; in Blender this is (x, -z, y)). Camera up is world up made orthogonal to d.
"""
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blib as B  # noqa: E402

GRID = 8
KINDS = ['spruce', 'hemlock', 'young', 'tall']
HEIGHT = {'spruce': 24.0, 'hemlock': 20.0, 'young': 8.5, 'tall': 31.0}


def decode(e):
    tx, ty = e[0] * 2 - 1, e[1] * 2 - 1
    px, pz = (tx + ty) / 2, (tx - ty) / 2
    y = max(0.0, 1 - abs(px) - abs(pz))
    v = Vector((px, y, pz)).normalized()           # three.js axes
    return v


def t2b(v):
    """three.js (x, y up, z) -> Blender (x, -z, y)"""
    return Vector((v.x, -v.z, v.y))


def leaf_mat(data, mode):
    m, nt = B.mat_new('imp_leaf_' + mode)
    N, L = (lambda t, **k: B.N(nt, t, **k)), (lambda a, b: B.L(nt, a, b))
    img = bpy.data.images.load(os.path.join(data, 'foliage_color.png'), check_existing=True)
    tx = N('ShaderNodeTexImage'); tx.image = img
    em = N('ShaderNodeEmission')
    if mode == 'color':
        # same darkening as the three.js foliage: mix(0.09, 1, r^1.3) * 0.62 (per-tree tint is applied in three.js)
        vc = N('ShaderNodeVertexColor', layer_name='col')
        sep = N('ShaderNodeSeparateColor'); L(vc.outputs[0], sep.inputs[0])
        pw = N('ShaderNodeMath', operation='POWER', inputs={1: 1.3}); L(sep.outputs[0], pw.inputs[0])
        ao = N('ShaderNodeMapRange', inputs={3: 0.09 * 0.62, 4: 0.62}); L(pw.outputs[0], ao.inputs[0])
        mul = N('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', inputs={'Factor': 1.0})
        L(tx.outputs[0], mul.inputs[6]); L(ao.outputs[0], mul.inputs[7])
        L(mul.outputs[2], em.inputs[0])
    else:
        g = N('ShaderNodeNewGeometry')
        # Blender normal (x, y, z) -> three.js (x, z, -y), then packed to 0..1
        sp = N('ShaderNodeSeparateXYZ'); L(g.outputs['Normal'], sp.inputs[0])
        neg = N('ShaderNodeMath', operation='MULTIPLY', inputs={1: -1.0}); L(sp.outputs['Y'], neg.inputs[0])
        cb = N('ShaderNodeCombineXYZ'); L(sp.outputs['X'], cb.inputs[0]); L(sp.outputs['Z'], cb.inputs[1]); L(neg.outputs[0], cb.inputs[2])
        mad = N('ShaderNodeVectorMath', operation='MULTIPLY_ADD'); L(cb.outputs[0], mad.inputs[0])
        mad.inputs[1].default_value = (0.5, 0.5, 0.5); mad.inputs[2].default_value = (0.5, 0.5, 0.5)
        L(mad.outputs[0], em.inputs[0])
    tp = N('ShaderNodeBsdfTransparent')
    cl = N('ShaderNodeMath', operation='GREATER_THAN', inputs={1: 0.5}); L(tx.outputs['Alpha'], cl.inputs[0])
    ms = N('ShaderNodeMixShader'); L(cl.outputs[0], ms.inputs[0]); L(tp.outputs[0], ms.inputs[1]); L(em.outputs[0], ms.inputs[2])
    L(ms.outputs[0], B.out_node(nt).inputs['Surface'])
    return m


def bark_mat(mode):
    m, nt = B.mat_new('imp_bark_' + mode)
    em = B.N(nt, 'ShaderNodeEmission')
    if mode == 'color':
        em.inputs[0].default_value = (0.025, 0.021, 0.018, 1)
    else:
        g = B.N(nt, 'ShaderNodeNewGeometry')
        sp = B.N(nt, 'ShaderNodeSeparateXYZ'); B.L(nt, g.outputs['Normal'], sp.inputs[0])
        neg = B.N(nt, 'ShaderNodeMath', operation='MULTIPLY', inputs={1: -1.0}); B.L(nt, sp.outputs['Y'], neg.inputs[0])
        cb = B.N(nt, 'ShaderNodeCombineXYZ'); B.L(nt, sp.outputs['X'], cb.inputs[0]); B.L(nt, sp.outputs['Z'], cb.inputs[1]); B.L(nt, neg.outputs[0], cb.inputs[2])
        mad = B.N(nt, 'ShaderNodeVectorMath', operation='MULTIPLY_ADD'); B.L(nt, cb.outputs[0], mad.inputs[0])
        mad.inputs[1].default_value = (0.5, 0.5, 0.5); mad.inputs[2].default_value = (0.5, 0.5, 0.5)
        B.L(nt, mad.outputs[0], em.inputs[0])
    B.L(nt, em.outputs[0], B.out_node(nt).inputs['Surface'])
    return m


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    data, chk = argv[0], argv[1]
    px = int(argv[2]) if len(argv) > 2 else 128
    scn = B.gpu_cycles(24)
    scn.cycles.use_denoising = False
    scn.render.film_transparent = True
    scn.view_settings.view_transform = 'Standard'
    scn.render.resolution_x = scn.render.resolution_y = px
    scn.render.image_settings.file_format = 'PNG'
    scn.render.image_settings.color_mode = 'RGBA'
    scn.render.filter_size = 1.0
    scn.cycles.max_bounces = 0
    mats = {m: (leaf_mat(data, m), bark_mat(m)) for m in ('color', 'normal')}
    for o in list(bpy.data.objects):
        if '_lod0' not in o.name:
            bpy.data.objects.remove(o)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scn.collection.objects.link(cam); scn.camera = cam
    cam.data.type = 'ORTHO'
    cam.data.clip_start = 0.1; cam.data.clip_end = 400
    atlas = {m: np.zeros((px * GRID * 2, px * GRID * 2, 4), np.float32) for m in ('color', 'normal')}
    tmp = os.path.join(chk, '_imp.png')
    for ki, k in enumerate(KINDS):
        H = HEIGHT[k]
        size = H * 1.12
        center = Vector((0, 0, H * 0.5))
        for o in bpy.data.objects:
            if o.type == 'MESH':
                o.hide_render = not o.name.startswith(k + '_')
        cam.data.ortho_scale = size
        for mode in ('color', 'normal'):
            lm, bm = mats[mode]
            for o in bpy.data.objects:
                if o.type == 'MESH' and o.name.startswith(k + '_'):
                    o.data.materials.clear(); o.data.materials.append(lm if 'leaves' in o.name else bm)
            for j in range(GRID):
                for i in range(GRID):
                    d = decode(((i + 0.5) / GRID, (j + 0.5) / GRID))
                    up = Vector((0, 1, 0)) - d * d.y
                    up = up.normalized() if up.length > 1e-4 else Vector((0, 0, -1))
                    db, ub = t2b(d), t2b(up)
                    cam.location = center + db * 150
                    # camera -Z toward the tree, +Y toward up
                    z = db.normalized(); y = ub.normalized(); x = y.cross(z)
                    R = Matrix((x, y, z)).transposed()
                    cam.matrix_world = Matrix.Translation(cam.location) @ R.to_4x4()
                    scn.render.filepath = tmp
                    bpy.ops.render.render(write_still=True)
                    im = bpy.data.images.load(tmp, check_existing=False)
                    a = np.empty(px * px * 4, np.float32); im.pixels.foreach_get(a)
                    bpy.data.images.remove(im)
                    a = a.reshape(px, px, 4)
                    r0, c0 = divmod(ki, 2)
                    # image rows run bottom to top. Within the species block (2x2, row 0 on top), cell (i, j) counts j from the top
                    y0 = (1 - r0) * px * GRID + (GRID - 1 - j) * px
                    x0 = c0 * px * GRID + i * px
                    atlas[mode][y0:y0 + px, x0:x0 + px] = a
            print('IMPOSTOR', k, mode)
    for mode in ('color', 'normal'):
        a = atlas[mode]
        if mode == 'normal':
            rgb = a[..., :3]
            a[..., :3] = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
            a[..., 3] = atlas['color'][..., 3]
        img = bpy.data.images.new(f'imp_{mode}', a.shape[1], a.shape[0], alpha=True)
        img.colorspace_settings.name = 'Non-Color'
        img.pixels.foreach_set(a.ravel())
        img.filepath_raw = os.path.join(data, f'impostor_{mode}.png')
        img.file_format = 'PNG'
        img.save()
    os.remove(tmp)
    print('IMPOSTOR done', atlas['color'].shape)


main()
