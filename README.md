# DeepWood · 3D feasibility prototype

A stand-alone spike that answers one question: **can the web path carry a
lifelike DeepWood** — a real rigged character standing in a real forest — without
moving the client to a game engine?

It is deliberately **not** the game. Nothing here touches
`deepwood-two.vercel.app`; it deploys as its own project.

```bash
npm install
npm run dev            # http://localhost:5174
npm run dev -- --open
# ?lite=1 → pixel ratio 1, 1k shadow map, ~40% of the trees (weak devices,
#           and headless software-raster verification on GPU-less boxes)
```

## What is real here (not primitives)

| piece | source | notes |
|---|---|---|
| Character | `soldier.glb`, three.js sample assets | 68-bone Mixamo rig, 2 skinned meshes, clips **Idle / Walk / Run / TPose**. **Placeholder** — swap for licensed art. |
| Tool | built in code | pickaxe parented to the `mixamorig:RightHand` bone — the same "attach to socket" pattern a real tool model would use. |
| Trees | Poly Haven, **CC0** | five models: `pine_sapling_small`, `quiver_tree_01`, `searsia_lucida`, `tree_stump_01`, `dead_tree_trunk_02`. Decimated — see below. |
| Tree materials | Poly Haven, **CC0** | real PBR sets: baseColor + normal + packed metallicRoughness/AO, resized to 512. |
| Terrain, sky, sun, fog, camp | procedural | the game's `camp3d.js` approach, upgraded with ACES tone mapping, PCF soft shadows and fog. |

## The finding that matters for scoping

Raw Poly Haven trees are **photogrammetry scans, not game assets**:

| model | raw buffer |
|---|---|
| `pine_tree_01` | 904.9 MB |
| `fir_tree_01` | 456.3 MB |
| `jacaranda_tree` | 198.7 MB |
| `island_tree_01` | 57.9 MB |
| `fir_sapling` | 20.7 MB |

A 905 MB mesh is unusable in a browser on a phone, so the prototype ships the
decimation step a real art pipeline would run anyway:

```bash
bash scripts/build-trees.sh          # weld → simplify → resize → prune → dedup
bash scripts/build-trees.sh 0.05     # more aggressive ratio
```

Runs with `@gltf-transform/cli` (a devDependency). It prints raw vs shipped size
and the final triangle count per species, so the cost of each step is visible
rather than asserted.

## What this proves / does not prove

Proves: a browser can hold a skinned character with animation blend trees,
hundreds of instanced real tree meshes with PBR materials, alpha-tested foliage
with vertex-shader wind, soft shadows and ACES tone mapping — in one WebGL2
frame, with no engine and no build step beyond Vite.

Does **not** prove: photoreal. The look still comes from the asset budget, not
the renderer. Skinned-mesh count, cloth/hair, IK-driven foot placement,
large-world streaming and netcode are all untested here.

## Verification hooks

`window.__proto3d` carries `ready`, `errors`, `clips`, `trees`, `species`,
`hasTool`, `lite`, and `setClip(name)` so a harness can assert the frame renders
and the skeleton actually animates.

## Licences

- Poly Haven models and textures: **CC0** (polyhaven.com) — no attribution
  required, credited here anyway.
- `soldier.glb` from the three.js examples: sample asset, **prototype use
  only** — replace before anything ships.
