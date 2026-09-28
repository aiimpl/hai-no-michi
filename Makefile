PORT ?= 8792
PY ?= .venv/bin/python
BLENDER ?= blender
B = $(BLENDER) -b --factory-startup --python-exit-code 1
D = docs/data
C = build/check

.PHONY: serve setup bake frames audio video clean

serve:
	python3 -m http.server $(PORT) --bind 127.0.0.1 --directory docs

setup:
	python3 -m venv .venv
	.venv/bin/pip install -r requirements.txt
	.venv/bin/playwright install chrome || true

# Rebuild all baked data, in order: terrain -> car -> foliage -> trees -> impostors -> rocks
# -> observatory -> props -> placement -> distant ranges -> WebP. Terrain, placement and distant
# ranges are numpy/scipy only and run with the venv python; the rest run in Blender.
bake:
	mkdir -p $(C)
	$(PY) bake/terrain.py $(D) $(C)
	$(B) -P bake/car.py -- $(D) $(C) 2048
	$(B) -P bake/foliage.py -- $(D) $(C) 1024
	$(B) -P bake/trees.py -- $(D) $(C)
	$(BLENDER) -b $(C)/trees.blend --python-exit-code 1 -P bake/impostor.py -- $(D) $(C) 128
	$(B) -P bake/rocks.py -- $(D) 1024
	$(B) -P bake/observatory.py -- $(D) $(C) 2048
	$(B) -P bake/props.py -- $(D) $(C) 2048
	$(PY) bake/scatter.py $(D) $(C)
	$(PY) bake/farland.py $(D) $(C)
	sh tools/webp.sh $(D)
	rm -f $(D)/*.png

# 900 frames (30 s at 30 fps) at 2x resolution. Resumes where it left off if interrupted
frames:
	$(PY) tools/render.py build/frames 0 900 30

audio: frames
	$(PY) tools/audio.py build/frames/meta.json build/hai-no-michi.wav 30 12:cut,20:cut

video: audio
	sh tools/encode.sh build/frames build/hai-no-michi.wav build/hai-no-michi.mp4

clean:
	rm -rf build
