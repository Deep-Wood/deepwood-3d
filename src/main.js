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
  clip: 'Idle',
  texBytes: 0,
};
window.__proto3d = state;
window.addEventListener('error', (e) => state.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => state.errors.push(String(e.reason?.message || e.reason)));

/** Detail level from ?lite=N — ?lite=1 for weak devices, ?lite=2 to shrink the
 *  scene far enough for headless software-raster verification on a GPU-less
 *  box (where 6M triangles a frame takes tens of seconds). */
const LITE = Number(new URLSearchParams(location.search).get('lite') || 0);
const LITE_K = LITE >= 3 ? 0.05 : LITE === 2 ? 0.16 : LITE === 1 ? 0.42 : 1;
state.lite = LITE;
// ?lite=3 is for automated runs only: a software rasteriser (no GPU) can spend
// seconds on a single full-quality frame, which starves the JS thread and makes
// the harness time out before it can assert anything.
const NO_SHADOWS = LITE >= 3;

const app = document.getElementById('app');
const el = {
  fps: document.getElementById('fps'),
  calls: document.getElementById('calls'),
  tris: document.getElementById('tris'),
  trees: document.getElementById('trees'),
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
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(LITE >= 3 ? 0.5 : LITE === 2 ? 0.75 : LITE === 1 ? 1 : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = !NO_SHADOWS;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 500);
camera.position.set(5.4, 2.9, 7.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 4;
controls.maxDistance = 46;
controls.maxPolarAngle = Math.PI * 0.495;
controls.target.set(0, 1.4, 0);

// ----------------------------------------------------------------- sky -----
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    topColor: { value: new THREE.Color(0x24405f) },
    midColor: { value: new THREE.Color(0x7d94a6) },
    horizon: { value: new THREE.Color(0xcfc09a) },
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
      col += vec3(1.0, 0.86, 0.6) * sun * 1.5 + vec3(1.0, 0.8, 0.55) * halo;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(320, 32, 16), skyMat);
scene.add(sky);
scene.fog = new THREE.Fog(0x8fa0a6, 70, 320);

// --------------------------------------------------------------- lights ----
// Sun behind-left of the default camera so the character reads front-lit.
const sunDir = new THREE.Vector3(-0.55, 0.48, 0.68).normalize();
const sun = new THREE.DirectionalLight(0xffe6bd, 2.7);
sun.castShadow = true;
const SHADOW_MAP = LITE >= 3 ? 256 : LITE === 2 ? 512 : LITE === 1 ? 1024 : 2048;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 140;
sun.shadow.camera.left = -34;
sun.shadow.camera.right = 34;
sun.shadow.camera.top = 34;
sun.shadow.camera.bottom = -34;
sun.shadow.bias = -0.0012;
sun.shadow.normalBias = 0.035;
scene.add(sun);
scene.add(sun.target);

const hemi = new THREE.HemisphereLight(0xbcd3e8, 0x2f3a25, 1.05);
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
const SEG = LITE >= 3 ? 48 : LITE === 2 ? 90 : LITE === 1 ? 140 : 240;
const groundGeo = new THREE.PlaneGeometry(GROUND, GROUND, SEG, SEG);
groundGeo.rotateX(-Math.PI / 2);
{
  const pos = groundGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cDirt = new THREE.Color(0x4a3a24);
  const cMoss = new THREE.Color(0x35492a);
  const cGrass = new THREE.Color(0x44613a);
  const cStone = new THREE.Color(0x6b6f66);
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
function instancedFrom(gltfScene, placements) {
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
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    group.add(inst);
    state.trees += placements.length;
  }

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isInstancedMesh) return;
    placements.forEach((pl, i) => {
      p.set(pl.x, heightAt(pl.x, pl.z) - 0.05, pl.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pl.rot);
      s.setScalar(pl.scale);
      m4.compose(p, q, s);
      o.setMatrixAt(i, m4);
    });
    o.instanceMatrix.needsUpdate = true;
  });
  return { group, height };
}

