#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
base_url="${1:-http://localhost:3000}"
chrome_bin="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
output="$project_dir/public/gtm-control-tower-walkthrough.mp4"
work_dir="$(mktemp -d /tmp/gtm-walkthrough.XXXXXX)"
trap 'mv "$work_dir" "$HOME/.Trash/$(basename "$work_dir")" 2>/dev/null || true' EXIT

if [[ ! -x "$chrome_bin" ]]; then
  echo "Google Chrome is required at the standard macOS application path." >&2
  exit 1
fi

node "$project_dir/scripts/capture-walkthrough.mjs" "$base_url" "$work_dir"

slides="$work_dir/slides.txt"
for index in {0..7}; do
  printf "file '%s/frame-%s.png'\nduration 15\n" "$work_dir" "$index" >> "$slides"
done
printf "file '%s/frame-7.png'\n" "$work_dir" >> "$slides"

sed -n '/^## Narration$/,/^## Recording notes$/p' "$project_dir/docs/two-minute-walkthrough.md" \
  | sed '1d;$d;/^$/d' > "$work_dir/narration.txt"
say -v Samantha -r 150 -o "$work_dir/narration.aiff" -f "$work_dir/narration.txt"

ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$slides" \
  -vf "scale=1600:900:force_original_aspect_ratio=decrease,pad=1600:900:(ow-iw)/2:(oh-ih)/2,format=yuv420p" \
  -r 30 -t 120 -c:v libx264 -preset medium -crf 27 -movflags +faststart "$work_dir/silent.mp4"
ffmpeg -hide_banner -loglevel error -y -i "$work_dir/silent.mp4" -i "$work_dir/narration.aiff" \
  -filter_complex "[1:a]apad=pad_dur=120[a]" -map 0:v -map "[a]" -t 120 -c:v copy -c:a aac -b:a 96k -movflags +faststart "$output"

echo "Wrote $output"
