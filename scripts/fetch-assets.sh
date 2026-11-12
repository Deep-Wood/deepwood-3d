#!/usr/bin/env bash
# Download a Poly Haven CC0 model (glTF + its .bin + every texture) into
# work/<slug>/, laid out the way the .gltf expects it.
#
#   bash scripts/fetch-assets.sh fern_02 island_tree_02 ...
#   bash scripts/fetch-assets.sh --list plants     # what is available
#
# Notes that cost real time to rediscover:
#   - api.polyhaven.com 403s the python-urllib user agent, hence curl -A.
#   - The per-map API keys are inconsistent across models (`diff`/`nor_gl`/`arm`
#     for some, capitalised `Diffuse`/`AO`/`Rough` for others), so match
#     case-insensitively.
#   - glTF textures live under Models/jpg/1k/<slug>/, the geometry under
#     Models/gltf/1k/<slug>/. The .gltf references an EXTERNAL .bin; without it
#     GLTFLoader throws "Invalid typed array length".
set -euo pipefail
cd "$(dirname "$0")/.."
UA="Mozilla/5.0"

if [ "${1:-}" = "--list" ]; then
  curl -s -A "$UA" "https://api.polyhaven.com/assets?t=models" | python3 -c "
import json, sys
want = (sys.argv[1] if len(sys.argv) > 1 else '').lower()
d = json.load(sys.stdin)
for slug, v in sorted(d.items()):
    tags = ' '.join([c.lower() for c in v.get('categories', [])] + [t.lower() for t in v.get('tags', [])])
    if not want or want in tags:
        print(f\"  {slug:32s} {','.join(v.get('categories', []))[:34]}\")
" "${2:-}"
  exit 0
fi

for slug in "$@"; do
  echo "--- $slug"
  dir="work/$slug"
  mkdir -p "$dir"
  curl -s -m 120 -A "$UA" "https://api.polyhaven.com/files/$slug" -o "$dir/api.json"
  python3 - "$slug" <<'PY'
import json, os, subprocess, sys, urllib.parse

slug = sys.argv[1]
dir_ = f"work/{slug}"
UA = "Mozilla/5.0"
api = json.load(open(f"{dir_}/api.json"))
base = f"https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/{slug}"

# basename -> direct url, from the API's include map (any resolution bucket)
by_name = {}
for bucket in api.get("gltf", {}).values():
    for name, info in (bucket.get("include") or {}).items():
        by_name.setdefault(os.path.basename(name).lower(), info.get("url"))
def get(url, dest):
    r = subprocess.run(["curl", "-s", "-m", "600", "-A", UA, "-o", dest, "-w", "%{http_code}", url],
                       capture_output=True, text=True)
    if r.stdout.strip() != "200":
        raise SystemExit(f"  ! {os.path.basename(dest)}: HTTP {r.stdout.strip()} from {url}")

gltf_dest = f"{dir_}/{slug}_1k.gltf"
get(f"{base}/{slug}_1k.gltf", gltf_dest)
g = json.load(open(gltf_dest))

for b in g.get("buffers", []):
    uri = b.get("uri")
    if uri and not uri.startswith("data:"):
        os.makedirs(os.path.join(dir_, os.path.dirname(uri)), exist_ok=True)
        get(f"{base}/{uri}", os.path.join(dir_, uri))

got = miss = 0
for img in g.get("images", []):
    uri = img.get("uri")
    if not uri or uri.startswith("data:"):
        continue
    dest = os.path.join(dir_, uri)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    url = by_name.get(os.path.basename(uri).lower())
    if not url:                      # fall back to the jpg tree, same filename
        url = f"https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/{slug}/{os.path.basename(uri)}"
    try:
        get(url, dest)
        got += 1
    except SystemExit as e:
        miss += 1
        print(e)

size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(dir_) for f in fs)
print(f"    {got} textures (miss {miss}), {size/1048576:.1f} MB total")
PY
done
