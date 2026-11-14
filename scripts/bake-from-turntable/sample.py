"""Bake per-vertex colours onto the mesh from the turntable video.

Uses fit4.json (height-matched camera, per-frame yaw, both axis calibrations).
Each vertex is projected into every frame; a sample counts only if the vertex is
in front of the camera, front-facing, the nearest surface along its pixel per a
z-buffer, and inside the measured figure mask. Frames blend by facing^3.

Colours are written as COLOR_0 LINEAR floats (glTF COLOR_0 is linear; three.js
multiplies it into the base colour), so sRGB -> linear conversion is required.
"""
import os, sys, json, struct
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from meshio import positions, read_glb

FRAMES = os.path.join(HERE, "frames")
SRC = os.path.join(HERE, "..", "r-simp.glb")          # float geometry, for projection
BASE = os.path.join(HERE, "..", "r-q.glb")            # pristine quantized base (no COLOR_0 yet)
SHIP = os.path.join(HERE, "..", "..", "..", "public", "assets", "char", "rodin-hooded.glb")
KEEP = os.path.join(HERE, "..", "rodin-hooded-colored.glb")

# The video is a studio render: its own soft lighting is baked into these colours
# (sides darker) and the design is a muted grey-green. Ungraded, the character
# reads as a dark blob under a dim forest sun, so lift it a little. Applied in
# sRGB space, before the linear conversion.
GRADE = dict(gamma=0.95, saturation=1.15, exposure=1.35)


def grade(c):
    c = np.clip(c, 0.0, 1.0) ** GRADE["gamma"]              # <1 lifts the shadows
    g = c.mean(axis=1, keepdims=True)
    c = g + (c - g) * GRADE["saturation"]                   # shallow sat boost
    return np.clip(c * GRADE["exposure"], 0.0, 1.0)

fit = json.load(open(os.path.join(HERE, "fit4.json")))
fpx, d = float(fit["fpx"]), float(fit["d"])
cal = fit["cal"]; ah, bh, av, bv = cal["ah"], cal["bh"], cal["av"], cal["bv"]
yaws = {int(k): float(v) for k, v in fit["yaws"].items()}
ZW, ZH = fit["canvas"]; ZW, ZH = int(ZW), int(ZH)
FW, FH = 720, 1280
print(f"camera fpx {fpx:.0f} d {d:.3f} | cal h({ah:+.1f},{bh:.4f}) v({av:+.1f},{bv:.4f})")
print(f"yaws {min(yaws.values()):.0f}..{max(yaws.values()):.0f} deg, {len(yaws)} frames")

pos, idx, j, b = positions(SRC)
pr = j["meshes"][0]["primitives"][0]
from meshio import accessor
_, _, jj, bb = positions(SRC)
nrm = accessor(jj, bb, pr["attributes"]["NORMAL"]).astype(np.float64)
n = len(pos)
print(f"mesh {n} verts, {len(idx)//3} tris, material {json.dumps(j['materials'][0])}")

masks = {f: ndimage.binary_dilation(np.load(os.path.join(HERE, f"mask_{f:03d}.npy")),
                                    np.ones((5, 5), bool)) for f in yaws}

acc = np.zeros((n, 3)); wsum = np.zeros(n); nsamp = np.zeros(n, np.int32)

def project(yaw):
    t = np.deg2rad(yaw); c, s = np.cos(t), np.sin(t)
    p = np.empty_like(pos)
    p[:, 0] = c * pos[:, 0] + s * pos[:, 2]
    p[:, 2] = -s * pos[:, 0] + c * pos[:, 2]
    p[:, 1] = pos[:, 1]
    nn = np.empty_like(nrm)
    nn[:, 0] = c * nrm[:, 0] + s * nrm[:, 2]
    nn[:, 2] = -s * nrm[:, 0] + c * nrm[:, 2]
    nn[:, 1] = nrm[:, 1]
    zc = d - p[:, 2]
    u = ZW / 2 + fpx * p[:, 0] / np.maximum(zc, 1e-6)
    v = ZH / 2 - fpx * p[:, 1] / np.maximum(zc, 1e-6)
    return p, nn, zc, ah + bh * u, av + bv * v

for i in sorted(yaws):
    p, nn, zc, colc, rowc = project(yaws[i])
    view = np.stack([-p[:, 0], -p[:, 1], d - p[:, 2]], axis=1)
    view /= np.linalg.norm(view, axis=1)[:, None] + 1e-9
    facing = (nn * view).sum(1)
    ch = np.clip(colc.astype(np.int32), 0, ZW - 1); rh = np.clip(rowc.astype(np.int32), 0, ZH - 1)
    zb = np.full((ZH, ZW), 1e9)
    np.minimum.at(zb, (rh, ch), zc)
    inb = (colc >= 1) & (colc < ZW - 1) & (rowc >= 1) & (rowc < ZH - 1)
    vis = (zc > 0.05) & (facing > 0.12) & (zc <= zb[rh, ch] + 0.04) & inb & masks[i][rh, ch]
    k = int(vis.sum())
    if k == 0:
        print(f"  f{i:>2} yaw {yaws[i]:>6.1f}: 0 samples"); continue
    im = np.asarray(Image.open(os.path.join(FRAMES, f"f{i:03d}.png")).convert("RGB"), np.float32) / 255.0
    x = (colc[vis] * 2).clip(0, FW - 1.001); y = (rowc[vis] * 2).clip(0, FH - 1.001)
    x0 = x.astype(np.int32); y0 = y.astype(np.int32)
    fx = (x - x0)[:, None]; fy = (y - y0)[:, None]
    c00 = im[y0, x0]; c10 = im[y0, x0 + 1]; c01 = im[y0 + 1, x0]; c11 = im[y0 + 1, x0 + 1]
    col = c00 * (1 - fx) * (1 - fy) + c10 * fx * (1 - fy) + c01 * (1 - fx) * fy + c11 * fx * fy
    w = (facing[vis] ** 3)[:, None]
    ii = np.nonzero(vis)[0]
    acc[ii] += col * w; wsum[ii] += w[:, 0]; nsamp[ii] += 1
    print(f"  f{i:>2} yaw {yaws[i]:>6.1f}: {k:>7} samples  (verts covered {int((nsamp>0).sum()):>7})")

