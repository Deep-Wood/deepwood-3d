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

## Quality profiles — **light by default**

This started as a feasibility spike tuned for a discrete GPU, which is a bad
default for a link someone will actually open: it cost 15 M triangles a frame and
a 2× pixel ratio. It is now **light by default**, with the heavy version opt-in.

| profile | URL | instances | pixel ratio | MSAA | shadows | visibility |
|---|---|---|---|---|---|---|
| **light (default)** | `/` | 50% | 1× | off | 512 map, 32 m box | fog 24-150 m, LODs to 80 m |
| full | `?full` | 100% | 1.5× | on | 1024 map, 40 m box | fog 26-165 m, LODs to 98 m |
| lite 1 | `?lite=1` | 30% | 0.85× | off | 512 map, 24 m box | fog 20-110 m |
| lite 2 | `?lite=2` | 15% | 0.7× | off | none | fog 16-85 m |
| lite 3 | `?lite=3` | 5% | 0.5× | off | none | fog 12-70 m — automated runs only |

Measured on the built site by reading it off the HUD: **default 723 trees, 1,210
plants, 26 rocks, 5.28 M triangles a frame, 74 draw calls, 1× pixel ratio, no
MSAA, 12.6 MB payload, tallest tree 34.6 m**; `?full` renders twice the instances.
Tall trees are not cheap on fill — a 30 m canopy puts a lot of alpha-tested leaf
over the camera at close range — so if the frame time climbs, that is where it is.

The per-frame triangle figure counts every pass, including the shadow pass
(three.js accumulates it in `renderer.info`) — which is why it is larger than the
visible-triangle column below.

Level 3 exists because a software rasteriser can spend seconds on one frame,
which starves the JS thread and makes a test harness time out before it can
assert anything. It is not for people.

**First paint does not wait for everything.** The trees around the camp and the
character load first (~8.3 MB); the distant LODs and the jungle floor load after
the first frame is on screen (~2.5 MB more) and appear as they arrive. Same total
bytes, but the scene is interactive in the smaller number and the decode cost is
spread instead of landing as one freeze.

## What is real here (not primitives)

| piece | source | notes |
|---|---|---|
| Character | `soldier.glb`, three.js sample assets | 68-bone Mixamo rig, 2 skinned meshes, clips **Idle / Walk / Run / TPose**. **Placeholder** — swap for licensed art. |
| Tool | built in code | pickaxe parented to the `mixamorig:RightHand` bone — the same "attach to socket" pattern a real tool model would use. |
| Canopy trees | Poly Haven, **CC0** | `island_tree_01/02/03` — tall broadleaf trees, 6.4-12.4k triangles each, two LOD tiers. |
| Mid-story trees | Poly Haven, **CC0** | `pine_sapling_small`, `searsia_lucida` filling the space between trunks. |
| Understory | Poly Haven, **CC0** | `fern_02`, `calathea_orbifolia_01`, `anthurium_botany_01`, `pachira_aquatica_01`, `shrub_02`, `grass_medium_01` — real plants, 320-2,602 triangles each, planted by the thousand. |
| Emergent giant | Poly Haven, **CC0** | `jacaranda_tree` — the only model tagged both `jungle` and `tall`, 19.33 m at scale 1, so it forms the 25-35 m ceiling. |
| Fallen wood | Poly Haven, **CC0** | `tree_stump_01`, `tree_stump_02`, `dead_tree_trunk_02` — the game's "depleted node" states, and the things the jump is for. |
| Rocks | **built in code** | a noise-displaced icosahedron, ~320 triangles. The Poly Haven boulder is 66k raw and `simplify` would not take it below 54k — 2.4 MB for a rock. |
| Tree materials | Poly Haven, **CC0** | real PBR sets: baseColor + normal + packed metallicRoughness/AO, 512 px near / 128 px far. |
| Terrain, sky, sun, fog, camp | procedural | humid-overcast sky, canopy haze fog, dark humus floor, ACES tone mapping, PCF shadows. |

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
Everything is instanced — the whole scene is 68 draw calls regardless of count
(the shadow pass adds a handful more at full detail).
### The models are small — measure before believing a forest is tall

Read off the shipped files, height in metres: `island_tree_01` **4.98**,
`island_tree_02` 3.40, `island_tree_03` **2.61**, `pine_sapling_small` 1.29,
`searsia_lucida` 2.28, stumps 0.52-0.56, `jacaranda_tree` **19.33**.

Against a 1.82 m character that is shrubbery, which is why the forest read as a
field with bushes. So the scene scales them, and it does it **non-uniformly**:
`scale` is width, `scaleY` is height, because a five-times-taller tree does not
want a five-times-thicker trunk — a forest of 2 m-radius trunks is a wall you
cannot walk through. Trunk collision radius grows with the 0.35 power of overall
scale for the same reason.

| layer | as planted | measured world height |
|---|---|---|
| jacaranda (emergent) | 9 | 25-35 m |
| island trees, emergent pass | 22 | 18-33 m |
| island trees, canopy | 185 | 12-20 m |
| mid-story | 160 | 5-10 m |
| fallen wood (jumpable) | 195 | 0.7-1.2 m |
| understory plants | 2,420 | 0.3-1.0 m |
| rocks (jumpable, procedural) | 18 | 0.7-1.5 m |

## Movement and obstacles

- **Walk into a trunk and you stop**, then slide along it (`blocked` in the HUD
  hooks). The 2D game does the same thing — its endless-walk test asserts
  `stopped before trunk`.
