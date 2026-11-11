# DeepWood · 3D feasibility prototype

A stand-alone spike that answers one question: **can the web path carry a
lifelike DeepWood** — a real rigged character standing in a real forest — without
moving the client to a game engine?

It is deliberately **not** the game. Nothing here touches
`deepwood-two.vercel.app`; it deploys as its own project.

**Live:** https://deepwood-3d.vercel.app/ · **Repo:**
https://github.com/Deep-Wood/deepwood-3d (public)

Pushes to `main` auto-deploy (~30 s). The Vercel project was imported through
the dashboard and lives in the account's personal scope, so the EdgeTeam-scoped
Vercel connector can't read its builds — verify deploys by checking that the
hashed bundle in the served HTML matches `npm run build` output locally.

```bash
npm install
npm run dev            # http://localhost:5174
npm run dev -- --open
```

Detail ladder via `?lite=N`:

| level | pixel ratio | shadow map | trees | terrain | use |
|---|---|---|---|---|---|
| (none) | up to 2 | 2048 | 100% (~410) | 240² | real GPUs — the one to judge the look on |
| `1` | 1 | 1024 | ~42% | 140² | weak laptops and phones |
| `2` | 0.75 | 512 | ~16% | 90² | light devices, screenshots |
| `3` | 0.5 | off | ~5% | 48² | automated runs on GPU-less boxes only |

Level 3 exists because a software rasteriser can spend seconds on one
full-quality frame, which starves the JS thread and makes a test harness time
out before it can assert anything.

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
bash scripts/build-trees.sh                      # near set: weld → simplify → resize → prune → dedup
bash scripts/build-trees.sh 0.006 0.05 _far 128  # far LOD: <slug>_far.glb, 128 px maps
```

Two tiers, because a forest that is dense only at the horizon is not a forest.
The near set (inside 42 m) is the full-detail decimation; the far set (out to the
fog) is ~1/7 the triangles with 128 px maps and casts no shadows. Measured at
full density: near **440 trees / 6.20 M triangles**, far **965 trees / 1.94 M** —
so the whole far tier costs less than the 170 near pines, and at 40+ m nobody can
tell. Scatter radii stop at the far side of the fog so no triangles are spent
where fog paints over them.

Runs with `@gltf-transform/cli` (a devDependency). It prints raw vs shipped size
and the final triangle count per species, so the cost of each step is visible
rather than asserted. What actually ships (ratio 0.04 / error 0.01):

| model | raw buffer | near set | triangles | far LOD | far triangles |
|---|---|---|---|---|---|
| `pine_sapling_small` | 16.9 MB | 1,453,768 B | 15,832 | 215,500 B | 2,318 |
| `searsia_lucida` | 17.1 MB | 1,590,928 B | 23,231 | 187,560 B | 2,231 |
| `quiver_tree_01` | 4.2 MB | 550,544 B | 5,995 | 105,864 B | 1,484 |
| `dead_tree_trunk_02` | 1.9 MB | 348,740 B | 3,324 | 47,572 B | 670 |
| `tree_stump_01` | 0.9 MB | 334,796 B | 1,641 | 33,444 B | 290 |
| `soldier.glb` (character) | — | 2,160,468 B | — | — | — |

**6.7 MB total** with the character and both tree tiers — that is the number the
page reports as "asset payload", and the whole network cost of the scene.

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
`shrubs`, `hasTool`, `lite`, `frames` (proves the rAF loop is running — a
background tab pauses it), `texBytes`/`assetBytes`, `gait`, `setClip(name)`,
`orbitTo(yawDeg, dist, height)` to park the camera at a known bearing, and
`facing()` for the world direction of the model's local +Z.

Proven this way, not eyeballed: a hand bone moves during Idle; `W` switches to
the Walk clip and translates the character; the Walk/Run buttons drive a gait
that keeps going until stopped; and the rig's front is its local **−Z** —
`mixamorigLeftToeBase − mixamorigLeftFoot` dots +0.816 against −Z, which is why
movement is expressed against −Z (aiming the yaw at the travel vector walks it
backwards).

## Licences

- Poly Haven models and textures: **CC0** (polyhaven.com) — no attribution
  required, credited here anyway.
- `soldier.glb` from the three.js examples: sample asset, **prototype use
  only** — replace before anything ships.
