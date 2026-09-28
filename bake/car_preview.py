"""Check render: draw the car with its baked textures from a few set angles in Cycles.
  blender -b build/check/car.blend -P bake/car_preview.py -- <docs/data> <output dir>
"""
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blib as B  # noqa: E402
from car import AXLES, TR, WZ, OZ  # noqa: E402  (importing car.py does not run main)


def tex_material(data):
    m, nt = B.mat_new('baked')
    N, L = (lambda t, **k: B.N(nt, t, **k)), (lambda a, b: B.L(nt, a, b))
    def img(name, color):
        i = bpy.data.images.load(os.path.join(data, name))
        i.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
        n = N('ShaderNodeTexImage'); n.image = i
        return n
    base, orm, emit = img('car_base.png', True), img('car_orm.png', False), img('car_emit.png', True)
    sep = N('ShaderNodeSeparateColor'); L(orm.outputs[0], sep.inputs[0])
    ao = N('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', inputs={'Factor': 1.0})
    L(base.outputs[0], ao.inputs[6]); L(sep.outputs[0], ao.inputs[7])
    bs = N('ShaderNodeBsdfPrincipled')
    L(ao.outputs[2], bs.inputs['Base Color']); L(sep.outputs[1], bs.inputs['Roughness']); L(sep.outputs[2], bs.inputs['Metallic'])
    L(emit.outputs[0], bs.inputs['Emission Color']); bs.inputs['Emission Strength'].default_value = 3.0
    L(bs.outputs[0], B.out_node(nt).inputs['Surface'])
    return m


def glass_material():
    m, nt = B.mat_new('glassp')
    bs = B.N(nt, 'ShaderNodeBsdfPrincipled', inputs={'Base Color': (0.004, 0.005, 0.006, 1), 'Roughness': 0.04, 'Coat Weight': 1.0})
    B.L(nt, bs.outputs[0], B.out_node(nt).inputs['Surface'])
    return m


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    data, out = argv[0], argv[1]
    os.makedirs(out, exist_ok=True)
    scn = B.gpu_cycles(96)
    scn.cycles.use_denoising = True
    body, glass, wheel = bpy.data.objects['body'], bpy.data.objects['glass'], bpy.data.objects['wheel']
    tm = tex_material(data)
    for o in (body, wheel):
        o.data.materials.clear(); o.data.materials.append(tm)
    glass.data.materials.clear(); glass.data.materials.append(glass_material())
    # six wheels (mirrored in x on the right side)
    for f in AXLES:
        for s in (-1, 1):
            w = wheel.copy(); scn.collection.objects.link(w)
            w.location = (s * TR, -f, WZ - OZ)
            w.scale.x = s
    wheel.hide_render = True
    # ground, sky and sun (low late-afternoon sun)
    bpy.ops.mesh.primitive_plane_add(size=80, location=(0, 0, -OZ))
    gm, gnt = B.mat_new('ground')
    gb = B.N(gnt, 'ShaderNodeBsdfPrincipled', inputs={'Base Color': (0.035, 0.032, 0.028, 1), 'Roughness': 0.95})
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
    sky.sun_elevation = math.radians(11); sky.sun_rotation = math.radians(210); sky.sun_disc = False
    bg = wn.nodes['Background']; bg.inputs['Strength'].default_value = 0.35
    wn.links.new(sky.outputs[0], bg.inputs[0])
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    scn.collection.objects.link(sun)
    sun.data.energy = 3.5; sun.data.color = (1.0, 0.83, 0.64); sun.data.angle = math.radians(1.5)
    sun.rotation_euler = (math.radians(90 - 11), 0, math.radians(210 - 90))
    scn.view_settings.view_transform = 'AgX'
    scn.render.resolution_x, scn.render.resolution_y = 900, 600
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scn.collection.objects.link(cam); scn.camera = cam
    cam.data.lens = 60
    views = {
        # name: (camera position, target)  front-left high, rear high, right side high, low side
        'front_left': ((9.5, -9.0, 5.5), (0.0, 0.2, 0.0)),
        'back_high': ((-2.5, 12.5, 9.5), (0.0, 0.0, -0.2)),
        'right_high': ((-11.0, 1.0, 7.5), (0.0, 0.0, -0.1)),
        'side': ((13.0, 0.0, 0.8), (0.0, 0.0, 0.0)),
    }
    for name, (p, t) in views.items():
        cam.location = p
        d = Vector(t) - Vector(p)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(out, f'car_{name}.png')
        bpy.ops.render.render(write_still=True)
        print('RENDER', name)


main()
