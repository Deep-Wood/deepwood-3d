"""Rig the delver: reuse the soldier's mixamorig skeleton, fitted to this mesh.

Reuse rather than re-author: the project already drives characters with the
soldier's clips by bone name, and a fresh rig would change the bone axes those
clips assume. The armature is scaled to the delver's height, moved so its bones sit
inside this mesh, and the delver is bound to it with automatic weights.

Three things this script had to learn the hard way (all measured, all printed):

  1. SIZE THE SKELETON FROM THE MESH, NOT THE BONES. glTF has no bone tails, so an
     importer invents them — this file's Hips tail is 1000 units long and its leg
     tails 4200, which made a "bone span" of 4.85 m for a 1.83 m character and
     scaled the rig to 0.39x. Only bone HEADS are meaningful.
  2. REPAIR THE TAILS BEFORE WEIGHTING. Bone-heat weighting solves against the bone
     SEGMENTS, and degenerate segments make it give up ("failed to find solution for
     one or more bones", 100% of vertices unweighted). Tails are a Blender-only
     concept — they affect weighting, never the exported GLB — so they are rebuilt
     from the child's head.
  3. SET THE REST POSE, NOT THE POSE. Weights and inverse-bind matrices come from the
     REST pose. The delver's arms hang ~76 deg down while the skeleton's rest is a
     T-pose, so rotating the arms in Pose Mode changes nothing about the bind; the
     arm bones must be rotated in EDIT mode so the rest matches the mesh. That
     mismatch is also why the clips now get retargeted by world orientation at
     playback instead of copied as local rotations.
"""
import math
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

SOL = "public/assets/char/soldier.glb"
# Overridable so any mesh can be put on the project's existing rig:
#   python scripts/rig/rig-delver.py --del public/assets/char/thug.glb \
#                                    --out public/assets/char/thug-rigged.glb --arm-down 0
import argparse
_ap = argparse.ArgumentParser()
_ap.add_argument("--del", dest="del_file", default="public/assets/char/rodin-hooded.glb")
_ap.add_argument("--out", default="work/rodin/rodin-rigged.glb")
_ap.add_argument("--normalise-rig", choices=["0", "1"], default="0",
                 help="bake the armature's tiny node scale into the bones so the GLB's "
                      "armature node is 1.0 — a 0.01 node scale interacting with the "
                      "inverse bind matrices makes three.js fling the mesh away")
_ap.add_argument("--mesh-yaw", type=float, default=0.0,
                 help="rotate the MESH about Blender's Z before fitting, to align its "
                      "arm axis with the skeleton's. Some downloads ship with the arms "
                      "along the depth axis; a mismatch makes the skin explode")
_ap.add_argument("--arm-down", type=float, default=76.0,
                 help="degrees to drop the arm chain from the skeleton's T-pose rest; "
                      "0 when the mesh is ALREADY a T-pose (a stock character download)")
_args = _ap.parse_args()
DEL = _args.del_file
OUT = _args.out
ARM_DOWN_DEG = _args.arm_down
MESH_YAW = _args.mesh_yaw
NORMALISE_RIG = _args.normalise_rig == '1'


def world_bbox(obj):
    M = obj.matrix_world
    co = [M @ v.co for v in obj.data.vertices]
    return (Vector((min(c.x for c in co), min(c.y for c in co), min(c.z for c in co))),
            Vector((max(c.x for c in co), max(c.y for c in co), max(c.z for c in co))))


def bh(arm, name):
    """World position of a bone's HEAD (the only trustworthy end of a bone here)."""
    return arm.matrix_world @ arm.data.bones[name].head_local


# ------------------------------------------------------------------ soldier
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SOL)
arm = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
sold = [o for o in bpy.data.objects if o.type == "MESH" and o.parent is arm]
lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
for o in sold:
    a, b = world_bbox(o)
    lo = Vector((min(lo[i], a[i]) for i in range(3)))
    hi = Vector((max(hi[i], b[i]) for i in range(3)))
sold_h = hi.z - lo.z
print(f"soldier mesh height {sold_h:.4f} (feet z {lo.z:.4f})")
for o in list(bpy.data.objects):
    if o is not arm:
        bpy.data.objects.remove(o, do_unlink=True)

# --------------------------------------------------- repair the invented tails
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
eb = arm.data.edit_bones
fixed = 0
for b in eb:
    kids = [c for c in b.children]
    if kids:
        want = b.head + (kids[0].head - b.head) * 0.75
    else:
        parent_dir = (b.head - b.parent.head) if b.parent else Vector((0, 0, 1))
        want = b.head + parent_dir.normalized() * 0.4
    if (b.tail - want).length > 1e-6:
        b.tail = want
        fixed += 1