/** Poisson-ish scatter: reject spots too close together or in the clearing. */
function scatter(count, { minR = 11, maxR = 68, minDist = 3.4, tries = 22, scale = [0.8, 1.5] }) {
  const spots = [];
  for (let i = 0; i < count; i++) {
    for (let t = 0; t < tries; t++) {
      const a = vnoise(i * 3.1 + t, 7.7) * Math.PI * 2;
      const r = minR + vnoise(i * 1.7 + t, 19.3) * (maxR - minR);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const density = vnoise(x * 0.08 + 5, z * 0.08 - 3);
      if (density < 0.42) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < minDist)) continue;
      spots.push({
        x, z,
        rot: vnoise(i + t, 42) * Math.PI * 2,
        scale: scale[0] + vnoise(i * 2.3 + t, 91) * (scale[1] - scale[0]),
      });
      break;
    }
  }
  return spots;
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
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
document.querySelectorAll('button.clip[data-clip]').forEach((b) => {
  b.addEventListener('click', () => setClip(b.dataset.clip));
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
  el.api.textContent = renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1';
  el.gpuhint.textContent = navigator.gpu ? 'available' : 'no';
  el.tex.textContent = tooltipByteEstimate ? `${(tooltipByteEstimate / 1048576).toFixed(1)} MB` : 'n/a';
  el.perf.textContent = fpsAvg < 25
    ? `note: ${fpsAvg.toFixed(1)} fps at ${renderer.info.render.calls} draw calls — this box is a 4-vCPU cloud VM with no GPU (software raster), not a hardware measure.`
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
    const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = run ? 4.6 : 1.7;
    move.set(
      (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
      0,
      (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0),
    );
    if (move.lengthSq() > 0) {
      move.normalize();
      const yaw = Math.atan2(move.x, move.z);
      character.rotation.y = THREE.MathUtils.lerp(character.rotation.y, character.rotation.y + ((yaw - character.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI, 0.15);
      const nx = THREE.MathUtils.clamp(character.position.x + move.x * speed * dt, -68, 68);
      const nz = THREE.MathUtils.clamp(character.position.z + move.z * speed * dt, -68, 68);
      character.position.set(nx, heightAt(nx, nz), nz);
      setClip(run ? 'Run' : 'Walk');
    } else {
      setClip('Idle');
    }
    if (metro.follow) {
      controls.target.lerp(new THREE.Vector3(character.position.x, character.position.y + 1.15, character.position.z), 0.08);
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

// ------------------------------------------------------------------ boot ---
/**
 * The forest. Five real models, each decimated from a Poly Haven CC0 scan:
 * pine shrub and searsia (conifer-ish cover), quiver tree (broadleaf), plus a
 * stump and a dead trunk — the "depleted node" states the game needs.
 */
const SPECIES = [
  { slug: 'pine_sapling_small',  n: 190, scatter: { minR: 10.2, maxR: 150, minDist: 3.0, scale: [0.9, 2.1] } },
  { slug: 'quiver_tree_01',      n: 70,  scatter: { minR: 12.5, maxR: 140, minDist: 6.5, scale: [0.9, 1.6] } },
  { slug: 'searsia_lucida',      n: 110, scatter: { minR: 10.0, maxR: 130, minDist: 2.4, scale: [0.9, 1.7] } },
  { slug: 'tree_stump_01',       n: 22,  scatter: { minR: 9, maxR: 70, minDist: 5.0, scale: [0.9, 1.3] } },
  { slug: 'dead_tree_trunk_02',  n: 18,  scatter: { minR: 14, maxR: 110, minDist: 8.0, scale: [1.0, 1.6] } },
];

(async function boot() {
  try {
    const k = LITE_K;
    const models = await Promise.all(
      SPECIES.map((s) => loader.loadAsync(`/assets/trees/${s.slug}.glb`)),
    );
    state.species = {};
    models.forEach((gltf, i) => {
      const s = SPECIES[i];
      const placements = scatter(Math.round(s.n * k), s.scatter);
      const built = instancedFrom(gltf.scene, placements);
      scene.add(built.group);
      state.species[s.slug] = placements.length;
      built.group.userData.treeHeight = built.height;
    });

    // Asset budget: HEAD the shipped files and sum the real Content-Length.
    // performance resource timings report 0 for cached/opaque responses, which
    // would print a fake "0 MB"; this is the number a phone actually pulls.
    const files = [
      ...SPECIES.map((s) => `/assets/trees/${s.slug}.glb`),
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

    el.loading.classList.add('hidden');
    state.ready = true;
    requestAnimationFrame(tick);
  } catch (err) {
    state.errors.push(`boot: ${err?.message || err}\n${err?.stack || ''}`);
    el.loading.innerHTML = `<div style="text-align:center;color:#ff8a7a">load failed:<br>${err?.message || err}</div>`;
  }
})();
