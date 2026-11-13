#!/usr/bin/env python3
"""FBX -> GLB, headless, via Blender as a Python module (bpy).

Why this exists: Mixamo hands you FBX. FBX is several times the size of GLB,
carries centimetre/T-pose/axis quirks, and would need a ~200 KB loader shipped to
the browser. Converted once, the result drops into the existing GLTFLoader
unchanged — the same import/export path an artist would use by hand.

    /data/workspace/tools/venv/bin/python scripts/fbx-to-glb.py in.fbx out.glb

Things that cost time to rediscover:
  - bpy cannot be installed into the system Python (PEP 668 / externally managed);
    it needs a venv. The one used here is /data/workspace/tools/venv.
  - Start from an EMPTY scene. Blender's default cube, light and camera are
    otherwise exported straight into your GLB.
  - Check the height after converting (the report below prints the bounding box):
    Mixamo exports are commonly centimetre-scaled, and a character that stands
    182 m tall is easier to fix here than to chase in the browser.
  - Exporter argument names drift between Blender versions, so the call below is
    filtered against the actual operator's RNA instead of hard-coded.
"""
import argparse
import os
import sys

import bpy


def rna_kwargs(op, wanted):
    """Keep only the keyword arguments this Blender's exporter actually has."""
    props = {p.identifier for p in op.get_rna_type().properties}
    return {k: v for k, v in wanted.items() if k in props}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fbx")
    ap.add_argument("glb")
    args = ap.parse_args()

    if not os.path.exists(args.fbx):
        sys.exit(f"  ! no such file: {args.fbx}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(args.fbx))

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    actions = list(bpy.data.actions)
    print(f"  imported: {len(meshes)} mesh(es), {len(armatures)} armature(s), {len(actions)} action(s)")
    if not meshes:
        sys.exit("  ! nothing imported — wrong file, or the import failed silently")

    total_faces = 0
    for o in meshes:
        total_faces += len(o.data.polygons)
        print(f"    mesh '{o.name}': {len(o.data.polygons):,} faces, "
              f"{len(o.data.vertices):,} verts, "
              f"{len(o.vertex_groups)} vertex groups, "
              f"{len(o.data.materials)} material(s), "
              f"shape keys={bool(o.data.shape_keys)}")
    for arm in armatures:
        print(f"    armature '{arm.name}': {len(arm.data.bones)} bones")
    for act in actions:
        frames = act.frame_range
        print(f"    action '{act.name}': frames {frames[0]:.0f}-{frames[1]:.0f}")

    # Bounding box across every mesh, in metres as Blender sees them.
    mins = [1e9, 1e9, 1e9]
    maxs = [-1e9, -1e9, -1e9]
    for o in meshes:
        for corner in o.bound_box:
            world = o.matrix_world @ __import__("mathutils").Vector(corner)
            for i in range(3):
                mins[i] = min(mins[i], world[i])
                maxs[i] = max(maxs[i], world[i])
    size = [maxs[i] - mins[i] for i in range(3)]
    print(f"  world size: {size[0]:.2f} x {size[1]:.2f} x {size[2]:.2f} m "
          f"(height is the largest of these for an upright character)")

    wanted = dict(
        export_format="GLB",
        use_selection=False,
        export_animations=True,
        export_skins=True,
        export_apply=False,
        export_yup=True,
        export_image_format="AUTO",
    )
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(args.glb),
        **rna_kwargs(bpy.ops.export_scene.gltf, wanted),
    )
    print(f"  wrote {args.glb} ({os.path.getsize(args.glb) / 1048576:.2f} MB)")


if __name__ == "__main__":
    main()
