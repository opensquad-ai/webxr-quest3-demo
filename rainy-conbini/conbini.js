// 星轨小屋 · Blender house VR walkthrough with interactive props
//
// Geometry: house-vr/scripts/01..07 (headless Blender). Collision, walkable
// surfaces and every interactable prop are derived from house_params.py through
// colliders.json, so the physics can never drift away from the mesh.
//
// Rendering: the shell carries one vertex colour per face (its material colour),
// so it needs no texture at all. MeshLambertMaterial lights those colours with a
// hemisphere light plus the seven switchable point lights, which is why toggling a
// lamp changes the walls around it and not just the lamp shade.
//
// Coordinates: colliders.json is authored in Blender (x, y, z-up); glTF is Y-up,
// so every box is converted once at load:
//   three.x = bl.x,  three.y = bl.z,  three.z = -bl.y
// No vertical offset is applied anywhere: the house floor really is at y=0.42, so
// the player's feet ride there via dolly.position.y. Shifting one side only would
// sink the player into the floor.

import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const WALK_RADIUS = 0.28;
const PLAYER_HEIGHT = 1.75;
const EYE_HEIGHT = 1.65;          // used when the runtime gives no floor reference
const WALK_SPEED = 1.9;
const TURN_DEG = 30;
const REACH = 2.6;                 // how far a held prop may be carried from the head
const GRAVITY = 9.8;
const MAX_FALL_TIME = 3.0;        // a released prop never stays airborne longer than this

const el = {
  hud: document.getElementById('hud'),
  enter: document.getElementById('enter'),
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  overlay: document.getElementById('overlay'),
  mode: document.getElementById('modeTag'),
  room: document.getElementById('roomTag'),
  hint: document.getElementById('hintTag'),
  fab: document.getElementById('vrFab'),
};

function log(msg) {
  el.log.textContent = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  console.log('[house]', msg);
}

// ---------------------------------------------------------------- scene setup
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// A ceiling point light sits <1 m above the ceiling plane, so raw linear output
// blows it to flat white. ACES keeps the highlight rolloff and the slight
// exposure lift restores the mid-tones.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// A cut-out of a city at night: deep navy, fog closing in, no skyline. The lit
// shopfront is meant to be the only thing that reads at distance.
const NIGHT = 0x070b14;
scene.background = new THREE.Color(NIGHT);
scene.fog = new THREE.Fog(NIGHT, 16, 52);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 140);
const dolly = new THREE.Group();
dolly.add(camera);
scene.add(dolly);

const world = new THREE.Group();      // holds the loaded house + props
scene.add(world);

// Base fill for the whole shell. Down-facing surfaces (every ceiling) read the
// ground colour outright, so it is a warm light grey rather than the near-black
// of open ground - otherwise every ceiling renders as stained wood.
const hemi = new THREE.HemisphereLight(0x5c7398, 0x0c1018, 0.62);
scene.add(hemi);
// A weak moon. Roofs and the road are horizontal, so the hemisphere's sky term is
// all they get and they sank to black; a directional light puts them back without
// brightening the vertical faces the shopfront already lights.
const moon = new THREE.DirectionalLight(0x9db2d4, 0.95);
moon.position.set(-14, 28, 12);
scene.add(moon);
const fill = new THREE.AmbientLight(0x8296b4, 0.12);
scene.add(fill);

// The lamp energies in colliders.json are authored for a path-traced bake; in a
// Lambert shader a ceiling light 0.6 m from the ceiling at 26 cd is ~70x over
// white. Scale them at build time instead of editing the shared source of truth.
const LAMP_SCALE = 0.62;

const state = {
  phase: 'loading', mode: 'teleport', feetY: 0, floorZ: 0, stepMax: 0.2,
  boxes: [], floors: [], rooms: [], hover: null, held: null,
  teleports: 0, blocked: 0, interactions: 0, usingFloor: true,
  props: {}, lampsOn: 0, inputs: [], lastIntent: null, eyeLift: null,
  btnA: false, btnB: false,
  view: 'orbit',   // 'orbit' = the diorama view, 'first' = standing inside
};

// ------------------------------------------------------------------- loading
// Nothing is serialised: the GLB and both JSON files start together. There is no
// atlas any more - the shell carries its colours as vertex colours, which removed
// a 222 KB image that took 26 s to arrive on a throttled link.
const setLoad = (msg) => {
  const o = document.getElementById('overlay');
  if (o) o.textContent = msg;
};
const done = {};
const mark = (what) => { done[what] = true; setLoad('加载中：' + Object.keys(done).join(' · ') + ' …'); };

const worldJsonP = fetch('./colliders.json').then((r) => r.json());
const modelJsonP = fetch('./model.json').then((r) => r.json());
setLoad('加载中：碰撞数据 · 模型 …');
const gltfP = new Promise((resolve, reject) => {
  new GLTFLoader().load('./conbini.glb', resolve,
    (e) => { if (e.lengthComputable) setLoad(`加载中：房屋模型 ${Math.round(e.loaded / e.total * 100)}% …`); },
    reject);
});

const [worldJson, modelJson, gltf] =
  await Promise.all([worldJsonP, modelJsonP, gltfP]);
['碰撞', '模型'].forEach(mark);
state.floorZ = worldJson.meta.floor_z;
state.stepMax = worldJson.meta.step_max;

const SHIFT = 0;
const toThree = (b) => ({
  x0: b.x[0], x1: b.x[1], z0: -b.y[1], z1: -b.y[0],
  y0: b.z[0] + SHIFT, y1: b.z[1] + SHIFT, kind: b.kind, name: b.name,
});
state.boxes = worldJson.boxes.map(toThree);
state.floors = worldJson.floors.map((f) => {
  const t = toThree({ x: f.x, y: f.y, z: [f.z, f.z] });
  return { name: f.name, x0: t.x0, x1: t.x1, z0: t.z0, z1: t.z1, y: t.y0 };
});
state.rooms = Object.entries(worldJson.rooms).map(([k, r]) => ({
  key: k, label: r.label, x0: r.x[0], x1: r.x[1], z0: -r.y[1], z1: -r.y[0], y: r.z + SHIFT,
}));

const houseMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const groundMat = new THREE.MeshLambertMaterial({ map: makeGroundTexture() });
// Shop windows: barely-there so the lit interior reads through them.
const glassMat = new THREE.MeshBasicMaterial({
  color: 0xa8c4dc, transparent: true, opacity: 0.15, depthWrite: false,
});
// The sliding doors are the one piece of glass that has to be *visible* - at night a
// transparent panel reads as a hole, which is why "there is no door" was a fair
// complaint. Dark, semi-reflective glass with a lit handle is legible at any angle.
const doorGlassMat = new THREE.MeshLambertMaterial({
  color: 0x40536a, transparent: true, opacity: 0.74, depthWrite: false,
});

const propMeshes = [];
gltf.scene.traverse((o) => {
  if (o.type !== 'Mesh') return;
  o.frustumCulled = false;
  if (o.name === 'Web_Conbini') o.material = houseMat;
  else if (o.name === 'Ground') o.material = groundMat;
  else if (o.name.startsWith('Glass_')) o.material = glassMat;
  else if (o.name.startsWith('Itc_')) {
    const id = o.name.slice(4);
    const spec = worldJson.interactables.find((i) => i.id === id);
    o.material = (spec && spec.glass)
      ? (id.startsWith('auto_door') ? doorGlassMat : glassMat)
      : new THREE.MeshLambertMaterial({ color: new THREE.Color(...(spec ? spec.color : [0.7, 0.7, 0.7])) });
    o.userData.propId = id;
    propMeshes.push(o);
  }
});
world.add(gltf.scene);

// ------------------------------------------------------------------ rain & sign
// Steady autumn rain as line segments: each drop is one short quad of two vertices,
// cheap enough to update on the CPU and it reads far better than round points.
function makeRain(count) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 6);
  const speed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = (Math.random() - 0.5) * 34;
    const z = (Math.random() - 0.5) * 34;
    const y = Math.random() * 14;
    const len = 0.30 + Math.random() * 0.26;
    pos[i * 6 + 0] = x;      pos[i * 6 + 1] = y;       pos[i * 6 + 2] = z;
    pos[i * 6 + 3] = x + 0.015; pos[i * 6 + 4] = y - len; pos[i * 6 + 5] = z;
    speed[i] = 7 + Math.random() * 5;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x9fc0e0, transparent: true,
                                            opacity: 0.095, depthWrite: false });
  const rain = new THREE.LineSegments(geo, mat);
  rain.frustumCulled = false;
  rain.userData.speed = speed;
  return rain;
}

