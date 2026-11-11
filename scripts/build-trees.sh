#!/usr/bin/env bash
# Poly Haven scans -> game-grade GLB.
#
# A raw Poly Haven tree is a photogrammetry scan: the fir's buffer is 478 MB and
# the pine is 905 MB. Nothing about that is shippable to a browser (or to a
# phone). This script does what an art pipeline normally does — weld, decimate,
# downscale the texture set, and prune — and prints the before/after so the cost
# of each step is visible.
#
# Usage: bash scripts/build-trees.sh   (run from the project root)
set -euo pipefail
cd "$(dirname "$0")/.."
GT="npx --no-install gltf-transform"
OUT=public/assets/trees
mkdir -p "$OUT" work/out

SPECIES=(pine_sapling_small quiver_tree_01 searsia_lucida tree_stump_01 dead_tree_trunk_02)
RATIO="${1:-0.10}"
ERR="${2:-0.005}"

for slug in "${SPECIES[@]}"; do
  src="work/$slug/${slug}_1k.gltf"
  [ -f "$src" ] || { echo "skip $slug (not downloaded)"; continue; }
  raw=$(du -sh "$src" | cut -f1)
  rawbin=$(python3 -c "import json;print(round(json.load(open('$src'))['buffers'][0]['byteLength']/1048576,1))")

  $GT copy    "$src"                     "work/out/$slug.a.glb" >/dev/null
  $GT weld    "work/out/$slug.a.glb"     "work/out/$slug.b.glb" >/dev/null
  $GT simplify "work/out/$slug.b.glb"    "work/out/$slug.c.glb" --ratio "$RATIO" --error "$ERR" >/dev/null
  $GT resize  "work/out/$slug.c.glb"     "work/out/$slug.d.glb" --width 512 --height 512 >/dev/null
  $GT prune   "work/out/$slug.d.glb"     "work/out/$slug.e.glb" >/dev/null
  $GT dedup   "work/out/$slug.e.glb"     "$OUT/$slug.glb"       >/dev/null
  rm -f work/out/$slug.[a-e].glb

  echo "--- $slug"
  echo "    raw buffer : ${rawbin} MB   (gltf ${raw})"
  echo "    shipped    : $(du -h "$OUT/$slug.glb" | cut -f1)  $(python3 -c "
import struct, json, sys
b = open('$OUT/$slug.glb','rb').read()
clen, _ = struct.unpack_from('<II', b, 12)
j = json.loads(b[20:20+clen])
tris = 0
for m in j.get('meshes', []):
    for p in m.get('primitives', []):
        if 'indices' in p:
            tris += j['accessors'][p['indices']]['count'] // 3
print(f'{tris:,} tris, {len(j.get(\"images\", []))} textures')")"
done

echo
echo "final asset dir:"; du -sh "$OUT"; ls -la "$OUT"
