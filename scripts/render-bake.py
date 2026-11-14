"""Render a GLB's baked vertex colours UNLIT, three views, so the bake can be
judged without the scene's lighting confusing the verdict.

Judging a character from an unlit/backlit bearing misdiagnoses the outfit, so this
renders COLOR_0 straight through an Emission shader (no lights, no shading): what
you see is the albedo itself.

Usage: blender --background --python render-bake.py -- <in.glb> <out-prefix>
   or: python render-bake.py <in.glb> <out-prefix>     (with bpy installed)
"""
import sys, os, math

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
src, prefix = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
obj = max(meshes, key=lambda o: len(o.data.vertices))
print(f"mesh: {obj.name}  verts {len(obj.data.vertices)}  "
      f"color attrs {[a.name for a in obj.data.color_attributes]}")

mat = bpy.data.materials.new("bakeview")
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
vcol = nt.nodes.new("ShaderNodeVertexColor")
if obj.data.color_attributes:
    vcol.layer_name = obj.data.color_attributes[0].name
em = nt.nodes.new("ShaderNodeEmission")
out = nt.nodes.new("ShaderNodeOutputMaterial")
nt.links.new(vcol.outputs["Color"], em.inputs["Color"])
nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
obj.data.materials.clear()
obj.data.materials.append(mat)

# frame the figure: Blender is Z-up after the glTF import
zmin = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
zmax = max((obj.matrix_world @ v.co).z for v in obj.data.vertices)
h = zmax - zmin
cz = 0.5 * (zmin + zmax)
print(f"figure height {h:.3f} m, centre z {cz:.3f}")

cam_data = bpy.data.cameras.new("cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = h * 1.12
cam = bpy.data.objects.new("cam", cam_data)
bpy.context.collection.objects.link(cam)
bpy.context.scene.camera = cam

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 24
scene.cycles.use_denoising = False
scene.render.resolution_x = 420
scene.render.resolution_y = 760
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new("w")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.05, 0.06, 1)

paths = []
for yaw in (0, 90, 180, 270):
    a = math.radians(yaw)
    d = h * 2.2
    cam.location = (math.sin(a) * d, -math.cos(a) * d, cz)
    cam.rotation_euler = (math.radians(90), 0, a)
    p = f"{prefix}_{yaw:03d}.png"
    scene.render.filepath = p
    bpy.ops.render.render(write_still=True)
    paths.append(p)
    print(f"rendered {p}")

# contact sheet
try:
    from PIL import Image
    ims = [Image.open(p) for p in paths]
    w = sum(i.width for i in ims)
    sheet = Image.new("RGB", (w, ims[0].height))
    x = 0
    for i in ims:
        sheet.paste(i, (x, 0)); x += i.width
    sheet.save(f"{prefix}_sheet.png")
    print(f"wrote {prefix}_sheet.png")
except Exception as e:
    print("sheet skipped:", e)
