/**
 * DeepWood · 3D feasibility prototype
 * -----------------------------------
 * Answers one question: can the *web* path carry a lifelike DeepWood — a real
 * rigged character standing in a real forest — without moving to a game engine?
 *
 * What is real here (not primitives):
 *   - Character: glTF skinned mesh, 68-bone Mixamo rig, Idle/Walk/Run clips,
 *     driven by AnimationMixer, walking on the terrain under player control.
 *   - Trees: Poly Haven CC0 models — fir, island tree, fir sapling — with their
 *     PBR texture sets (baseColor + normal + packed metallicRoughness/AO),
 *     merged per material and drawn as InstancedMesh.
 *   - Terrain, sky, sun and fog are still procedural (the game's Campfire View
 *     approach, upgraded with real tone mapping and shadows).
 *
 * E2E hooks live on window.__proto3d so the harness can assert "the frame is
 * not black and the skinned mesh actually animated".
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- state ----
const state = {
  ready: false,
  errors: [],
  wind: true,
  shadows: true,
  trees: 0,
  understory: 0,
  clip: 'Idle',
  gait: 'Idle', // button-driven locomotion: keeps walking until told to stop
  texBytes: 0,
};
window.__proto3d = state;
window.addEventListener('error', (e) => state.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => state.errors.push(String(e.reason?.message || e.reason)));

// ---------------------------------------------------------------- quality ---
/**
 * LIGHT BY DEFAULT, heavy on request.
 *
 * This scene started as a feasibility prototype and was tuned for a discrete
 * GPU: 11 M triangles, shadows re-rendering every caster each frame, 2× device
 * pixels. That is a fine answer to "can the web carry this" and a bad answer to
 * "run it on my laptop" — so the default is now the profile that runs anywhere,
 * and `?full` opts back into the heavy one. `?lite=1..3` still steps down for
 * weak devices (and `?lite=3` exists for automated runs on a GPU-less box, where
 * a single full frame starves the JS thread and times the harness out).
 *
 *   k           instance counts: near trees, far LODs, understory plants
 *   dpr         pixel ratio cap — 2× is FOUR times the fill work of 1×
 *   msaa        antialias; costly here, because alpha-tested foliage defeats
 *               early-Z and this scene is full of it
 *   shadow      shadow map size, 0 = no shadows at all
 *   shadowHalf  shadow frustum half-width in metres. It re-renders every caster
 *               every frame (the player moves), so this is a per-frame cost
 *   fog         [near, far] — also the depth at which counting trees stops
 *   farCap      furthest radius any LOD tier is scattered to
 */
const PROFILES = {
  // k = 0.5, not 0.3: at 0.3 the clearing read as a bare field with a thin
  // treeline, which is exactly the complaint that started the density work. The
  // assets are decimated hard enough now (grass 3,260 -> 676 triangles, pine
  // 15,832 -> 7,495) that half the previous instance count costs about what the
  // sparse version did — density is the cheapest thing to buy back.
  light: { k: 0.50, dpr: 1.0,  msaa: false, shadow: 512,  shadowHalf: 16, seg: 160,
           fog: [24, 150], farCap: 80,       label: 'light (default)' },
  full:  { k: 1.00, dpr: 1.5,  msaa: true,  shadow: 1024, shadowHalf: 20, seg: 240,
           fog: [26, 165], farCap: Infinity, label: 'full (?full)' },
  lite1: { k: 0.30, dpr: 0.85, msaa: false, shadow: 512,  shadowHalf: 12, seg: 120,
           fog: [20, 110], farCap: 65,       label: 'lite 1' },
  lite2: { k: 0.15, dpr: 0.7,  msaa: false, shadow: 0,    shadowHalf: 10, seg: 90,
           fog: [16, 85],  farCap: 52,       label: 'lite 2' },
  lite3: { k: 0.05, dpr: 0.5,  msaa: false, shadow: 0,    shadowHalf: 8,  seg: 48,
           fog: [12, 70],  farCap: 45,       label: 'lite 3 (automation)' },
};
const params = new URLSearchParams(location.search);
const hasLite = params.has('lite');
const LITE = hasLite ? Number(params.get('lite')) : NaN;
const Q = params.has('full') || LITE === 0 ? PROFILES.full
  : hasLite ? (PROFILES[`lite${Math.max(1, Math.min(3, LITE || 1))}`] || PROFILES.lite2)
  : PROFILES.light;
const LITE_K = Q.k;
const NO_SHADOWS = Q.shadow === 0;
state.lite = LITE;
state.profile = Q.label;

const app = document.getElementById('app');
const el = {
  fps: document.getElementById('fps'),
  calls: document.getElementById('calls'),
  tris: document.getElementById('tris'),
  trees: document.getElementById('trees'),
  plants: document.getElementById('plants'),
  rocks: document.getElementById('rocks'),
  tallest: document.getElementById('tallest'),
  profile: document.getElementById('profile'),
  ms: document.getElementById('ms'),
  dpr: document.getElementById('dpr'),
  api: document.getElementById('api'),
  gpuhint: document.getElementById('gpuhint'),
  tex: document.getElementById('tex'),
  perf: document.getElementById('perf'),
  loading: document.getElementById('loading'),
  bar: document.querySelector('#bar > i'),
};