print(f"rebuilt {fixed}/{len(eb)} bone tails from their children")
bpy.ops.object.mode_set(mode="OBJECT")
h_hips_z = bh(arm, "mixamorig:Hips").z
h_toe_z = bh(arm, "mixamorig:LeftToeBase").z
print(f"skeleton: hips head z {h_hips_z:.3f}, toe head z {h_toe_z:.3f} "
      f"(span {h_hips_z - h_toe_z:.3f} = {(h_hips_z - h_toe_z)/sold_h*100:.1f}% of height)")

# ------------------------------------------------------------------- delver
bpy.ops.import_scene.gltf(filepath=DEL)
delv = max([o for o in bpy.data.objects if o.type == "MESH"], key=lambda o: len(o.data.vertices))
for o in bpy.data.objects:
    o.select_set(o is delv)
bpy.context.view_layer.objects.active = delv
if MESH_YAW:
    # The skeleton's arms run along +/-X. If the downloaded mesh has its arms along the
    # depth axis instead, every arm bone pulls the mesh sideways and the skin tears
    # apart (measured: a 40 m skinned bounding box on a 1.77 m character).
    delv.rotation_mode = 'XYZ'   # glTF imports can leave this on QUATERNION, where
                                 # writing rotation_euler silently does nothing
    delv.rotation_euler.z += math.radians(MESH_YAW)
    bpy.context.view_layer.update()
    print(f"  mesh yaw {MESH_YAW} deg about Z")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# Weld coincident vertices FIRST. This sculpt is a seam-split mesh (140k verts for
# ~48k unique positions). Weights computed on a fragmented mesh differ across the
# seams, so the surface tears when posed, and bone-heat refuses to solve on it at
# all. Merging by distance makes it one continuous surface to weight.
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=0.0002)
bpy.ops.object.mode_set(mode="OBJECT")
print(f"after weld: {len(delv.data.vertices)} verts, {len(delv.data.polygons)} faces, "
      f"colours {[a.name for a in delv.data.color_attributes]}")
dlo, dhi = world_bbox(delv)
d_h = dhi.z - dlo.z
print(f"delver z {dlo.z:.4f}..{dhi.z:.4f} (h {d_h:.4f}) x {dlo.x:.3f}..{dhi.x:.3f} "
      f"y {dlo.y:.3f}..{dhi.y:.3f} verts {len(delv.data.vertices)}")

ankle = dlo.z + 0.09 * d_h
band = [c for c in (close for close in [delv.matrix_world @ v.co for v in delv.data.vertices])
        if ankle <= c.z <= ankle + 0.05]
forward = -1.0 if abs(min(c.y for c in band)) > abs(max(c.y for c in band)) else 1.0
print(f"toes point {'-Y' if forward < 0 else '+Y'} (ankle band y "
      f"{min(c.y for c in band):.3f}..{max(c.y for c in band):.3f})")

# ------------------------------------------------------------ fit to the mesh
scale = d_h / sold_h
arm.scale = Vector(arm.scale) * scale
arm.location.z += dlo.z - bh(arm, "mixamorig:LeftToeBase").z
arm.location.x += 0.5 * (dlo.x + dhi.x) - 0.5 * (bh(arm, "mixamorig:LeftUpLeg").x +
                                                 bh(arm, "mixamorig:RightUpLeg").x)
arm.location.y += 0.5 * (dlo.y + dhi.y) - 0.5 * (bh(arm, "mixamorig:LeftFoot").y +
                                                 bh(arm, "mixamorig:RightFoot").y)
bpy.context.view_layer.update()
hips = bh(arm, "mixamorig:Hips")
head = bh(arm, "mixamorig:Head")
armx = bh(arm, "mixamorig:LeftArm").x
print(f"scale {scale:.5f}: hips z {hips.z:.3f} ({(hips.z - dlo.z)/d_h*100:.1f}% up, want ~51), "
      f"head z {head.z:.3f} ({(head.z - dlo.z)/d_h*100:.1f}% up, want ~86), "
      f"arm joint x {armx:+.3f} (want ~+0.21)")

