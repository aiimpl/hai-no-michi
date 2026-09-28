"""Rocks: bake color (lichen, moss) and normals in Cycles from a detailed high-res source mesh onto a light mesh.
  blender -b --factory-startup -P bake/rocks.py -- <docs/data> [resolution]
Kinds: 0 angular basalt, 1 round stone, 2 flat stone, 3 white pumice (small and porous)
"""
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blib as B  # noqa: E402
import car as C  # noqa: E402  (reuses the bake helpers)

KINDS = [
    dict(name='basalt', scale=(1.0, 0.85, 0.62), rough=0.55, crack=0.5, seed=3),
    dict(name='round', scale=(1.0, 0.9, 0.7), rough=0.28, crack=0.15, seed=8),
    dict(name='flat', scale=(1.2, 1.0, 0.38), rough=0.4, crack=0.3, seed=13),
    dict(name='pumice', scale=(1.0, 0.8, 0.62), rough=0.35, crack=0.0, seed=21),
]


def rock_mesh(K, subdiv):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=0.5)
    off = Vector((K['seed'] * 1.7, K['seed'] * 0.3, 2.1))
    for v in bm.verts:
        p = v.co.normalized()
        # large facet breaks (angularity) + medium relief + fine grain
        cell = noise.cell(p * 1.6 + off)
        big = noise.fractal(p * 1.3 + off, 0.6, 2.0, 3) * K['rough']
        mid = noise.fractal(p * 4.0 + off, 0.55, 2.1, 4) * 0.12
        fine = noise.fractal(p * 14.0 + off, 0.5, 2.0, 3) * 0.035
        facet = (round(cell * 4) / 4 - cell) * K['crack'] * 0.4
        r = 0.5 * (1.0 + big + mid + fine + facet)
        q = p * r
        q.x *= K['scale'][0]; q.y *= K['scale'][1]; q.z *= K['scale'][2]
        if q.z < -0.12:                     # flatten the buried bottom
            q.z = -0.12 + (q.z + 0.12) * 0.25
        v.co = q
    if K['name'] == 'pumice':               # pumice: small pits
        for v in bm.verts:
            c = noise.cell(v.co * 22.0 + off)
            if c > 0.72:
                v.co *= 1.0 - (c - 0.72) * 0.25
    return bm


