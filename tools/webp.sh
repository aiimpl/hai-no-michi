#!/bin/sh
# Pack baked PNGs into WebP (color at q90, alpha kept lossless, normals and ORM at near-lossless settings).
#   sh tools/webp.sh <data dir>
set -e
D=$1
for f in car_base obs_base rock_base; do cwebp -quiet -q 90 "$D/$f.png" -o "$D/$f.webp"; done
for f in car_emit obs_emit; do cwebp -quiet -q 85 "$D/$f.png" -o "$D/$f.webp"; done
for f in car_orm obs_orm; do cwebp -quiet -q 95 "$D/$f.png" -o "$D/$f.webp"; done
for f in foliage_color impostor_color; do cwebp -quiet -q 92 -alpha_q 100 -exact "$D/$f.png" -o "$D/$f.webp"; done
for f in foliage_normal impostor_normal rock_normal; do cwebp -quiet -near_lossless 60 -exact "$D/$f.png" -o "$D/$f.webp"; done
du -ch "$D"/*.webp | tail -1
cwebp -quiet -q 90 "$D/props_base.png" -o "$D/props_base.webp"
cwebp -quiet -q 95 "$D/props_orm.png" -o "$D/props_orm.webp"