# ------------------------ put the ARMS IN THE REST POSE (edit mode) where they are
# The delver import above made THAT object active, so mode_set('EDIT') would enter
# mesh edit mode and armature edit_bones would not exist. Re-activate the armature.
for o in bpy.data.objects:
    o.select_set(o is arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
eb = arm.data.edit_bones
print(f"  edit bones: {len(eb)} (e.g. {[b.name for b in eb][:3]})")
# Rotate each arm as a CHAIN about the shoulder joint. Edit-mode bones are not
# connected, so rotating every bone about its own head leaves the forearm out where
# it was (measured: forearm head stayed at x -0.456 while the upper arm came in to
# -0.216). One pivot, the whole chain, rigidly.
FINGERS = ("Thumb1", "Thumb2", "Thumb3", "Index1", "Index2", "Index3", "Middle1",
           "Middle2", "Middle3", "Ring1", "Ring2", "Ring3", "Pinky1", "Pinky2")
for side, sgn in (("Left", 1.0), ("Right", -1.0)):
    piv = eb[f"mixamorig:{side}Arm"].head.copy()
    # Edit bones live in the ARMATURE's local space, which here is Y-up-ish inside a
    # Z-up world, so a world axis has to be converted or the arm swings forward
    # instead of down (measured: forearm head went to y +0.441 with z unmoved 0.570).
    axis_local = (arm.matrix_world.to_3x3().inverted() @ Vector((0.0, forward, 0.0))).normalized()
    # sign: measured, the arm went UP (forearm head z 0.570 -> 1.045) before this flip
    q = Quaternion(axis_local, math.radians(-ARM_DOWN_DEG) * sgn)
    chain = ([f"mixamorig:{side}Arm", f"mixamorig:{side}ForeArm", f"mixamorig:{side}Hand"]
             + [f"mixamorig:{side}Hand{f}" for f in FINGERS])
    moved = 0
    for n in chain:
        if n not in eb:
            continue
        b = eb[n]
        for end in ("head", "tail"):
            v = getattr(b, end) - piv
            v.rotate(q)
            setattr(b, end, piv + v)
        moved += 1
    print(f"  arm chain {side}: {moved} bones rotated about {[round(v,3) for v in piv]}")
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.update()
for n in ("mixamorig:LeftShoulder", "mixamorig:LeftArm", "mixamorig:LeftForeArm",
          "mixamorig:LeftHand"):
    print(f"  rest {n:26s} head {[round(v,3) for v in bh(arm, n)]}")

# --------------------------------------------------------------------- bind
bpy.ops.object.select_all(action="DESELECT")
delv.select_set(True)
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def unweighted(o):
    return sum(1 for v in o.data.vertices if sum(g.weight for g in v.groups) <= 1e-6)


u1 = unweighted(delv)
print(f"bone-heat weights: {len(delv.vertex_groups)} groups, unweighted {u1}/"
      f"{len(delv.data.vertices)} ({100*u1/len(delv.data.vertices):.1f}%)")
if u1 > 0.05 * len(delv.data.vertices):
    # Envelope weighting is not a fallback here: the glTF importer leaves every
    # bone's envelope radius at zero, so it also returns 100% unweighted (measured).
    # So compute weights directly: inverse distance to the nearest bone SEGMENTS,
    # then diffuse them over the mesh graph so there are no hard seams.
    print("  too many unweighted -> computing distance-based weights instead")
    import numpy as np
    from scipy.sparse import coo_matrix

    for g in list(delv.vertex_groups):
        delv.vertex_groups.remove(g)
    for m in list(delv.modifiers):
        if m.type == "ARMATURE":
            delv.modifiers.remove(m)
    delv.parent = None
    bpy.ops.object.select_all(action="DESELECT")
    delv.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_NAME")     # modifier + empty groups

    names = [b.name for b in arm.data.bones]
    segs = [(np.array(arm.matrix_world @ arm.data.bones[n].head_local),
             np.array(arm.matrix_world @ arm.data.bones[n].tail_local)) for n in names]
    V = np.array([delv.matrix_world @ v.co for v in delv.data.vertices])
    N, B = len(V), len(segs)
    D = np.empty((N, B))
    for i, (h, t) in enumerate(segs):
        d = t - h
        L2 = float(d @ d)
        if L2 < 1e-12:
            D[:, i] = np.linalg.norm(V - h, axis=1)
        else:
            u = np.clip((V - h) @ d / L2, 0.0, 1.0)
            D[:, i] = np.linalg.norm(V - (h + u[:, None] * d), axis=1)
    K = 3
    idx = np.argsort(D, axis=1)[:, :K]
    dd = np.take_along_axis(D, idx, axis=1)
    w = 1.0 / np.maximum(dd, 1e-4) ** 6.0
    w /= w.sum(axis=1, keepdims=True)
    W = np.zeros((N, B))
    np.put_along_axis(W, idx, w, axis=1)
    edges = np.array([e.vertices for e in delv.data.edges])
    rows = np.concatenate([edges[:, 0], edges[:, 1]])
    cols = np.concatenate([edges[:, 1], edges[:, 0]])
    A = coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(N, N))
    deg = np.maximum(np.asarray(A.sum(axis=1)).ravel(), 1)
    for _ in range(8):
        W = 0.5 * W + 0.5 * (A @ W) / deg[:, None]
    W /= np.maximum(W.sum(axis=1, keepdims=True), 1e-9)
    for vi in range(N):
        row = W[vi]
        keep = np.nonzero(row > 0.01)[0]
        if len(keep) == 0:
            keep = np.array([int(np.argmax(row))])
        keep = keep[np.argsort(-row[keep])][:4]
        s = float(row[keep].sum())
        for bi in keep:
            delv.vertex_groups[names[bi]].add([vi], float(row[bi] / s), "REPLACE")
    u1 = unweighted(delv)
    print(f"  distance weights: {N} verts over {B} bones, unweighted {u1} "
          f"({100*u1/N:.2f}%)")

