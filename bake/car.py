"""Six-wheeled expedition vehicle: build the shape, bake the dirt-and-wear materials to textures with Cycles, and export the glb and textures.
  blender -b --factory-startup -P bake/car.py -- <docs/data> <build/check> [bake resolution]
Axes: in Blender forward is -Y, up is +Z, left is +X. The glTF conversion maps to three.js as (x, z, -y), so forward becomes +Z.
The origin is the center of mass (OZ above the ground). Dimensions come from side-view proportions.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blib as B  # noqa: E402

OZ = 1.107                     # center-of-mass height (matches the physics SPEC)
R = 0.58                       # wheel radius
WZ = R                         # wheel center height (at rest)
TR = 0.93                      # lateral wheel offset
AXLES = (1.6, -0.6, -1.95)     # axle positions along the body (forward is +)
BODY_Z = 1.18                  # bottom of the body (above the wheels)
ROOF = 2.22                    # roof height


def P(f, x, z):
    """Forward f, lateral x, height above ground z -> Blender coordinates"""
    return (x, -f, z - OZ)


def pbox(name, f0, f1, x0, x1, z0, z1, mat, bev=0.0, seg=2):
    c = P((f0 + f1) / 2, (x0 + x1) / 2, (z0 + z1) / 2)
    return B.box(name, c, (abs(x1 - x0), abs(f1 - f0), abs(z1 - z0)), mat, bev, seg)


def phull(name, lo, hi, mat, bev=0.0, seg=2):
    """lo/hi are 4 points each of (f, x, z): bottom face and top face"""
    return B.hull(name, [P(*p) for p in lo] + [P(*p) for p in hi], mat, bev, seg)


def ptube(name, pts, r, mat, rad=0.0, seg=12):
    pts = [P(*p) for p in pts]
    if rad:
        pts = B.bend(pts, rad)
    return B.tube(name, pts, r, mat, seg)


# ---- Materials: built so color, roughness, metal and emission can be baked separately ---------------------
SOCK = {}


def material(name, base, rough, metal=0.0, wear=0.0, dust=0.6, emit=None, emit_k=0.0, scuff=0.0, chip=0.0, patch=0.35, streak=0.0):
    """base is linear RGB. wear = edge wear (bright bare metal), dust = dirt low down and on upward faces, scuff = white scratches on faces"""
    m, nt = B.mat_new(name)
    N, L = (lambda t, **k: B.N(nt, t, **k)), (lambda a, b: B.L(nt, a, b))
    geo = N('ShaderNodeNewGeometry')
    tc = N('ShaderNodeTexCoord')
    sep = N('ShaderNodeSeparateXYZ'); L(tc.outputs['Object'], sep.inputs[0])
    # Dust: heavier near the ground, a light coat on upward faces, blotchy
    nz = N('ShaderNodeSeparateXYZ'); L(geo.outputs['Normal'], nz.inputs[0])
    low = N('ShaderNodeMapRange', inputs={1: -OZ, 2: -OZ + 1.3, 3: 1.0, 4: 0.0}); L(sep.outputs['Z'], low.inputs[0])
    up = N('ShaderNodeMapRange', inputs={1: 0.6, 2: 0.97, 3: 0.0, 4: 0.3}); L(nz.outputs['Z'], up.inputs[0])
    n1 = N('ShaderNodeTexNoise', inputs={'Scale': 3.2, 'Detail': 8.0, 'Roughness': 0.62}); L(tc.outputs['Object'], n1.inputs['Vector'])
    n1r = N('ShaderNodeMapRange', inputs={1: 0.38, 2: 0.66}); L(n1.outputs['Fac'], n1r.inputs[0])
    dmax = N('ShaderNodeMath', operation='MAXIMUM'); L(low.outputs[0], dmax.inputs[0]); L(up.outputs[0], dmax.inputs[1])
    dmul = N('ShaderNodeMath', operation='MULTIPLY'); L(dmax.outputs[0], dmul.inputs[0]); L(n1r.outputs[0], dmul.inputs[1])
    dk = N('ShaderNodeMath', operation='MULTIPLY', use_clamp=True, inputs={1: dust}); L(dmul.outputs[0], dk.inputs[0])
    # Edge wear: chip areas near edges with fine blotches
    # Edge proximity: difference between a bevelled normal and the true normal (per pixel, so it works on low-poly parts too)
    bv = N('ShaderNodeBevel', samples=8, inputs={'Radius': 0.018})
    dt = N('ShaderNodeVectorMath', operation='DOT_PRODUCT'); L(bv.outputs[0], dt.inputs[0]); L(geo.outputs['Normal'], dt.inputs[1])
    pr = N('ShaderNodeMapRange', inputs={1: 0.985, 2: 0.9}); L(dt.outputs['Value'], pr.inputs[0])
    n2 = N('ShaderNodeTexNoise', inputs={'Scale': 38.0, 'Detail': 6.0, 'Roughness': 0.7}); L(tc.outputs['Object'], n2.inputs['Vector'])
    w1 = N('ShaderNodeMath', operation='MULTIPLY'); L(pr.outputs[0], w1.inputs[0]); L(n2.outputs['Fac'], w1.inputs[1])
    wr = N('ShaderNodeMapRange', inputs={1: 0.33 - 0.1 * wear, 2: 0.4 - 0.1 * wear, 3: 0.0, 4: min(1.0, wear * 1.5)}); L(w1.outputs[0], wr.inputs[0])
    # Face scratches: thin streaks of noise stretched in one direction
    mp = N('ShaderNodeMapping', inputs={'Scale': (90.0, 6.0, 90.0)}); L(tc.outputs['Object'], mp.inputs['Vector'])
    n3 = N('ShaderNodeTexNoise', inputs={'Scale': 1.0, 'Detail': 3.0}); L(mp.outputs[0], n3.inputs['Vector'])
    n4 = N('ShaderNodeTexNoise', inputs={'Scale': 1.6, 'Detail': 2.0}); L(tc.outputs['Object'], n4.inputs['Vector'])
    s1 = N('ShaderNodeMapRange', inputs={1: 0.68, 2: 0.74}); L(n3.outputs['Fac'], s1.inputs[0])
    s2 = N('ShaderNodeMapRange', inputs={1: 0.5, 2: 0.62}); L(n4.outputs['Fac'], s2.inputs[0])
    sm0 = N('ShaderNodeMath', operation='MULTIPLY'); L(s1.outputs[0], sm0.inputs[0]); L(s2.outputs[0], sm0.inputs[1])
    # Grey blotches on upward faces where the paint has worn
    n6 = N('ShaderNodeTexNoise', inputs={'Scale': 6.0, 'Detail': 14.0, 'Roughness': 0.72}); L(tc.outputs['Object'], n6.inputs['Vector'])
    pm = N('ShaderNodeMapRange', inputs={1: 0.56, 2: 0.66}); L(n6.outputs['Fac'], pm.inputs[0])
    upf = N('ShaderNodeMapRange', inputs={1: 0.6, 2: 0.97}); L(nz.outputs['Z'], upf.inputs[0])
    pmu = N('ShaderNodeMath', operation='MULTIPLY', inputs={2: 0.0}); L(pm.outputs[0], pmu.inputs[0]); L(upf.outputs[0], pmu.inputs[1])
    pmk = N('ShaderNodeMath', operation='MULTIPLY', inputs={1: patch}); L(pmu.outputs[0], pmk.inputs[0])
    sm = N('ShaderNodeMath', operation='MAXIMUM'); L(sm0.outputs[0], sm.inputs[0]); L(pmk.outputs[0], sm.inputs[1])
    sk = N('ShaderNodeMath', operation='MULTIPLY', use_clamp=True, inputs={1: scuff}); L(sm.outputs[0], sk.inputs[0])
    # Color variation (uneven paint)
    n5 = N('ShaderNodeTexNoise', inputs={'Scale': 7.0, 'Detail': 4.0}); L(tc.outputs['Object'], n5.inputs['Vector'])
    var = N('ShaderNodeMapRange', inputs={3: 0.86, 4: 1.12}); L(n5.outputs['Fac'], var.inputs[0])
    c0 = N('ShaderNodeVectorMath', operation='SCALE'); c0.inputs[0].default_value = base; L(var.outputs[0], c0.inputs['Scale'])
    mix_w = N('ShaderNodeMix', data_type='RGBA'); L(wr.outputs[0], mix_w.inputs['Factor']); L(c0.outputs[0], mix_w.inputs[6]); mix_w.inputs[7].default_value = (0.32, 0.31, 0.29, 1)
    mix_s = N('ShaderNodeMix', data_type='RGBA'); L(sk.outputs[0], mix_s.inputs['Factor']); L(mix_w.outputs[2], mix_s.inputs[6]); mix_s.inputs[7].default_value = (0.13, 0.125, 0.118, 1)
    # Chips: the accent paint flakes off to reveal black paint underneath
    n7 = N('ShaderNodeTexNoise', inputs={'Scale': 22.0, 'Detail': 8.0, 'Roughness': 0.7}); L(tc.outputs['Object'], n7.inputs['Vector'])
    ch = N('ShaderNodeMapRange', inputs={1: 0.64 - 0.12 * chip, 2: 0.68 - 0.12 * chip, 3: 0.0, 4: 1.0 if chip else 0.0}); L(n7.outputs['Fac'], ch.inputs[0])
    mix_c = N('ShaderNodeMix', data_type='RGBA'); L(ch.outputs[0], mix_c.inputs['Factor']); L(mix_s.outputs[2], mix_c.inputs[6]); mix_c.inputs[7].default_value = (0.03, 0.031, 0.032, 1)
    # Rain streaks: vertically stretched noise for grime running downward (for buildings)
    mps = N('ShaderNodeMapping', inputs={'Scale': (2.2, 2.2, 0.12)}); L(tc.outputs['Object'], mps.inputs['Vector'])
    n8 = N('ShaderNodeTexNoise', inputs={'Scale': 6.0, 'Detail': 6.0, 'Roughness': 0.6}); L(mps.outputs[0], n8.inputs['Vector'])
    st = N('ShaderNodeMapRange', inputs={1: 0.45, 2: 0.7, 3: 0.0, 4: streak}); L(n8.outputs['Fac'], st.inputs[0])
    mix_t = N('ShaderNodeMix', data_type='RGBA'); L(st.outputs[0], mix_t.inputs['Factor']); L(mix_c.outputs[2], mix_t.inputs[6]); mix_t.inputs[7].default_value = (0.05, 0.047, 0.042, 1)
    mix_d = N('ShaderNodeMix', data_type='RGBA'); L(dk.outputs[0], mix_d.inputs['Factor']); L(mix_t.outputs[2], mix_d.inputs[6]); mix_d.inputs[7].default_value = (0.105, 0.088, 0.070, 1)
    # Roughness/metal: worn areas show metal and are slightly rougher; dust is rough
    r0 = N('ShaderNodeValue'); r0.outputs[0].default_value = rough
    rw = N('ShaderNodeMix', data_type='FLOAT', inputs={'B': 0.5}); L(wr.outputs[0], rw.inputs['Factor']); L(r0.outputs[0], rw.inputs['A'])
    rd = N('ShaderNodeMix', data_type='FLOAT', inputs={'B': 0.93}); L(dk.outputs[0], rd.inputs['Factor']); L(rw.outputs[0], rd.inputs['A'])
    m0 = N('ShaderNodeValue'); m0.outputs[0].default_value = metal
    mw = N('ShaderNodeMix', data_type='FLOAT', inputs={'B': 0.6}); L(wr.outputs[0], mw.inputs['Factor']); L(m0.outputs[0], mw.inputs['A'])
    md = N('ShaderNodeMix', data_type='FLOAT', inputs={'B': 0.0}); L(dk.outputs[0], md.inputs['Factor']); L(mw.outputs[0], md.inputs['A'])
    em = N('ShaderNodeRGB'); em.outputs[0].default_value = (*(emit or (0, 0, 0)), 1)
    bs = N('ShaderNodeBsdfPrincipled')
    L(mix_d.outputs[2], bs.inputs['Base Color']); L(rd.outputs[0], bs.inputs['Roughness']); L(md.outputs[0], bs.inputs['Metallic'])
    L(em.outputs[0], bs.inputs['Emission Color']); bs.inputs['Emission Strength'].default_value = emit_k
    L(bs.outputs[0], B.out_node(nt).inputs['Surface'])
    SOCK[name] = dict(nt=nt, bsdf=bs, base=mix_d.outputs[2], rough=rd.outputs[0], metal=md.outputs[0], emit=em.outputs[0], emit_k=emit_k)
    return m


def make_materials():
    M = {}
    M['paint'] = material('paint', (0.030, 0.032, 0.034), 0.46, wear=0.7, dust=0.6, scuff=0.9)
    M['orange'] = material('orange', (0.40, 0.075, 0.018), 0.5, wear=0.4, dust=0.5, scuff=0.3, chip=1.0, patch=0.2)
    M['trim'] = material('trim', (0.016, 0.016, 0.017), 0.72, wear=0.25, dust=0.7)
    M['steel'] = material('steel', (0.05, 0.05, 0.052), 0.45, metal=0.7, wear=0.6, dust=0.6)
    M['case'] = material('case', (0.022, 0.024, 0.022), 0.6, wear=0.4, dust=0.35, scuff=0.9)
    M['rubber'] = material('rubber', (0.034, 0.032, 0.03), 0.9, dust=2.2, scuff=0.3, patch=0.0)
    M['rim'] = material('rim', (0.07, 0.072, 0.075), 0.35, metal=0.85, wear=0.35, dust=0.8)
    M['chrome'] = material('chrome', (0.75, 0.75, 0.75), 0.12, metal=1.0, dust=0.1)
    M['spring'] = material('spring', (0.45, 0.085, 0.02), 0.4, metal=0.2, wear=0.3, dust=0.6)
    M['dome'] = material('dome', (0.42, 0.42, 0.40), 0.5, wear=0.2, dust=0.5, scuff=0.4)
    M['glass'] = material('glass', (0.01, 0.011, 0.012), 0.04, dust=0.25)
    M['lamp_w'] = material('lamp_w', (0.8, 0.78, 0.72), 0.1, dust=0.0, emit=(1.0, 0.86, 0.64), emit_k=1.0)
    M['lamp_a'] = material('lamp_a', (0.7, 0.35, 0.05), 0.15, dust=0.0, emit=(1.0, 0.45, 0.06), emit_k=1.0)
    M['lamp_r'] = material('lamp_r', (0.5, 0.03, 0.02), 0.15, dust=0.0, emit=(1.0, 0.06, 0.02), emit_k=1.0)
    M['led'] = material('led', (0.85, 0.85, 0.85), 0.1, dust=0.0, emit=(1.0, 0.95, 0.85), emit_k=1.0)
    return M


# ---- Wheels ------------------------------------------------------------------------
def wheel(M, name='wheel', cx=0.0):
    """One wheel facing +X, centered at the origin. Includes tread lugs, beadlock bolts and hub nuts"""
    parts = []
    prof = [(0.285, -0.19), (0.33, -0.205), (0.43, -0.218), (0.51, -0.212), (0.548, -0.195), (0.556, -0.16),
            (0.556, 0.16), (0.548, 0.195), (0.51, 0.212), (0.43, 0.218), (0.33, 0.205), (0.285, 0.19)]
    parts.append(B.lathe(name + '_tire', [(r, t + cx) for r, t in prof], M['rubber'], seg=72))
    # Tread lugs: two rows offset by half a pitch, angled (V pattern). Shoulder lugs wrap onto the sidewall
    n = 34
    for i in range(n):
        for row, (xc, ang, off) in enumerate(((-0.085, 0.32, 0.0), (0.085, -0.32, 0.5))):
            a = 2 * math.pi * (i + off) / n
            rr = 0.556 + 0.018
            c = (cx + xc, rr * math.cos(a), rr * math.sin(a))
            lug = B.box(f'{name}_lug', c, (0.15, 0.085, 0.036), M['rubber'], 0.009, 1,
                        rot=[((0, 0, 1), ang), ((1, 0, 0), a + math.pi / 2)])
            parts.append(lug)
            # shoulder lugs (protrude outward)
            sx = cx + (-0.2 if row == 0 else 0.2)
            rs = 0.535
            c2 = (sx, rs * math.cos(a), rs * math.sin(a))
            parts.append(B.box(f'{name}_sh', c2, (0.05, 0.07, 0.06), M['rubber'], 0.008, 1, rot=[((1, 0, 0), a + math.pi / 2)]))
    # Wheel: rim barrel, recessed face, beadlock ring
    rim = [(0.29, -0.17), (0.282, -0.12), (0.27, -0.05), (0.268, 0.05), (0.285, 0.13), (0.3, 0.165), (0.302, 0.185),
           (0.285, 0.19), (0.255, 0.185), (0.245, 0.15), (0.2, 0.12), (0.12, 0.105), (0.0, 0.1)]
    parts.append(B.lathe(name + '_rim', [(r, t + cx) for r, t in rim], M['rim'], seg=64))
    for i in range(18):  # beadlock bolts
        a = 2 * math.pi * i / 18
        c = (cx + 0.192, 0.273 * math.cos(a), 0.273 * math.sin(a))
        parts.append(B.lathe(f'{name}_bolt', [(0.0, 0.0), (0.011, 0.0), (0.011, 0.012), (0.0, 0.014)], M['chrome'], seg=6,
                             center=c, smooth=False))
    for i in range(8):   # face recesses (read as round cut-outs)
        a = 2 * math.pi * (i + 0.5) / 8
        c = (cx + 0.118, 0.175 * math.cos(a), 0.175 * math.sin(a))
        parts.append(B.lathe(f'{name}_hole', [(0.0, 0.0), (0.042, 0.0), (0.046, 0.004)], M['trim'], seg=20, center=c))
    hub = [(0.105, 0.1), (0.1, 0.16), (0.075, 0.175), (0.06, 0.2), (0.0, 0.205)]
    parts.append(B.lathe(name + '_hub', [(r, t + cx) for r, t in hub], M['steel'], seg=32))
    for i in range(8):   # nuts
        a = 2 * math.pi * i / 8
        c = (cx + 0.16, 0.085 * math.cos(a), 0.085 * math.sin(a))
        parts.append(B.lathe(f'{name}_nut', [(0.0, 0.0), (0.014, 0.0), (0.014, 0.02), (0.0, 0.022)], M['chrome'], seg=6, center=c, smooth=False))
    return B.join(name, parts)


# ---- Body --------------------------------------------------------------------------
def body(M):
    parts = []
    add = parts.append
    # Frame and underbody (black)
    for s in (-1, 1):
        add(pbox('rail', -2.55, 2.55, s * 0.42, s * 0.58, 0.62, 0.8, M['steel'], 0.01))
    add(pbox('tub', -2.6, 2.3, -0.66, 0.66, 0.78, BODY_Z + 0.02, M['trim'], 0.02))
    for f in AXLES:
        add(ptube('axle', [(f, -0.78, WZ), (f, 0.78, WZ)], 0.065, M['steel']))
        add(pbox('diff', f - 0.16, f + 0.16, -0.17, 0.17, WZ - 0.14, WZ + 0.13, M['steel'], 0.05, 3))
        for s in (-1, 1):
            # springs sit ahead of the wheels (visible inside the arches)
            add(B.helix('spring', Vector(P(f + 0.67, s * 0.84, 1.0)), 0.078, 0.016, 0.44, 5.0, M['spring']))
            add(ptube('shock', [(f + 0.67, s * 0.84, 0.74), (f + 0.67, s * 0.84, 1.26)], 0.026, M['steel']))
            add(ptube('mount', [(f + 0.67, s * 0.84, 0.74), (f + 0.2, s * 0.7, WZ)], 0.022, M['steel']))
            add(ptube('arm', [(f + 0.35, s * 0.55, 0.7), (f + 0.05, s * 0.8, WZ + 0.02), (f - 0.3, s * 0.55, 0.7)], 0.03, M['steel']))
    # Cabin: width 1.0 at the bottom, 0.94 at the top; raked front
    lo = [(-2.62, -1.0, BODY_Z), (-2.62, 1.0, BODY_Z), (0.98, 1.0, BODY_Z), (0.98, -1.0, BODY_Z)]
    hi = [(-2.6, -0.95, ROOF), (-2.6, 0.95, ROOF), (0.86, 0.95, ROOF), (0.86, -0.95, ROOF)]
    add(phull('cab', lo, hi, M['paint'], 0.06, 3))
    # Side skirt between the front and middle axles, and the step
    for s in (-1, 1):
        add(pbox('skirt', 0.14, 0.9, s * 0.72, s * 0.99, 0.84, BODY_Z + 0.04, M['paint'], 0.025, 2))
        add(pbox('step', 0.1, 0.94, s * 0.9, s * 1.08, 0.74, 0.8, M['trim'], 0.012))
        add(pbox('rocker', -2.55, 0.95, s * 0.985, s * 1.012, BODY_Z - 0.02, BODY_Z + 0.07, M['trim'], 0.008))
    # Hood (above the wheels), engine bay below it (inboard of the wheels), front overhang
    lo = [(0.9, -0.91, BODY_Z), (0.9, 0.91, BODY_Z), (2.62, 0.91, BODY_Z), (2.62, -0.91, BODY_Z)]
    hi = [(0.88, -0.87, 1.53), (0.88, 0.87, 1.53), (2.6, 0.87, 1.47), (2.6, -0.87, 1.47)]
    add(phull('hood', lo, hi, M['paint'], 0.05, 3))
    add(pbox('bulge', 1.15, 2.35, -0.42, 0.42, 1.48, 1.54, M['paint'], 0.025, 2))
    add(pbox('engine', 0.9, 2.62, -0.6, 0.6, 0.72, BODY_Z + 0.02, M['trim'], 0.02))
    add(pbox('nose', 2.24, 2.64, -0.9, 0.9, 0.92, BODY_Z + 0.02, M['paint'], 0.03))
    for s in (-1, 1):
        # orange strip along the hood edge, and the side stripe
        add(phull('stripe', [(0.95, s * 0.6, 1.529), (0.95, s * 0.8, 1.529), (2.54, s * 0.8, 1.477), (2.54, s * 0.6, 1.477)],
                  [(0.95, s * 0.6, 1.538), (0.95, s * 0.8, 1.538), (2.54, s * 0.8, 1.486), (2.54, s * 0.6, 1.486)], M['orange']))
        add(pbox('sstripe', 0.95, 2.55, s * 0.9, s * 0.912, 1.36, 1.44, M['orange']))
        for k in range(4):   # vents
            add(pbox('vent', 1.0 + k * 0.07, 1.04 + k * 0.07, s * 0.2, s * 0.55, 1.515, 1.54, M['trim'], 0.006))
    # Front: grille, round headlights, orange marker lights
    add(pbox('grille', 2.6, 2.655, -0.56, 0.56, 0.98, 1.42, M['trim'], 0.01))
    for k in range(8):
        x = -0.49 + k * 0.14
        add(pbox('bar', 2.64, 2.67, x - 0.025, x + 0.025, 1.0, 1.4, M['paint'], 0.006))
    for s in (-1, 1):
        c = P(2.63, s * 0.72, 1.26)
        add(B.lathe('hl_ring', [(0.0, 0.0), (0.12, 0.0), (0.125, -0.03), (0.105, -0.045), (0.09, -0.04)], M['chrome'], seg=32, axis='Y', center=c))
        # the lathe axis is +Y; forward is -Y, so the profile extends to the negative side (forward)
        add(B.lathe('hl_lens', [(0.0, -0.035), (0.09, -0.03)], M['lamp_w'], seg=32, axis='Y', center=c))
        add(pbox('ind', 2.62, 2.665, s * 0.84, s * 0.9, 1.06, 1.12, M['lamp_a'], 0.006))
    # Heavy front bumper, winch, orange tow hooks, bull bar
    add(pbox('bumper', 2.6, 2.96, -1.0, 1.0, 0.6, 0.9, M['trim'], 0.02, 2))
    add(pbox('winchbox', 2.78, 2.98, -0.3, 0.3, 0.64, 0.86, M['steel'], 0.015))
    add(ptube('winch', [(2.9, -0.24, 0.75), (2.9, 0.24, 0.75)], 0.08, M['steel']))
    for s in (-1, 1):
        add(ptube('hook', [(2.9, s * 0.58, 0.72), (3.02, s * 0.58, 0.72), (3.02, s * 0.58, 0.62), (2.9, s * 0.58, 0.62)], 0.022, M['orange'], rad=0.04))
        add(ptube('bull', [(2.92, s * 0.8, 0.9), (2.9, s * 0.8, 1.42), (2.9, s * 0.3, 1.52)], 0.035, M['trim'], rad=0.12))
        add(ptube('bull_v', [(2.92, s * 0.3, 0.9), (2.9, s * 0.3, 1.52)], 0.03, M['trim']))
        add(pbox('pod', 2.85, 2.95, s * 0.44, s * 0.6, 1.5, 1.6, M['trim'], 0.012))
        add(pbox('pod_l', 2.945, 2.955, s * 0.46, s * 0.58, 1.52, 1.58, M['led']))
    add(ptube('bull_t', [(2.9, -0.3, 1.52), (2.9, 0.3, 1.52)], 0.035, M['trim']))
    # Wheel arches (black) with orange top edges
    for f in AXLES:
        for s in (-1, 1):
            x0, x1 = (0.9, 1.13) if s > 0 else (-1.13, -0.9)
            yc = -f
            add(B.arch('flare', (yc, WZ - OZ), 0.66, 0.8, x0, x1, 0.02, math.pi - 0.02, M['trim']))
            xo0, xo1 = (1.128, 1.142) if s > 0 else (-1.142, -1.128)
            add(B.arch('lip', (yc, WZ - OZ), 0.715, 0.792, xo0, xo1, 0.22, math.pi - 0.22, M['orange'], bev=0.004))
    # Windows (glass is a separate object), pillar seams, handles, hinges
    glass = []

    def side_x(z):
        return 1.0 - 0.05 * (z - BODY_Z) / (ROOF - BODY_Z)
    z0, z1 = 1.6, ROOF - 0.13
    for s in (-1, 1):
        for fa, fb in ((0.66, -0.1), (-0.22, -1.02), (-1.14, -1.9), (-2.02, -2.45)):
            lo = [(fb, s * (side_x(z0) + 0.002), z0), (fa, s * (side_x(z0) + 0.002), z0), (fa, s * (side_x(z0) + 0.012), z0), (fb, s * (side_x(z0) + 0.012), z0)]
            hi = [(fb, s * (side_x(z1) + 0.002), z1), (fa, s * (side_x(z1) + 0.002), z1), (fa, s * (side_x(z1) + 0.012), z1), (fb, s * (side_x(z1) + 0.012), z1)]
            glass.append(phull('win', lo, hi, M['glass']))
        for f in (0.74, -0.16, -1.08):
            add(pbox('seam', f - 0.005, f + 0.005, s * 0.99, s * (side_x(1.8) + 0.006), BODY_Z + 0.05, ROOF - 0.08, M['trim']))
        for f in (-0.02, -0.92):
            add(pbox('handle', f - 0.1, f + 0.02, s * 0.995, s * 1.02, 1.52, 1.56, M['steel'], 0.008))
        for z in (1.35, 2.05):
            add(pbox('hinge', 0.66, 0.72, s * 0.99, s * 1.018, z, z + 0.1, M['steel'], 0.006))
        add(pbox('gutter', -2.55, 0.8, s * 0.945, s * 0.97, ROOF - 0.1, ROOF - 0.07, M['trim'], 0.005))
        # mirrors
        add(ptube('mirror_arm', [(0.8, s * 0.97, 1.72), (0.86, s * 1.16, 1.78)], 0.016, M['trim']))
        add(pbox('mirror', 0.84, 0.9, s * 1.12, s * 1.3, 1.72, 1.96, M['trim'], 0.02))
    # Windshield (follows the raked face)
    def front_f(z):
        return 0.98 + (0.86 - 0.98) * (z - BODY_Z) / (ROOF - BODY_Z)
    zw0, zw1 = 1.6, ROOF - 0.11
    lo = [(front_f(zw0) + 0.002, -0.84, zw0), (front_f(zw0) + 0.002, 0.84, zw0), (front_f(zw0) + 0.012, 0.84, zw0), (front_f(zw0) + 0.012, -0.84, zw0)]
    hi = [(front_f(zw1) + 0.002, -0.8, zw1), (front_f(zw1) + 0.002, 0.8, zw1), (front_f(zw1) + 0.012, 0.8, zw1), (front_f(zw1) + 0.012, -0.8, zw1)]
    glass.append(phull('windshield', lo, hi, M['glass']))
    add(pbox('wiper', front_f(1.63) + 0.01, front_f(1.63) + 0.03, -0.6, 0.1, 1.63, 1.65, M['trim']))
    # Rear: window, spare tire, tail lights, bumper, ladder
    glass.append(pbox('rearwin', -2.625, -2.612, -0.66, 0.66, 1.62, ROOF - 0.14, M['glass']))
    add(pbox('rbumper', -2.74, -2.58, -0.98, 0.98, 0.62, 0.86, M['trim'], 0.02))
    for s in (-1, 1):
        add(pbox('tail', -2.64, -2.61, s * 0.86, s * 0.95, 0.96, 1.22, M['lamp_r'], 0.008))
        add(pbox('tail_a', -2.64, -2.61, s * 0.86, s * 0.95, 1.24, 1.3, M['lamp_a'], 0.006))
        add(pbox('rev', -2.64, -2.61, s * 0.72, s * 0.8, 1.2, 1.26, M['lamp_w'], 0.006))
    add(pbox('carrier', -2.72, -2.62, -0.22, 0.22, 1.2, 1.7, M['steel'], 0.02))
    spare = wheel(M, 'spare')
    spare.rotation_euler = (0, 0, math.pi / 2)
    spare.location = P(-2.95, 0.0, 1.5)
    add(spare)
    for z in (0.95, 1.27, 1.59, 1.91):
        add(ptube('rung', [(-2.66, -0.9, z), (-2.66, -0.66, z)], 0.014, M['steel']))
    for x in (-0.9, -0.66):
        add(ptube('ladder', [(-2.64, x, 0.88), (-2.66, x, ROOF + 0.08), (-2.5, x, ROOF + 0.2)], 0.02, M['steel'], rad=0.08))
    # Roof rack: frame, legs, crossbars, front light bar, cargo (cases, jerry cans, satellite dome), antenna
    RZ = ROOF + 0.2
    add(ptube('rack', [(-2.45, -0.92, RZ), (0.74, -0.92, RZ), (0.74, 0.92, RZ), (-2.45, 0.92, RZ), (-2.45, -0.92, RZ)], 0.024, M['trim'], rad=0.1))
    for f in (-2.4, -1.4, -0.4, 0.6):
        for s in (-1, 1):
            add(ptube('leg', [(f, s * 0.91, ROOF), (f, s * 0.92, RZ)], 0.02, M['trim']))
    for k in range(7):
        f = -2.3 + k * 0.48
        add(ptube('slat', [(f, -0.92, RZ - 0.02), (f, 0.92, RZ - 0.02)], 0.016, M['trim']))
    add(pbox('lightbar', 0.66, 0.8, -0.82, 0.82, RZ - 0.06, RZ + 0.05, M['trim'], 0.02))
    for k in range(12):
        x = -0.72 + k * 0.13
        add(pbox('led', 0.79, 0.805, x - 0.045, x + 0.045, RZ - 0.035, RZ + 0.03, M['led']))
    cases = [(-2.32, -1.66, -0.86, -0.16, 0.22), (-1.52, -0.9, 0.1, 0.86, 0.18), (-0.8, 0.28, -0.84, -0.06, 0.13),
             (-1.54, -0.96, -0.86, -0.18, 0.16), (-0.24, 0.42, 0.22, 0.86, 0.11), (-0.8, -0.34, 0.1, 0.86, 0.14)]
    for f0, f1, x0, x1, h in cases:
        add(pbox('case', f0, f1, x0, x1, RZ, RZ + h, M['case'], 0.022, 2))
        add(pbox('lid', f0 + 0.03, f1 - 0.03, x0 + 0.03, x1 - 0.03, RZ + h - 0.004, RZ + h + 0.012, M['case'], 0.01))
        for fm in (f0 + (f1 - f0) * 0.3, f0 + (f1 - f0) * 0.7):   # latches
            add(pbox('latch', fm - 0.03, fm + 0.03, x1 - 0.01, x1 + 0.012, RZ + h - 0.08, RZ + h - 0.03, M['steel'], 0.004))
    for x in (0.28, 0.5):
        add(pbox('jerry', -2.36, -2.04, x - 0.08, x + 0.08, RZ, RZ + 0.42, M['case'], 0.02))
    dome = B.lathe('dome', [(0.2, 0.0), (0.195, 0.05), (0.17, 0.11), (0.12, 0.16), (0.06, 0.19), (0.0, 0.2)], M['dome'], seg=32, axis='Z', center=P(0.25, 0.55, RZ + 0.16))
    add(dome)
    add(pbox('dome_base', 0.08, 0.42, 0.38, 0.72, RZ, RZ + 0.16, M['case'], 0.02))
    add(ptube('antenna', [(-2.25, -0.86, RZ), (-2.25, -0.86, RZ + 1.1)], 0.006, M['trim'], seg=6))
    # Snorkel (along the left A-pillar)
    add(ptube('snorkel', [(1.3, 0.93, 1.45), (1.0, 1.04, 1.62), (0.92, 1.05, ROOF - 0.1), (0.94, 1.05, ROOF + 0.14)], 0.055, M['trim'], rad=0.14))
    add(pbox('snorkel_head', 0.87, 1.09, 0.97, 1.13, ROOF + 0.09, ROOF + 0.25, M['trim'], 0.03))
    return parts, glass


def finish(ob):
    me = ob.data
    me.set_sharp_from_angle(angle=math.radians(40))
    return ob


def unwrap_all(obs, size):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
        # drop the UV maps brought in by tubes (built from curves) and keep only the bake UV
        while len(o.data.uv_layers):
            o.data.uv_layers.remove(o.data.uv_layers[0])
        uv = o.data.uv_layers.new(name='uv')
        o.data.uv_layers.active = uv
        uv.active_render = True
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(62), island_margin=0.0, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=4.0 / size)
    bpy.ops.object.mode_set(mode='OBJECT')


def bake_pass(obs, kind, size, samples=16):
    """kind: base / rough / metal / emit (baked by swapping in emission), ao (baked with real lighting)"""
    img = bpy.data.images.new(f'bake_{kind}', size, size, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    for name, s in SOCK.items():
        nt = s['nt']
        out = B.out_node(nt)
        e = nt.nodes.get('bake_emit') or nt.nodes.new('ShaderNodeEmission')
        e.name = 'bake_emit'
        for l in list(e.inputs['Color'].links):
            nt.links.remove(l)
        if kind == 'ao':
            nt.links.new(s['bsdf'].outputs[0], out.inputs['Surface'])
        else:
            src = s[kind]
            if kind == 'emit' and s['emit_k'] <= 0:
                e.inputs['Color'].default_value = (0, 0, 0, 1)
            else:
                nt.links.new(src, e.inputs['Color'])
            nt.links.new(e.outputs[0], out.inputs['Surface'])
        t = nt.nodes.get('bake_target') or nt.nodes.new('ShaderNodeTexImage')
        t.name = 'bake_target'
        t.image = img
        nt.nodes.active = t
    scn = bpy.context.scene
    scn.cycles.samples = samples
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    scn.render.bake.margin = 6
    scn.render.bake.use_clear = True
    bpy.ops.object.bake(type='AO' if kind == 'ao' else 'EMIT')
    a = np.empty(size * size * 4, np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(size, size, 4)
    for name, s in SOCK.items():   # restore
        s['nt'].links.new(s['bsdf'].outputs[0], B.out_node(s['nt']).inputs['Surface'])
    return a


def save_png(path, rgb, srgb):
    """Write a linear 0..1 array as an 8-bit PNG (converted to sRGB when srgb is set)"""
    x = np.clip(rgb, 0, 1)
    if srgb:
        x = np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)
    h, w, c = x.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=(c == 4))
    img.colorspace_settings.name = 'Non-Color'
    px = np.ones((h, w, 4), np.float32)
    px[..., :c] = x
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()


def export_glb(path, obs):
    # after baking, materials no longer need to differ; merge them so glTF does not split the mesh per material
    for o in obs:
        me = o.data
        for p in me.polygons:
            p.material_index = 0
        while len(me.materials) > 1:
            me.materials.pop()
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_materials='PLACEHOLDER',
                              export_normals=True, export_texcoords=True, export_apply=True, export_yup=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv else 'docs/data'
    chk = argv[1] if len(argv) > 1 else 'build/check'
    size = int(argv[2]) if len(argv) > 2 else 2048
    os.makedirs(out, exist_ok=True)
    os.makedirs(chk, exist_ok=True)
    B.reset()
    B.gpu_cycles(1)
    M = make_materials()
    parts, glass = body(M)
    bodyo = finish(B.join('body', parts))
    glasso = B.join('glass', glass)
    wh = wheel(M)
    finish(wh)
    wh.location = (0, 0, 0)
    obs = [bodyo, glasso, wh]
    for o in obs:
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    tris = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in obs}
    print('CAR tris', tris)
    unwrap_all(obs, size)

    base = bake_pass(obs, 'base', size)
    rough = bake_pass(obs, 'rough', size)
    metal = bake_pass(obs, 'metal', size)
    emit = bake_pass(obs, 'emit', size)
    ao = bake_pass(obs, 'ao', size, samples=96)
    save_png(os.path.join(out, 'car_base.png'), base[..., :3], True)
    orm = np.stack([ao[..., 0], rough[..., 0], metal[..., 0]], -1)
    save_png(os.path.join(out, 'car_orm.png'), orm, False)
    save_png(os.path.join(out, 'car_emit.png'), emit[..., :3], True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(chk, 'car.blend'))
    export_glb(os.path.join(out, 'car.glb'), obs)
    print('CAR done', {f: os.path.getsize(os.path.join(out, f)) for f in ('car.glb', 'car_base.png', 'car_orm.png', 'car_emit.png')})


if __name__ == '__main__':
    main()
