"""Final fit: height-matched camera, smooth rotation, both axis calibrations.

fit3 proved the rotation can be recovered (omega 8.0 deg/frame, 37/39 steps the
same sign) but its chosen camera (fov 28, d 5.5) projected only 443 px of a 578 px
figure and papered over it with a 1.276 slope. Fix the distance analytically so
the projection matches the measured height, then absorb the residual (and the
horizontal equivalent) in a least-squares calibration of both axes.

Output: fit4.json = camera + per-frame yaw + the two linear mappings.
"""
import os, sys, json
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from meshio import positions

ZW, ZH = 360, 640
NB = 16
COARSE, FINE = 3.0, 1.0
FOV = 25.0

pos, idx, j, b = positions(os.path.join(HERE, "..", "r-simp.glb"))

# measured figure height, canvas px (mean over frames)
tops, bots = [], []
for i in range(1, 41):
    ys, _ = np.nonzero(np.load(os.path.join(HERE, f"mask_{i:03d}.npy")))
    tops.append(ys.min()); bots.append(ys.max())
OBS_H = float(np.mean(np.array(bots) - np.array(tops) + 1))
fpx = (ZH / 2) / np.tan(np.deg2rad(FOV / 2))
dist = 1.9 * fpx / OBS_H
print(f"observed figure height {OBS_H:.1f} px -> fov {FOV} fpx {fpx:.0f} distance {dist:.3f} m")
print(f"  (analytic: projected height should be {1.9*fpx/dist:.1f} px)")

def proj(yaw):
    t = np.deg2rad(yaw); c, s = np.cos(t), np.sin(t)
    x = c * pos[:, 0] + s * pos[:, 2]
    z = -s * pos[:, 0] + c * pos[:, 2]
    zc = dist - z
    ok = zc > 1e-3
    return (ZW / 2 + fpx * x[ok] / zc[ok], ZH / 2 - fpx * pos[ok, 1] / zc[ok])

def obs_px(fr):
    m = np.load(os.path.join(HERE, f"mask_{fr:03d}.npy"))
    ys, xs = np.nonzero(m)
    top, bot = int(ys.min()), int(ys.max())
    hgt = bot - top + 1
    L = np.zeros(NB); R = np.zeros(NB)
    for k in range(NB):
        y0 = top + int(k * hgt / NB); y1 = top + int((k + 1) * hgt / NB)
        xx = np.nonzero(m[y0:max(y1, y0 + 1)].any(axis=0))[0]
        if len(xx):
            L[k] = xx.min(); R[k] = xx.max()
    return L, R, top, bot

def view_px(yaw):
    u, v = proj(yaw)
    top, bot = float(v.min()), float(v.max())
    hgt = max(bot - top, 1e-6)
    band = np.clip(((v - top) / hgt * NB).astype(np.int32), 0, NB - 1)
    L = np.zeros(NB); R = np.zeros(NB)
    for k in range(NB):
        sel = band == k
        if sel.any():
            L[k] = u[sel].min(); R[k] = u[sel].max()
    return L, R, top, bot

# normalised feature (scale/centre invariant) for the yaw fit
OBSF = {}
for i in range(1, 41):
    L, R, top, bot = obs_px(i)
    h = bot - top + 1; cx = 0.5 * (L.max() + R.min())
    OBSF[i] = np.concatenate([(L - cx) / h, (R - cx) / h])

YAWV = np.arange(0, 360, COARSE)
FEAT = []
for y in YAWV:
    L, R, top, bot = view_px(y)
    h = bot - top + 1; cx = 0.5 * (L.max() + R.min())
    FEAT.append(np.concatenate([(L - cx) / h, (R - cx) / h]))
FEAT = np.stack(FEAT)

obs = np.stack([OBSF[i] for i in range(1, 41)])
D = np.abs(FEAT[:, None, :] - obs[None, :, :]).mean(axis=2)
best = (1e9, None, None)
for om in np.arange(1.0, 22.0, 0.05):
    idxs = np.arange(40) * om / COARSE
    for p0 in np.arange(0, len(YAWV)):
        k = np.mod(np.round(p0 + idxs).astype(int), len(YAWV))
        sc = D[k, np.arange(40)].mean()
        if sc < best[0]:
            best = (float(sc), float(om), float(p0 * COARSE))
