"""Check render: draw the trees from the side and from above at an angle in Cycles.
  blender -b build/check/trees.blend -P bake/tree_preview.py -- <docs/data> <output dir> [lod]
"""
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blib as B  # noqa: E402


def leaf_mat(data):
    m, nt = B.mat_new('leaf')
    N, L = (lambda t, **k: B.N(nt, t, **k)), (lambda a, b: B.L(nt, a, b))
    img = bpy.data.images.load(os.path.join(data, 'foliage_color.png'))
    tx = N('ShaderNodeTexImage'); tx.image = img; tx.interpolation = 'Cubic'
    vc = N('ShaderNodeVertexColor', layer_name='col')
    sep = N('ShaderNodeSeparateColor'); L(vc.outputs[0], sep.inputs[0])
    ao = N('ShaderNodeMapRange', inputs={3: 0.18, 4: 1.0}); L(sep.outputs[0], ao.inputs[0])
    mul = N('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', inputs={'Factor': 1.0})
    L(tx.outputs[0], mul.inputs[6]); L(ao.outputs[0], mul.inputs[7])
    bs = N('ShaderNodeBsdfPrincipled', inputs={'Roughness': 0.6})
    L(mul.outputs[2], bs.inputs['Base Color'])
    tr = N('ShaderNodeBsdfTranslucent'); L(mul.outputs[2], tr.inputs[0])
    mx = N('ShaderNodeMixShader', inputs={0: 0.3}); L(bs.outputs[0], mx.inputs[1]); L(tr.outputs[0], mx.inputs[2])
    tp = N('ShaderNodeBsdfTransparent')
    cl = N('ShaderNodeMath', operation='GREATER_THAN', inputs={1: 0.5}); L(tx.outputs['Alpha'], cl.inputs[0])
    ms = N('ShaderNodeMixShader'); L(cl.outputs[0], ms.inputs[0]); L(tp.outputs[0], ms.inputs[1]); L(mx.outputs[0], ms.inputs[2])
    L(ms.outputs[0], B.out_node(nt).inputs['Surface'])
    return m


def bark_mat():
    m, nt = B.mat_new('bark')
    N, L = (lambda t, **k: B.N(nt, t, **k)), (lambda a, b: B.L(nt, a, b))
    tc = N('ShaderNodeTexCoord')
    mp = N('ShaderNodeMapping', inputs={'Scale': (6.0, 6.0, 1.2)}); L(tc.outputs['Object'], mp.inputs[0])
    n = N('ShaderNodeTexNoise', inputs={'Scale': 3.0, 'Detail': 8.0}); L(mp.outputs[0], n.inputs[0])
    cr = N('ShaderNodeMapRange', inputs={3: 0.02, 4: 0.09}); L(n.outputs['Fac'], cr.inputs[0])
    cm = N('ShaderNodeCombineColor'); L(cr.outputs[0], cm.inputs[0]); L(cr.outputs[0], cm.inputs[1]); L(cr.outputs[0], cm.inputs[2])
    bs = N('ShaderNodeBsdfPrincipled', inputs={'Roughness': 0.85}); L(cm.outputs[0], bs.inputs['Base Color'])
    bm = N('ShaderNodeBump', inputs={'Strength': 0.6}); L(n.outputs['Fac'], bm.inputs['Height']); L(bm.outputs[0], bs.inputs['Normal'])
    L(bs.outputs[0], B.out_node(nt).inputs['Surface'])
    return m


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    data, out = argv[0], argv[1]
    lod = argv[2] if len(argv) > 2 else '0'
    scn = B.gpu_cycles(64)
    scn.cycles.use_denoising = True
    lm, bm = leaf_mat(data), bark_mat()
    names = ['spruce', 'hemlock', 'young', 'tall']
    for o in list(bpy.data.objects):
        if f'_lod{lod}' not in o.name:
            bpy.data.objects.remove(o)
    for o in bpy.data.objects:
        i = names.index(o.name.split('_')[0])
        o.location.x = (i - 1.5) * 10.0
        o.data.materials.clear(); o.data.materials.append(lm if 'leaves' in o.name else bm)
    bpy.ops.mesh.primitive_plane_add(size=200)
    gm, gnt = B.mat_new('ground')
    gb = B.N(gnt, 'ShaderNodeBsdfPrincipled', inputs={'Base Color': (0.03, 0.028, 0.025, 1), 'Roughness': 0.95})
    B.L(gnt, gb.outputs[0], B.out_node(gnt).inputs['Surface'])
    bpy.context.active_object.data.materials.append(gm)
    world = bpy.data.worlds.new('w'); scn.world = world
    wn = world.node_tree
    sky = wn.nodes.new('ShaderNodeTexSky')
    for t in ('MULTIPLE_SCATTERING', 'NISHITA'):
        try:
            sky.sky_type = t
            break
        except TypeError:
            pass
    sky.sun_elevation = math.radians(12); sky.sun_rotation = math.radians(200); sky.sun_disc = False
    wn.nodes['Background'].inputs['Strength'].default_value = 0.35
    wn.links.new(sky.outputs[0], wn.nodes['Background'].inputs[0])
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    scn.collection.objects.link(sun)
    sun.data.energy = 3.5; sun.data.color = (1.0, 0.83, 0.64); sun.data.angle = math.radians(1.5)
    sun.rotation_euler = (math.radians(78), 0, math.radians(110))
    scn.view_settings.view_transform = 'AgX'
    scn.render.resolution_x, scn.render.resolution_y = 1350, 1080
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scn.collection.objects.link(cam); scn.camera = cam
    cam.data.lens = 40
    for name, p, t in (('side', (0, -62, 12), (0, 0, 11)), ('above', (6, -38, 42), (0, 0, 6))):
        cam.location = p
        cam.rotation_euler = (Vector(t) - Vector(p)).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(out, f'trees_lod{lod}_{name}.png')
        bpy.ops.render.render(write_still=True)
        print('RENDER', name)


main()