// --------------------------------------------------------------- noise -----
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, z, octaves = 4) {
  let h = 0, amp = 1, freq = 0.045;
  for (let o = 0; o < octaves; o++) {
    h += vnoise(x * freq, z * freq) * amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return h;
}
const CLEARING = 9.5;
/** Terrain height. The camp sits in a flattened clearing at the origin; the
 *  ground swells into ridges further out so the horizon is a treed skyline
 *  rather than the bare edge of a plane. */
function heightAt(x, z) {
  const d = Math.hypot(x, z);
  const flat = THREE.MathUtils.smoothstep(d, CLEARING, CLEARING + 12);
  const raw = (fbm(x, z) - 0.5) * 3.4;
  const ridge = (fbm(x * 0.28 + 40, z * 0.28 - 25, 3) - 0.42) * 26;
  const rise = THREE.MathUtils.smoothstep(d, 40, 210);
  return (raw + ridge * rise) * flat;
}

// ------------------------------------------------------------ renderer -----
const renderer = new THREE.WebGLRenderer({ antialias: Q.msaa, powerPreference: 'high-performance' });
// Capped by the profile. 2x device pixels is four times the fill work of 1x, and
// this scene is fill-bound at the far end (double-sided alpha-tested foliage,
// PCF shadows, overdraw), so paying it by default was the wrong trade.
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.98;
renderer.shadowMap.enabled = !NO_SHADOWS;
// PCF, not PCFSoft: the soft variant takes nine-plus taps per fragment, and on a
// scene this full of alpha-tested leaves that is the dominant fill cost.
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 500);
camera.position.set(5.4, 2.9, 7.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
// Low floor on purpose: the follow rig's occlusion pull-in has to be able to
// take the camera in past a trunk, and OrbitControls clamps the radius every
// frame — at 4 m the pull-in was clamped away and fought itself.
controls.minDistance = 1.2;
controls.maxDistance = 46;
controls.maxPolarAngle = Math.PI * 0.495;
controls.target.set(0, 1.4, 0);

// ----------------------------------------------------------------- sky -----
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    // Humid overcast: a jungle sky is hazy and pale, and mostly hidden anyway.
    topColor: { value: new THREE.Color(0x5c7f86) },
    midColor: { value: new THREE.Color(0x9fb3a4) },
    horizon: { value: new THREE.Color(0xe0e2c2) },
    sunDir: { value: new THREE.Vector3(0.6, 0.42, -0.7).normalize() },
  },
  vertexShader: /* glsl */`
    varying vec3 vWorld;
    void main() {
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 topColor, midColor, horizon, sunDir;
    varying vec3 vWorld;
    void main() {
      vec3 d = normalize(vWorld);
      float h = clamp(d.y * 1.15 + 0.06, 0.0, 1.0);
      vec3 col = mix(horizon, midColor, smoothstep(0.0, 0.35, h));
      col = mix(col, topColor, smoothstep(0.3, 0.95, h));
      float sun = pow(max(dot(d, normalize(sunDir)), 0.0), 42.0);
      float halo = pow(max(dot(d, normalize(sunDir)), 0.0), 5.0) * 0.25;
      // Soft, diffuse glow — a hard sun disc reads as open sky, not canopy.
      col += vec3(1.0, 0.94, 0.78) * sun * 0.55 + vec3(1.0, 0.93, 0.8) * halo;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(320, 32, 16), skyMat);
scene.add(sky);
// Canopy haze: green and fairly close, so distance reads as humid jungle depth.
// Not TOO close — fog this dense over a thin forest just looks like empty ground.
scene.fog = new THREE.Fog(0x7f9168, Q.fog[0], Q.fog[1]);

// --------------------------------------------------------------- lights ----
// Sun behind-left of the default camera so the character reads front-lit.
const sunDir = new THREE.Vector3(-0.55, 0.48, 0.68).normalize();
const sun = new THREE.DirectionalLight(0xf0f4d8, 1.9);
sun.castShadow = true;
// 1024 over a 40 m box is ~4 cm per texel — sharper AND cheaper than 2048 over
// 68 m. The shadow frustum is re-rendered every frame (the player moves), so its
// size is a direct per-frame cost, not a one-off.
const SHADOW_MAP = Q.shadow || 256;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = Q.shadowHalf * 4.5;
sun.shadow.camera.left = -Q.shadowHalf;
sun.shadow.camera.right = Q.shadowHalf;
sun.shadow.camera.top = Q.shadowHalf;
sun.shadow.camera.bottom = -Q.shadowHalf;
sun.shadow.bias = -0.0012;
sun.shadow.normalBias = 0.035;
scene.add(sun);
scene.add(sun.target);

// Stronger green bounce from the foliage below than an open plain would give.
const hemi = new THREE.HemisphereLight(0xb4cede, 0x26351a, 0.95);
scene.add(hemi);
// Soft fill from the camera side: keeps the rig readable when the sun is low.
const fill = new THREE.DirectionalLight(0xbfd6ff, 0.45);
fill.position.set(6, 5, 9);
scene.add(fill);

const fireLight = new THREE.PointLight(0xff9a3c, 6, 22, 2);
fireLight.position.set(0, 0.9, 0);
scene.add(fireLight);

// -------------------------------------------------------------- terrain ----
const GROUND = 340;
const SEG = Q.seg;
const groundGeo = new THREE.PlaneGeometry(GROUND, GROUND, SEG, SEG);
groundGeo.rotateX(-Math.PI / 2);
{
  const pos = groundGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  // Forest floor: dark humus and leaf litter, not pasture.
  const cDirt = new THREE.Color(0x38301c);
  const cMoss = new THREE.Color(0x22331a);
  const cGrass = new THREE.Color(0x2c4420);
  const cStone = new THREE.Color(0x4c5044);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = heightAt(x, z);
    pos.setY(i, y);
    const n = vnoise(x * 0.25 + 11, z * 0.25 - 7);
    const slope = Math.abs(heightAt(x + 0.8, z) - heightAt(x - 0.8, z)) + Math.abs(heightAt(x, z + 0.8) - heightAt(x, z - 0.8));
    tmp.copy(cMoss).lerp(cGrass, n);
    tmp.lerp(cDirt, THREE.MathUtils.clamp(0.55 - n, 0, 0.5));
    tmp.lerp(cStone, THREE.MathUtils.clamp(slope * 0.5, 0, 0.45));
    if (Math.hypot(x, z) < CLEARING) tmp.lerp(cDirt, 0.35);
    colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
  }
  groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  groundGeo.computeVertexNormals();
}
const ground = new THREE.Mesh(
  groundGeo,
  new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 }),
);
ground.receiveShadow = true;
scene.add(ground);

// ----------------------------------------------------------------- camp ----
function buildCamp() {
  const camp = new THREE.Group();
  const logMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.95 });
  const charMat = new THREE.MeshStandardMaterial({ color: 0x2a1d13, roughness: 1 });
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6d6d68, roughness: 0.9 });

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 1.5, 7), logMat);
    log.position.set(Math.cos(a) * 0.55, 0.12, Math.sin(a) * 0.55);
    log.rotation.set(Math.PI / 2, 0, -a);
    log.castShadow = true; log.receiveShadow = true;
    camp.add(log);
  }
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0xff7a1c, emissive: 0xff5a00, emissiveIntensity: 2.4, roughness: 0.7,
  });
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.88, 7), emberMat);
  flame.position.y = 0.5;
  camp.add(flame);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const st = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16 + (i % 3) * 0.04, 0), stoneMat);
    st.position.set(Math.cos(a) * 1.35, 0.05, Math.sin(a) * 1.35);
    st.rotation.set(vnoise(i, 3) * 3, vnoise(i, 7) * 3, vnoise(i, 11) * 3);
    st.castShadow = true; st.receiveShadow = true;
    camp.add(st);
  }
  const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), charMat);
  stone.position.set(-1.9, 0.16, 1.5);
  stone.castShadow = true; stone.receiveShadow = true;
  camp.add(stone);
  camp.traverse((o) => { if (o.isMesh) o.castShadow = o.castShadow ?? true; });
  camp.position.y = heightAt(0, 0);
  return camp;
}
const camp = buildCamp();
scene.add(camp);

// ---------------------------------------------------------------- trees ----
// NB: THREE.DefaultLoadingManager is a ready-made *instance* in this three
// build, not a class — `new` on it throws "not a constructor".
const manager = new THREE.LoadingManager();
manager.onProgress = (_u, loaded, total) => {
  el.bar.style.width = `${Math.round((loaded / Math.max(total, 1)) * 100)}%`;
};
const loader = new GLTFLoader(manager);

const windMats = [];
let windTime = 0;

/** Sway injection: foliage only, weighted by local height so trunks stay put. */
function makeWindy(material, treeHeight, strength) {
  const m = material.clone();
  m.userData.wind = { uTime: { value: 0 }, uStrength: { value: strength }, uHeight: { value: Math.max(treeHeight, 0.5) } };
  const { uTime, uStrength, uHeight } = m.userData.wind;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uStrength = uStrength;
    shader.uniforms.uHeight = uHeight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uStrength; uniform float uHeight;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 iPos = vec3(0.0);
        #endif
        float ph = iPos.x * 0.42 + iPos.z * 0.31;
        float w = (sin(uTime * 1.25 + ph) * 0.55 + sin(uTime * 2.7 + ph * 1.7) * 0.25) * uStrength;
        float hw = clamp(transformed.y / uHeight, 0.0, 1.0);
        transformed.x += w * hw * hw;
        transformed.z += w * 0.65 * hw * hw;`);
  };
  m.needsUpdate = true;
  windMats.push(m);
  return m;
}

