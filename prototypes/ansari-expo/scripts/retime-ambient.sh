#!/usr/bin/env bash
# Retime the ambient palm-shadow clips so they play at exactly 1.0x.
#
# The shadow is meant to cross the wall at 8/11 of the 30 fps master's own
# speed. Playing the master at that rate is what made it judder on phones:
# ~21.8 source frames a second cannot divide a 60 Hz display evenly, so
# frames were held for an irregular mix of two and three refreshes. Moving
# the slowness into the file instead — 11/8 as many frames, filled in by
# motion interpolation — keeps the speed on the wall and lets the player
# present every frame for exactly two refreshes. See the note above
# `PLAYBACK_RATE` in components/AmbientVideo.tsx.
#
# Usage (from prototypes/ansari-expo, with ffmpeg on PATH):
#   scripts/retime-ambient.sh <portrait-master.mp4> <desktop-master.mp4>
#
# The masters are the pre-retime 30 fps clips (248 frames, ~8.27 s each);
# git history holds them as assets/video/ambient-shadow{,-desktop}.mp4
# before issue #254. Do not run this over its own output: that would slow
# the shadow by another 11/8.
set -euo pipefail

# 11/8 = 1 / (8/11), the rate the lull used to be played at.
RETIME_NUM=11
RETIME_DEN=8
OUT=assets/video
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

retime() {
  local master=$1 name=$2 webm_bitrate=$3
  local frames out_frames
  frames=$(ffprobe -v error -count_frames -select_streams v:0 \
    -show_entries stream=nb_read_frames -of csv=p=0 "$master")
  out_frames=$(( frames * RETIME_NUM / RETIME_DEN ))

  # Interpolated over a doubled copy and cut at one loop's worth of frames:
  # the interpolator never runs out of source pairs at the tail, and the
  # last frame glides into the first exactly as any other pair does, so the
  # wrap is as smooth as the middle of the clip. Lossless intermediate, so
  # the two encodings below start from the same pixels.
  ffmpeg -v error -y -stream_loop 1 -i "$master" \
    -vf "setpts=PTS*${RETIME_NUM}/${RETIME_DEN},minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1" \
    -frames:v "$out_frames" -c:v ffv1 -an "$TMP/$name.mkv"

  # H.264 Main @ L4.0 — `webPrefersMp4` probes for exactly avc1.4D4028.
  # faststart keeps the moov ahead of the data, as the originals had it.
  ffmpeg -v error -y -i "$TMP/$name.mkv" -c:v libx264 -profile:v main -level 4.0 \
    -pix_fmt yuv420p -preset veryslow -crf 27 -movflags +faststart -an \
    "$OUT/$name.mp4"

  # VP9 Profile 0 (4:2:0), which every VP9 decoder implements. Two passes,
  # because a single pass at these bitrates spends far more on the opening
  # keyframe than on the frames that run into it, and the loop's last
  # frame then lands on a visibly sharper first one at every wrap.
  local pass
  for pass in 1 2; do
    ffmpeg -v error -y -i "$TMP/$name.mkv" -c:v libvpx-vp9 -profile:v 0 \
      -pix_fmt yuv420p -b:v "$webm_bitrate" -row-mt 1 -deadline good -cpu-used 1 \
      -pass "$pass" -passlogfile "$TMP/$name-vp9" -an \
      $([ "$pass" = 1 ] && echo "-f null /dev/null" || echo "$OUT/$name.webm")
  done
}

# WebM bitrates track the per-second rates the pre-retime files ran at.
retime "$1" ambient-shadow 118k
retime "$2" ambient-shadow-desktop 38k
