# Texturing an image-to-3D model from a turntable video

An image-to-3D service gives you geometry. A paid tier gives you textures; the free
one usually will not. But the service's viewer will happily *turn the textured model
on screen* — so a screen-recorded turntable is a usable texture source: project each
frame onto the mesh, from the angle that frame shows, and bake the samples into
per-vertex colours.

This is that pipeline. Measured on a 10 s, 720x1280, 24 fps turntable of a Rodin
"hooded medieval outfit" sculpt (1,000,000 triangles, 1.9 m tall, no textures):

| step | script | result |
|---|---|---|
| frames + figure mask | `measure.py` | 40 frames at 4 fps; Otsu on luminance (backdrop ~207, figure darker) |
| camera + per-frame yaw | `fit4.py` | fov 25, d 4.73 m, **omega 7.90 deg/frame**, 36/39 steps the same sign, total +322 deg |
| back-project + bake | `sample.py` | **99.1% of vertices** sampled, 14.4 frames each; COLOR_0 written to the GLB |

Then `../render-bake.py` renders the result unlit (Emission from the colour
attribute) to judge the bake without the scene's lighting confusing the verdict.

## What decides success

- **A T/A-pose image and a smooth turntable.** The rotation rate must be constant
  enough to fit; a hand-held pan is not a turntable.
- **Fit the yaw by matching the figure's width PROFILE (16 height bands), not its
  area.** Rendering this mesh as a vertex splat leaves the inside of large triangles
  empty (after decimation the vertex density is high along creases, sparse across
  flats), so an area IoU against a splat tops out around 0.55 and cannot tell a
  front view from a back one — the sequence lurches ~180 deg between frames. The
  per-band left/right extent is set by the outermost vertices, which a splat *does*
  capture, and it separates front from back.
- **Solve the whole sequence at once.** The rig is rigid: one rate `omega`, one
  phase. Search those two numbers against the profile distance (the profile table
  depends only on yaw, so 120 projections cover every frame), then refine each frame
  a few degrees. Independent per-frame fitting gives a physically absurd sequence.
- **Calibrate both axes afterwards** (`col = a + b*u_proj`) instead of trusting the
  camera: the fitted fov/d pair is nearly degenerate on scale, and the linear
  calibration absorbs it (measured residual 1.7 px vertical, 13 px horizontal — the
  horizontal one is the splat undershooting the true outline).
- **COLOR_0 is LINEAR.** Convert sRGB -> linear before writing it, or the character
  comes out washed out.
- **Check the material the service shipped.** Rodin's placeholder was
  `baseColorFactor 0.5` with **`metallicFactor 0.8`**: a metallic cloth surface has
  almost no diffuse response, so with no environment map the character renders
  near-black no matter what colour you bake into it. White, `metallicFactor 0`,
  roughness ~0.78.
- **Every bake is graded.** The video is a studio render, so its lighting is baked
  into the samples and the design is muted. `GRADE` at the top of `sample.py`
  (gamma / saturation / exposure) is the knob — ungraded, the character reads as a
  dark blob under a dim forest sun.
- **Bake onto a pristine base, not the previous output.** Injecting COLOR_0 into an
  already-baked file stacks accessors.
