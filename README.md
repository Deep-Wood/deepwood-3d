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
| Canopy trees | Poly Haven, **CC0** | `island_tree_01/02/03` — tall broadleaf trees, 12.7-24.9k triangles each, two LOD tiers. |
| Mid-story trees | Poly Haven, **CC0** | `pine_sapling_small`, `searsia_lucida` filling the space between trunks. |
| Understory | Poly Haven, **CC0** | `fern_02`, `calathea_orbifolia_01`, `anthurium_botany_01`, `pachira_aquatica_01`, `shrub_02`, `grass_medium_01` — real plants, ~0.8-4.6k triangles each, planted by the thousand. |
| Fallen wood | Poly Haven, **CC0** | `tree_stump_01`, `tree_stump_02`, `dead_tree_trunk_02` — the game's "depleted node" states, and real forest-floor debris. |
| Tree materials | Poly Haven, **CC0** | real PBR sets: baseColor + normal + packed metallicRoughness/AO, 512 px near / 128 px far. |
| Terrain, sky, sun, fog, camp | procedural | humid-overcast sky, canopy haze fog, dark humus floor, ACES tone mapping, PCF soft shadows. |

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

Three layers, because a forest that is dense only at the horizon is not a forest.
Everything is instanced — the whole scene is ~70 draw calls regardless of count.
Measured at full density (`npm run build` output, read back off disk):

| layer | instances | triangles | payload |
|---|---|---|---|
| canopy, full detail (inside 42 m) | 185 | 3.41 M | 5.80 MB |
| canopy, far LOD (42-98 m) | 390 | 1.32 M | 1.00 MB |
| mid-story, full detail | 160 | 3.05 M | 2.90 MB |
| mid-story, far LOD | 360 | 0.82 M | 0.38 MB |
| fallen wood | 315 | 0.59 M | 0.89 MB |
| understory plants | 3,620 | 7.46 M | **0.93 MB** |
| **total** | **5,030** | **16.6 M** | **14.0 MB** |

The far LODs are ~1/7 the triangles with 128 px maps and cast no shadows; the
understory casts no shadows either (leaves cost more in the shadow pass than they
add). Scatter radii stop at the far side of the fog so nothing is spent where fog
paints over it. `?lite=1` renders about 42% of these counts.

Runs with `@gltf-transform/cli` (a devDependency). It prints raw vs shipped size
and the final triangle count per species, so the cost of each step is visible
rather than asserted. What actually ships (ratio 0.04 / error 0.01):

| model | raw buffer | near set | triangles | far LOD | far triangles |
|---|---|---|---|---|---|
| `island_tree_01` | 60.7 MB | 2,041,044 B | 19,131 | 367,000 B | 3,780 |
| `island_tree_03` | 79.6 MB | 2,493,724 B | 24,909 | 422,000 B | 4,222 |
| `island_tree_02` | 40.7 MB | 1,545,508 B | 12,687 | 258,000 B | 2,275 |
| `pine_sapling_small` | 16.9 MB | 1,453,768 B | 15,832 | 215,500 B | 2,318 |
| `searsia_lucida` | 17.1 MB | 1,590,928 B | 23,231 | 187,560 B | 2,231 |
| `dead_tree_trunk_02` | 1.9 MB | 348,740 B | 3,324 | 47,572 B | 670 |
| `tree_stump_01` | 0.9 MB | 334,796 B | 1,641 | 33,444 B | 290 |
| `fern_02` | 0.2 MB | 64 K | 816 | — | — |
| `calathea_orbifolia_01` | 0.4 MB | 172 K | 4,021 | — | — |
| `grass_medium_01` | 1.0 MB | 168 K | 3,735 | — | — |
| `pachira_aquatica_01` | 2.0 MB | 124 K | 1,590 | — | — |
| `anthurium_botany_01` | 1.7 MB | 260 K | 4,576 | — | — |
| `shrub_02` | 0.8 MB | 124 K | 968 | — | — |
| `soldier.glb` (character) | — | 2,160,468 B | — | — | — |

**14.0 MB total** — that is the number the page reports as "asset payload", and
the whole network cost of the scene. The understory is the cheap half: 3,620
plants for under 1 MB.

## What this proves / does not prove

Proves: a browser can hold a skinned character with animation blend trees, 5,030
instanced trees, plants and props with PBR materials, alpha-tested foliage with
vertex-shader wind, soft shadows and ACES tone mapping — in one WebGL2 frame at
~70 draw calls, with no engine and no build step beyond Vite.

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