// the shopfront is the light source of the whole corner: a broad warm spill in
// front of the doors is what makes the wet asphalt glow in the reference image
const spill = new THREE.PointLight(0xffb066, 6.5, 12.0, 2.0);
spill.position.set(0, 2.3, 1.6);
scene.add(spill);

const rain = makeRain(760);
scene.add(rain);

// Wet road. A planar Reflector renders the whole scene a second time and, with no
// Fresnel term, mirrors the shopfront straight down into the player's feet - from
// eye height that reads as a second shop rather than a wet street. A soft additive
// glow on the asphalt is what the reference actually shows: the light smears, the
// geometry does not.
function makeWetGlow() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 150, 10, 128, 150, 128);
  grd.addColorStop(0.0, 'rgba(255,196,140,0.95)');
  grd.addColorStop(0.35, 'rgba(255,170,110,0.42)');
  grd.addColorStop(1.0, 'rgba(255,150,90,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const wetGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(34, 11),
  new THREE.MeshBasicMaterial({
    map: makeWetGlow(), transparent: true, opacity: 0.17,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }),
);
wetGlow.rotation.x = -Math.PI / 2;
wetGlow.position.set(0, 0.02, 4.6);      // spills from the doors out onto the road
scene.add(wetGlow);

function stepRain(dt) {
  const attr = rain.geometry.attributes.position;
  const a = attr.array;
  const sp = rain.userData.speed;
  for (let i = 0; i < sp.length; i++) {
    const dy = sp[i] * dt;
    a[i * 6 + 1] -= dy;
    a[i * 6 + 4] -= dy;
    if (a[i * 6 + 4] < -0.6) {
      const len = a[i * 6 + 1] - a[i * 6 + 4];
      const y = 12 + Math.random() * 4;
      a[i * 6 + 1] = y;
      a[i * 6 + 4] = y - len;
    }
  }
  attr.needsUpdate = true;
}

// The invented brand lives on a canvas texture: vertex colours cannot carry text,
// and a lit sign needs to be emissive anyway.
function makeSignTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '#edf1f2'; g.fillRect(0, 0, 1024, 96);
  g.fillStyle = '#12332c';
  g.fillRect(0, 0, 118, 96);
  g.fillStyle = '#eef2f4';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 44px system-ui, sans-serif';
  g.fillText('24', 59, 50);
  g.fillStyle = '#143a31';
  g.font = 'bold 52px system-ui, sans-serif';
  g.fillText('MORI MART', 566, 50);   // centred in the white field right of the 24 block
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const signFace = new THREE.Mesh(
  new THREE.PlaneGeometry(9.2, 0.74),
  new THREE.MeshBasicMaterial({ map: makeSignTexture(), toneMapped: false }),
);
signFace.position.set(-1.0, 3.45, 0.03);   // +z is toward the street
world.add(signFace);

// teleport / drop proxies: one invisible plane per walkable surface
const proxy = new THREE.Group();
for (const f of state.floors) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(f.x1 - f.x0, f.z1 - f.z0),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set((f.x0 + f.x1) / 2, f.y, (f.z0 + f.z1) / 2);
  m.userData.floor = f;
  proxy.add(m);
}
world.add(proxy);

function makeGroundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#4c5c3a';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2800; i++) {
    const s = 40 + Math.random() * 70;
    g.fillStyle = `rgba(${s + 30},${s + 55},${s},${0.25 + Math.random() * 0.3})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(26, 22);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------- prop registry
const boxOf = (o) => {
  if (!o.userData.bb) o.userData.bb = new THREE.Box3().setFromObject(o);
  return o.userData.bb;
};

for (const mesh of propMeshes) {
  const id = mesh.userData.propId;
  const spec = worldJson.interactables.find((i) => i.id === id);
  const rec = {
    id, spec, mesh, kind: spec.kind, label: spec.label,
    home: mesh.position.clone(),
    homeQuat: mesh.quaternion.clone(),
    value: 0, open: false, on: spec.kind !== 'toggle' ? null : (spec.id === 'tv' ? false : true),
    held: null, vel: new THREE.Vector3(), free: false, freeFor: 0,
  };
  // Half-height measured once, at build time. Recomputing a Box3 per frame after
  // release returned a box cached at the prop's original position, so a dropped
  // prop could settle at the wrong height or never settle at all.
  if (!mesh.userData.bb) mesh.userData.bb = new THREE.Box3().setFromObject(mesh);
  rec.half = (mesh.userData.bb.max.y - mesh.userData.bb.min.y) / 2;
  // Offset from the prop origin up to just above its box, used to park the aim
  // label over the object rather than at its pivot.
  rec.hintY = mesh.userData.bb.max.y - mesh.position.y + 0.12;
  if (spec.kind === 'hinge') rec.axis = new THREE.Vector3(0, 1, 0);
  if (spec.kind === 'slide') rec.dir = new THREE.Vector3(spec.dir[0], 0, -spec.dir[1]).normalize();
  if (spec.light) {
    const room = state.rooms.find((r) => r.label === worldJson.rooms[spec.light.room].label);
    const bb = boxOf(mesh);
    const light = new THREE.PointLight(0xffd9a8, spec.light.energy * LAMP_SCALE, 13.0, 2);
    light.position.set(bb.min.x + (bb.max.x - bb.min.x) / 2, bb.min.y - 0.12,
                       bb.min.z + (bb.max.z - bb.min.z) / 2);
    light.userData.base = spec.light.energy * LAMP_SCALE;
    scene.add(light);
    rec.light = light;
    rec.on = true;
    state.lampsOn += 1;
  }
  state.props[id] = rec;
}
setLamp('lamp_living', true);       // apply initial on/off look

// ------------------------------------------------------------- diorama camera
// The reference material is an isometric miniature, while the VR requirement is
// first person. Both views run off the same scene: this rig frames the block the
// way the reference does, and pressing V (or the button) drops you into the street.
const orbit = { radius: 23, theta: 0.62, phi: 1.06, target: new THREE.Vector3(-1.0, 2.1, -3.6) };
const ORBIT_MIN_R = 14, ORBIT_MAX_R = 62;

function orbitPosition(out) {
  const sp = Math.sin(orbit.phi), cp = Math.cos(orbit.phi);
  return out.set(
    orbit.target.x + orbit.radius * sp * Math.sin(orbit.theta),
    orbit.target.y + orbit.radius * cp,
    orbit.target.z + orbit.radius * sp * Math.cos(orbit.theta),
  );
}

function applyOrbit() {
  dolly.position.set(0, 0, 0);
  dolly.rotation.set(0, 0, 0);
  orbitPosition(camera.position);
  camera.lookAt(orbit.target);
}

// applyOrbit() zeroes the dolly every frame (the diorama camera works in world
// space), so the standing pose has to be parked somewhere or pressing F drops you
// wherever the last frame left the rig - which is the shop doorway, not the street.
const firstPose = { x: 0, z: 6, yaw: 0, pitch: 0, set: false };

function saveFirstPose() {
  firstPose.x = dolly.position.x;
  firstPose.z = dolly.position.z;
  firstPose.yaw = yaw;
  firstPose.pitch = pitch;
  firstPose.set = true;
}

function setView(mode) {
  if (mode === state.view) return;
  if (state.view === 'first') saveFirstPose();
  state.view = mode;
  if (mode === 'orbit') {
    // a miniature reads better with the fog pushed back
    scene.fog.near = 26; scene.fog.far = 95;
    log('俯瞰模式（拖动旋转 · 滚轮缩放 · F 进入街道）');
  } else {
    scene.fog.near = 16; scene.fog.far = 52;
    const px = firstPose.set ? firstPose.x : startX;
    const pz = firstPose.set ? firstPose.z : startZ;
    yaw = firstPose.yaw;
    pitch = firstPose.pitch;
    dolly.position.set(px, 0, pz);
    const g = groundAt(px, pz, 1.0);
    state.feetY = g ? g.y : 0;
    camera.position.set(0, 1.6, 0);
    log('第一人称（WASD 走动 · 拖动转视角 · F 回到俯瞰）');
  }
}

// ------------------------------------------------------------------- controls
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
// Scratch objects for the per-frame prop update. Allocating a few Vector3 per
// frame per held prop is what makes the room hitch as soon as you pick something up.
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpQ2 = new THREE.Quaternion();
const tmpQ3 = new THREE.Quaternion();
const raycaster = new THREE.Raycaster();

const controllers = [0, 1].map((index) => {
  const obj = renderer.xr.getController(index);
  const grip = renderer.xr.getControllerGrip(index);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x8ff0c8 }),
  );
  ray.scale.z = 4.0;
  obj.add(ray);
  dolly.add(obj);
  dolly.add(grip);
  grip.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.12),
                          new THREE.MeshBasicMaterial({ color: 0x223044 })));
  const info = { index, obj, grip, ray, gamepad: null, hand: 'none',
                 active: false, hover: null, held: null, hoverAt: -1 };
  // three.js dispatches XR events without setting event.currentTarget, so every
  // handler closes over `info` instead of reading it off the event.
  obj.addEventListener('connected', (e) => {
    info.gamepad = e.data.gamepad || null;
    info.hand = e.data.handedness || 'none';
    info.active = true;
    log(`手柄已连接: ${e.data.handedness}`);
  });
  obj.addEventListener('disconnected', () => { info.active = false; info.gamepad = null; info.hand = 'none'; });
  obj.addEventListener('selectstart', () => onSelectStart(info));
  obj.addEventListener('selectend', () => onSelectEnd(info));
  obj.addEventListener('squeezestart', () => recenter());
  return info;
});

const marker = new THREE.Group();
{
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.12, 0.2, 28).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x2ee6a8, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  marker.add(ring);
  marker.visible = false;
  scene.add(marker);
}

// ------------------------------------------------------- floating hint label
// A label pinned above whatever you are aiming at. The wrist panel carries the
// same text, but it is easy to miss with your hand down by your side, and the
// whole point of the prompt is telling you the trigger does something.
const hintCanvas = document.createElement('canvas');
hintCanvas.width = 512; hintCanvas.height = 128;
const hctx = hintCanvas.getContext('2d');
const hintTex = new THREE.CanvasTexture(hintCanvas);
hintTex.colorSpace = THREE.SRGBColorSpace;
const hintSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: hintTex, transparent: true, depthTest: false, depthWrite: false,
}));
hintSprite.scale.set(0.62, 0.155, 1);
hintSprite.renderOrder = 999;
hintSprite.visible = false;
scene.add(hintSprite);

let hintText = '';
let hintUntil = 0;
let hintTarget = null;

function drawHint(text) {
  if (text === hintText) return;
  hintText = text;
  hctx.clearRect(0, 0, 512, 128);
  if (text) {
    hctx.fillStyle = 'rgba(8,14,28,0.88)';
    hctx.beginPath();
    if (hctx.roundRect) hctx.roundRect(6, 20, 500, 88, 44); else hctx.rect(6, 20, 500, 88);
    hctx.fill();
    hctx.strokeStyle = 'rgba(46,230,168,0.8)';
    hctx.lineWidth = 3;
    hctx.stroke();
    hctx.fillStyle = '#eaf6ff';
    hctx.font = 'bold 38px system-ui, sans-serif';
    hctx.textAlign = 'center';
    hctx.textBaseline = 'middle';
    hctx.fillText(text, 256, 64);
  }
  hintTex.needsUpdate = true;
}

// sticky = keep showing for `seconds` even after the crosshair moves away.
function showHint(text, rec, seconds) {
  drawHint(text);
  hintTarget = rec || null;
  hintUntil = performance.now() + (seconds || 0) * 1000;
  hintSprite.visible = !!text;
}

function verbFor(rec) {
  if (rec.kind === 'toggle') return rec.id === 'tv' ? '换台' : (rec.on ? '关灯' : '开灯');
  if (rec.kind === 'grab') return '拿起';
  return rec.open ? '关闭' : '打开';
}

// ------------------------------------------------------------ input debug card
// Shown with ?debug=1. It prints what the runtime actually reports for each
// controller, so "the stick does nothing" can be told apart from "the stick never
// reached the page". Pinned to the lower right of the view.
const dbgCanvas = document.createElement('canvas');
dbgCanvas.width = 640; dbgCanvas.height = 200;
const dctx = dbgCanvas.getContext('2d');
const dbgTex = new THREE.CanvasTexture(dbgCanvas);
dbgTex.colorSpace = THREE.SRGBColorSpace;
const dbgSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: dbgTex, transparent: true, depthTest: false, depthWrite: false,
}));
dbgSprite.scale.set(0.58, 0.18, 1);
dbgSprite.renderOrder = 1002;
dbgSprite.visible = false;
scene.add(dbgSprite);

const DEBUG = new URLSearchParams(location.search).has('debug');
let dbgAt = 0;

function drawDebug() {
  const rows = (state.inputs && state.inputs.length) ? state.inputs : [];
  dctx.clearRect(0, 0, 640, 200);
  dctx.fillStyle = 'rgba(0,0,0,0.72)';
  dctx.fillRect(0, 0, 640, 200);
  dctx.fillStyle = '#2ee6a8';
  dctx.font = 'bold 26px monospace';
  dctx.fillText('input debug', 14, 34);
  dctx.font = '22px monospace';
  dctx.fillStyle = '#e8eefc';
  dctx.fillText('        a0    a1    a2    a3   btn', 14, 72);
  let y = 106;
  for (const i of rows) {
    dctx.fillStyle = i.hand === 'right' ? '#ffd479' : '#8ff0c8';
    dctx.fillText(`${i.hand === 'right' ? 'R' : 'L'}  ` +
      i.a.map((v) => String(v).padStart(5)).join(' ') + `   ${i.b}`, 14, y);
    y += 34;
  }
  if (!rows.length) {
    dctx.fillStyle = '#ff8080';
    dctx.fillText('no gamepad reported', 14, 110);
  }
  dctx.fillStyle = '#7f9bc9';
  dctx.font = '20px monospace';
  dctx.fillText(`head y ${(state.poseY || 0).toFixed(2)}  lift ${(state.eyeLift || 0).toFixed(2)}  ` +
    `feet ${(state.feetY || 0).toFixed(2)}`, 14, 158);
  dctx.fillText(`move ${state.lastIntent ? state.lastIntent.mx.toFixed(2) + ',' + state.lastIntent.mz.toFixed(2) : '-'}  turn ${state.lastIntent ? state.lastIntent.turn.toFixed(2) : '-'}`, 14, 186);
  dbgTex.needsUpdate = true;
}

function updateDebug() {
  if (!renderer.xr.isPresenting) { dbgSprite.visible = false; return; }
  const now = performance.now();
  // Auto-shows for the first few seconds of a session so the reported stick values
  // can be read without editing the URL (the APK start URL is fixed anyway).
  if (!DEBUG && now > (state.dbgUntil || 0)) { dbgSprite.visible = false; return; }
  if (now - dbgAt < 200) { return; }
  dbgAt = now;
  drawDebug();
  headCam().getWorldPosition(tmpV);
  headCam().getWorldQuaternion(tmpQ);
  tmpV2.set(0.34, -0.26, -0.9).applyQuaternion(tmpQ).add(tmpV);
  dbgSprite.position.copy(tmpV2);
  dbgSprite.visible = true;
}

function updateHint(hoverRec) {
  const now = performance.now();
  if (now > hintUntil) {
    hintTarget = hoverRec || null;
    if (hoverRec) showHint(`扳机 · ${verbFor(hoverRec)}`, hoverRec, 0);
    else { hintSprite.visible = false; hintText = ''; return; }
  }
  if (!hintSprite.visible) return;
  if (hintTarget && hintTarget.mesh) {
    // Prop origins sit at the floor (the geometry is built relative to y=0), so the
    // raw position put the label on the floor instead of over the drawer.
    hintTarget.mesh.getWorldPosition(tmpV);
    hintSprite.position.copy(tmpV);
    hintSprite.position.y += hintTarget.hintY || 0.3;
  } else {
    headCam().getWorldPosition(tmpV);
    hintSprite.position.copy(tmpV).setY(tmpV.y + 0.1);
  }
}

// ------------------------------------------------------------- intro panel
const introCanvas = document.createElement('canvas');
introCanvas.width = 768; introCanvas.height = 512;
{
  const g = introCanvas.getContext('2d');
  g.fillStyle = 'rgba(10,17,32,0.94)';
  if (g.roundRect) { g.beginPath(); g.roundRect(0, 0, 768, 512, 28); g.fill(); }
  else g.fillRect(0, 0, 768, 512);
  g.strokeStyle = 'rgba(46,230,168,0.5)'; g.lineWidth = 4; g.stroke();
  g.textAlign = 'center';
  g.fillStyle = '#ffc27a'; g.font = 'bold 46px system-ui, sans-serif';
  g.fillText('雨夜便利店', 384, 84);
  g.fillStyle = '#8fa6c4'; g.font = '23px system-ui, sans-serif';
  g.fillText('MORI MART · 街角', 384, 122);
  g.textAlign = 'left';
  const rows = [
    ['右摇杆', '前后左右走动'],
    ['左摇杆左右', '原地转身'],
    ['扳机', '开门 / 开冰柜 / 开关灯'],
    ['扳机指地面', '瞬移到该处'],
    ['方向不对', '右手 A 翻前后 · 左手 X 翻转向'],
  ];
  let y = 186;
  for (const [k, v] of rows) {
    g.fillStyle = '#ffc27a'; g.font = 'bold 29px system-ui, sans-serif';
    g.fillText(k, 64, y);
    g.fillStyle = '#e8eefc'; g.font = '27px system-ui, sans-serif';
    g.fillText(v, 306, y);
    y += 50;
  }
  g.textAlign = 'center';
  g.fillStyle = '#7fd6a8'; g.font = 'bold 27px system-ui, sans-serif';
  g.fillText('走到门口 · 门自动开 · 按扳机开始', 384, 470);
}
const introTex = new THREE.CanvasTexture(introCanvas);
introTex.colorSpace = THREE.SRGBColorSpace;
const intro = new THREE.Mesh(
  new THREE.PlaneGeometry(1.02, 0.68),
  new THREE.MeshBasicMaterial({ map: introTex, transparent: true, depthTest: false, depthWrite: false }),
);
intro.renderOrder = 1000;
intro.visible = false;
scene.add(intro);

function placeIntro() {
  headCam().getWorldPosition(tmpV);
  headCam().getWorldQuaternion(tmpQ);
  tmpV2.set(0, 0, -1).applyQuaternion(tmpQ);
  intro.position.copy(tmpV).addScaledVector(tmpV2, 1.35);
  intro.lookAt(tmpV);
}


let aiming = null;
let aimTp = null;

// Cached once: getObjectByName() walked the whole scene on every controller, every
// frame, and then raycast 1649 triangles of house shell twice per frame. That was
// the stutter - it got worse the moment you grabbed something, because the hover
// pass kept running while the physics step also allocated per frame.
let houseMesh = null;
function getHouseMesh() {
  if (!houseMesh) houseMesh = world.getObjectByName('Web_Conbini');
  return houseMesh;
}

const RAY_DIR = new THREE.Vector3();
const HOVER_EVERY = 3;          // frames between hover raycasts, per hand
let frameNo = 0;

function hitFor(info, wantWall) {
  info.obj.getWorldPosition(tmpV);
  info.obj.getWorldQuaternion(tmpQ);
  RAY_DIR.set(0, 0, -1).applyQuaternion(tmpQ).normalize();
  raycaster.set(tmpV, RAY_DIR);
  raycaster.far = 12;
  // Aiming at props only needs the 18 prop meshes. The shell is only tested when
  // a teleport needs to know where the wall is, which happens on release.
  const prop = raycaster.intersectObjects(propMeshes, false)[0];
  if (!wantWall) {
    return prop ? { type: 'prop', rec: state.props[prop.object.userData.propId], distance: prop.distance } : null;
  }
  const house = getHouseMesh();
  const wall = house ? raycaster.intersectObject(house, false)[0] : null;
  if (prop && (!wall || prop.distance < wall.distance + 0.05)) {
    return { type: 'prop', rec: state.props[prop.object.userData.propId], distance: prop.distance };
  }
  if (wall) return { type: 'wall', distance: wall.distance };
  return null;
}

function onSelectStart(info) {
  // The intro panel eats the first trigger press, so you dismiss it and act with
  // the same button instead of hunting for a separate one.
  if (intro && intro.visible) {
    intro.visible = false;
    state.introDone = true;
    log('操作面板已关闭');
    return;
  }
  const hit = hitFor(info);
  if (hit && hit.type === 'prop' && hit.rec) {
    const rec = hit.rec;
    if (rec.kind === 'toggle') { actToggle(rec); return; }
    // Doors, wardrobe doors and drawers open on a trigger tap. Dragging them with
    // a held trigger worked, but it read as "nothing happens" because the object
    // only moves while you keep pressing and waving your arm.
    if (rec.kind === 'hinge' || rec.kind === 'slide') { actuate(rec); return; }
    info.held = rec;
    state.held = rec;
    rec.held = info;
    rec.free = false;
    rec.mesh.getWorldPosition(tmpV);
    rec.grabOffset = info.obj.worldToLocal(tmpV.clone());
    rec.grabOffsetQ = info.obj.getWorldQuaternion(new THREE.Quaternion()).invert()
      .multiply(rec.mesh.getWorldQuaternion(new THREE.Quaternion()));
    state.interactions += 1;
    log(`拿起：${rec.label}`);
    return;
  }
  aiming = info;
  info.ray.visible = true;
}

// Discrete open / close for hinges and sliders.
function actuate(rec) {
  if (rec.kind === 'slide') {
    rec.value = rec.value > 0.01 ? 0 : rec.spec.travel;
    rec.mesh.position.copy(rec.home).addScaledVector(rec.dir, rec.value);
  } else if (rec.kind === 'hinge') {
    const open = THREE.MathUtils.degToRad(rec.spec.openDeg);
    rec.value = rec.value > 0.01 ? 0 : open;
    rec.mesh.rotation.set(0, rec.value, 0);
  }
  rec.open = rec.value > 0.01;
  state.interactions += 1;
  const verb = rec.open ? '打开' : '关闭';
  log(`${rec.label} ${verb}`);
  showHint(`${rec.label} · ${verb}`, rec, 1.2);
}

function onSelectEnd(info) {
  const rec = info.held;
  if (rec) {
    info.held = null;
    state.held = null;
    rec.held = null;
    rec.free = true;
    rec.freeFor = 0;
    // Drop, do not throw. This used to derive velocity from (controller world pos
    // - prop world pos), which is the grab offset - half a metre to two metres -
    // times six, i.e. 10+ m/s straight through the nearest wall, where the prop
    // then stuck. A released prop now just falls from where it was.
    rec.vel.set(0, 0, 0);
    state.interactions += 1;
    return;
  }
  if (aiming !== info) return;
  aiming = null;
  const target = computeTeleport(info);
  info.ray.visible = true;
  if (target) {
    dolly.position.set(target.x, 0, target.z);
    state.feetY = target.y;
    state.teleports += 1;
    log(`瞬移到 ${target.name}`);
  }
}

// Teleporting used to raycast the walkable planes alone, so aiming at the floor
// picked the yard plane straight through the wall and dropped the player outside.
// Every candidate now needs an unobstructed line from the controller.
const tpOrigin = new THREE.Vector3();
const tpDir = new THREE.Vector3();
const losDir = new THREE.Vector3();
const TELEPORT_MAX = 8.0;

function hasLineOfSight(from, to) {
  losDir.copy(to).sub(from);
  const d = losDir.length();
  if (d < 0.35) return true;
  losDir.divideScalar(d);
  raycaster.set(from, losDir);
  raycaster.far = d - 0.12;          // stop short so the floor itself is not a hit
  const house = getHouseMesh();
  if (!house) return true;
  return raycaster.intersectObject(house, false).length === 0;
}

function computeTeleport(info) {
  info.obj.getWorldPosition(tpOrigin);
  info.obj.getWorldQuaternion(tmpQ);
  tpDir.set(0, 0, -1).applyQuaternion(tmpQ).normalize();
  raycaster.set(tpOrigin, tpDir);
  raycaster.far = TELEPORT_MAX;
  for (const h of raycaster.intersectObjects(proxy.children, false)) {
    const f = h.object.userData.floor;
    if (blocked(h.point.x, h.point.z, f.y)) continue;
    if (!hasLineOfSight(tpOrigin, h.point)) continue;
    return { x: h.point.x, z: h.point.z, y: f.y, name: f.name };
  }
  return null;
}

function actToggle(rec) {
  if (rec.id === 'tv') {
    rec.value = (rec.value + 1) % hpChannels.length;
    rec.mesh.material.color.setRGB(...hpChannels[rec.value]);
    state.interactions += 1;
    log(`电视换台：${rec.value + 1}/${hpChannels.length}`);
    return;
  }
  setLamp(rec.id, !rec.on);
  state.interactions += 1;
  log(`${rec.label} ${rec.on ? '开' : '关'}`);
}

const hpChannels = [[0.05, 0.05, 0.07], [0.16, 0.42, 0.72], [0.72, 0.32, 0.16],
                    [0.12, 0.62, 0.44], [0.55, 0.20, 0.60]];

function setLamp(id, on) {
  const rec = state.props[id];
  if (!rec) return;
  rec.on = on;
  if (rec.light) rec.light.visible = on;
  const warm = [1.0, 0.86, 0.62];
  const off = [0.30, 0.30, 0.33];
  const c = on ? warm : off;
  rec.mesh.material.color.setRGB(...c);
  rec.mesh.material.emissive.setRGB(on ? c[0] * 0.85 : 0, on ? c[1] * 0.85 : 0, on ? c[2] * 0.85 : 0);
  state.lampsOn = Object.values(state.props).filter((p) => p.light && p.on).length;
}

// grab follows the controller. Zero allocations per frame.
// ------------------------------------------------------------------ auto doors
// A konbini door opens by itself; walking up to it is the entire interaction. The
// manual trigger still works, but proximity wins so nobody ends up standing in the
// rain pressing A at a closed sliding door.
const DOOR_SENSE = 2.8;
let doorT = 0;

function stepAutoDoors(dt) {
  // The diorama zeroes the dolly every frame (its camera works in world space), so
  // dolly.position means "the player" only in first person / VR. Reading it in the
  // diorama kept the doors permanently open.
  const active = renderer.xr.isPresenting || state.view === 'first';
  const dz = dolly.position.z + 0.19;      // door plane: bl.y 0.16..0.22 -> three z -0.22..-0.16
  const near = active && Math.hypot(dolly.position.x, dz) < DOOR_SENSE;
  doorT += ((near ? 1 : 0) - doorT) * Math.min(1, dt * 5.0);
  const open = doorT > 0.02;
  for (const id of ['auto_door_l', 'auto_door_r']) {
    const rec = state.props[id];
    if (!rec) continue;
    rec.value = doorT * rec.spec.travel;
    rec.mesh.position.copy(rec.home).addScaledVector(rec.dir, rec.value);
    rec.open = open;
  }
}

function updateHeld(rec) {
  const info = rec.held;
  if (!info) return;
  if (rec.kind !== 'grab') return;     // hinge and slide are discrete now

  info.obj.getWorldPosition(tmpV);
  const head = renderer.xr.isPresenting
    ? renderer.xr.getCamera().getWorldPosition(tmpV2)
    : tmpV2.copy(dolly.position).setY(state.feetY + 1.6);
  if (tmpV.distanceTo(head) > REACH) tmpV.sub(head).setLength(REACH).add(head);
  info.obj.getWorldQuaternion(tmpQ);
  rec.mesh.position.copy(tmpV).add(tmpV3.copy(rec.grabOffset).applyQuaternion(tmpQ));
  rec.mesh.quaternion.copy(tmpQ).multiply(rec.grabOffsetQ);
}

function updateFree(rec, dt) {
  if (!rec.free) return;
  rec.freeFor = (rec.freeFor || 0) + dt;
  rec.vel.y -= GRAVITY * dt;
  if (rec.vel.lengthSq() > 36) rec.vel.setLength(6);       // never exceed 6 m/s
  rec.mesh.position.addScaledVector(rec.vel, dt);
  const half = rec.half || 0.05;                            // fixed at build time
  const c = rec.mesh.position;
  let support = supportAt(c.x, c.z, c.y + half);
  if (support < -4) support = state.floorZ;                 // nothing under it: settle on the floor
  if (c.y - half <= support || rec.freeFor > MAX_FALL_TIME) {
    c.y = support + half;
    rec.vel.set(0, 0, 0);
    rec.free = false;
    rec.freeFor = 0;
  }
}

function supportAt(x, z, fromY) {
  let best = -5;
  for (const f of state.floors) {
    if (x < f.x0 || x > f.x1 || z < f.z0 || z > f.z1) continue;
    if (f.y <= fromY + 0.05 && f.y > best) best = f.y;
  }
  for (const b of state.boxes) {
    if (b.kind === 'wall' || b.kind === 'ground') continue;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    if (b.y1 <= fromY + 0.05 && b.y1 > best) best = b.y1;
  }
  return best;
}

// ------------------------------------------------------------------- physics
function blocked(x, z, feetY) {
  for (const b of state.boxes) {
    if (feetY >= b.y1 - 0.02) continue;
    if (feetY + PLAYER_HEIGHT <= b.y0 + 0.02) continue;
    if (x > b.x0 - WALK_RADIUS && x < b.x1 + WALK_RADIUS &&
        z > b.z0 - WALK_RADIUS && z < b.z1 + WALK_RADIUS) return true;
  }
  return false;
}

function groundAt(x, z, fromY) {
  let best = null;
  for (const f of state.floors) {
    if (x < f.x0 || x > f.x1 || z < f.z0 || z > f.z1) continue;
    if (f.y > fromY + state.stepMax) continue;
    if (best === null || f.y > best.y) best = f;
  }
  return best;
}

function tryMove(dx, dz) {
  const base = dolly.position;
  const stuck = blocked(base.x, base.z, state.feetY);
  const nx = base.x + dx;
  if (!blocked(nx, base.z, state.feetY) || stuck) base.x = nx; else state.blocked += 1;
  const nz = base.z + dz;
  if (!blocked(base.x, nz, state.feetY) || stuck) base.z = nz; else state.blocked += 1;
  const g = groundAt(base.x, base.z, state.feetY);
  if (g) state.feetY += (g.y - state.feetY) * 0.25;
}

function roomAt(x, z, y) {
  for (const r of state.rooms) {
    if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1 && Math.abs(y - r.y) < 0.3) return r.label;
  }
  return y > -0.1 ? '室内' : '室外';
}

// The `connected` event hands over an input source whose .gamepad can still be
// null at that moment, and nothing ever refreshed it afterwards - so `info.gamepad`
// stayed null forever and the sticks were dead while the trigger (which arrives as
// a separate XR event) kept working. Re-read it from the live session every frame.
// How much the rig has to be lifted so the eyes sit at EYE_HEIGHT above the house
// floor. A floor-relative pose already reports ~1.6 m and needs no lift; a plain
// "local" pose reports ~0 and needs the full lift. Pure function so the mapping
// can be asserted without a headset.
function eyeLiftFor(poseY) {
  if (!(poseY > 0.02)) return null;         // not measured yet
  return poseY < 0.9 ? Math.max(0, EYE_HEIGHT - poseY) : 0;
}

function liveInput(c) {
  const session = renderer.xr.getSession ? renderer.xr.getSession() : null;
  let src = null;
  if (session && session.inputSources) {
    const list = Array.from(session.inputSources);
    // Match by handedness first: three.js assigns controller slots by input-source
    // order, which is not guaranteed to line up with left/right.
    if (c.hand === 'left' || c.hand === 'right') {
      src = list.find((s) => s.handedness === c.hand) || null;
    }
    if (!src) src = list[c.index] || null;
  }
  return {
    gp: (src && src.gamepad) || c.gamepad || null,
    hand: (src && src.handedness) || c.hand || 'none',
  };
}

// Quest controllers follow the xr-standard gamepad layout: the thumbstick lives in
// axes[2]/axes[3], while axes[0]/axes[1] are the touchpad slot and read 0 because
// Quest controllers have no touchpad. Reading [0]/[1] is why both sticks felt dead.
function stickAxes(gp) {
  if (!gp || !gp.axes) return [0, 0];
  const sx = gp.axes[2] || 0, sy = gp.axes[3] || 0;
  if (Math.abs(sx) > 0.01 || Math.abs(sy) > 0.01) return [sx, sy];
  return [gp.axes[0] || 0, gp.axes[1] || 0];
}

function handOf(c, hand) {
  const h = hand || c.hand;
  if (h === 'left' || h === 'right') return h;
  // Some runtimes report handedness 'none'; fall back to the controller index.
  return c.index === 0 ? 'left' : 'right';
}

// Quest reports the thumbstick with the opposite sign to the Gamepad-API
// convention this code originally assumed: on device, pushing the stick up gives
// ay = +1 (not -1) and pushing right gives ax = -1. Both axes are negated once,
// here, instead of scattering minus signs through the movement maths.
// Sign of each thumbstick axis - and the two hands are NOT the same.
//
// Measured on Quest 3 in the TWA shell: the right stick reports the Gamepad-API
// convention (up = -1, right = +1) while the left stick reports the opposite
// (up = +1, left = +1). Sharing one pair of signs therefore guarantees that
// fixing the walk breaks the turn and vice versa, which is exactly the loop the
// previous two attempts got stuck in.
//
//   right: rx=+1 ry=+1  -> push up = forward, push right = strafe right
//   left:  lx=-1        -> push left = turn left
//
// Still adjustable: right A flips walking fwd/back, right B flips strafe,
// left X flips the turn. Persisted under a new key so an old {x,y} pair cannot
// be mistaken for this shape.
const STICK = (() => {
  const def = { rx: 1, ry: 1, lx: -1 };
  try {
    const v = JSON.parse(localStorage.getItem('conbini.stickSign2') || 'null');
    if (v && typeof v.rx === 'number' && typeof v.ry === 'number' && typeof v.lx === 'number') return v;
  } catch (_) { /* private mode */ }
  return def;
})();
const saveStick = () => {
  try { localStorage.setItem('conbini.stickSign2', JSON.stringify(STICK)); } catch (_) {}
};

// Right stick walks, left stick turns. Kept as a pure function of the controller
// state so it can be exercised with fake gamepads in the browser test - it is the
// one piece of XR behaviour that cannot be checked from a desktop run.
function stickIntent() {
  let mx = 0, mz = 0, turn = 0;
  state.inputs = [];
  for (const c of controllers) {
    const { gp, hand } = liveInput(c);
    if (gp && gp.axes) {
      state.inputs.push({ i: c.index, hand: handOf(c, hand),
                          a: [gp.axes[0] || 0, gp.axes[1] || 0, gp.axes[2] || 0, gp.axes[3] || 0]
                               .map((v) => +v.toFixed(2)),
                          b: gp.buttons ? gp.buttons.length : 0 });
    }
    if (!gp || !gp.axes) continue;
    const [ax, ay] = stickAxes(gp);
    const h = handOf(c, hand);
    if (h === 'right') {
      // push up -> walk forward, push right -> strafe right
      if (Math.hypot(ax, ay) > 0.18) { mx = STICK.rx * ax; mz = -STICK.ry * ay; }
    } else if (h === 'left') {
      // push left -> turn left
      if (Math.abs(ax) > 0.22) turn = STICK.lx * ax;
    }
  }
  return { mx, mz, turn };
}

// Squeeze re-centres the view and reports the room on the wrist panel; the old
// teleport/smooth toggle is gone because both sticks are always live now.
function recenter() {
  log(`已重置视角 · 位置 ${roomAt(dolly.position.x, dolly.position.z, state.feetY)}`);
  showHint('视角已重置', null, 0.9);
}

// ------------------------------------------------------------- desktop fallback
const keys = new Set();
let dragging = false, lastX = 0, lastY = 0, yaw = 0, pitch = 0;
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (renderer.xr.isPresenting) return;
  // The diorama is a still camera, so WASD there reads as "the keyboard is broken".
  // Pressing a movement key is the clearest possible request to go and walk, so drop
  // into first person instead of silently ignoring it.
  if (state.view === 'orbit' && MOVE_KEYS.has(e.code)) setView('first');
  // V toggles into VR from the desktop preview, so a PC-tethered headset does not
  // require hunting for the corner button.
  if (e.code === 'KeyF') setView(state.view === 'orbit' ? 'first' : 'orbit');
  if (e.code === 'KeyV' && state.phase === 'desktop') enterVR();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  if (!renderer.xr.isPresenting) desktopAct(e);
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging || renderer.xr.isPresenting) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  if (state.view === 'orbit') {
    orbit.theta -= dx * 0.006;
    orbit.phi = Math.max(0.30, Math.min(1.34, orbit.phi - dy * 0.004));
  } else {
    yaw -= dx * 0.004;
    pitch = Math.max(-1.2, Math.min(1.2, pitch - dy * 0.004));
  }
  lastX = e.clientX; lastY = e.clientY;
});

renderer.domElement.addEventListener('wheel', (e) => {
  if (state.view !== 'orbit') return;
  e.preventDefault();
  orbit.radius = Math.max(ORBIT_MIN_R, Math.min(ORBIT_MAX_R, orbit.radius * (1 + e.deltaY * 0.0012)));
}, { passive: false });

function desktopAct(e) {
  const nd = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1,
                               -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(nd, camera);
  const propHits = raycaster.intersectObjects(propMeshes, false);
  if (propHits.length) {
    const rec = state.props[propHits[0].object.userData.propId];
    if (!rec) return;
    if (rec.kind === 'toggle') actToggle(rec);
    else if (rec.kind === 'grab') { showHint(`拿起：${rec.label}`, null, 0.8); }
    else actuate(rec);
  }
}

function desktopMove(dt) {
  const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const move = new THREE.Vector3();
  if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(f);
  if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(f);
  if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(r);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(r);
  if (move.lengthSq() === 0) return;
  move.normalize().multiplyScalar(WALK_SPEED * dt);
  tryMove(move.x, move.z);
  // rotation is applied in the loop, not here: dragging the mouse has to turn the
  // view even when no movement key is held.
}

// ------------------------------------------------------------------ wrist panel
const panelCanvas = document.createElement('canvas');
panelCanvas.width = 512; panelCanvas.height = 256;
const pctx = panelCanvas.getContext('2d');
const panelTex = new THREE.CanvasTexture(panelCanvas);
panelTex.colorSpace = THREE.SRGBColorSpace;
const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.095),
                             new THREE.MeshBasicMaterial({ map: panelTex, transparent: true }));
panel.position.set(0, 0.035, -0.02);
panel.rotation.set(-0.5, 0.35, 0);
controllers[0].grip.add(panel);

function drawPanel(hoverLabel) {
  const g = pctx;
  g.clearRect(0, 0, 512, 256);
  g.fillStyle = 'rgba(8,14,28,0.82)';
  g.beginPath(); g.roundRect(4, 4, 504, 248, 18); g.fill();
  g.strokeStyle = 'rgba(120,180,255,0.4)'; g.lineWidth = 2; g.stroke();
  g.textAlign = 'left';
  g.fillStyle = '#2ee6a8'; g.font = 'bold 32px system-ui, sans-serif';
  g.fillText('右摇杆 移动 · 左摇杆 转身', 26, 54);
  g.fillStyle = '#e8eefc'; g.font = '26px system-ui, sans-serif';
  g.fillText(`所在  ${roomAt(dolly.position.x, dolly.position.z, state.feetY)}`, 26, 100);
  g.fillStyle = '#9fb4d8'; g.font = '22px system-ui, sans-serif';
  g.fillText(`灯 ${state.lampsOn} 盏亮 · 交互 ${state.interactions} 次`, 26, 138);
  g.fillStyle = hoverLabel ? '#ffd479' : '#5f7ba6'; g.font = 'bold 24px system-ui, sans-serif';
  g.fillText(hoverLabel ? `瞄准：${hoverLabel}` : '瞄准：—', 26, 180);
  g.fillStyle = '#7f9bc9'; g.font = '20px system-ui, sans-serif';
  g.fillText('握把键 切换移动 · 扳机 抓取/开关/瞬移', 26, 216);
  panelTex.needsUpdate = true;
}

function draw2d(hoverLabel) {
  el.mode.textContent = renderer.xr.isPresenting ? '摇杆' : 'WASD / 拖动';
  el.room.textContent = roomAt(dolly.position.x, dolly.position.z, state.feetY);
  el.hint.textContent = hoverLabel ? `瞄准：${hoverLabel}` : `灯 ${state.lampsOn} 盏亮`;
}

// ---------------------------------------------------------------------- loop
const headCam = () => (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
let last = performance.now();
let introPlaced = false;

renderer.setAnimationLoop((t) => {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  let hoverLabel = null;

  if (renderer.xr.isPresenting) {
    let mz = 0, mx = 0, turn = 0;
    frameNo += 1;
    for (const c of controllers) {
      // Hover raycasts are throttled: doing them for both hands every frame was the
      // main per-frame cost, and it spiked exactly while holding an object.
      if ((frameNo + c.index) % HOVER_EVERY === 0) {
        const hit = hitFor(c);
        c.hover = hit && hit.type === 'prop' ? hit.rec : null;
      }
      if (c.hover && !hoverLabel) hoverLabel = c.hover.label;
    }
    // A / B flip one axis each. Quest hands the sticks over with the opposite sign
    // and the convention differs between Quest Browser and the TWA shell, so the
    // mapping is adjustable at runtime instead of baked in - it persists, so this is
    // a one-time calibration rather than a per-session chore.
    for (const c of controllers) {
      const { gp, hand } = liveInput(c);
      const pressed = (i) => !!(gp && gp.buttons && gp.buttons[i] && gp.buttons[i].pressed);
      const btnA = pressed(4), btnB = pressed(5);
      const side = handOf(c, hand);
      if (btnA && !state.btnA) {
        if (side === 'left') {
          STICK.lx *= -1; saveStick();
          showHint(`左摇杆转向翻转：推左 = ${STICK.lx < 0 ? '左转' : '右转'}`, null, 2.4);
        } else {
          STICK.ry *= -1; saveStick();
          showHint(`前后翻转：推上 = ${STICK.ry > 0 ? '前进' : '后退'}`, null, 2.4);
        }
      }
      if (btnB && !state.btnB) {
        if (side === 'right') {
          STICK.rx *= -1; saveStick();
          showHint(`左右翻转：推右 = ${STICK.rx > 0 ? '右移' : '左移'}`, null, 2.4);
        }
      }
      state.btnA = btnA; state.btnB = btnB;
    }
    ({ mx, mz, turn } = stickIntent());
    state.lastIntent = { mx, mz, turn };
    if (mx || mz) {
      headCam().getWorldQuaternion(tmpQ);
      tmpV.set(0, 0, -1).applyQuaternion(tmpQ); tmpV.y = 0;
      tmpV2.set(1, 0, 0).applyQuaternion(tmpQ); tmpV2.y = 0;
      if (tmpV.lengthSq() > 1e-6 && tmpV2.lengthSq() > 1e-6) {
        tmpV.normalize(); tmpV2.normalize();
        tmpV3.copy(tmpV).multiplyScalar(mz).addScaledVector(tmpV2, mx);
        if (tmpV3.lengthSq() > 1e-6) tmpV3.normalize().multiplyScalar(WALK_SPEED * dt);
        tryMove(tmpV3.x, tmpV3.z);
      }
    }
    if (turn) dolly.rotation.y -= turn * THREE.MathUtils.degToRad(TURN_DEG) * Math.min(1, dt * 8);

    // three.js writes the headset pose into camera.position each frame, so its y
    // says which reference space we actually got: a floor-relative pose puts the
    // eyes around 1.6 m, while a plain "local" pose sits near 0. With local, the
    // rig has to be lifted or the player walks around at knee height - which read
    // as "very short person, looking under the table".
    const poseY = camera.position.y;
    state.poseY = poseY;
    if (state.eyeLift === null) {
      const lift = eyeLiftFor(poseY);
      if (lift !== null) {
        state.eyeLift = lift;
        log(`视线高度校正：${lift > 0.01 ? `抬升 ${lift.toFixed(2)} m` : '无需（local-floor 生效）'}`);
      }
    }
    camera.rotation.set(0, 0, 0);
  } else if (state.view === 'orbit') {
    applyOrbit();
  } else {
    camera.position.set(0, 1.6, 0);        // desktop preview has no headset pose
    desktopMove(dt);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    const hit = hitFor({ obj: { getWorldPosition: (v) => v.copy(headCam().getWorldPosition(v)),
                                getWorldQuaternion: (q) => q.copy(headCam().getWorldQuaternion(q)) } });
    if (hit && hit.type === 'prop') hoverLabel = hit.rec.label;
  }
  // Ride the floor / stairs / porch height, plus the head-height correction when
  // the runtime did not give us a floor-relative pose.
  dolly.position.y = state.feetY + (state.eyeLift || 0);

  for (const c of controllers) if (c.held) updateHeld(c.held);
  for (const rec of Object.values(state.props)) updateFree(rec, dt);
  stepAutoDoors(dt);
  for (const rec of Object.values(state.props)) {
    const hot = rec === state.held || controllers.some((c) => c.hover === rec);
    const target = hot ? 1.08 : 1.0;
    rec.mesh.scale.lerp(tmpV.set(target, target, target), 0.2);
  }

  if (aiming) {
    // The line-of-sight test walks 1649 triangles, so it runs every other frame
    // while the trigger is held down rather than on every frame.
    if (frameNo % 2 === 0) aimTp = computeTeleport(aiming);
    const tp = aimTp;
    marker.visible = !!tp;
    if (tp) marker.position.set(tp.x, tp.y + 0.012, tp.z);
  } else {
    aimTp = null;
    marker.visible = false;
  }

  stepRain(dt);
  drawPanel(hoverLabel);
  draw2d(hoverLabel);
  // The intro card is placed once, in world space, so walking away leaves it behind
  // instead of gluing it to your face.
  if (intro.visible && !introPlaced && renderer.xr.isPresenting) { placeIntro(); introPlaced = true; }
  if (renderer.xr.isPresenting) {
    const hov = (controllers.find((c) => c.hover) || {}).hover || null;
    updateHint(hov);
    updateDebug();
  }
  renderer.render(scene, camera);
});

// --------------------------------------------------------------------- session
const XR_TIMEOUT_MS = 10000;

// isSessionSupported() is known to hang on some builds, so it races a short timer.
async function hasXRDevice() {
  if (!navigator.xr || !navigator.xr.isSessionSupported) return false;
  try {
    return await Promise.race([
      navigator.xr.isSessionSupported('immersive-vr'),
      new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
  } catch {
    return false;
  }
}

function enterDesktopPreview() {
  state.xrUnsupported = true;
  backToDesktop();
  log('桌面预览已就绪（无头显时可用鼠标键盘试玩）');
}

async function enterVR() {
  el.enter.disabled = true;
  el.status.textContent = '正在请求 VR 会话…';
  try {
    // Never await isSessionSupported(): it can hang forever and freeze the page.
    const session = await Promise.race([
      navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('请求 VR 会话超时')), XR_TIMEOUT_MS)),
    ]);
    state.usingFloor = !!(session.enabledFeatures && session.enabledFeatures.includes('local-floor'));
    await renderer.xr.setSession(session);
    session.addEventListener('end', onSessionEnd);
    el.hud.classList.add('hidden');
    el.fab.classList.add('hidden');
    el.status.textContent = '';
    if (state.view === 'orbit') setView('first');
    state.phase = 'presenting';
    // Show the controls card on entry; the first trigger press dismisses it.
    intro.visible = true;
    introPlaced = false;
    state.dbgUntil = performance.now() + 7000;   // input readout for the first seconds
    state.eyeLift = null;                        // re-measure the pose reference
    for (const c of controllers) c.ray.visible = true;
    log(`VR 会话已启动（${state.usingFloor ? 'local-floor' : 'local'} 参考空间）`);
    return true;
  } catch (err) {
    el.enter.disabled = false;
    const msg = String(err.message || err);
    // A desktop browser with no headset says "not supported" / "no XR hardware":
    // that is not a failure to nag about, it simply means desktop preview mode.
    if (/not supported|unsupported|no XR|NotFound|NotSupported|secure context/i.test(msg)) {
      state.xrUnsupported = true;
    }
    el.status.textContent = state.xrUnsupported
      ? '桌面预览：WASD 移动 · 按住拖动转视角 · 点击家具交互（接头显后点「进入 VR」）'
      : `进入 VR 失败：${msg}`;
    log(`enterVR 失败: ${msg}`);
    return false;
  }
}

// Entering VR and coming back have to be symmetric: leaving a session used to
// bring the title card back, which threw away the room you were standing in and
// made "test on desktop, then try it in the headset" a restart-the-page
// operation. Now the exit lands back in the desktop preview at the same spot.
function backToDesktop(message) {
  state.phase = 'desktop';
  state.eyeLift = null;          // the next session may get a different reference space
  state.introDone = false;
  state.held = null;
  for (const c of controllers) { c.held = null; c.hover = null; }
  dolly.rotation.y = 0;
  if (el.hud) el.hud.classList.add('hidden');
  if (el.fab) el.fab.classList.remove('hidden');
  if (el.enter) { el.enter.textContent = '进入 VR'; el.enter.disabled = false; }
  el.status.textContent = message || '桌面预览：WASD 走动 · 拖动转视角 · 点击交互 · F 俯瞰 · V 进 VR';
}

function onSessionEnd() {
  backToDesktop('已退出 VR · 桌面预览（WASD 移动 · 拖动转视角 · 点击交互）');
  log('VR 会话已结束，已回到桌面预览（位置保留）');
}

let gestureArmed = false;
function armGestureRetry() {
  if (gestureArmed) return;
  gestureArmed = true;
  const retry = async () => {
    window.removeEventListener('pointerdown', retry);
    window.removeEventListener('keydown', retry);
    log('检测到用户手势，重试进入 VR');
    if (!(await enterVR())) armGestureRetry();
  };
  window.addEventListener('pointerdown', retry, { passive: true });
  window.addEventListener('keydown', retry);
}

el.enter.addEventListener('click', enterVR);
el.fab.addEventListener('click', enterVR);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------------ boot
const startX = modelJson.entry.x;
const startZ = -modelJson.entry.y;            // bl.y -> three.z, no inward offset: entry is already in the street
{
  // From 1.0 m, not 0.1: the yard region overlaps the whole footprint at y=0, and
  // searching from just above the ground makes it win over the 0.42 m house
  // floor, which starts the player sunk into the floor.
  const g = groundAt(startX, startZ, 1.0) || state.floors[0];
  dolly.position.set(startX, 0, startZ);
  state.feetY = g ? g.y : 0;
  state.phase = 'desktop';
  el.overlay.classList.add('hidden');
  el.status.textContent = '桌面预览：WASD 移动，按住拖动转视角，点击家具可交互';
  log(`就绪：${state.boxes.length} 个碰撞盒 · ${state.floors.length} 块可行走面 · ` +
      `${Object.keys(state.props).length} 件可交互物`);
  window.__demo = {
    state, renderer, scene, camera, dolly, world, proxy,
    log,
    api: {
      blocked, groundAt, tryMove, supportAt, roomAt,
      setPos: (x, z) => { dolly.position.set(x, 0, z); const g2 = groundAt(x, z, 1.0); state.feetY = g2 ? g2.y : 0; },
      // Desktop view is owned by the module-level yaw/pitch, which the render loop
      // re-applies every frame; setting camera.rotation directly is overwritten.
      setView: (y, p) => { yaw = y; pitch = p || 0; camera.rotation.set(pitch, yaw, 0, 'YXZ'); },
      // Orbit vs first person. The module-level setView() owns the fog and the pose,
      // so tests must go through it rather than poking camera.position.
      setMode: (m) => { setView(m); return state.view; },
      act: (id) => {
        const rec = state.props[id];
        if (!rec) return false;
        if (rec.kind === 'toggle') { actToggle(rec); return true; }
        if (rec.kind === 'hinge' || rec.kind === 'slide') { actuate(rec); return true; }
        return false;
      },
      prop: (id) => {
        const rec = state.props[id];
        if (!rec) return null;
        return { kind: rec.kind, value: +rec.value.toFixed(3), on: rec.on, open: !!rec.open,
                 pos: rec.mesh.position.toArray().map((v) => +v.toFixed(3)),
                 rotY: +rec.mesh.rotation.y.toFixed(3), lightVisible: rec.light ? rec.light.visible : null };
      },
      // Fake both gamepads so the stick mapping can be asserted without a headset.
      sticks: (rightAxes, leftAxes) => {
        for (const c of controllers) {
          if (c.index === 0) { c.hand = 'left'; c.gamepad = leftAxes ? { axes: leftAxes } : null; }
          else { c.hand = 'right'; c.gamepad = rightAxes ? { axes: rightAxes } : null; }
        }
        return stickIntent();
      },
      ui: () => ({ intro: intro.visible, hint: hintSprite.visible, hintText,
                   hud: el.hud ? !el.hud.classList.contains('hidden') : null,
                   fab: el.fab ? !el.fab.classList.contains('hidden') : null,
                   phase: state.phase }),
      // Exercise the VR-exit path without a headset.
      exitVR: () => { backToDesktop(); return true; },
      eyeLift: eyeLiftFor,
      // Release a prop from a given height and run the fall for `frames` steps.
      // This is the exact path that used to leave a prop stuck in a wall.
      dropTest: (id, x, y, z, frames) => {
        const rec = state.props[id];
        if (!rec) return null;
        const before = rec.mesh.position.clone();
        rec.mesh.position.set(x, y, z);
        rec.held = null;
        rec.free = true;
        rec.freeFor = 0;
        rec.vel.set(0, 0, 0);
        for (let i = 0; i < (frames || 240); i++) updateFree(rec, 1 / 72);
        const after = rec.mesh.position;
        return {
          from: [x, y, z],
          to: [+after.x.toFixed(3), +after.y.toFixed(3), +after.z.toFixed(3)],
          settled: !rec.free,
          drift: +Math.hypot(after.x - x, after.z - z).toFixed(3),
          home: [+before.x.toFixed(3), +before.y.toFixed(3), +before.z.toFixed(3)],
        };
      },
      // Probe the teleport solver as if a controller sat at `origin` looking along
      // `dir`. Used to prove that aiming through a wall is refused.
      teleportProbe: (origin, dir) => {
        const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), d);
        const fake = {
          obj: {
            getWorldPosition: (v) => v.set(origin[0], origin[1], origin[2]),
            getWorldQuaternion: (qq) => qq.copy(q),
          },
        };
        return computeTeleport(fake);
      },
      // Median frame cost over N forced renders - the number that actually shows
      // whether the hover raycast rework removed the hitch.
      budget: (n) => {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) renderer.render(scene, camera);
        return +((performance.now() - t0) / n).toFixed(3);
      },
    },
  };
  // A desktop browser advertises navigator.xr but has no headset; asking straight
  // away leaves the title card covering the scene for ten seconds and then keeps
  // covering it. Probe first, and on failure go straight to the mouse/keyboard
  // preview so the walkthrough can be exercised without putting a headset on.
  if (!(await hasXRDevice())) {
    enterDesktopPreview();
  } else {
    const ok = await enterVR();
    if (!ok) enterDesktopPreview();
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