/** Merge a glTF scene by material and draw it as instanced meshes. */
function instancedFrom(gltfScene, placements, { castShadow = true, tally = 'trees' } = {}) {
  gltfScene.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(gltfScene);
  const height = box.max.y - box.min.y;

  const byMaterial = new Map();
  gltfScene.traverse((o) => {
    if (!o.isMesh) return;
    // Normalise before merging: mergeGeometries needs an identical attribute
    // set across the group, and raw scans ship extras (COLOR_0, tangents,
    // mixed uvs). Dropping to non-indexed position/normal/uv/uv2 always merges.
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    g = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'uv2'].includes(name)) g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      const n = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    g.setAttribute('uv2', g.attributes.uv);
    const key = o.material.uuid;
    if (!byMaterial.has(key)) byMaterial.set(key, { material: o.material, name: o.material.name || '', geos: [] });
    byMaterial.get(key).geos.push(g);
  });

  const group = new THREE.Group();
  for (const { material, name, geos } of byMaterial.values()) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const foliage = /twig|leaf|leaves|branch|needle|canopy/i.test(name);
    const mat = foliage ? makeWindy(material, height, 0.16) : material.clone();
    mat.side = foliage ? THREE.DoubleSide : mat.side;
    const inst = new THREE.InstancedMesh(merged, mat, placements.length);
    inst.castShadow = castShadow;
    inst.receiveShadow = true;
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    group.add(inst);
  }
  // Counted once per species. This used to sit inside the per-material loop
  // above, so a two-material tree (bark + foliage) reported double its
  // instances and the HUD overstated the forest by ~2x.
  if (tally) state[tally] = (state[tally] || 0) + placements.length;

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isInstancedMesh) return;
    placements.forEach((pl, i) => {
      p.set(pl.x, heightAt(pl.x, pl.z) - 0.05, pl.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pl.rot);
      s.set(pl.scale, pl.sy || pl.scale, pl.scale); // non-uniform: see SPECIES
      m4.compose(p, q, s);
      o.setMatrixAt(i, m4);
    });
    o.instanceMatrix.needsUpdate = true;
  });
  return { group, height };
}

/**
 * Poisson-ish scatter: spots must not crowd each other, and none may land in
 * the camp clearing.
 *
 * Radius is sampled as sqrt(minR² + u·(maxR²−minR²)) so the density is uniform
 * PER UNIT AREA. Sampling the radius uniformly instead — which is what this did
 * — concentrates instances in a ring at maxR: the camp stood on bare ground and
 * every tree sat on the horizon.
 */
function scatter(count, { minR = 6, maxR = 68, minDist = 3.4, tries = 26, scale = [0.8, 1.5],
                         scaleY = null, gate = 0.3, nearClear = 42 }) {
  const spots = [];
  const r2span = maxR * maxR - minR * minR;
  for (let i = 0; i < count; i++) {
    for (let t = 0; t < tries; t++) {
      const a = vnoise(i * 3.1 + t, 7.7) * Math.PI * 2;
      const r = Math.sqrt(minR * minR + vnoise(i * 1.7 + t, 19.3) * r2span);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      // Low-frequency gate: makes clumps and glades instead of a uniform lawn.
      // It is only applied OUTSIDE the visible band. This noise sits below the
      // threshold across the whole camp area, so gating the near field rejected
      // every nearby attempt and left the trees in a ring at maxR.
      if (r > nearClear) {
        const density = vnoise(x * 0.055 + 5, z * 0.055 - 3);
        if (density < gate) continue;
      }
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < minDist)) continue;
      const syRange = scaleY || scale;
      spots.push({
        x, z,
        rot: vnoise(i + t, 42) * Math.PI * 2,
        scale: scale[0] + vnoise(i * 2.3 + t, 91) * (scale[1] - scale[0]),
        // Height scales separately from width (see SPECIES): the models are
        // small, and growing only the trunk radius with them walls off the world.
        sy: syRange[0] + vnoise(i * 3.7 + t, 53) * (syRange[1] - syRange[0]),
      });
      break;
    }
  }
  return spots;
}

// ---------------------------------------------------------- undergrowth ----
/**
 * Shrub clumps: two crossed quads per clump with a canvas-drawn blade texture,
 * alpha-tested. A floor of blades costs ~4 triangles per instance, so it can be
 * dense where the trees have to stay countable.
 */
function shrubTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.lineCap = 'round';
  for (let i = 0; i < 34; i++) {
    const x = 12 + vnoise(i, 3.3) * 104;
    const h = 30 + vnoise(i, 8.1) * 86;
    const bend = (vnoise(i, 11.7) - 0.5) * 48;
    const r = (48 + vnoise(i, 21) * 70) | 0;
    const gg = (94 + vnoise(i, 33) * 84) | 0;
    const b = (38 + vnoise(i, 41) * 44) | 0;
    g.strokeStyle = `rgba(${r}, ${gg}, ${b}, ${0.68 + vnoise(i, 51) * 0.32})`;
    g.lineWidth = 1.8 + vnoise(i, 61) * 2.6;
    g.beginPath();
    g.moveTo(x, 128);
    g.quadraticCurveTo(x + bend * 0.4, 128 - h * 0.55, x + bend, 128 - h);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shrubGeometry(w = 1.3, h = 1.05) {
  const a = new THREE.PlaneGeometry(w, h);
  a.translate(0, h / 2, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  return mergeGeometries([a, b]);
}

function buildUndergrowth() {
  // Half-again the normal density at every lite level: the floor is what makes
  // the ground read as "forest" instead of "field".
  const k = LITE_K >= 1 ? 1 : Math.max(LITE_K, 0.35);
  // Only a garnish now: the real understory models carry the floor, and every
  // card here is a double-sided alpha-tested quad (fill cost, no early-Z).
  const spots = scatter(Math.round(350 * k), {
    minR: 3.0, maxR: 46, minDist: 1.1, tries: 12, gate: 0.16, scale: [0.7, 1.8],
  });
  const geo = shrubGeometry();
  const mat = new THREE.MeshStandardMaterial({
    map: shrubTexture(), alphaTest: 0.35, side: THREE.DoubleSide,
    roughness: 0.95, metalness: 0,
  });
  const inst = new THREE.InstancedMesh(geo, mat, spots.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  spots.forEach((pl, i) => {
    p.set(pl.x, heightAt(pl.x, pl.z) - 0.04, pl.z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pl.rot);
    sc.setScalar(pl.scale);
    inst.setMatrixAt(i, m4.compose(p, q, sc));
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.receiveShadow = true;
  inst.castShadow = false; // blades in the shadow pass cost more than they add
  scene.add(inst);
  state.shrubs = spots.length;
}

// ------------------------------------------------------------ character ----
const keys = new Set();
let character = null;
let mixer = null;
const actions = {};
let currentAction = null;

function setClip(name, { force = false } = {}) {
  if (!actions[name]) return false;
  if (!force && currentAction === actions[name]) return true;
  const next = actions[name];
  next.reset().setEffectiveWeight(1).fadeIn(0.25).play();
  if (currentAction) currentAction.fadeOut(0.25);
  currentAction = next;
  state.clip = name;
  document.querySelectorAll('button.clip[data-clip]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.clip === name));
  });
  return true;
}
state.setClip = setClip;

function attachTool(handBone) {
  const tool = new THREE.Group();
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.032, 0.85, 8),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 }),
  );
  handle.castShadow = true;
  const headMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.45, metalness: 0.85 });
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.09, 0.1), headMat);
  head.position.y = 0.42;
  head.castShadow = true;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 5), headMat);
  tip.position.set(0.17, 0.42, 0);
  tip.rotation.z = -Math.PI / 2;
  tip.castShadow = true;
  tool.add(handle, head, tip);
  tool.position.set(0.04, 0.02, 0.02);
  tool.rotation.set(1.15, 0.25, 0.35);
  handBone.add(tool);
  return tool;
}