- **Jump** with Space or the button: a kinematic arc, ~1.1 m apex, heavier than
  real gravity because a floaty jump reads as underwater. No Jump clip exists in
  the placeholder rig, so the gait clip keeps playing in the air.
- **Obstacles are circles with a top height.** A jump clears anything whose top
  sits below your feet, which is what makes logs, stumps and small boulders
  jumpable and trunks not: at the default profile, 107 of 297 colliders are
  jumpable. The same circles stop the camera seeing through a trunk, so movement
  and the chase rig share one piece of world data.

### Terrain and budget, measured on the built site

Counts and triangles below are the **`?full`** tier; the default renders half of
them, and the HUD reports the live figure. Measured by reading the built files
back off disk:

| layer | instances | triangles | payload | casts shadows |
|---|---|---|---|---|
| canopy, full detail (inside 42 m) | 185 | 1.72 M | 3.80 MB | yes |
| canopy, far LOD (42-98 m) | 390 | 1.32 M | 1.00 MB | no |
| mid-story, full detail | 160 | 1.18 M | 1.46 MB | no |
| mid-story, far LOD | 360 | 0.82 M | 0.38 MB | no |
| fallen wood | 195 | 0.24 M | 0.87 MB | no |
| fallen wood, far LOD | 120 | 0.06 M | 0.08 MB | no |
| understory plants | 2,420 | 1.56 M | **1.18 MB** | no |
| character (placeholder) | 1 | 0.01 M | 2.06 MB | yes |
| **total** | **3,831** | **6.91 M visible** | **10.8 MB** | |

**What decides the frame rate is visible + the shadow pass:** at `?full`, 6.91 M
+ 1.72 M = **8.63 M triangles per frame**; at the default, **4.31 M**. The shadow
frustum is re-rendered every frame (the player moves), so every shadow caster is
paid for twice — which is why only the canopy casts. The far LODs are ~1/7 the
triangles with 128 px maps.

Three tricks buy density without triangles, because this is a prototype whose
budget is a laptop, not a console:

- **Scatter radii stop at the fog.** The understory is planted to 24-28 m because
  the fog starts at 24 m; past that it was being placed only to be painted out.
  Same instance count over a smaller disc is density where the camera is.
- **Only what you see is decimated less.** The canopy near tier keeps 6.4-12.4k
  triangles a tree because you stand next to it; the floor plants are 320-2,602.
- **Fill is half the bill.** 2× device pixels is four times the work of 1×, and
  double-sided alpha-tested foliage defeats early-Z, so the default caps the pixel
  ratio at 1, turns MSAA off and uses PCF rather than PCFSoft shadows.

Runs with `@gltf-transform/cli` (a devDependency). It prints raw vs shipped size
and the final triangle count per species, so the cost of each step is visible
rather than asserted (near canopy: ratio 0.006 / error 0.05; far LOD: 0.006 /
0.05 with 128 px maps):

Raw scans decimate hard, and small things decimate hardest because you never get
close enough to see it:

| model | shipped triangles | was |
|---|---|---|
| `island_tree_01` (canopy hero) | 9,925 | from a 1.6 M-triangle / 60.7 MB scan |
| `island_tree_03` (canopy hero) | 12,378 | from a 79.6 MB scan |
| `pine_sapling_small` | 7,495 | 15,832 |
| `searsia_lucida` | 7,235 | 23,231 |
| `grass_medium_01` (floor) | 676 | 3,260 |
| `fern_02` (floor) | 406 | 816 |
| `pachira_aquatica_01` (floor) | 1,527 | 4,576 |

The script prints raw vs shipped and the final triangle count per species, so the
cost of each pass stays visible — run it and read the numbers rather than trusting
this table, which is the kind of thing that goes stale.

**10.8 MB total** — the number the page reports as "asset payload". The biggest
single item is the placeholder **character at 2.06 MB**, i.e. one model costs more
than all 2,420 understory plants together (1.18 MB). A real character with a
sensible texture budget is the obvious next saving; so is 256 px maps on the
canopy, which would roughly halve the remaining total at some cost up close.

## What this proves / does not prove

Proves: a browser can hold a skinned character with animation blend trees, 3,831
instanced trees, plants and props with PBR materials, alpha-tested foliage with
vertex-shader wind, shadows and ACES tone mapping — in one WebGL2 frame at 68
draw calls, with no engine and no build step beyond Vite. It also proves the
budget side: the same scene fits in ~4.3 M triangles a frame at the default
profile, which is a laptop number rather than a workstation one.

Does **not** prove: photoreal. The look still comes from the asset budget, not
the renderer. Skinned-mesh count, cloth/hair, IK-driven foot placement,
large-world streaming and netcode are all untested here.

## Verification hooks

`window.__proto3d` carries `ready`, `errors`, `clips`, `trees`, `species`,
`shrubs`, `hasTool`, `lite`, `profile`, `phase2` (true once the deferred LODs and
jungle floor have arrived), `frames` (proves the rAF loop is running — a
background tab pauses it), `texBytes`/`assetBytes`, `gait`, `setClip(name)`,
`orbitTo(yawDeg, dist, height)` to park the camera at a known bearing, and
`facing()` for the world direction of the model's local +Z.

Two of these exist to make complaints measurable rather than arguable:
`occlusion` (`camDist`, `blocked`, `ducking`, `userDist`) and `camLog`, a
300-frame ring buffer of the rig's own distance, eye height and blocked flag —
counting direction reversals in it is how "the camera shakes" gets settled. The
trunk circles the camera collides against are exposed as `trunkColliders`, which
is how a blocking trunk can be injected on demand.

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
