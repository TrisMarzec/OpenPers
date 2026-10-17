#!/usr/bin/env bash
# Rasterizes the brand SVGs with headless Chrome. Run from the repository root:
#   CHROME=/path/to/chrome bash brand/tools/export-png.sh
set -euo pipefail
CHROME="${CHROME:-google-chrome}"
REPO="$(pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

render() { # <svg> <width> <height> <out.png>
  printf '<!doctype html><html><body style="margin:0;background:transparent"><img src="file://%s/brand/%s" width="%s" height="%s" style="display:block"></body></html>' "$REPO" "$1" "$2" "$3" > "$TMP/r.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 --window-size="$2,$3" --screenshot="$4" "file://$TMP/r.html" 2>/dev/null
}

mkdir -p brand/png
render openpers-mark.svg 1024 1024 brand/png/openpers-mark-1024.png
render openpers-mark.svg 512 512 brand/png/openpers-mark-512.png
# iOS rounds home-screen icons itself, so it gets the square variant.
render openpers-mark-square.svg 180 180 apps/web/public/apple-touch-icon.png
render openpers-mark.svg 192 192 apps/web/public/icon-192.png
render openpers-mark.svg 512 512 apps/web/public/icon-512.png
W=$(grep -o 'viewBox="0 0 [0-9]*' brand/openpers-logo.svg | grep -o '[0-9]*$')
render openpers-logo.svg $((W * 4)) 256 brand/png/openpers-logo.png
render openpers-logo-dark.svg $((W * 4)) 256 brand/png/openpers-logo-dark.png
render social-preview.svg 1280 640 brand/png/social-preview.png
cp brand/openpers-mark.svg apps/web/public/favicon.svg
echo "PNG exports written."
