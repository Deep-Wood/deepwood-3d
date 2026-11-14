"""Verify the exported animated GLB: reload it, apply its Walk action, render the
stride. Deliberately renders the FILE rather than the in-memory scene, so an export
that dropped the animation or renamed the clips shows up here.
"""
import math

import bpy
from PIL import Image

SRC = "work/rodin/rodin-animated.glb"
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
print("objects:", [(o.name, o.type) for o in bpy.data.objects])
print("actions:", [a.name for a in bpy.data.actions])

mesh = max([o for o in bpy.data.objects if o.type == "MESH"], key=lambda o: len(o.data.vertices))
arm = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
zs = [(mesh.matrix_world @ v.co).z for v in mesh.data.vertices]
cz, h = 0.5 * (min(zs) + max(zs)), max(zs) - min(zs)
print(f"mesh {len(mesh.data.vertices)} verts, height {h:.3f}, bones {len(arm.data.bones)}")

act = None
for a in bpy.data.actions:
    if "walk" in a.name.lower():
        act = a
print("using:", act.name if act else "NONE")
arm.animation_data_create()
arm.animation_data.action = act

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x, scene.render.resolution_y = 300, 540
cd = bpy.data.cameras.new("c")
cd.type = "ORTHO"
cd.ortho_scale = h * 1.45
cam = bpy.data.objects.new("c", cd)
bpy.context.collection.objects.link(cam)
scene.camera = cam
cam.location = (8.0, 0.0, cz)                     # side profile of the stride
cam.rotation_euler = (math.radians(90), 0, math.radians(90))

paths = []
for f in (0, 6, 12, 18):
    scene.frame_set(f)
    bpy.context.view_layer.update()
    scene.render.filepath = f"work/rodin/walk_{f:02d}.png"
    bpy.ops.render.render(write_still=True)
    paths.append(scene.render.filepath)

ims = [Image.open(p) for p in paths]
sheet = Image.new("RGB", (sum(i.width for i in ims), ims[0].height))
x = 0
for i in ims:
    sheet.paste(i, (x, 0))
    x += i.width
sheet.save("work/rodin/walk_sheet.png")
print("wrote work/rodin/walk_sheet.png")
