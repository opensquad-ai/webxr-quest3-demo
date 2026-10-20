import * as THREE from 'three';

const ROUND_SECONDS = 60;
const DWELL_SECONDS = 0.8;
const BLOCK_COUNT = 7;
const BLOCK_SIZE = 0.15;
const RING_RADIUS = 0.42;
const COLORS = [0xff4d6d, 0xffb703, 0x2ee6a8, 0x3a86ff, 0xc77dff, 0x00d9f5, 0xff7b00];

const el = {
  hud: document.getElementById('hud'),
  enter: document.getElementById('enter'),
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  score2d: document.getElementById('score2d'),
  desc: document.getElementById('desc'),
  fab: document.getElementById('vrFab'),
};

// TWA (bubblewrap) runs inside an Android WebView: display-mode stays "browser",
// so this flag only tells us whether the page is an installed PWA. Never gate
// the XR request on it — the headset build has no button to click.
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: fullscreen)').matches;

const state = {
  phase: 'idle',        // idle | playing | over
  score: 0,
  timeLeft: ROUND_SECONDS,
  dwell: 0,
  dwellTarget: null,
  worldY: 1.3,
  usingFloorSpace: true,
};

function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  el.log.textContent = line;
  console.log('[demo]', msg);
}

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070f);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 0);

scene.add(new THREE.HemisphereLight(0x88aaff, 0x101018, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.0);
key.position.set(1, 2, 1);
scene.add(key);
const rim = new THREE.PointLight(0x2ee6a8, 12, 6);
rim.position.set(-0.6, 0.4, -0.6);
scene.add(rim);

// starfield
{
  const count = 600;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 4 + Math.random() * 4;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9fc4ff, size: 0.012, sizeAttenuation: true })));
}

// ------------------------------------------------------------------ arena
const playGroup = new THREE.Group();
playGroup.position.set(0, 1.3, -1.2);
scene.add(playGroup);

const ringGeo = new THREE.TorusGeometry(RING_RADIUS, 0.004, 8, 96);
const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x2a3c63 }));
ring.rotation.x = 0;
playGroup.add(ring);

const blocks = [];
for (let i = 0; i < BLOCK_COUNT; i++) {
  const color = COLORS[i];
  const material = new THREE.MeshStandardMaterial({
    color, roughness: 0.32, metalness: 0.15, emissive: color, emissiveIntensity: 0.28,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE), material);
  mesh.userData = { index: i, collect: 0, highlight: 0, spin: Math.random() * Math.PI };
  playGroup.add(mesh);
  blocks.push(mesh);
}

// VR HUD: a canvas-textured panel floating above the ring
const hudCanvas = document.createElement('canvas');
hudCanvas.width = 512;
hudCanvas.height = 200;
const hudCtx = hudCanvas.getContext('2d');
const hudTexture = new THREE.CanvasTexture(hudCanvas);
hudTexture.colorSpace = THREE.SRGBColorSpace;
const hudPanel = new THREE.Mesh(
  new THREE.PlaneGeometry(0.56, 0.22),
  new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true, depthTest: false }),
);
hudPanel.position.set(0, 0.34, 0.05);
hudPanel.renderOrder = 10;
playGroup.add(hudPanel);

function drawHud() {
  const ctx = hudCtx;
  ctx.clearRect(0, 0, 512, 200);
  ctx.fillStyle = 'rgba(8,14,28,0.72)';
  ctx.beginPath();
  ctx.roundRect(6, 6, 500, 188, 22);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,180,255,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8eefc';
  ctx.font = 'bold 54px system-ui, sans-serif';
  ctx.fillText(String(state.score), 150, 110);
  ctx.font = '22px system-ui, sans-serif';
  ctx.fillStyle = '#7f9bc9';
  ctx.fillText('收集', 150, 145);

  ctx.fillStyle = '#e8eefc';
  ctx.font = 'bold 54px system-ui, sans-serif';
  ctx.fillText(String(Math.max(0, Math.ceil(state.timeLeft))), 360, 110);
  ctx.font = '22px system-ui, sans-serif';
  ctx.fillStyle = '#7f9bc9';
  ctx.fillText('剩余秒', 360, 145);

  if (state.phase === 'over') {
    ctx.fillStyle = '#2ee6a8';
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.fillText(renderer.xr.isPresenting ? '时间到 · 按扳机重开' : '时间到 · 点画面重开', 256, 40);
  }
  hudTexture.needsUpdate = true;
}

