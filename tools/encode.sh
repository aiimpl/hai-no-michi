#!/bin/sh
# Encode the PNG sequence (2x resolution) and audio into a 1350x1080, yuv420p, TV-range (bt709) mp4, then verify with ffprobe.
#   sh tools/encode.sh <frames dir> <audio.wav> <out.mp4>
set -e
IN=$1; AUD=$2; OUT=$3
ffmpeg -v error -y -framerate 30 -i "$IN/%05d.png" -i "$AUD" \
  -vf "scale=1350:1080:flags=lanczos,scale=in_range=pc:out_range=tv,format=yuv420p" \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:v libx264 -profile:v high -crf 16 -preset slow -pix_fmt yuv420p \
  -c:a aac -b:a 192k -af "alimiter=limit=0.9" -shortest -movflags +faststart "$OUT"
ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt,color_range,color_space,r_frame_rate:format=duration -of compact "$OUT"