sc, om, th0 = best
print(f"rotation: omega {om:.2f} deg/frame ({om*4:.1f} deg/s)  theta0 {th0:.1f}  feature dist {sc:.4f}")

yaw_f = {}
for i in range(1, 41):
    base = np.mod(th0 + (i - 1) * om, 360.0)
    cand = np.arange(base - 8, base + 8.01, FINE)
    ks = np.mod(np.round(cand / COARSE).astype(int), len(YAWV))
    dd = np.abs(FEAT[ks] - OBSF[i][None, :]).mean(axis=1)
    yaw_f[i] = float(cand[int(np.argmin(dd))]) if dd.min() < dd.mean() * 0.98 else float(base)

steps = [((yaw_f[i] - yaw_f[i - 1] + 540) % 360 - 180) for i in range(2, 41)]
print(f"steps: {min(steps):+.1f} .. {max(steps):+.1f} deg/frame; "
      f"{sum(1 for s in steps if s>0)}/{len(steps)} positive; total {sum(steps):+.1f} deg")

# ---- calibrations: observed px = a + b * projected px ----------------------
# Bands with no projected vertices report 0, which is a wild outlier: mask them
# before fitting, then refit once with the worst residuals dropped.
U, V, VP, TO = [], [], [], []
skipped = 0
for i in range(1, 41):
    Lp, Rp, tp, bp = view_px(yaw_f[i])
    Lo, Ro, to, bo = obs_px(i)
    for k in range(NB):
        if (Lp[k] > 0 or Rp[k] > 0) and (Lo[k] > 0 or Ro[k] > 0):
            U.append(Lp[k]); V.append(Lo[k]); U.append(Rp[k]); V.append(Ro[k])
        else:
            skipped += 1
    VP += [tp, bp]; TO += [to, bo]
U = np.array(U); V = np.array(V); VP = np.array(VP); TO = np.array(TO)
print(f"  horizontal samples {len(U)} ({skipped} empty bands skipped)")

def robust(x, y, tol):
    b = np.corrcoef(x, y)[0, 1] * y.std() / x.std(); a = y.mean() - b * x.mean()
    for _ in range(3):
        r = y - (a + b * x)
        keep = np.abs(r) < tol
        b = np.corrcoef(x[keep], y[keep])[0, 1] * y[keep].std() / x[keep].std()
        a = y[keep].mean() - b * x[keep].mean()
    return a, b, (y - (a + b * x))

ah, bh, rh = robust(U, V, 12.0)
av, bv, rv = robust(VP, TO, 6.0)
print(f"horizontal cal: col = {ah:+.2f} + {bh:.4f} * u_proj   (residual rms {rh.std():.2f} px)")
print(f"vertical   cal: row = {av:+.2f} + {bv:.4f} * v_proj   (residual rms {rv.std():.2f} px)")

json.dump(dict(fov=FOV, fpx=fpx, d=dist, omega=om, theta0=th0,
               yaws={str(k): round(v, 2) for k, v in yaw_f.items()},
               cal=dict(ah=float(ah), bh=float(bh), av=float(av), bv=float(bv),
                        resid_h=float(rh.std()), resid_v=float(rv.std())),
               obs_h=OBS_H, canvas=[ZW, ZH]),
          open(os.path.join(HERE, "fit4.json"), "w"), indent=1)

# ---- proof with the CALIBRATED projection ---------------------------------
for i in (2, 11, 20, 29):
    m = np.load(os.path.join(HERE, f"mask_{i:03d}.npy"))
    Lo, Ro, to, bo = obs_px(i)
    L, R, tp, bp = view_px(yaw_f[i])
    Uc = ah + bh * np.array([L, R]); Vc = av + bv * np.array([tp, bp])
    img = np.zeros((ZH, ZW, 3), np.uint8); img[...] = 22
    img[m] = [75, 80, 90]
    for k in range(NB):
        yb = int(to + (k + 0.5) * (bo - to + 1) / NB)
        u0 = int(np.clip(Uc[0, k], 0, ZW - 1)); u1 = int(np.clip(Uc[1, k], 0, ZW - 1))
        img[max(yb - 1, 0):yb + 2, u0:u1 + 1] = [90, 230, 120]
    Image.fromarray(img).save(os.path.join(HERE, f"cal_{i:03d}.png"))
print("wrote cal_002/011/020/029.png (green = calibrated profile over measured figure)")