// -------------------------------------------------------------- controllers
const raycaster = new THREE.Raycaster();
raycaster.params.Mesh = { threshold: 0 };
const pointerRay = new THREE.Raycaster();
const tmpVec = new THREE.Vector3();

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x2ee6a8 }));
  line.scale.z = 1.2;
  controller.add(line);
  scene.add(controller);
  controller.addEventListener('selectstart', () => onSelect(controller));
  controller.addEventListener('connected', (e) => {
    controller.userData.handedness = e.data.handedness;
    log(`手柄已连接: ${e.data.handedness}`);
  });
  controller.addEventListener('disconnected', () => { controller.userData.handedness = null; });
}

// ------------------------------------------------------------------- audio
let audioCtx = null;
function beep(freq = 660, dur = 0.12, gain = 0.15) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch (e) {
    /* audio is optional */
  }
}

// ------------------------------------------------------------------ helpers
function activeBlocks() {
  return blocks.filter((b) => b.userData.collect === 0);
}

function viewRay() {
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  const origin = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const quat = new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(quat).normalize();
  return { origin, dir };
}

function pickWithRay(origin, dir) {
  raycaster.set(origin, dir);
  const hits = raycaster.intersectObjects(activeBlocks(), false);
  return hits.length ? hits[0].object : null;
}

function collect(block) {
  block.userData.collect = 0.0001;
  state.score += 1;
  beep(520 + state.score * 18, 0.14);
  state.dwell = 0;
  state.dwellTarget = null;
  updateHud2d();
}

function respawn(block) {
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  block.material.color.setHex(color);
  block.material.emissive.setHex(color);
  block.userData.collect = 0;
  block.userData.highlight = 0;
}

// three.js dispatches XR select events on the controller group without setting
// event.currentTarget, so the controller is passed in explicitly.
function onSelect(controller) {
  if (state.phase === 'over') { restart(); return; }
  if (state.phase !== 'playing') return;
  const origin = controller.getWorldPosition(new THREE.Vector3());
  const quat = controller.getWorldQuaternion(new THREE.Quaternion());
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(quat).normalize();
  const target = pickWithRay(origin, dir);
  if (target) collect(target);
}

function restart() {
  state.score = 0;
  state.timeLeft = ROUND_SECONDS;
  state.phase = 'playing';
  state.dwell = 0;
  state.dwellTarget = null;
  blocks.forEach((b) => respawn(b));
  el.hud.classList.add('hidden');
  if (!renderer.xr.isPresenting) el.fab.classList.remove('hidden');
  updateHud2d();
  log('新一局开始');
}

function updateHud2d() {
  el.score2d.textContent = `SCORE ${state.score} · TIME ${Math.max(0, Math.ceil(state.timeLeft))}s`;
}

// -------------------------------------------------------------------- loop
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const t = now / 1000;

  // blocks orbit + idle spin
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.userData.collect > 0) {
      b.userData.collect += dt / 0.35;
      const k = Math.min(b.userData.collect, 1);
      b.scale.setScalar(1 - k * 0.85);
      b.position.lerp(tmpVec.set(0, 0, 0.55), k * 0.12);
      if (b.userData.collect >= 1) respawn(b);
    } else {
      const a = (i / BLOCK_COUNT) * Math.PI * 2 + t * 0.35;
      b.position.set(Math.cos(a) * RING_RADIUS, Math.sin(a) * RING_RADIUS * 0.55, Math.sin(t * 0.7 + b.userData.spin) * 0.05);
      b.rotation.x += dt * 0.7;
      b.rotation.y += dt * 0.9;
      b.scale.setScalar(1 + b.userData.highlight * 0.35);
      b.material.emissiveIntensity = 0.28 + b.userData.highlight * 0.9;
    }
  }

  // gaze dwell targeting
  if (state.phase === 'playing') {
    const { origin, dir } = viewRay();
    const target = pickWithRay(origin, dir);
    if (target !== state.dwellTarget) {
      state.dwellTarget = target;
      state.dwell = 0;
    }
    for (const b of blocks) {
      if (b !== target) b.userData.highlight = Math.max(0, b.userData.highlight - dt * 3);
    }
    if (target) {
      state.dwell += dt;
      target.userData.highlight = Math.min(1, state.dwell / DWELL_SECONDS);
      if (state.dwell >= DWELL_SECONDS) collect(target);
    }

    state.timeLeft -= dt;
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      state.phase = 'over';
      beep(320, 0.5);
      el.desc.innerHTML = `时间到！本局收集了 <b>${state.score}</b> 个方块。`;
      el.enter.textContent = '再来一局';
      el.enter.disabled = false;
      el.hud.classList.remove('hidden');
      if (!renderer.xr.isPresenting) el.fab.classList.remove('hidden');
    }
    updateHud2d();
  }

  drawHud();
  renderer.render(scene, camera);
});

