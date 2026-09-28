"""Check render: line up the baked props and draw them in Cycles.
  blender -b build/check/props.blend -P bake/props_preview.py -- <docs/data> <output dir>
"""
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blib as B  # noqa: E402


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    data, out = argv[0], argv[1]
    scn = B.gpu_cycles(64)
    scn.cycles.use_denoising = True
    m, nt = B.mat_new('baked')
    img = lambda n, c: (lambda i: (setattr(i.colorspace_settings, 'name', 'sRGB' if c else 'Non-Color'), i)[1])(bpy.data.images.load(os.path.join(data, n)))
    tb = B.N(nt, 'ShaderNodeTexImage'); tb.image = img('props_base.png', True)
    to = B.N(nt, 'ShaderNodeTexImage'); to.image = img('props_orm.png', False)
    sp = B.N(nt, 'ShaderNodeSeparateColor'); B.L(nt, to.outputs[0], sp.inputs[0])
    mu = B.N(nt, 'ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', inputs={'Factor': 1.0}); B.L(nt, tb.outputs[0], mu.inputs[6]); B.L(nt, sp.outputs[0], mu.inputs[7])
    bs = B.N(nt, 'ShaderNodeBsdfPrincipled'); B.L(nt, mu.outputs[2], bs.inputs['Base Color']); B.L(nt, sp.outputs[1], bs.inputs['Roughness']); B.L(nt, sp.outputs[2], bs.inputs['Metallic'])
    B.L(nt, bs.outputs[0], B.out_node(nt).inputs['Surface'])
    x = 0.0
    order = ['torii', 'honden', 'toro', 'jizo', 'boat', 'boardwalk', 'shack', 'boathouse', 'hut', 'pier']
    for name in order:
        o = bpy.data.objects[name]
        o.data.materials.clear(); o.data.materials.append(m)
        w = o.dimensions.x
        o.location = (x + w / 2, 0, 0)
        x += w + 1.5
    bpy.ops.mesh.primitive_plane_add(size=300)
    world = bpy.data.worlds.new('w'); scn.world = world
    sky = world.node_tree.nodes.new('ShaderNodeTexSky')
    for t in ('MULTIPLE_SCATTERING', 'NISHITA'):
        try:
            sky.sky_type = t; break
        except TypeError:
            pass
    sky.sun_elevation = math.radians(20); sky.sun_rotation = math.radians(220); sky.sun_disc = False
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.4
    world.node_tree.links.new(sky.outputs[0], world.node_tree.nodes['Background'].inputs[0])
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); scn.collection.objects.link(sun)
    sun.data.energy = 3.5; sun.rotation_euler = (math.radians(65), 0, math.radians(-40))
    scn.view_settings.view_transform = 'AgX'
    scn.render.resolution_x, scn.render.resolution_y = 1600, 700
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scn.collection.objects.link(cam); scn.camera = cam
    cam.data.lens = 35
    c = Vector((x / 2, 0, 2.5))
    for tag, p in (('front', Vector((x / 2, -x * 0.62, 9.0))), ('back', Vector((x / 2 - 6, x * 0.5, 12.0)))):
        cam.location = p; cam.rotation_euler = (c - p).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(out, f'props_{tag}.png')
        bpy.ops.render.render(write_still=True)


main()