async function loadCharacter() {
  const gltf = await loader.loadAsync('/assets/char/soldier.glb');
  const root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root);
  const h = box.max.y - box.min.y;
  const scale = 1.82 / h;
  root.scale.setScalar(scale);
  root.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      if (o.material) o.material.roughness = Math.min(o.material.roughness ?? 0.8, 0.85);
    }
  });
  root.position.set(2.15, heightAt(2.15, 2.9), 2.9);
  root.rotation.y = Math.PI * 0.82;
  scene.add(root);
  character = root;

  mixer = new THREE.AnimationMixer(root);
  gltf.animations.forEach((clip) => {
    const a = mixer.clipAction(clip);
    a.enabled = true;
    actions[clip.name] = a;
  });
  setClip('Idle', { force: true });

  let hand = null;
  root.traverse((o) => {
    if (!hand && /right.?hand/i.test(o.name)) hand = o;
  });
  if (hand) root.userData.tool = attachTool(hand);
  state.character = root;
  state.clips = Object.keys(actions);
  state.hasTool = Boolean(hand);
  return root;
}

// ------------------------------------------------------------ interaction --
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space') { jumpQueued = true; e.preventDefault(); } // not a page scroll
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
document.querySelectorAll('button.clip[data-clip]').forEach((b) => {
  b.addEventListener('click', () => {
    const name = b.dataset.clip;
    // Swapping the clip alone was pointless: with no key held the render loop
    // set it straight back to Idle on the next frame, so the button looked
    // dead. Walk/Run now set a GAIT that keeps driving the character; clicking
    // the running one (or Idle) stops it.
    const next = name !== 'Idle' && state.gait === name ? 'Idle' : name;
    state.gait = next;
    setClip(next, { force: true });
  });
});

// ---------------------------------------------------------------- resize ---
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// -------------------------------------------------------------- reporting --
const move = new THREE.Vector3();
let last = performance.now();
let fpsAvg = 60;
let frames = 0;
let tooltipByteEstimate = 0;

let hudAt = 0;
function updateHud() {
  frames++;
  state.frames = frames; // harness hook: proves the rAF loop is actually running
  const now = performance.now();
  // Time-based, NOT frame-count based: at software-raster speeds a
  // `frames % 12` throttle leaves the panel reading "–" forever.
  fpsAvg = fpsAvg * 0.92 + (1000 / Math.max(now - last, 1)) * 0.08;
  last = now;
  if (now - hudAt < 300) return;
  hudAt = now;
  el.fps.textContent = fpsAvg.toFixed(1);
  el.calls.textContent = String(renderer.info.render.calls);
  el.tris.textContent = renderer.info.render.triangles.toLocaleString();
  el.trees.textContent = String(state.trees);
  el.plants.textContent = String(state.understory || 0);
  el.rocks.textContent = String(state.rocks || 0);
  el.tallest.textContent = state.tallest ? `${state.tallest.toFixed(1)} m` : '–';
  // Frame time in ms, not just fps: at 12 fps it matters a lot whether that is
  // 83 ms or 400 ms, and it localises the cost to the renderer vs the JS.
  el.ms.textContent = `${(1000 / Math.max(fpsAvg, 0.01)).toFixed(0)} ms`;
  el.dpr.textContent = String(renderer.getPixelRatio());
  el.profile.textContent = state.profile;
  el.api.textContent = renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1';
  el.gpuhint.textContent = navigator.gpu ? 'available' : 'no';
  el.tex.textContent = tooltipByteEstimate ? `${(tooltipByteEstimate / 1048576).toFixed(1)} MB` : 'n/a';
  // Short on purpose: this used to be one long sentence that stretched the
  // panel across half the screen because the panel had no width cap.
  el.perf.textContent = fpsAvg < 30
    ? `⚠ ${fpsAvg.toFixed(1)} fps — try ?lite=1 (lighter) · ?full for full detail.`
    : '';
}

// ---------------------------------------------------------------- frame ----
function tick() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  windTime += dt;
  for (const m of windMats) m.userData.wind.uTime.value = windTime;

  // fire flicker
  fireLight.intensity = 5.2 + Math.sin(windTime * 11.3) * 0.9 + vnoise(windTime * 6, 3) * 1.6;

  // character locomotion
  if (character) {
    move.set(
      (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
      0,
      (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0),
    );
    const keysDown = move.lengthSq() > 0;
    if (keysDown && state.gait !== 'Idle') state.gait = 'Idle'; // keys take over

    // The rig faces its local -Z (measured: the toes sit 0.816·(-Z) ahead of the
    // ankles), so aiming the yaw at the travel vector makes it walk backwards.
    // Both the yaw and the gait translation below are therefore expressed
    // against -Z.
    // Jump: a kinematic arc, and the only way past a log, stump or boulder that
    // blocks the path. The placeholder rig has no Jump clip, so the gait clip
    // keeps playing while he is in the air — a real character needs one.
    if (jumpQueued && !airborne) { airborne = true; vy = JUMP_V; }
    jumpQueued = false;
    if (airborne) {
      vy -= GRAVITY * dt;
      jumpH += vy * dt;
      if (jumpH <= 0) { jumpH = 0; vy = 0; airborne = false; }
    }
    state.jumpH = +jumpH.toFixed(3);
    state.airborne = airborne;
    // Apex recorded in-page: at software-raster frame rates a poll can miss the
    // top of the arc entirely and make a working jump look broken.
    state.maxJumpH = Math.max(state.maxJumpH || 0, jumpH);

    let gait = state.gait;
    if (keysDown) {
      move.normalize();
      const yaw = Math.atan2(-move.x, -move.z);
      // turnToward is dt-based: a fixed 0.15/frame turns him (and therefore the
      // whole follow rig) twice as fast at 120 fps as at 60.
      character.rotation.y += wrapPi(yaw - character.rotation.y) * turnToward(dt);
      gait = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 'Run' : 'Walk';
    } else if (gait !== 'Idle') {
      // Button gait: steer it home instead of walking off into the fog.
      //
      // This used to be `rotation.y += Math.PI` while past 62 m, i.e. a half turn
      // EVERY FRAME: he spun on the spot, and since the follow rig rotates with
      // his yaw the camera span with him. A bounded steer toward the origin does
      // the same job without the whip.
      const r = Math.hypot(character.position.x, character.position.z);
      if (r > 62) {
        const home = Math.atan2(character.position.x, character.position.z); // -Z faces origin
        character.rotation.y += wrapPi(home - character.rotation.y) * turnToward(dt);
      }
    }

    if (gait !== 'Idle') {
      const speed = gait === 'Run' ? 4.6 : 1.7;
      const dx = keysDown ? move.x : -Math.sin(character.rotation.y);
      const dz = keysDown ? move.z : -Math.cos(character.rotation.y);
      let nx = THREE.MathUtils.clamp(character.position.x + dx * speed * dt, -68, 68);
      let nz = THREE.MathUtils.clamp(character.position.z + dz * speed * dt, -68, 68);
      // Slide along what he cannot walk through rather than stopping dead: try
      // the whole step, then one axis at a time. If he is somehow already
      // inside something (a jump that lands on a log), let him out instead of
      // pinning him there.
      const feet = jumpH + 0.12;
      const stuck = blockedAt(character.position.x, character.position.z, feet);
      if (!stuck && blockedAt(nx, nz, feet)) {
        if (!blockedAt(nx, character.position.z, feet)) nz = character.position.z;
        else if (!blockedAt(character.position.x, nz, feet)) nx = character.position.x;
        else { nx = character.position.x; nz = character.position.z; }
        state.blocked = true;
      } else {
        state.blocked = false;
      }
      character.position.set(nx, heightAt(nx, nz) + jumpH, nz);
    } else {
      // Standing still can still be mid-jump.
      character.position.y = heightAt(character.position.x, character.position.z) + jumpH;
    }
    setClip(gait);
    if (metro.follow) {
      // Third-person chase rig, three parts:
      //   1. translate with him (otherwise he shrinks into the distance),
      //   2. swing around him by his own turn (otherwise the camera keeps a
      //      fixed world bearing and he walks sideways out of "tracking"),
      //   3. pull in when a trunk blocks the line to his chest.
      const p = character.position;
      if (!prevFollow) {
        prevFollow = p.clone();
        prevYaw = character.rotation.y;
        camFocusY = p.y + 1.15;
        prevFocusY = camFocusY;
      }
      // Horizontal: still locked to him exactly, so he can never drift
      // off-centre — that was the "he gets lost" bug and it stays fixed.
      const dx = p.x - prevFollow.x, dz = p.z - prevFollow.z;
      camera.position.x += dx; camera.position.z += dz;
      controls.target.x += dx; controls.target.z += dz;

      // Vertical: SPRUNG. Following his height exactly meant every jump, log and
      // ridge snapped the whole view up and down, which is what made the follow
      // read as rigid rather than continuous. The eye now rides a damped version
      // of his height instead.
      camFocusY += ((p.y + 1.15) - camFocusY) * (1 - Math.exp(-9 * dt));
      const dySoft = camFocusY - prevFocusY;
      camera.position.y += dySoft;
      prevFocusY = camFocusY;

      const dyaw = wrapPi(character.rotation.y - prevYaw);
      if (Math.abs(dyaw) > 1e-4) rotateRigAround(p, dyaw);
      prevFollow.copy(p);
      prevYaw = character.rotation.y;
      state.followDbg = { dyaw: +dyaw.toFixed(4), yaw: +character.rotation.y.toFixed(3),
                          focusY: +camFocusY.toFixed(2) };

      camFocus.set(p.x, camFocusY, p.z);
      controls.target.copy(camFocus);
      applyCameraOcclusion(dt);
    } else {
      prevFollow = null;
      camDist = 0;
      camUserDist = 0;
      camDucking = false;
    }
    // keep the shadow frustum on the player
    sun.position.copy(character.position).addScaledVector(sunDir, 60);
    sun.target.position.copy(character.position);
    sun.target.updateMatrixWorld();
  }

  mixer?.update(dt);
  controls.update();
  renderer.render(scene, camera);
  updateHud(dt);
  requestAnimationFrame(tick);
}
const metro = { follow: true };

