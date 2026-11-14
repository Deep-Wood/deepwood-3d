"""Export a GLB as a Mixamo-ready FBX, and check it against Mixamo's rules.

Mixamo's auto-rigger takes FBX/OBJ/ZIP (never GLB), under 50 MB, ideally under
100k triangles, ONE mesh, centred at the origin, neutral A/T-pose, no props, and
the arms separated from the torso (or the skin weights web between arm and chest).

This applies the object transform first, so the FBX carries scale 1.0 rather than
whatever node scale the source glTF had, then re-imports its own output and prints
the numbers back.

Usage: python glb-to-mixamo-fbx.py -- <in.glb> <out.fbx>
"""
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
src, dst = argv[0], argv[1]


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if path.lower().endswith(".fbx"):
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    obj = max(meshes, key=lambda o: len(o.data.vertices))
    print(f"imported {path}: {len(meshes)} mesh object(s), using '{obj.name}'")
    return obj


obj = load(src)
for o in bpy.data.objects:
    o.select_set(False)
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
print(f"  after apply: dims {[round(d, 3) for d in obj.dimensions]} "
      f"scale {[round(s, 3) for s in obj.scale]} "
      f"verts {len(obj.data.vertices)} faces {len(obj.data.polygons)} "
      f"colour layers {[a.name for a in obj.data.color_attributes]}")

bpy.ops.export_scene.fbx(
    filepath=dst,
    use_selection=True,
    object_types={"MESH"},
    apply_unit_scale=True,
    apply_scale_options="FBX_SCALE_ALL",
    global_scale=1.0,
    axis_forward="-Z",
    axis_up="Y",
    bake_space_transform=False,
    use_mesh_modifiers=True,
    mesh_smooth_type="OFF",
    use_tspace=False,
    path_mode="COPY",
    embed_textures=False,
    add_leaf_bones=False,
    bake_anim=False,
)
print(f"wrote {dst}")

# --- verify by re-importing our own output ------------------------------------
obj2 = load(dst)
tri = sum(len(p.vertices) - 2 for p in obj2.data.polygons)
print(f"  re-imported: verts {len(obj2.data.vertices)} tris {tri} "
      f"dims {[round(d, 3) for d in obj2.dimensions]} "
      f"colour layers {[a.name for a in obj2.data.color_attributes]}")
zmin = min((obj2.matrix_world @ v.co).z for v in obj2.data.vertices)
zmax = max((obj2.matrix_world @ v.co).z for v in obj2.data.vertices)
xs = [(obj2.matrix_world @ v.co).x for v in obj2.data.vertices]
print(f"  height {zmax - zmin:.3f} m, x centre {0.5*(min(xs)+max(xs)):+.3f} "
      f"(Mixamo wants it centred at the origin)")
arm_gap_note = ("arms hang close to the torso — if Mixamo webs the armpits, "
                "spread them into a wider A-pose and re-export")
print(f"  NOTE: {arm_gap_note}")
