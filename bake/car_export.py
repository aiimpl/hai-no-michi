"""Re-export the glb without re-baking: blender -b build/check/car.blend -P bake/car_export.py -- <docs/data>"""
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from car import export_glb  # noqa: E402

out = sys.argv[sys.argv.index('--') + 1]
export_glb(os.path.join(out, 'car.glb'), [bpy.data.objects[n] for n in ('body', 'glass', 'wheel')])
print('EXPORT', os.path.getsize(os.path.join(out, 'car.glb')))
