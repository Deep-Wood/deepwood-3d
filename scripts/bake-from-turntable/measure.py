"""Measure the turntable: figure silhouette per frame + head colour, so the camera
can be fitted and the frame showing the FRONT can be identified.

The median-over-frames background does NOT work here: the figure is centred in
every frame, so the median at the centre IS the figure. Use Otsu on luminance
(the studio backdrop is ~207 grey, the figure is darker) instead.
"""
import os, glob, json
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
FR = sorted(glob.glob(os.path.join(HERE, "frames", "f*.png")))
SCALE = 0.5
W = H = None

frames = []
for p in FR:
    im = Image.open(p).convert("RGB")
    if W is None:
        W, H = int(im.width * SCALE), int(im.height * SCALE)
    frames.append(np.asarray(im.resize((W, H), Image.BILINEAR), dtype=np.float32))
F = np.stack(frames)
luma = F @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
print(f"frames {F.shape} at {W}x{H}")
print("luma percentiles:", {p: int(np.percentile(luma, p)) for p in (0, 1, 5, 10, 25, 50, 75, 90, 99, 100)})
print("corner luma:", int(luma[0, 5, 5]), int(luma[0, 5, W - 5]), " top-centre:", int(luma[0, 5, W // 2]))

def otsu(v, bins=256):
    hist, edges = np.histogram(v, bins=bins)
    centres = (edges[:-1] + edges[1:]) / 2
    tot = hist.sum()
    w0 = np.cumsum(hist) / tot
    m0 = np.cumsum(hist * centres) / np.maximum(np.cumsum(hist), 1)
    mT = (hist * centres).sum() / tot
    m1 = (mT - w0 * m0) / np.maximum(1 - w0, 1e-9)
    var = w0 * (1 - w0) * (m0 - m1) ** 2
    k = int(np.argmax(var))
    return float(centres[k])

thr = otsu(luma.ravel())
print(f"otsu threshold: {thr:.1f}   -> background luma {int(luma.mean()):d} mean")

rows = []
for i in range(len(FR)):
    m = luma[i] < thr
    m = ndimage.binary_closing(m, np.ones((5, 5)))
    lab, n = ndimage.label(m)
    if n:
        sizes = ndimage.sum(m, lab, range(1, n + 1))
        m = lab == (1 + int(np.argmax(sizes)))
    m = ndimage.binary_fill_holes(m)
    ys, xs = np.nonzero(m)
    if len(ys) == 0:
        rows.append(None); continue
    top, bot = int(ys.min()), int(ys.max())
    hh = bot - top + 1
    head = F[i][top:top + max(3, int(hh * 0.14)), int(xs.min()):int(xs.max()) + 1]
    hm = m[top:top + max(3, int(hh * 0.14)), int(xs.min()):int(xs.max()) + 1]
    headcol = head[hm].mean(axis=0) if hm.any() else np.zeros(3)
    rows.append(dict(i=i + 1, t=(i + 1) / 4, top=top, bot=bot, h=hh,
                     w=int(xs.max() - xs.min() + 1), cx=float(xs.mean()), cy=float(ys.mean()),
                     area=int(m.sum()), head=[int(c) for c in headcol]))
    np.save(os.path.join(HERE, f"mask_{i+1:03d}.npy"), m)

print(f"{'f':>3} {'t':>5} {'top':>4} {'bot':>4} {'h':>4} {'w':>4} {'cx':>6} {'cy':>6} {'area':>6}  head RGB       warm")
for r in rows:
    if r is None:
        print("  missing"); continue
    hc = r['head']; warm = hc[0] - hc[2]
    print(f"{r['i']:>3} {r['t']:>5.2f} {r['top']:>4} {r['bot']:>4} {r['h']:>4} {r['w']:>4} "
          f"{r['cx']:>6.1f} {r['cy']:>6.1f} {r['area']:>6}  {str(hc):<14} {warm:>+4}")
json.dump(rows, open(os.path.join(HERE, "measure.json"), "w"), indent=1)

# overlay proof: draw the mask edge onto 2 frames so the silhouette can be eyeballed
for idx in (1, 10, 20, 29):
    m = np.load(os.path.join(HERE, f"mask_{idx:03d}.npy"))
    edge = m & ~ndimage.binary_erosion(m, np.ones((3, 3)))
    im = F[idx - 1].copy()
    im[edge] = [255, 0, 0]
    Image.fromarray(im.astype(np.uint8)).save(os.path.join(HERE, f"overlay_{idx:03d}.png"))
print("wrote overlay_001/010/020/029.png")
