"""Video audio: synthesize from per-frame speed (meta.json) using the same design as the in-browser audio (docs/src/audio.js).
Engine (low drone following RPM), gravel, wind, distant birds, slowly shifting chords. 48 kHz stereo wav.
  python tools/audio.py <meta.json> <out.wav> [seconds] [events]
Events are comma-separated "sec:kind". Kinds: cut (scene cut), splash, under / over (enter / leave water)
  e.g. 7:cut,8.4:splash,12.3:under,15:cut,15:over
"""
import json
import sys
import wave

import numpy as np
from scipy.signal import butter, sosfilt

SR = 48000


def lowpass(x, f, order=2):
    return sosfilt(butter(order, f / (SR / 2), 'low', output='sos'), x)


def bandpass(x, f0, f1):
    return sosfilt(butter(2, [f0 / (SR / 2), f1 / (SR / 2)], 'band', output='sos'), x)


def main():
    meta = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 25.0
    events = [(float(a), b) for a, b in (e.split(':') for e in sys.argv[4].split(','))] if len(sys.argv) > 4 else []
    n = int(dur * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(5)
    ft = np.array([m['t'] for m in meta]); kmh = np.array([abs(m['kmh']) for m in meta])
    v = np.interp(t, ft, kmh)
    acc = np.gradient(np.interp(t, ft, kmh)) * SR / 3.6            # m/s^2
    thr = np.clip(0.35 + acc / 3.0, 0, 1)
    thr = lowpass(thr, 3.0, 1)
    # engine: RPM climbs and drops through the gears
    gear = (v / 22) % 1
    rpm = 700 + gear * 1600 + np.minimum(v, 22) * 20 + thr * 380
    f = lowpass(rpm / 60 * 2, 4.0, 1)
    ph = 2 * np.pi * np.cumsum(f) / SR
    saw = 2 * ((ph / (2 * np.pi)) % 1) - 1
    sq = np.sign(np.sin(ph * 0.5))
    eng = (saw + 0.6 * sq) * (1 + 0.25 * np.sin(ph / 4))
    # brighter under throttle (mix two low-pass filters)
    e_lo, e_hi = lowpass(eng, 260, 2), lowpass(eng, 900, 2)
    eng = e_lo * (1 - thr) + e_hi * thr
    eng *= 0.1 + 0.12 * thr
    # gravel: proportional to speed, roughened by road bumps
    noise = rng.standard_normal(n)
    grav = bandpass(noise, 1400, 4200) * np.minimum(v / 60, 1) * (0.05 + 0.2 * (0.5 + 0.5 * lowpass(rng.standard_normal(n), 6, 1) * 40).clip(0, 1))
    # wind
    wind = lowpass(rng.standard_normal(n), 420, 2) * (0.03 + np.minimum(v / 70, 1) * 0.06) * 3
    # birds: every 3-10 s, three short calls on the left or right
    birdL = np.zeros(n); birdR = np.zeros(n)
    tb = 1.8
    while tb < dur - 0.6:
        f0 = 2800 + rng.random() * 1800
        seg = np.arange(int(0.45 * SR)) / SR
        ff = f0 * (1 + 0.16 * np.abs(np.sin(seg * np.pi / 0.12)))
        env = np.clip(np.minimum(seg / 0.02, (0.42 - seg) / 0.2), 0, 1) * (0.5 + 0.5 * np.cos(seg * 2 * np.pi / 0.12))
        s = np.sin(2 * np.pi * np.cumsum(ff) / SR) * env * 0.02
        i0 = int(tb * SR); i1 = min(n, i0 + len(s))
        pan = rng.random()
        birdL[i0:i1] += s[:i1 - i0] * (1 - pan); birdR[i0:i1] += s[:i1 - i0] * pan
        tb += 3 + rng.random() * 7
    # chords: three triangle-wave notes shifting every 8 s, long reverb
    chords = [[146.8, 220.0, 277.2], [130.8, 196.0, 293.7], [123.5, 185.0, 246.9], [110.0, 164.8, 261.6]]
    mus = np.zeros(n)
    for k in range(3):
        fk = np.array([chords[int(tt // 8) % 4][k] for tt in t[::480]])
        fk = lowpass(np.repeat(fk, 480)[:n], 0.5, 1)
        p = 2 * np.pi * np.cumsum(fk) / SR
        mus += (2 * np.abs(2 * ((p / (2 * np.pi)) % 1) - 1) - 1) * 0.3
    ir = rng.standard_normal(int(3 * SR)) * (1 - np.arange(int(3 * SR)) / (3 * SR)) ** 3
    musR = np.convolve(mus, ir[::1], mode='full')[:n]
    musR = musR / (np.abs(musR).max() + 1e-9) * 0.05
    fade = np.clip(t / 1.5, 0, 1) * np.clip((dur - t) / 1.2, 0, 1)
    # scene cut: dip only the vehicle sounds for 0.25 s (hides the RPM jump)
    cutg = np.ones(n)
    for te, k in events:
        if k == 'cut':
            cutg *= np.clip(np.abs(t - te) / 0.25, 0, 1)
    eng, grav = eng * cutg, grav * cutg
    # splash: a low thump plus a broadband wash
    spl = np.zeros(n)
    for te, k in events:
        if k == 'splash':
            i0 = int(te * SR); m = int(2.0 * SR); tt = np.arange(m) / SR
            nz = bandpass(rng.standard_normal(m), 250, 5000) * np.exp(-tt * 2.2) * np.clip(tt / 0.02, 0, 1)
            thump = np.sin(2 * np.pi * (80 - 40 * np.clip(tt / 0.4, 0, 1)) * tt) * np.exp(-tt * 7)
            seg = (nz * 1.4 + thump * 0.9)[:max(0, min(m, n - i0))]
            spl[i0:i0 + len(seg)] += seg
    # underwater: cut the highs to muffle, add low bubbling
    uw = np.zeros(n)
    for te, k in sorted(events):
        if k in ('under', 'over'):
            uw[int(te * SR):] = 1.0 if k == 'under' else 0.0
    uw = lowpass(uw, 3.0, 1)
    L = (eng + grav + wind + musR + spl) * fade + birdL
    R = (eng * 0.95 + grav * 0.9 + np.roll(wind, 900) + np.roll(musR, 1200) + spl) * fade + birdR
    if uw.max() > 0.01:
        gurgle = lowpass(rng.standard_normal(n), 180, 2) * 0.35 * (1 + 0.6 * np.sin(2 * np.pi * 3.1 * t))
        L = L * (1 - uw) + (lowpass(L, 380, 2) * 1.4 + gurgle) * uw
        R = R * (1 - uw) + (lowpass(R, 380, 2) * 1.4 + gurgle) * uw
    st = np.stack([L, R], 1)
    st = st / max(1e-9, np.abs(st).max()) * 0.8
    pcm = (st * 32767).astype('<i2')
    with wave.open(out, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    print('AUDIO', out, round(dur, 2), 's')


main()
