# Hai no Michi — the Ash Road

A small driving game in the browser: a six-wheeled expedition truck on the roads of a volcanic caldera.
It runs on three.js. Every truck part, tree, rock, shrine and hut was built by Python scripts driving Blender and baked there — no photos, scans, hand-painted textures or hand-modeled assets.

**Play: https://aiimpl.github.io/hai-no-michi/**

## What's in it
- A 2 km rim road around a crater lake, a switchback down to the shore, and a branch into a steaming geothermal valley
- A lakeside shrine with a torii standing in the water, a boathouse and pier, a sulfur shack, an old observatory
- Mountains carved by simulated rain erosion, about 140,000 trees in the playable area and 500,000 more on the far ranges
- A six-wheel vehicle with independent springs, dampers, anti-roll, tyre slip and all-wheel drive; buoyancy and flooding if you drive into the lake
- Continuous time of day: the sun, sky, fog, shadows and reflections all follow one sun elevation, from afternoon to starlight
- Procedural audio: engine, gravel, wind, birds, a slow chord pad (WebAudio, no sound files)
- A scripted 30 s film that renders frame by frame to 1350×1080 mp4

## Controls
Keyboard: W/S drive · A/D steer · Shift boost · drag to look · V side view · N night · L headlights · H high beam · R recover · P hide HUD

Touch: left thumb stick drives and steers, drag on the right to look, buttons for boost / view / reset / night. Phones get a lighter quality profile automatically (`?q=high` or `?q=low` to override).

## Requirements
- To play: a browser with WebGL2 (Chrome / Safari / Edge), desktop or phone. About 60 fps on an Apple M-series Mac.
- To rebuild the assets: Blender 5.2, Python 3.10+, ffmpeg, cwebp. To render the film: Google Chrome.

## Usage
```sh
make serve     # play at http://127.0.0.1:8792/
make setup     # Python venv with Playwright, numpy, scipy
make bake      # rebuild all assets with Blender (about 30 min)
make video     # render 900 frames and encode build/hai-no-michi.mp4 with sound (about 20 min)
```
`docs/data` already contains the baked assets, so `make bake` is only needed if you change the generators.

## How it works
- **Terrain** (`bake/world.py`, `bake/terrain.py`): the caldera, lake, geothermal valley and cape are closed-form fields in numpy. The outer mountains are then eroded by millions of simulated raindrops in four passes (16 m → 2 m grids). Roads are Catmull-Rom splines with a grade limit; the ground is cut to them with slopes no steeper than 29°. A distance field to the road network is baked for the shader and the vehicle.
- **Far ranges** (`bake/farland.py`): a 12 km heightfield eroded the same way, stitched to the playable map at its edge, with its own forest drawn as impostors only.
- **Vehicle** (`bake/car.py`, `docs/src/vehicle.js`): beveled boxes, tubes and lathes assembled in Blender; wear, dust, chipping and streaks are baked with Cycles into base/ORM/emission maps. Physics runs at 240 Hz with a fixed step, so the same inputs always give the same drive.
- **Trees** (`bake/foliage.py`, `bake/trees.py`, `bake/impostor.py`): needle sprays and fern fronds are built strand by strand and photographed from above into cards. Four conifer species in two LODs, and octahedral impostors (8×8 view directions) beyond 190 m, blended by screen-door dithering.
- **Shadows** (`docs/src/shadows.js`): one 8192² static shadow map over 2.3 km, redrawn only when the sun moves, plus a small per-frame map for the truck.
- **Water** (`docs/src/lake.js`): gust bands, 40 ripple waves, glints and a sun glitter path; planar reflection of the mirrored world; refraction and depth absorption from the scene behind the surface.
- **Post** (`docs/src/post.js`): half-float HDR with MSAA, dual-filter bloom, ACES-style curve, vignette and dither.
- **Film** (`docs/src/script.js`, `tools/render.py`): `?render` fixes time per frame, drives the truck and a free camera from the script, and captures each frame with the HUD at 2× resolution.

## Layout
```
bake/          Python for Blender and numpy (terrain, far ranges, truck, foliage, trees, impostors, rocks, props, scatter)
docs/          the page (GitHub Pages)
  src/         main, quality, touch, terrain, vehicle, car, forest, groundcover, lake, sky, shadows, post, props, geothermal, splash, hud, audio, script
  data/        baked assets
  vendor/three three.js r160 (MIT)
tools/         render.py (frame capture), audio.py (soundtrack), encode.sh (mp4), webp.sh (texture packing), probe.py (scripted checks)
```

## License
MIT (`LICENSE`). three.js is MIT, see `docs/vendor/three/LICENSE`.