have = wsum > 0
srgb = np.zeros((n, 3))
srgb[have] = acc[have] / wsum[have][:, None]
print(f"\nsampled {int(have.sum())}/{n} verts ({100*have.mean():.1f}%), "
      f"mean {nsamp[have].mean():.1f} frames/vertex")

missing = np.nonzero(~have)[0]
if len(missing):
    tree = cKDTree(pos[have])
    dist_n, nn_i = tree.query(pos[missing], k=1)
    src = np.nonzero(have)[0][nn_i]
    close = dist_n < 0.02
    srgb[missing[close]] = srgb[src[close]] * 0.85
    srgb[missing[~close]] = np.array([0.045, 0.042, 0.038])
    print(f"unsampled {len(missing)}: {int(close.sum())} from a close neighbour, "
          f"{int((~close).sum())} dark neutral (hood interior / armpits / soles)")

def srgb_to_linear(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

srgb = grade(srgb)
lin = srgb_to_linear(srgb).astype(np.float32)

# ---- preview: splat the baked colours from 4 views -------------------------
panels = []
for yaw in (0, 90, 180, 270):
    _, _, _, colc, rowc = project(yaw)
    img = np.zeros((ZH, ZW, 3), np.float32) + 0.08
    m = np.zeros((ZH, ZW), bool)
    ci = np.clip(colc.astype(np.int32), 0, ZW - 1); ri = np.clip(rowc.astype(np.int32), 0, ZH - 1)
    img[ri, ci] = srgb
    m[ri, ci] = True
    m = ndimage.binary_closing(m, np.ones((5, 5), bool))
    img[~m] = 0.08
    panels.append((np.clip(img, 0, 1) * 255).astype(np.uint8))
Image.fromarray(np.concatenate(panels, axis=1)).save(os.path.join(HERE, "bake_preview.png"))
print("wrote bake_preview.png (front / 90 / back / 270, splat of baked colours)")

y = pos[:, 1]
print("\nregional mean colour (linear):")
for name, lo, hi in (("hood/head", 0.55, 0.95), ("mantle", 0.30, 0.55),
                     ("belt", 0.00, 0.12), ("trousers", -0.45, -0.10),
                     ("boots", -0.95, -0.60)):
    c = lin[(y > lo) & (y < hi)].mean(axis=0)
    print(f"  {name:<10} {np.round(c,3).tolist()}  -> sRGB {np.round(np.where(c<=0.0031308, c*12.92, 1.055*c**(1/2.4)-0.055),2).tolist()}")

# ---- inject COLOR_0 into the shipped (quantized) glb -----------------------
j2, b2 = read_glb(BASE)
n2 = j2["accessors"][j2["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]["count"]
if n2 != n:
    raise SystemExit(f"vertex count mismatch: base {n2} vs sampled {n}")
# Rodin's placeholder material ships baseColorFactor 0.5 with metallicFactor 0.8:
# a metallic cloth surface has almost no diffuse response, so with no environment
# map the character renders near-black whatever colour you put in it.
pm = j2["materials"][0].setdefault("pbrMetallicRoughness", {})
pm["baseColorFactor"] = [1.0, 1.0, 1.0, 1.0]
pm["metallicFactor"] = 0.0
pm["roughnessFactor"] = 0.78
buf = bytearray(b2)
while len(buf) % 4:
    buf.append(0)
off = len(buf)
raw = lin.tobytes()
buf += raw
while len(buf) % 4:
    buf.append(0)
j2["bufferViews"].append({"buffer": 0, "byteOffset": off, "byteLength": len(raw), "target": 34962})
j2["accessors"].append({"bufferView": len(j2["bufferViews"]) - 1, "componentType": 5126,
                        "count": n, "type": "VEC3", "min": [float(lin.min())] * 3,
                        "max": [float(lin.max())] * 3})
ai = len(j2["accessors"]) - 1
j2["meshes"][0]["primitives"][0]["attributes"]["COLOR_0"] = ai
j2["buffers"][0]["byteLength"] = len(buf)
js = json.dumps(j2, separators=(",", ":")).encode()
while len(js) % 4:
    js += b" "
total = 12 + 8 + len(js) + 8 + len(buf)
out = bytearray()
out += struct.pack("<III", 0x46546C67, 2, total)
out += struct.pack("<II", len(js), 0x4E4F534A) + js
out += struct.pack("<II", len(buf), 0x004E4942) + bytes(buf)
for dst in (KEEP, SHIP):
    open(dst, "wb").write(out)
    print(f"wrote {dst}  ({len(out)/1048576:.2f} MB, COLOR_0 accessor {ai})")