// ------------------------------------------------------------ follow rig ----
/** Previous character position + heading for the follow rig (see the tick). */
let prevFollow = null;
let prevYaw = 0;
const camFocus = new THREE.Vector3();

/**
 * Trunks the camera must not see through, as 2D circles. Deliberately not
 * geometry: this runs every frame and the real alternative — a raycast against
 * ~1,300 instances of 20k-triangle trees — is orders of magnitude too slow.
 */
const trunkColliders = [];
/** Rig distance while something is in the way; 0 = adopt the user's. */
let camDist = 0;
/** The radius the user last had, frozen while the camera is ducking. */
let camUserDist = 0;
let camDucking = false;
/** Sprung height of the aim point, so the follow is continuous, not rigid. */
let camFocusY = 0;
let prevFocusY = 0;
/** Ring buffer of recent rig distance / eye height / blocked, for diagnosis. */
const camLog = { dist: new Float32Array(300), y: new Float32Array(300),
                 blocked: new Uint8Array(300), i: 0, n: 0 };

// ------------------------------------------------------------ jump + body --
/**
 * Obstacle height by slug, in metres at scale 1: the things a jump is FOR.
 * Anything not listed is a tree trunk and counts as unjumpable (Infinity) — you
 * walk around those, which is also what the 2D game does (`stopped before trunk`).
 */
const LOW_OBSTACLE = { tree_stump_01: 0.9, tree_stump_02: 0.7, dead_tree_trunk_02: 0.8 };
/** How wide the character is, for the walk-into-things test. */
const BODY_RADIUS = 0.34;
const JUMP_V = 5.9;   // ~1.1 m apex
const GRAVITY = 16;   // heavier than 9.8: a floaty jump reads as underwater
let jumpH = 0, vy = 0, airborne = false, jumpQueued = false;

/**
 * Is (x, z) inside something solid that reaches above `feet`? Obstacles are the
 * same 2D circles the camera avoids; a jump clears anything whose top sits below
 * his feet, which is what makes logs, stumps and boulders jumpable and trunks
 * not. Cheap on purpose: ~500 circles, three candidate positions a frame.
 */
function blockedAt(x, z, feet) {
  for (const o of trunkColliders) {
    if (o.top <= feet) continue;
    const dx = x - o.x, dz = z - o.z, rr = o.r + BODY_RADIUS;
    if (dx * dx + dz * dz < rr * rr) return true;
  }
  return false;
}