bpy.context.view_layer.objects.active = delv
bpy.ops.object.select_all(action="DESELECT")
delv.select_set(True)
bpy.ops.object.vertex_group_limit_total(limit=4)
bpy.ops.object.vertex_group_normalize_all(lock_active=False)
print(f"after limit(4)+normalize: unweighted {unweighted(delv)}")

# -------------------------------------- deformation test: lift one arm, render it
scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x, scene.render.resolution_y = 480, 720
cam_data = bpy.data.cameras.new("c")
cam_data.type = "ORTHO"
cam_data.ortho_scale = d_h * 1.25
cam = bpy.data.objects.new("c", cam_data)
bpy.context.collection.objects.link(cam)
scene.camera = cam
cz = 0.5 * (dlo.z + dhi.z)
for yaw, tag in ((0, "front"), (90, "side")):
    a = math.radians(yaw)
    cam.location = (math.sin(a) * 6, -math.cos(a) * 6 * forward, cz)
    cam.rotation_euler = (math.radians(90), 0, a)
    scene.render.filepath = f"work/rodin/bind_{tag}.png"
    bpy.ops.render.render(write_still=True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
# Rotate about a WORLD axis through the bone's own head by assigning pose_bone.matrix:
# a rotation in the bone's local space just twists the limb (the first attempt
# produced two byte-identical renders because nothing visibly moved).
axis_world = Vector((0.0, forward, 0.0))
for bname, deg in (("mixamorig:LeftArm", -75.0), ("mixamorig:RightUpLeg", 40.0)):
    pb = arm.pose.bones[bname]
    M = pb.matrix.copy()
    R = Matrix.Rotation(math.radians(deg), 4, axis_world)
    pb.matrix = Matrix.Translation(M.translation) @ R @ Matrix.Translation(-M.translation) @ M
    bpy.context.view_layer.update()
    print(f"  posed {bname} by {deg} deg about the world forward axis")
cam.location = (math.sin(0) * 6, -math.cos(0) * 6 * forward, cz)
cam.rotation_euler = (math.radians(90), 0, 0)
scene.render.filepath = "work/rodin/bind_posed.png"
bpy.ops.render.render(write_still=True)
bpy.ops.object.mode_set(mode="OBJECT")
print("wrote bind_front/side/posed.png")

# -------------------------------------------------------------------- export
if NORMALISE_RIG:
    # Blender's exporter writes the inverse bind matrices against the bone rest in the
    # armature's LOCAL space, while three.js multiplies by the bone's WORLD matrix —
    # which carries this node's 0.0097 scale. Applying the scale removes the mismatch.
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    print(f"  armature scale applied -> {[round(v,4) for v in arm.scale]}")

bpy.ops.object.select_all(action="DESELECT")
delv.select_set(True)
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.export_scene.gltf(filepath=OUT, use_selection=True, export_apply=False,
                          export_skins=True, export_animations=False)
print("wrote", OUT)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=OUT)
a2 = [o for o in bpy.data.objects if o.type == "ARMATURE"]
m2 = [o for o in bpy.data.objects if o.type == "MESH"]
print(f"re-import: {len(m2)} mesh(es), {len(a2)} armature(s)")
if a2 and m2:
    print(f"  bones {len(a2[0].data.bones)}, vgroups {len(m2[0].vertex_groups)}, "
          f"modifiers {[m.type for m in m2[0].modifiers]}, "
          f"colours {[a.name for a in m2[0].data.color_attributes]}, "
          f"verts {len(m2[0].data.vertices)}")