// desktop fallback: click to collect
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (state.phase === 'over') { restart(); return; }
  if (state.phase !== 'playing') return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointerRay.setFromCamera(
    { x: ((e.clientX - rect.left) / rect.width) * 2 - 1, y: -((e.clientY - rect.top) / rect.height) * 2 + 1 },
    camera,
  );
  const hits = pointerRay.intersectObjects(activeBlocks(), false);
  if (hits.length) collect(hits[0].object);
});

// ------------------------------------------------------------------ session
const XR_TIMEOUT_MS = 8000;

async function enterVR() {
  el.enter.disabled = true;
  el.status.textContent = '正在请求 VR 会话…';
  try {
    // Never await navigator.xr.isSessionSupported() on this path: some browsers
    // never settle that promise, which would freeze the whole page.
    const session = await Promise.race([
      navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('请求 VR 会话超时')), XR_TIMEOUT_MS)),
    ]);
    state.usingFloorSpace = session.enabledFeatures && session.enabledFeatures.includes('local-floor');
    await renderer.xr.setSession(session);
    session.addEventListener('end', onSessionEnd);
    playGroup.position.y = state.usingFloorSpace ? 1.3 : 0;
    state.phase = 'playing';
    state.timeLeft = ROUND_SECONDS;
    el.hud.classList.add('hidden');
    el.fab.classList.add('hidden');
    el.status.textContent = '';
    log(`VR 会话已启动（${state.usingFloorSpace ? 'local-floor' : 'local'} 参考空间）`);
    return true;
  } catch (err) {
    el.enter.disabled = false;
    el.status.textContent = `进入 VR 失败：${err.message || err}`;
    log(`enterVR 失败: ${err.message || err}`);
    return false;
  }
}

function onSessionEnd() {
  state.phase = 'idle';
  el.hud.classList.remove('hidden');
  el.enter.textContent = '进入 VR';
  el.enter.disabled = false;
  el.status.textContent = 'VR 会话已结束';
}

// 2D mode: the game runs on a flat screen, mouse click collects.
function start2D(reason) {
  playGroup.position.set(0, 0, -1.2);
  state.phase = 'playing';
  state.timeLeft = ROUND_SECONDS;
  el.hud.classList.add('hidden');
  el.fab.classList.remove('hidden');
  updateHud2d();
  log(`2D 模式：${reason}`);
}

el.enter.addEventListener('click', enterVR);
el.fab.addEventListener('click', enterVR);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------ startup
window.__demo = { state, renderer, scene, camera, blocks, start2D };

(async function boot() {
  drawHud();
  updateHud2d();
  if (isStandalone) log('以独立应用模式运行（PWA）');

  if (!navigator.xr) {
    el.status.textContent = '此浏览器不支持 WebXR（需要 Quest 3 上的 Horizon 浏览器）';
    start2D('浏览器不支持 WebXR');
    return;
  }
  el.status.textContent = '正在进入 VR…';
  log('尝试请求 immersive-vr 会话');
  const ok = await enterVR();
  if (!ok) {
    // The session may have been rejected for lack of a user gesture. Arm a
    // one-shot listener so the next tap/click/keypress starts it instead.
    armGestureRetry();
    start2D('VR 会话未启动，点屏幕任意处或按按钮重试');
  }
})();

let gestureArmed = false;
function armGestureRetry() {
  if (gestureArmed) return;
  gestureArmed = true;
  const retry = async (e) => {
    window.removeEventListener('pointerdown', retry);
    window.removeEventListener('touchstart', retry);
    window.removeEventListener('keydown', retry);
    log('检测到用户手势，重试进入 VR');
    const ok = await enterVR();
    if (!ok) armGestureRetry();
  };
  window.addEventListener('pointerdown', retry, { passive: true });
  window.addEventListener('touchstart', retry, { passive: true });
  window.addEventListener('keydown', retry);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