function wrapPi(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Framerate-independent turn fraction (~0.15 at 60 fps, ~0.25 at 30, same rate). */
function turnToward(dt) {
  return 1 - Math.exp(-10 * dt);
}

/** Rotate the whole rig around the character, so the camera keeps its bearing
 *  RELATIVE to him: he turns a corner, the camera swings behind his shoulder. */
function rotateRigAround(p, dyaw) {
  const c = Math.cos(dyaw), s = Math.sin(dyaw);
  const spin = (v) => {
    const ox = v.x - p.x, oz = v.z - p.z;
    v.x = p.x + ox * c + oz * s;
    v.z = p.z - ox * s + oz * c;
  };
  spin(camera.position);
  spin(controls.target);
}

/**
 * Camera collision. Pulls the camera in until the line to his chest is clear,
 * snapping in immediately (he must never be hidden) and easing back out (no
 * popping when the trunk passes).
 */
function applyCameraOcclusion(dt) {
  const p = character.position;
  const cx = camera.position.x - p.x, cz = camera.position.z - p.z;
  const len = Math.hypot(cx, cz);
  if (len < 0.001 || !trunkColliders.length) return;

  // While nothing is in the way the current radius IS the user's choice; while
  // ducking under something it has to be REMEMBERED. Re-reading it each frame
  // made the pull-in permanent: the ease-out target was the pulled-in distance.
  if (!camDucking) camUserDist = len;
  const ux = cx / len, uz = cz / len;

  // Compare against the NOMINAL radius, never the current (already pulled-in)
  // distance. Testing `t > len` made the rig pump: pull in to 3.4 for a trunk at
  // 4.0, and on the next frame that trunk reads as "past the camera", so the rig
  // eased back out, hit 4.0 again, snapped in — a ~3-5 Hz oscillation whenever a
  // tree stood on the camera line. 0.4 m of hysteresis on the way out.
  const limit = camUserDist + (camDucking ? 0.4 : 0);
  let hit = limit, blocked = false;
  for (const o of trunkColliders) {
    const ox = o.x - p.x, oz = o.z - p.z;
    // Projection onto the view ray. It does not move when the camera slides
    // along that ray, so this stays stable as the rig pulls in.
    const t = ox * ux + oz * uz;
    if (t < 0.9 || t > limit) continue;                  // behind him or out of range
    if (Math.abs(ox * uz - oz * ux) > o.r + 0.5) continue; // clear of the trunk
    if (t < hit) { hit = t; blocked = true; }
  }

  if (blocked) {
    camDucking = true;
    // Continuous, not a snap: the instant jump to the clearance distance was the
    // one discontinuous thing left in an otherwise smooth rig, and it read as
    // the camera jerking every time a trunk crossed the line. Fast in (~0.08 s,
    // so still clear before he can be hidden), slower out (~0.2 s).
    const want = Math.max(1.4, hit - 0.6);
    const rate = want < camDist ? 12 : 5;
    camDist += (want - camDist) * (1 - Math.exp(-rate * dt));
  } else if (camDucking) {
    // Time-based ease (~0.2 s), not a per-frame factor: a fixed 0.08/frame takes
    // four times longer to recover at 30 fps than at 120.
    camDist += (camUserDist - camDist) * (1 - Math.exp(-5 * dt));
    if (camUserDist - camDist < 0.05) { camDist = camUserDist; camDucking = false; }
  } else {
    camDist = len;
  }

  state.occlusion = { camDist: +camDist.toFixed(2), blocked, ducking: camDucking,
                      userDist: +camUserDist.toFixed(2) };
  // Ring buffer of the rig's own motion, so "the camera shakes" can be measured
  // instead of argued about. Allocation-free: reuses one Float32Array.
  camLog.dist[camLog.i] = camDist;
  camLog.y[camLog.i] = camera.position.y;
  camLog.blocked[camLog.i] = blocked ? 1 : 0;
  camLog.i = (camLog.i + 1) % camLog.dist.length;
  if (camLog.n < camLog.dist.length) camLog.n++;
  if (Math.abs(camDist - len) > 0.01) {
    const scale = camDist / len;
    // Relative to the SPRUNG focus height, not his raw y: on a jump the eye
    // should stay on its damped arc, not snap to the pulled-in offset.
    const oy = camera.position.y - camFocusY;
    camera.position.set(p.x + cx * scale, camFocusY + Math.max(oy * scale, 0.55), p.z + cz * scale);
  }
}

// ------------------------------------------------------------------ boot ---
/**
 * The forest, in two tiers — five real models, each decimated from a Poly Haven
 * CC0 scan (pine shrub and searsia as cover, quiver tree broadleaf, plus the
 * stump and dead trunk that double as the game's "depleted node" states).
 *
 * `near` is the full-detail decimation; `far` is the same scan at ~1/7 the
 * triangles with a 128 px texture set. That split is what makes a dense
 * treeline affordable: measured, the near tier is 440 trees / 6.20 M triangles
 * and the far tier is 965 trees / 1.94 M — the whole far tier costs less than
 * the 170 pines, and at 40+ m the difference is invisible. Radii stop at the far
 * side of the fog (it starts fading at 70 m) so no triangles are spent where fog
 * paints over them. Counts are scaled by the ?lite level at boot.
 */
const SPECIES = [
  // Canopy. The broadleaf island trees replace the karoo/desert species that
  // were standing in for a forest: they are tall, wide and leafy, which is what
  // makes the layer above the player read as jungle.
  // `emergent` is the same tree planted a second time, sparse and much larger.
  // A jungle is not one even canopy — a handful of crowns standing well above the
  // rest is most of what makes the ceiling read as tall — and this costs nothing:
  // same asset, same instanced draw call, only different instance matrices.
  // THESE MODELS ARE PHYSICALLY SMALL, and that is why the forest read as a field
  // with bushes in it: island_tree_01 is 4.98 m tall, island_tree_03 only 2.61 m,
  // against a 1.82 m character. Measured off the shipped files, not guessed.
  //
  // So scale is doing deliberate work here, and it is NON-UNIFORM on purpose:
  // `scale` is width, `scaleY` is height. A five-times-taller tree does not want a
  // five-times-thicker trunk — a forest of 2 m-radius trunks is a wall you cannot
  // walk through — so the trunk radius barely grows while the height does.
  //
  // World heights this targets: canopy 12-20 m, emergent layer 18-39 m.
  { slug: 'island_tree_01', trunk: 0.5,
    near: { n: 60, minR: 7.0, maxR: 42, minDist: 6.0, scale: [1.6, 2.2], scaleY: [2.9, 4.0] },
    emergent: { n: 7, minR: 11, maxR: 46, minDist: 15, scale: [2.8, 3.4], scaleY: [5.4, 6.6] },
    far:  { n: 130, minR: 42, maxR: 96, minDist: 7.0, scale: [1.6, 2.2], scaleY: [2.9, 4.0], gate: 0.24 } },
  { slug: 'island_tree_02', trunk: 0.45,
    near: { n: 70, minR: 6.5, maxR: 40, minDist: 5.5, scale: [1.8, 2.5], scaleY: [3.9, 5.4] },
    emergent: { n: 8, minR: 12, maxR: 44, minDist: 15, scale: [3.0, 3.8], scaleY: [6.4, 8.0] },
    far:  { n: 140, minR: 40, maxR: 92, minDist: 6.5, scale: [1.8, 2.5], scaleY: [3.9, 5.4], gate: 0.24 } },
  { slug: 'island_tree_03', trunk: 0.4,
    near: { n: 55, minR: 7.5, maxR: 44, minDist: 6.5, scale: [1.9, 2.6], scaleY: [4.6, 6.5] },
    emergent: { n: 7, minR: 12, maxR: 48, minDist: 16, scale: [3.0, 4.0], scaleY: [7.0, 9.0] },
    far:  { n: 120, minR: 44, maxR: 98, minDist: 7.5, scale: [1.9, 2.6], scaleY: [4.6, 6.5], gate: 0.24 } },
  // The genuine giant: jacaranda is 19.33 m tall, and the only Poly Haven model
  // tagged both `jungle` and `tall`. At 1.3-2.0x it forms a 25-39 m ceiling with
  // 16-23 m crowns, which is what makes the canopy read as tall from underneath.
  //
  // `far: null` deliberately. The source is 3.86 M triangles and simplify refuses
  // to take it below ~27k, so a 128 px far copy cost 1.2 MB and 0.65 M triangles to
  // say what the island-tree far tier already says at 46+ m.
  { slug: 'jacaranda_tree', trunk: 0.9,
    near: { n: 9, minR: 15, maxR: 46, minDist: 16, scale: [0.7, 1.0], scaleY: [1.3, 2.0] },
    far:  null },
  // Mid-story filler between the trunks. `shadow: false`: only the canopy casts,
  // because the shadow frustum re-renders every near instance each frame and the
  // mid-story's shadows land under the canopy anyway. Saves ~3.6 M triangles.
  { slug: 'pine_sapling_small', trunk: 0.3, shadow: false,
    near: { n: 90, minR: 6.5, maxR: 40, minDist: 2.6, scale: [1.2, 1.8], scaleY: [3.9, 7.0] },
    far:  { n: 200, minR: 40, maxR: 94, minDist: 3.6, scale: [1.2, 1.8], scaleY: [3.9, 7.0], gate: 0.26 } },
  { slug: 'searsia_lucida', trunk: 0.35, shadow: false,
    near: { n: 70, minR: 6.0, maxR: 38, minDist: 2.2, scale: [1.2, 1.8], scaleY: [2.2, 4.4] },
    far:  { n: 160, minR: 38, maxR: 88, minDist: 3.2, scale: [1.2, 1.8], scaleY: [2.2, 4.4], gate: 0.26 } },
  // Fallen and rotting wood — the "depleted node" states the game needs, and the
  // things the jump is FOR: tops of 0.7-0.9 m, comfortably under a 1.1 m jump.
  { slug: 'tree_stump_01', trunk: 0.7, shadow: false,
    near: { n: 80, minR: 5.5, maxR: 34, minDist: 3.4, scale: [1.0, 1.6], scaleY: [1.0, 1.6] },
    far:  { n: 60, minR: 34, maxR: 58, minDist: 5.0, scale: [1.0, 1.6], scaleY: [1.0, 1.6], gate: 0.3 } },
  { slug: 'tree_stump_02', trunk: 0.8, shadow: false,
    near: { n: 45, minR: 6.0, maxR: 36, minDist: 5.0, scale: [1.0, 1.5], scaleY: [1.0, 1.6] },
    far:  null },
  { slug: 'dead_tree_trunk_02', trunk: 0.7, shadow: false,
    near: { n: 70, minR: 9.0, maxR: 40, minDist: 6.0, scale: [0.9, 1.2], scaleY: [0.8, 1.2] },
    far:  { n: 60, minR: 40, maxR: 74, minDist: 7.5, scale: [0.9, 1.2], scaleY: [0.8, 1.2], gate: 0.3 } },
];

/**
 * The jungle floor. Real Poly Haven understory models rather than billboards, at
 * 0.8-4.6k triangles each, so thousands are affordable; nothing here casts
 * shadows, because leaves and blades cost more in the shadow pass than they add.
 * `far: null` on a species means it has no cheap LOD and is only planted near.
 */
const UNDERSTORY = [
  // Counts trimmed from 3,620: the floor still reads dense, but the understory
  // was 45% of the scene's triangles and the least visible per triangle spent.
  // Radii pulled in from 36-42 m to 24-28 m: the fog starts at 24 m, so the
  // outer half of these plants were being planted only to be painted out. The
  // same instance count over a smaller disc is density where the camera is, for
  // no extra triangles — the same trick as farCap, applied to the floor.
  { slug: 'fern_02',               n: 700, minR: 2.4, maxR: 26, minDist: 0.7, scale: [0.8, 1.9] },
  { slug: 'grass_medium_01',       n: 800, minR: 2.2, maxR: 24, minDist: 0.6, scale: [0.7, 1.8] },
  { slug: 'shrub_02',              n: 320, minR: 3.0, maxR: 28, minDist: 1.1, scale: [0.8, 1.7] },
  { slug: 'calathea_orbifolia_01', n: 400, minR: 3.0, maxR: 26, minDist: 1.0, scale: [0.8, 1.6] },
  { slug: 'anthurium_botany_01',   n: 120, minR: 4.0, maxR: 24, minDist: 1.8, scale: [0.9, 1.5] },
  { slug: 'pachira_aquatica_01',   n: 80,  minR: 5.0, maxR: 26, minDist: 2.2, scale: [0.9, 1.6] },
];

/**
 * Rocks, built in code rather than downloaded. The Poly Haven boulder is 66k
 * triangles raw and `simplify` would not take it below 54k — 2.4 MB for a rock,
 * which is exactly the weight problem this prototype just spent a pass fixing.
 * A displaced icosahedron is ~320 triangles, costs no payload, and reads as the
 * same wet stone on a dark floor.
 *
 * Normalised to 1 m tall so `top` in this table is literally the obstacle height.
 * Small ones clear a 1.1 m jump; the big ones you walk around, which is right.
 */
const ROCKS = [
  { slug: 'rock', procedural: true, n: 18, minR: 6, maxR: 30, minDist: 4.6,
    scale: [0.7, 1.5], scaleY: [0.7, 1.5], trunk: 0.7, top: 1.0, shadow: true },
  { slug: 'rock_moss_set_01', n: 34, minR: 5, maxR: 26, minDist: 2.2,
    scale: [0.5, 1.1], scaleY: [0.5, 1.1], trunk: 0, top: 0, shadow: false },
];

/** A boulder-ish blob: icosahedron, noise-displaced, squashed, 1 m tall. */
function rockGeometry(seed = 0) {
  const g = new THREE.IcosahedronGeometry(0.5, 1).toNonIndexed();
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = vnoise(x * 4.1 + seed, z * 4.1 - seed) * 0.6 + vnoise(y * 5.3 + seed, x * 3.7) * 0.4;
    const k = 0.78 + n * 0.5;
    pos.setXYZ(i, x * k, y * k * 0.86, z * k); // slightly squashed: rocks sit
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  const h = Math.max(g.boundingBox.max.y - g.boundingBox.min.y, 0.001);
  g.scale(1 / h, 1 / h, 1 / h);
  g.computeBoundingBox();
  return g;
}

(async function boot() {
  try {
    const k = LITE_K;

    // ---- phase 1: everything the first picture needs -------------------------
    // The trees around the camp and the character. Distant LODs and the jungle
    // floor load AFTER the first frame is on screen (phase 2, at the bottom), so
    // the scene is interactive in ~8.7 MB instead of waiting on the full ~11 MB,
    // and the decode cost is spread instead of landing as one main-thread freeze.
    const models = await Promise.all(SPECIES.map((s) => loader.loadAsync(`/assets/trees/${s.slug}.glb`)));
    state.species = {};
    models.forEach((gltf, i) => {
      const s = SPECIES[i];
      const near = scatter(Math.round(s.near.n * k), s.near);
      const emergent = s.emergent ? scatter(Math.round(s.emergent.n * k), s.emergent) : [];
      const placements = emergent.length ? near.concat(emergent) : near;
      // Solid circles, used twice: the camera must not see through a trunk, and
      // the character must not walk through one. `top` is how high it reaches,
      // which is the one thing that decides whether a jump clears it.
      const low = LOW_OBSTACLE[s.slug];
      if (s.trunk) {
        for (const pl of placements) {
          trunkColliders.push({
            x: pl.x, z: pl.z,
            // Trunk radius grows with the cube-ish root of the overall scale, not
            // linearly: these trees now stand 12-39 m and must still be walkable
            // between (see SPECIES).
            r: s.trunk * Math.pow(pl.scale, 0.35),
            top: low === undefined ? Infinity : low * pl.scale,
          });
        }
      }
      const built = instancedFrom(gltf.scene, placements, { castShadow: s.shadow !== false });
      scene.add(built.group);
      built.group.userData.treeHeight = built.height;
      // Tallest in metres, measured rather than claimed — this is the number
      // behind "the forest needs tall trees too", and per species so the tall
      // layer can be checked rather than eyeballed.
      let speciesTop = 0;
      for (const pl of placements) {
        speciesTop = Math.max(speciesTop, built.height * (pl.sy || pl.scale));
      }
      state.speciesHeights = state.speciesHeights || {};
      state.speciesHeights[s.slug] = +speciesTop.toFixed(1);
      state.tallest = Math.max(state.tallest || 0, speciesTop);
      state.species[s.slug] = placements.length;
    });

    // Rocks in phase 1 too, so the things worth jumping are there from the first
    // frame rather than appearing under his feet later.
    const rockModels = await Promise.all(
      ROCKS.map((r) => (r.procedural ? null : loader.loadAsync(`/assets/trees/${r.slug}.glb`))),
    );
    rockModels.forEach((gltf, i) => {
      const r = ROCKS[i];
      const spots = scatter(Math.round(r.n * k), r);
      let source = gltf?.scene;
      if (r.procedural) {
        source = new THREE.Group();
        source.add(new THREE.Mesh(
          rockGeometry(i + 1),
          new THREE.MeshStandardMaterial({ color: 0x59604f, roughness: 0.94, metalness: 0 }),
        ));
      }
      const built = instancedFrom(source, spots, { castShadow: r.shadow, tally: 'rocks' });
      scene.add(built.group);
      built.group.userData.treeHeight = built.height;
      if (r.trunk) {
        for (const pl of spots) {
          trunkColliders.push({
            x: pl.x, z: pl.z, r: r.trunk * pl.scale,
            top: r.top * (pl.sy || pl.scale),
          });
        }
      }
    });

    buildUndergrowth();

    await loadCharacter();
    document.querySelectorAll('#toggle-shadows, #toggle-wind').forEach((btn) => {});
    document.getElementById('toggle-shadows').onclick = (e) => {
      state.shadows = !state.shadows;
      renderer.shadowMap.enabled = state.shadows;
      sun.castShadow = state.shadows;
      scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
      e.target.textContent = `shadows: ${state.shadows ? 'on' : 'off'}`;
    };
    document.getElementById('toggle-wind').onclick = (e) => {
      state.wind = !state.wind;
      for (const m of windMats) m.userData.wind.uStrength.value = state.wind ? 0.16 : 0;
      e.target.textContent = `wind: ${state.wind ? 'on' : 'off'}`;
    };
    // Jump on a button too, not just Space: this has to be usable on a phone.
    document.getElementById('btn-jump').onclick = () => { jumpQueued = true; };

    // Let the rig be detached: orbiting a static scene is sometimes what you
    // want, and the chase rig fights it.
    document.getElementById('toggle-follow').onclick = (e) => {
      metro.follow = !metro.follow;
      e.target.textContent = `follow: ${metro.follow ? 'on' : 'off'}`;
    };
    state.trunkColliders = trunkColliders; // harness hook for the occlusion test
    state.camLog = camLog;                 // harness hook: rig motion history

    // Clear the readout off the scene in one click (or H) when showing it to
    // someone: the stats are for us, the forest is for them.
    const hudEl = document.getElementById('hud');
    const hudBtn = document.getElementById('toggle-hud');
    const showHud = (visible) => {
      hudEl.style.display = visible ? '' : 'none';
      hudBtn.textContent = visible ? 'hide stats' : 'show stats';
      state.hudVisible = visible;
    };
    hudBtn.onclick = () => showHud(hudEl.style.display === 'none');
    addEventListener('keydown', (e) => { if (e.code === 'KeyH') showHud(hudEl.style.display === 'none'); });

    // Harness handles: let a test park the camera at a known bearing from the
    // character (used to settle which way the imported model actually faces).
    state.camera = camera;
    state.controls = controls;
    state.orbitTo = (yawDeg = 0, dist = 4.6, height = 1.6) => {
      const a = (yawDeg * Math.PI) / 180;
      const c = state.character;
      if (!c) return null;
      metro.follow = false;
      camera.position.set(c.position.x + Math.sin(a) * dist, c.position.y + height, c.position.z + Math.cos(a) * dist);
      controls.target.set(c.position.x, c.position.y + 1.05, c.position.z);
      controls.update();
      return { pos: camera.position.toArray().map((n) => +n.toFixed(2)), charYaw: +c.rotation.y.toFixed(3) };
    };
    /** World direction the model's local +Z axis points in (facing probe). */
    state.facing = () => {
      const c = state.character;
      if (!c) return null;
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion);
      return [+f.x.toFixed(3), +f.z.toFixed(3)];
    };

    el.loading.classList.add('hidden');
    state.ready = true;
    requestAnimationFrame(tick);

    // ---- phase 2: the far side of the forest and the jungle floor -----------
    // Deliberately after the first frame: the player is looking at a forest while
    // these stream in, rather than at a progress bar. Its own try/catch, because
    // a missing LOD tier is a note in the error list, not a failed load — the
    // scene is already up and playable at this point.
    try {
      const [farModels, under] = await Promise.all([
        Promise.all(SPECIES.map((s) => (s.far ? loader.loadAsync(`/assets/trees/${s.slug}_far.glb`) : null))),
        Promise.all(UNDERSTORY.map((s) => loader.loadAsync(`/assets/trees/${s.slug}.glb`))),
      ]);
      farModels.forEach((gltf, i) => {
        if (!gltf) return;
        const s = SPECIES[i];
        // farCap stops the LOD tiers at the far side of the fog: past that they
        // are painted over, and in the light profile they are not planted at all.
        const farCfg = { ...s.far, maxR: Math.min(s.far.maxR, Q.farCap) };
        const far = scatter(Math.round(s.far.n * k), farCfg);
        const builtFar = instancedFrom(gltf.scene, far, { castShadow: false });
        scene.add(builtFar.group);
        builtFar.group.userData.treeHeight = builtFar.height;
        state.species[s.slug] = (state.species[s.slug] || 0) + far.length;
      });

      // Jungle floor: instanced plants, no shadow casting, tallied separately so
      // the HUD can show the two layers apart.
      under.forEach((gltf, i) => {
        const u = UNDERSTORY[i];
        const spots = scatter(Math.round(u.n * k), u);
        const built = instancedFrom(gltf.scene, spots, { castShadow: false, tally: 'understory' });
        scene.add(built.group);
        built.group.userData.treeHeight = built.height;
      });

      // Asset budget: HEAD the shipped files and sum the real Content-Length.
      // performance resource timings report 0 for cached/opaque responses, which
      // would print a fake "0 MB"; this is the number a phone actually pulls.
      const files = [
        ...SPECIES.map((s) => `/assets/trees/${s.slug}.glb`),
        ...SPECIES.filter((s) => s.far).map((s) => `/assets/trees/${s.slug}_far.glb`),
        ...UNDERSTORY.map((s) => `/assets/trees/${s.slug}.glb`),
        ...ROCKS.filter((r) => !r.procedural).map((r) => `/assets/trees/${r.slug}.glb`),
        '/assets/char/soldier.glb',
      ];
      const heads = await Promise.all(files.map(async (f) => {
        try {
          const r = await fetch(f, { method: 'HEAD' });
          const n = Number(r.headers.get('content-length') || 0);
          if (n) return n;
        } catch { /* fall through to a measured read */ }
        try {
          // Vercel omits content-length on HEAD responses, and headless Chrome
          // does not populate resource timings, so metadata alone reports 0.
          // Measure the response instead: the loader just downloaded these GLBs,
          // so force-cache reuses that entry rather than fetching a second copy.
          const r = await fetch(f, { cache: 'force-cache' });
          return (await r.arrayBuffer()).byteLength;
        } catch { return 0; }
      }));
      state.texBytes = tooltipByteEstimate = heads.reduce((a, b) => a + b, 0);
      state.assetBytes = Object.fromEntries(files.map((f, i) => [f.split('/').pop(), heads[i]]));
      state.phase2 = true;
    } catch (err) {
      state.errors.push(`phase 2: ${err?.message || err}`);
    }
  } catch (err) {
    state.errors.push(`boot: ${err?.message || err}\n${err?.stack || ''}`);
    el.loading.innerHTML = `<div style="text-align:center;color:#ff8a7a">load failed:<br>${err?.message || err}</div>`;
  }
})();
