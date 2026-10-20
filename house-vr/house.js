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
const WALK_SPEED = 1.9;
const TURN_DEG = 30;
const REACH = 2.6;                 // how far a held prop may be carried from the head
const GRAVITY = 9.8;

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
scene.background = new THREE.Color(0x9fb6cc);
scene.fog = new THREE.Fog(0x9fb6cc, 28, 80);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 140);
const dolly = new THREE.Group();
dolly.add(camera);
scene.add(dolly);

const world = new THREE.Group();      // holds the loaded house + props
scene.add(world);

// Base fill for the whole shell. Down-facing surfaces (every ceiling) read the
// ground colour outright, so it is a warm light grey rather than the near-black
// of open ground - otherwise every ceiling renders as stained wood.
const hemi = new THREE.HemisphereLight(0xdfeaff, 0xa89f92, 0.95);
scene.add(hemi);
const fill = new THREE.AmbientLight(0xfff4e6, 0.40);
scene.add(fill);

// The lamp energies in colliders.json are authored for a path-traced bake; in a
// Lambert shader a ceiling light 0.6 m from the ceiling at 26 cd is ~70x over
// white. Scale them at build time instead of editing the shared source of truth.
const LAMP_SCALE = 0.28;

const state = {
  phase: 'loading', mode: 'teleport', feetY: 0, floorZ: 0, stepMax: 0.2,
  boxes: [], floors: [], rooms: [], hover: null, held: null,
  teleports: 0, blocked: 0, interactions: 0, usingFloor: true,
  props: {}, lampsOn: 0,
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
  new GLTFLoader().load('./house.glb', resolve,
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
const glassMat = new THREE.MeshBasicMaterial({
  color: 0xbcd6f0, transparent: true, opacity: 0.22, depthWrite: false,
});

const propMeshes = [];
gltf.scene.traverse((o) => {
  if (o.type !== 'Mesh') return;
  o.frustumCulled = false;
  if (o.name === 'Web_House') o.material = houseMat;
  else if (o.name === 'Ground') o.material = groundMat;
  else if (o.name.startsWith('Glass_')) o.material = glassMat;
  else if (o.name.startsWith('Itc_')) {
    const id = o.name.slice(4);
    const spec = worldJson.interactables.find((i) => i.id === id);
    o.material = new THREE.MeshLambertMaterial({ color: new THREE.Color(...(spec ? spec.color : [0.7, 0.7, 0.7])) });
    o.userData.propId = id;
    propMeshes.push(o);
  }
});
world.add(gltf.scene);

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
    value: 0, on: spec.kind !== 'toggle' ? null : (spec.id === 'tv' ? false : true),
    held: null, vel: new THREE.Vector3(), free: false,
  };
  if (spec.kind === 'hinge') rec.axis = new THREE.Vector3(0, 1, 0);
  if (spec.kind === 'slide') rec.dir = new THREE.Vector3(spec.dir[0], 0, -spec.dir[1]).normalize();
  if (spec.light) {
    const room = state.rooms.find((r) => r.label === worldJson.rooms[spec.light.room].label);
    const bb = boxOf(mesh);
    const light = new THREE.PointLight(0xffd9a8, spec.light.energy * LAMP_SCALE, 6.5, 2);
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

// ------------------------------------------------------------------- controls
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
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
  const info = { index, obj, grip, ray, gamepad: null, active: false, hover: null, held: null };
  // three.js dispatches XR events without setting event.currentTarget, so every
  // handler closes over `info` instead of reading it off the event.
  obj.addEventListener('connected', (e) => {
    info.gamepad = e.data.gamepad || null;
    info.active = true;
    log(`手柄已连接: ${e.data.handedness}`);
  });
  obj.addEventListener('disconnected', () => { info.active = false; info.gamepad = null; });
  obj.addEventListener('selectstart', () => onSelectStart(info));
  obj.addEventListener('selectend', () => onSelectEnd(info));
  obj.addEventListener('squeezestart', () => toggleMode());
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

let aiming = null;

function hitFor(info) {
  info.obj.getWorldPosition(tmpV);
  info.obj.getWorldQuaternion(tmpQ);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(tmpQ).normalize();
  raycaster.set(tmpV, dir);
  raycaster.far = 12;
  const propHits = raycaster.intersectObjects(propMeshes, false);
  const wallHits = raycaster.intersectObjects([world.getObjectByName('Web_House')].filter(Boolean), false);
  const prop = propHits[0], wall = wallHits[0];
  if (prop && (!wall || prop.distance < wall.distance + 0.05)) return { type: 'prop', rec: state.props[prop.object.userData.propId], distance: prop.distance };
  if (wall) return { type: 'wall', distance: wall.distance };
  return null;
}

function onSelectStart(info) {
  const hit = hitFor(info);
  if (hit && hit.type === 'prop' && hit.rec) {
    const rec = hit.rec;
    if (rec.kind === 'toggle') { actToggle(rec); return; }
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
  if (state.mode === 'teleport') {
    aiming = info;
    info.ray.visible = true;
  }
}

function onSelectEnd(info) {
  const rec = info.held;
  if (rec) {
    info.held = null;
    state.held = null;
    rec.held = null;
    rec.free = true;
    // carry the controller's motion into the throw
    rec.mesh.getWorldPosition(tmpV);
    rec.vel.copy(info.obj.getWorldPosition(new THREE.Vector3()).sub(rec.prevPos || tmpV).multiplyScalar(6));
    state.interactions += 1;
    return;
  }
  if (aiming !== info) return;
  aiming = null;
  const target = computeTeleport(info);
  info.ray.visible = state.mode === 'teleport';
  if (target) {
    dolly.position.set(target.x, 0, target.z);
    state.feetY = target.y;
    state.teleports += 1;
    log(`瞬移到 ${target.name}`);
  }
}

function computeTeleport(info) {
  info.obj.getWorldPosition(tmpV);
  info.obj.getWorldQuaternion(tmpQ);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(tmpQ).normalize();
  raycaster.set(tmpV, dir);
  raycaster.far = 20;
  for (const h of raycaster.intersectObjects(proxy.children, false)) {
    const f = h.object.userData.floor;
    if (blocked(h.point.x, h.point.z, f.y)) continue;
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

// prop actuation: slide / hinge follow the held controller
function updateHeld(rec) {
  const info = rec.held;
  if (!info) return;
  rec.prevPos = rec.mesh.getWorldPosition(new THREE.Vector3());
  if (rec.kind === 'grab') {
    info.obj.getWorldPosition(tmpV);
    const head = renderer.xr.isPresenting ? renderer.xr.getCamera().getWorldPosition(new THREE.Vector3())
                                          : dolly.position.clone().setY(state.feetY + 1.6);
    if (tmpV.distanceTo(head) > REACH) tmpV.sub(head).setLength(REACH).add(head);
    const q = info.obj.getWorldQuaternion(new THREE.Quaternion());
    rec.mesh.position.copy(tmpV).add(rec.grabOffset.clone().applyQuaternion(q));
    rec.mesh.quaternion.copy(q).multiply(rec.grabOffsetQ);
    return;
  }
  if (rec.kind === 'slide') {
    const p = info.obj.getWorldPosition(new THREE.Vector3());
    const rel = p.clone().sub(rec.home.clone().add(world.position)).projectOnVector(rec.dir);
    const t = THREE.MathUtils.clamp(rel.length() * Math.sign(rel.dot(rec.dir) || 1), 0, rec.spec.travel);
    rec.value = t;
    rec.mesh.position.copy(rec.home).addScaledVector(rec.dir, t);
    return;
  }
  if (rec.kind === 'hinge') {
    const pivot = rec.home.clone();
    const p = info.obj.getWorldPosition(new THREE.Vector3()).sub(pivot);
    const want = Math.atan2(p.x, -p.z);
    const base = Math.atan2(rec.grabOffset.x, -rec.grabOffset.z);
    let a = want - base;
    a = THREE.MathUtils.euclideanModulo(a + Math.PI, Math.PI * 2) - Math.PI;
    const max = THREE.MathUtils.degToRad(rec.spec.openDeg);
    rec.value = THREE.MathUtils.clamp(Math.abs(a) > max ? (a > 0 ? max : 0) : Math.max(0, a), 0, max);
    rec.mesh.rotation.set(0, rec.value, 0);
  }
}

function updateFree(rec, dt) {
  if (!rec.free) return;
  rec.vel.y -= GRAVITY * dt;
  rec.mesh.position.addScaledVector(rec.vel, dt);
  const bb = boxOf(rec);
  const half = (bb.max.y - bb.min.y) / 2;
  const c = rec.mesh.position;
  const support = supportAt(c.x, c.z, c.y);
  if (c.y - half <= support) {
    c.y = support + half;
    if (Math.abs(rec.vel.y) < 0.6 && rec.vel.length() < 0.8) {
      rec.vel.set(0, 0, 0);
      rec.free = false;
    } else {
      rec.vel.y = -rec.vel.y * 0.25;
      rec.vel.x *= 0.6; rec.vel.z *= 0.6;
    }
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

function toggleMode() {
  state.mode = state.mode === 'teleport' ? 'smooth' : 'teleport';
  for (const c of controllers) c.ray.visible = state.mode === 'teleport';
  log(`移动方式：${state.mode === 'teleport' ? '扳机瞬移' : '摇杆平滑移动'}`);
}

// ------------------------------------------------------------- desktop fallback
const keys = new Set();
let dragging = false, lastX = 0, lastY = 0, yaw = 0, pitch = 0;
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));
renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  if (!renderer.xr.isPresenting) desktopAct(e);
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging || renderer.xr.isPresenting) return;
  yaw -= (e.clientX - lastX) * 0.004;
  pitch = Math.max(-1.2, Math.min(1.2, pitch - (e.clientY - lastY) * 0.004));
  lastX = e.clientX; lastY = e.clientY;
});

function desktopAct(e) {
  const nd = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1,
                               -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(nd, camera);
  const propHits = raycaster.intersectObjects(propMeshes, false);
  if (propHits.length) {
    const rec = state.props[propHits[0].object.userData.propId];
    if (rec && rec.kind === 'toggle') { actToggle(rec); return; }
    if (rec) {
      rec.value = rec.kind === 'slide' ? (rec.value > 0.01 ? 0 : rec.spec.travel)
                                       : (rec.value > 0.01 ? 0 : THREE.MathUtils.degToRad(rec.spec.openDeg));
      if (rec.kind === 'slide') rec.mesh.position.copy(rec.home).addScaledVector(rec.dir, rec.value);
      if (rec.kind === 'hinge') rec.mesh.rotation.set(0, rec.value, 0);
      state.interactions += 1;
    }
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
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
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
  g.fillText(state.mode === 'teleport' ? '瞬移模式' : '平滑移动', 26, 54);
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
  el.mode.textContent = state.mode === 'teleport' ? '瞬移（扳机）' : '平滑（左摇杆）';
  el.room.textContent = roomAt(dolly.position.x, dolly.position.z, state.feetY);
  el.hint.textContent = hoverLabel ? `瞄准：${hoverLabel}` : `灯 ${state.lampsOn} 盏亮`;
}

// ---------------------------------------------------------------------- loop
const headCam = () => (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
let last = performance.now();

renderer.setAnimationLoop((t) => {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  let hoverLabel = null;

  if (renderer.xr.isPresenting) {
    let mz = 0, mx = 0, turn = 0;
    for (const c of controllers) {
      const gp = c.gamepad;
      if (gp && gp.axes) {
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        if (Math.hypot(ax, ay) > 0.18) { mx = ax; mz = -ay; }
        const tx = gp.axes[2] || 0, ty = gp.axes[3] || 0;
        if (Math.hypot(tx, ty) > 0.6 && Math.abs(tx) > Math.abs(ty)) turn = tx;
      }
      const hit = hitFor(c);
      c.hover = hit && hit.type === 'prop' ? hit.rec : null;
      if (c.hover && !hoverLabel) hoverLabel = c.hover.label;
    }
    if (state.mode === 'smooth' && (mx || mz)) {
      const q = headCam().getWorldQuaternion(new THREE.Quaternion());
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q); fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q); right.y = 0; right.normalize();
      const v = fwd.multiplyScalar(mz).add(right.multiplyScalar(mx));
      if (v.lengthSq() > 1e-6) v.normalize().multiplyScalar(WALK_SPEED * dt);
      tryMove(v.x, v.z);
    }
    if (turn) dolly.rotation.y -= turn * THREE.MathUtils.degToRad(TURN_DEG) * Math.min(1, dt * 8);
    camera.rotation.set(0, 0, 0);
    camera.position.set(0, state.usingFloor ? 0 : 1.5, 0);
  } else {
    camera.position.set(0, 1.6, 0);        // desktop preview has no headset pose
    desktopMove(dt);
    const hit = hitFor({ obj: { getWorldPosition: (v) => v.copy(headCam().getWorldPosition(v)),
                                getWorldQuaternion: (q) => q.copy(headCam().getWorldQuaternion(q)) } });
    if (hit && hit.type === 'prop') hoverLabel = hit.rec.label;
  }
  dolly.position.y = state.feetY;          // ride the floor / stairs / porch height

  for (const c of controllers) if (c.held) updateHeld(c.held);
  for (const rec of Object.values(state.props)) updateFree(rec, dt);
  for (const rec of Object.values(state.props)) {
    const hot = rec === state.held || controllers.some((c) => c.hover === rec);
    const target = hot ? 1.08 : 1.0;
    rec.mesh.scale.lerp(tmpV.set(target, target, target), 0.2);
  }

  if (aiming) {
    const tp = computeTeleport(aiming);
    marker.visible = !!tp;
    if (tp) marker.position.set(tp.x, tp.y + 0.012, tp.z);
  } else {
    marker.visible = false;
  }

  drawPanel(hoverLabel);
  draw2d(hoverLabel);
  renderer.render(scene, camera);
});

// --------------------------------------------------------------------- session
const XR_TIMEOUT_MS = 10000;

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
    state.phase = 'presenting';
    for (const c of controllers) c.ray.visible = state.mode === 'teleport';
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

function onSessionEnd() {
  state.phase = 'desktop';
  dolly.position.y = 0;
  el.hud.classList.remove('hidden');
  el.enter.textContent = '进入 VR';
  el.enter.disabled = false;
  el.status.textContent = 'VR 会话已结束';
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
const startZ = -modelJson.entry.y - 0.6;      // inside the house means three.z < 4.25
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
      act: (id) => {
        const rec = state.props[id];
        if (!rec) return false;
        if (rec.kind === 'toggle') { actToggle(rec); return true; }
        rec.value = rec.kind === 'slide' ? (rec.value > 0.01 ? 0 : rec.spec.travel)
                                         : (rec.value > 0.01 ? 0 : THREE.MathUtils.degToRad(rec.spec.openDeg));
        if (rec.kind === 'slide') rec.mesh.position.copy(rec.home).addScaledVector(rec.dir, rec.value);
        if (rec.kind === 'hinge') rec.mesh.rotation.set(0, rec.value, 0);
        state.interactions += 1;
        return true;
      },
      prop: (id) => {
        const rec = state.props[id];
        if (!rec) return null;
        return { kind: rec.kind, value: +rec.value.toFixed(3), on: rec.on,
                 pos: rec.mesh.position.toArray().map((v) => +v.toFixed(3)),
                 rotY: +rec.mesh.rotation.y.toFixed(3), lightVisible: rec.light ? rec.light.visible : null };
      },
    },
  };
  if (!navigator.xr) {
    state.xrUnsupported = true;
    el.status.textContent = '此浏览器不支持 WebXR；桌面预览：WASD 移动 · 按住拖动转视角 · 点击家具交互';
  } else {
    const ok = await enterVR();
    // Only auto-retry when the failure might be a missing user gesture; a browser
    // with no headset would otherwise replay the error on every single click.
    if (!ok && !state.xrUnsupported) armGestureRetry();
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
