"""Bake the soldier's clips onto the delver's rig, retargeted by WORLD orientation.

Why not copy local rotations: the clips were authored for the soldier's T-pose rest.
The delver rests with his arms 76 deg lower, and skinning is relative to the bind, so
the same local rotations put his arms ~76 deg through his own body.

Why world orientation is correct: setting each joint's world rotation to the source's
world rotation makes the limb point where the source's limb points. The deformation is
then measured from the delver's own bind pose, so the arm swings the right way from
where it actually hangs. The rigs' non-arm bones share a rest pose, so this is exact
for them and a pure swing (no twist error) for the arms.

Bone positions are NOT copied (the proportions differ a little); only rotations, so
the limb lengths stay the delver's. The hips' bob is skipped, so the walk rides at a
constant height — the prototype's movement code supplies the travel.

All maths is done in the destination armature's local space, and each bone's pose
rotation is derived analytically from the parent's already-known target rotation, so
no per-bone depsgraph updates are needed.
"""
import bpy
from mathutils import Matrix, Quaternion, Vector

SOL = "public/assets/char/soldier.glb"
# Overridable so the same baker serves any Mixamo-rigged character:
#   python scripts/rig/retarget.py --rig public/assets/char/man-textured.glb \
#                                  --out public/assets/char/man-animated.glb
import argparse
_ap = argparse.ArgumentParser()
_ap.add_argument("--rig", default="work/rodin/rodin-rigged.glb")
_ap.add_argument("--out", default="work/rodin/rodin-animated.glb")
_ap.add_argument("--mode", choices=["world", "local"], default="world",
                 help="world = copy each joint's world rotation (needed when the two "
                      "rest poses differ, e.g. our own sculpt rig); local = copy local "
                      "rotations (correct when both files are stock Mixamo rigs)")
_args = _ap.parse_args()
MODE = _args.mode
RIG = _args.rig
OUT = _args.out

# ------------------------------------------------------------- source: clips
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SOL)
src = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
src_actions = list(bpy.data.actions)
print("source actions:", [(a.name, tuple(round(v) for v in a.frame_range)) for a in src_actions])
SRC_MW = src.matrix_world.copy()
src.animation_data_create()

# ------------------------------------------------------- destination: the rig
bpy.ops.import_scene.gltf(filepath=RIG)
dst = [o for o in bpy.data.objects if o.type == "ARMATURE" and o is not src][0]
_meshes = [o for o in bpy.data.objects if o.type == "MESH"]
mesh = next((o for o in _meshes if o.parent is dst), None) or _meshes[0]
MY_MW = dst.matrix_world.copy()
TO_LOCAL = MY_MW.inverted()
print(f"destination: {dst.name}, {len(dst.data.bones)} bones, mesh {mesh.name} "
      f"({len(mesh.data.vertices)} verts)")

# hierarchy order, parents first
order = []
def walk(b):
    order.append(b.name)
    for c in b.children:
        walk(c)
for b in dst.data.bones:
    if b.parent is None:
        walk(b)
pairs = [n for n in order if n in src.pose.bones and n in dst.pose.bones]
print(f"joints to drive: {len(pairs)}")

REST_LOCAL = {}
for n in pairs:
    b = dst.data.bones[n]
    REST_LOCAL[n] = ((b.parent.matrix_local.inverted() @ b.matrix_local)
                     if b.parent else b.matrix_local).to_quaternion()
PARENT = {n: (dst.data.bones[n].parent.name if dst.data.bones[n].parent else None)
          for n in pairs}

def action_fcurves(action):
    """F-curves across API generations: Blender 4.4+/5 replaced a flat Action.fcurves
    with layered actions (layer -> strip -> channelbag -> fcurves)."""
    try:
        return list(action.fcurves)
    except AttributeError:
        out = []
        for layer in getattr(action, "layers", []):
            for strip in getattr(layer, "strips", []):
                for bag in getattr(strip, "channelbags", []) or []:
                    out.extend(bag.fcurves)
        return out


bpy.context.view_layer.objects.active = dst
bpy.ops.object.mode_set(mode="POSE")
for n in pairs:
    dst.pose.bones[n].rotation_mode = "QUATERNION"
dst.animation_data_create()

SKIP = {"tpose"}                       # the rest-pose export, not a gameplay clip
for act in [a for a in src_actions if a.name.lower() not in SKIP]:
    src.animation_data.action = act
    f0, f1 = (int(v) for v in act.frame_range)
    # Prefixed name: the source action of the same name still exists, so a plain name
    # collides and Blender hands us "Idle.001" — leaving the ORIGINAL, un-retargeted
    # clip under the name the loader matches on. Renamed back after the sources go.
    new = bpy.data.actions.new(f"baked_{act.name}")
    new.use_fake_user = True
    dst.animation_data.action = new
    for f in range(f0, f1 + 1):
        bpy.context.scene.frame_set(f)
        bpy.context.view_layer.update()
        world_rot = {}                      # achieved rotation per bone, my local space
        for n in pairs:
            q_target = (TO_LOCAL @ SRC_MW @ src.pose.bones[n].matrix).to_quaternion()
            p = PARENT[n]
            q_parent = world_rot.get(p, (TO_LOCAL @ MY_MW).to_quaternion())
            if MODE == "local":
                # Both files are stock Mixamo rigs in a T-pose, so their LOCAL
                # rest rotations already agree and the clip can be copied as-is.
                dst.pose.bones[n].rotation_quaternion = src.pose.bones[n].rotation_quaternion
            else:
                dst.pose.bones[n].rotation_quaternion = (q_parent @ REST_LOCAL[n]).inverted() @ q_target
            world_rot[n] = q_target
        for n in pairs:
            dst.pose.bones[n].keyframe_insert("rotation_quaternion", frame=f)
    fcs = action_fcurves(new)
    for fc in fcs:
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    print(f"  baked '{act.name}': frames {f0}..{f1} -> {len(fcs)} curves"
          + ("" if fcs else "  WARNING: no fcurves found (API path mismatch)"))
bpy.ops.object.mode_set(mode="OBJECT")

# ------------------------------------------------------------------ export
# Drop the SOURCE armature and its actions before exporting: the exporter writes every
# action in the file, and leaving the originals in ships both the retargeted clip and
# the original under a colliding name.
bpy.context.view_layer.objects.active = dst
src.animation_data_clear()
bpy.data.objects.remove(src, do_unlink=True)
for a in [a for a in bpy.data.actions if not a.name.startswith("baked_")]:
    try:
        bpy.data.actions.remove(a)
    except Exception as exc:
        print("  could not remove source action", a.name, exc)
for a in [a for a in bpy.data.actions if a.name.startswith("baked_")]:
    a.name = a.name[len("baked_"):]
print("actions to export:", sorted(a.name for a in bpy.data.actions))

bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True)
dst.select_set(True)
bpy.context.view_layer.objects.active = dst
bpy.ops.export_scene.gltf(filepath=OUT, use_selection=True, export_apply=False,
                          export_skins=True, export_animations=True,
                          export_animation_mode="ACTIONS", export_nla_strips=False,
                          export_frame_range=False)
print("wrote", OUT)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=OUT)
print("re-import actions:", [a.name for a in bpy.data.actions])
a2 = [o for o in bpy.data.objects if o.type == "ARMATURE"]
m2 = [o for o in bpy.data.objects if o.type == "MESH"]
if a2 and m2:
    print(f"  bones {len(a2[0].data.bones)}, verts {len(m2[0].data.vertices)}, "
          f"colours {[c.name for c in m2[0].data.color_attributes]}")