def rock_material(name, K):
    m, nt = B.mat_new(name)
    N, L = (lambda t, **k: B.N(nt, t, **k)), (lambda a, b: B.L(nt, a, b))
    tc = N('ShaderNodeTexCoord')
    geo = N('ShaderNodeNewGeometry')
    nz = N('ShaderNodeSeparateXYZ'); L(geo.outputs['Normal'], nz.inputs[0])
    if K['name'] == 'pumice':
        base = (0.55, 0.54, 0.5)
        n1 = N('ShaderNodeTexVoronoi', inputs={'Scale': 60.0}); L(tc.outputs['Object'], n1.inputs['Vector'])
        dk = N('ShaderNodeMapRange', inputs={1: 0.0, 2: 0.35, 3: 0.35, 4: 1.0}); L(n1.outputs['Distance'], dk.inputs[0])
        col = N('ShaderNodeVectorMath', operation='SCALE'); col.inputs[0].default_value = base; L(dk.outputs[0], col.inputs['Scale'])
        base_out = col.outputs[0]
    else:
        # grey rock: color variation, dark cracks, lichen on upward faces (pale grey-green and whitish spots), moss and soil below
        n1 = N('ShaderNodeTexNoise', inputs={'Scale': 3.0, 'Detail': 10.0, 'Roughness': 0.6}); L(tc.outputs['Object'], n1.inputs['Vector'])
        c1 = N('ShaderNodeMapRange', inputs={3: 0.06, 4: 0.16}); L(n1.outputs['Fac'], c1.inputs[0])
        g = N('ShaderNodeCombineColor'); L(c1.outputs[0], g.inputs[0]); L(c1.outputs[0], g.inputs[1])
        cb = N('ShaderNodeMath', operation='MULTIPLY', inputs={1: 1.12}); L(c1.outputs[0], cb.inputs[0]); L(cb.outputs[0], g.inputs[2])
        vo = N('ShaderNodeTexVoronoi', inputs={'Scale': 7.0}, feature='DISTANCE_TO_EDGE'); L(tc.outputs['Object'], vo.inputs['Vector'])
        cr = N('ShaderNodeMapRange', inputs={1: 0.0, 2: 0.04, 3: 0.35, 4: 1.0}); L(vo.outputs['Distance'], cr.inputs[0])
        crm = N('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', inputs={'Factor': K['crack'] + 0.2})
        L(g.outputs[0], crm.inputs[6]); L(cr.outputs[0], crm.inputs[7])
        n2 = N('ShaderNodeTexNoise', inputs={'Scale': 9.0, 'Detail': 12.0, 'Roughness': 0.7}); L(tc.outputs['Object'], n2.inputs['Vector'])
        up = N('ShaderNodeMapRange', inputs={1: 0.2, 2: 0.8}); L(nz.outputs['Z'], up.inputs[0])
        li = N('ShaderNodeMapRange', inputs={1: 0.52, 2: 0.58}); L(n2.outputs['Fac'], li.inputs[0])
        lim = N('ShaderNodeMath', operation='MULTIPLY'); L(up.outputs[0], lim.inputs[0]); L(li.outputs[0], lim.inputs[1])
        lc = N('ShaderNodeMix', data_type='RGBA'); L(lim.outputs[0], lc.inputs['Factor']); L(crm.outputs[2], lc.inputs[6]); lc.inputs[7].default_value = (0.24, 0.25, 0.2, 1)
        n3 = N('ShaderNodeTexVoronoi', inputs={'Scale': 40.0}); L(tc.outputs['Object'], n3.inputs['Vector'])
        sp = N('ShaderNodeMapRange', inputs={1: 0.12, 2: 0.05}); L(n3.outputs['Distance'], sp.inputs[0])
        spm = N('ShaderNodeMath', operation='MULTIPLY'); L(sp.outputs[0], spm.inputs[0]); L(lim.outputs[0], spm.inputs[1])
        wc = N('ShaderNodeMix', data_type='RGBA'); L(spm.outputs[0], wc.inputs['Factor']); L(lc.outputs[2], wc.inputs[6]); wc.inputs[7].default_value = (0.5, 0.5, 0.46, 1)
        sep = N('ShaderNodeSeparateXYZ'); L(tc.outputs['Object'], sep.inputs[0])
        low = N('ShaderNodeMapRange', inputs={1: -0.1, 2: 0.05}); L(sep.outputs['Z'], low.inputs[0])
        inv = N('ShaderNodeMath', operation='SUBTRACT', inputs={0: 1.0}); L(low.outputs[0], inv.inputs[1])
        mo = N('ShaderNodeMix', data_type='RGBA'); L(inv.outputs[0], mo.inputs['Factor']); L(wc.outputs[2], mo.inputs[6]); mo.inputs[7].default_value = (0.045, 0.05, 0.03, 1)
        base_out = mo.outputs[2]
    r0 = N('ShaderNodeValue'); r0.outputs[0].default_value = 0.82
    zero = N('ShaderNodeValue'); zero.outputs[0].default_value = 0.0
    em = N('ShaderNodeRGB'); em.outputs[0].default_value = (0, 0, 0, 1)
    bs = N('ShaderNodeBsdfPrincipled'); L(base_out, bs.inputs['Base Color']); bs.inputs['Roughness'].default_value = 0.82
    L(bs.outputs[0], B.out_node(nt).inputs['Surface'])
    C.SOCK[name] = dict(nt=nt, bsdf=bs, base=base_out, rough=r0.outputs[0], metal=zero.outputs[0], emit=em.outputs[0], emit_k=0.0)
    return m


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv else 'docs/data'
    size = int(argv[1]) if len(argv) > 1 else 1024
    B.reset()
    scn = B.gpu_cycles(8)
    his, los = [], []
    for i, K in enumerate(KINDS):
        mat = rock_material(f'rock_{K["name"]}', K)
        hi = B._obj(f'hi_{K["name"]}', rock_mesh(K, 7), mat)
        lo = B._obj(f'rock{i}', rock_mesh(K, 4), mat)
        for o in (hi, lo):
            o.data.shade_smooth()
            o.location.x = i * 3.0
        his.append(hi); los.append(lo)
    bpy.ops.object.select_all(action='DESELECT')
    for o in los + his:
        o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    C.unwrap_all(los, size)
    # color: high-res to light mesh (baked as emission, no lighting)
    img = bpy.data.images.new('rock_base', size, size, float_buffer=True)
    nimg = bpy.data.images.new('rock_nrm', size, size, float_buffer=True)
    nimg.colorspace_settings.name = img.colorspace_settings.name = 'Non-Color'
    scn.render.bake.use_selected_to_active = True
    scn.render.bake.cage_extrusion = 0.08
    scn.render.bake.margin = 6
    results = {}
    for kind, im in (('base', img), ('normal', nimg)):
        for s in C.SOCK.values():
            nt = s['nt']; out_n = B.out_node(nt)
            e = nt.nodes.get('bake_emit') or nt.nodes.new('ShaderNodeEmission'); e.name = 'bake_emit'
            nt.links.new(s['base'], e.inputs['Color'])
            nt.links.new((e if kind == 'base' else s['bsdf']).outputs[0], out_n.inputs['Surface'])
        for i, (hi, lo) in enumerate(zip(his, los)):
            # the bake target image goes on the light mesh material; both meshes share the material, so the target node is placed for each bake
            for s in C.SOCK.values():
                t = s['nt'].nodes.get('bake_target') or s['nt'].nodes.new('ShaderNodeTexImage')
                t.name = 'bake_target'; t.image = im; s['nt'].nodes.active = t
            bpy.ops.object.select_all(action='DESELECT')
            hi.select_set(True); lo.select_set(True)
            bpy.context.view_layer.objects.active = lo
            scn.render.bake.use_clear = (i == 0)
            scn.cycles.samples = 4
            bpy.ops.object.bake(type='EMIT' if kind == 'base' else 'NORMAL')
        a = np.empty(size * size * 4, np.float32); im.pixels.foreach_get(a)
        results[kind] = a.reshape(size, size, 4)
    C.save_png(os.path.join(out, 'rock_base.png'), results['base'][..., :3], True)
    C.save_png(os.path.join(out, 'rock_normal.png'), results['normal'][..., :3], False)
    for hi in his:
        bpy.data.objects.remove(hi)
    for o in los:
        o.location.x = 0
    C.export_glb(os.path.join(out, 'rocks.glb'), los)
    print('ROCKS', {o.name: len(o.data.polygons) for o in los}, os.path.getsize(os.path.join(out, 'rocks.glb')))


if __name__ == '__main__':
    main()
