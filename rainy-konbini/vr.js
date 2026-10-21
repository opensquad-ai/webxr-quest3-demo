// VR layer for the rainy-konbini diorama (original by 08102317cdw-art, MIT).
//
// The page is desktop-only: OrbitControls, an EffectComposer with bloom, and no
// navigator.xr entry. This module adds an immersive session without touching the
// scene code:
//   * three calls inside the page's frame function were patched to no-op while
//     presenting (a composer renders to a fullscreen quad, which is invalid inside
//     an XR session), so XR frames render the scene straight to the headset
//   * the framing camera is reparented under a dolly; XR ignores camera.position,
//     so the orbit camera keeps writing it harmlessly
//   * two viewpoints measured from the scene: standing on the street in front of
//     the store (default) and the original elevated model view
//
// No THREE namespace is exposed by the page, so constructors are borrowed from
// live objects instead of importing anything.

(() => {
  const EYE = 1.6;              // assumed eye height for placing the dolly
  const STREET_Y = 0.16;        // road/sidewalk surface measured from the scene
  const WALK_RADIUS = 12;       // how far the player may wander from the store
  const SPEED = 1.7;            // m/s, comfortable walking pace
  const TURN_DEG = 30;

  const state = {
    ready: false, presenting: false, view: null, moves: 0, turns: 0, resets: 0,
    views: null, error: null, visibility: null, attempts: 0, stuckTimer: null,
  };

  const V = () => new (window.__camera.position.constructor)();
  const Q = () => new (window.__camera.quaternion.constructor)();

  // ------------------------------------------------------------------ overlay UI
  // Centred and large so a controller can hit it inside a 2D panel; the wrapper
  // ignores pointer events so the original orbit controls keep working.
  const ui = document.createElement('div');
  Object.assign(ui.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    zIndex: 99999, textAlign: 'center', pointerEvents: 'none',
    font: '13px/1.5 system-ui, -apple-system, "Microsoft YaHei", sans-serif',
    color: '#cfe3ff', userSelect: 'none',
  });
  const btn = document.createElement('button');
  btn.textContent = '进入 VR';
  Object.assign(btn.style, {
    pointerEvents: 'auto', font: 'inherit', fontSize: '19px',
    padding: '16px 34px', borderRadius: '999px',
    border: '1px solid rgba(46,230,168,.7)', background: 'rgba(8,14,28,.88)',
    color: '#2ee6a8', cursor: 'pointer',
    boxShadow: '0 8px 40px rgba(0,0,0,.55)',
  });
  const hint = document.createElement('div');
  Object.assign(hint.style, {
    marginTop: '10px', padding: '7px 12px', borderRadius: '8px',
    background: 'rgba(8,14,28,.75)', color: '#8fa6c8', fontSize: '12px',
    display: 'inline-block',
  });
  ui.append(btn, document.createElement('br'), hint);
  document.body.appendChild(ui);

  const setHint = (text, color) => { hint.textContent = text; hint.style.color = color || '#8fa6c8'; };
  setHint('按一下这个按钮（或按手柄扳机）进入 VR');

  // ------------------------------------------------------------------- geometry
  // Measured once: ground height, the point the framing camera looks at, and the
  // horizontal direction it looks from. Meshes bigger than 150 m are the sky dome.
  function measure() {
    const camera = window.__camera;
    const scene = window.__scene;
    scene.updateMatrixWorld(true);
    const v = V();
    let mnY = 1e9, hit = null;
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      if (!b) return;
      if (Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) > 150) return;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
        v.applyMatrix4(o.matrixWorld);
        if (v.y < mnY) mnY = v.y;
        if (Math.abs(v.y - STREET_Y) < 0.03) hit = true;
      }
    });
    const eye = camera.getWorldPosition(V());
    const dir = V().set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(Q()));
    const groundY = hit ? STREET_Y : Math.max(0, mnY + 1.3);
    // where the framing camera's ray meets the street
    const t = dir.y < -0.05 ? (groundY - eye.y) / dir.y : 12;
    const target = { x: eye.x + dir.x * t, z: eye.z + dir.z * t };
    let dx = eye.x - target.x, dz = eye.z - target.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const streetDist = Math.min(11, Math.max(6, len * 0.22));
    return {
      groundY,
      target,
      dir: { x: dx, z: dz },
      street: { x: target.x + dx * streetDist, y: groundY, z: target.z + dz * streetDist },
      overview: { x: eye.x, y: Math.max(groundY + 2, eye.y - EYE), z: eye.z },
      rawEye: { x: eye.x, y: eye.y, z: eye.z },
    };
  }

  function faceTarget() {
    const { target } = state.views;
    const dolly = state.dolly;
    if (!dolly) return;
    const dx = target.x - dolly.position.x;
    const dz = target.z - dolly.position.z;
    dolly.rotation.set(0, Math.atan2(dx, dz) + Math.PI, 0);
  }

  function setView(name, keepFacing) {
    const v = state.views;
    const dolly = state.dolly;
    if (!v || !dolly) return false;
    const p = name === 'overview' ? v.overview : v.street;
    dolly.position.set(p.x, p.y, p.z);
    if (!keepFacing) faceTarget();
    state.view = name;
    state.resets += 1;
    return true;
  }

  // --------------------------------------------------------------------- session
  let dolly = null;
  let cameraHome = null;
  let turnArmed = true;
  let last = 0;

  async function enter() {
    const renderer = window.__renderer;
    const scene = window.__scene;
    const camera = window.__camera;
    if (!renderer || !scene || !camera) { setHint('场景还在加载…', '#ffd479'); return false; }
    if (state.presenting) return true;
    if (!navigator.xr) { setHint('此浏览器没有 WebXR：用鼠标拖动环视即可', '#ffd479'); return false; }
    btn.disabled = true;
    btn.textContent = '正在进入 VR…';
    try {
      const session = await Promise.race([
        navigator.xr.requestSession('immersive-vr', {
          optionalFeatures: ['local-floor', 'bounded-floor'],
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), 10000)),
      ]);

      state.views = measure();
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType('local-floor');
      await renderer.xr.setSession(session);

      cameraHome = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
      };
      // The dolly carries the player; the page's orbit camera becomes a passive
      // child. local-floor already supplies the real head height, so the dolly
      // sits on the ground plane.
      dolly = new (scene.constructor)();
      scene.add(dolly);
      dolly.add(camera);
      state.dolly = dolly;
      camera.position.set(0, 0, 0);
      camera.quaternion.set(0, 0, 0, 1);
      setView('street');

      turnArmed = true;
      session.addEventListener('selectstart', () => setView('street'));
      session.addEventListener('squeezestart', () => {
        setView(state.view === 'overview' ? 'street' : 'overview');
      });
      session.addEventListener('end', leave);

      state.visibility = session.visibilityState;
      session.addEventListener('visibilitychange', () => {
        state.visibility = session.visibilityState;
        if (state.visibility === 'visible' && state.stuckTimer) {
          clearTimeout(state.stuckTimer);
          state.stuckTimer = null;
        }
      });

      // The runtime can hand back a session that never becomes visible (it happens
      // when the request races the app's own launch transition). The XR frame loop
      // then never ticks: the picture freezes and inputSources stays empty. Watch
      // for that and end the session so the next trigger press starts clean.
      if (state.stuckTimer) clearTimeout(state.stuckTimer);
      state.stuckTimer = setTimeout(() => {
        state.stuckTimer = null;
        if (state.presenting && session.visibilityState !== 'visible') {
          state.error = 'session stayed hidden';
          state.visibility = session.visibilityState;
          setHint('系统没把 VR 会话切到前台 —— 再按一次扳机重试', '#ffd479');
          try { session.end(); } catch (e) { /* already gone */ }
        }
      }, 2500);

      renderer.setAnimationLoop(frame);
      state.presenting = true;
      state.error = null;
      btn.textContent = 'VR 中';
      setHint('VR：左摇杆走动 · 右摇杆转身 · 握把切俯瞰 · 扳机回起点', '#2ee6a8');
      return true;
    } catch (err) {
      state.error = String(err.message || err);
      btn.disabled = false;
      btn.textContent = '进入 VR';
      const unsupported = /not supported|unsupported|no XR|NotFound|NotSupported/i.test(state.error);
      const needsGesture = /user activation|requires .*gesture/i.test(state.error);
      setHint(unsupported
        ? '这台设备没有 VR：鼠标拖动即可环视整个便利店'
        : needsGesture
          ? '点一下画面（或按任意键）进入 VR'
          : `进入 VR 失败：${state.error}`, unsupported || needsGesture ? '#8fa6c8' : '#ff8f8f');
      console.warn('[xr] enter failed:', err);
      return false;
    }
  }

  function leave() {
    const renderer = window.__renderer;
    const scene = window.__scene;
    const camera = window.__camera;
    state.presenting = false;
    renderer.setAnimationLoop(null);
    if (dolly && cameraHome) {
      scene.add(camera);
      camera.position.copy(cameraHome.position);
      camera.quaternion.copy(cameraHome.quaternion);
      scene.remove(dolly);
      dolly = null;
      state.dolly = null;
    }
    btn.disabled = false;
    btn.textContent = '进入 VR';
    setHint('头显：左摇杆走动 · 右摇杆转身 · 握把切俯瞰 · 扳机回起点');
  }

  function frame(time) {
    const renderer = window.__renderer;
    const scene = window.__scene;
    const camera = window.__camera;
    const dt = last ? Math.max(0, Math.min(0.05, (time - last) / 1000)) : 1 / 72;
    last = time;

    const session = renderer.xr.getSession();
    if (session && dolly) {
      let mx = 0, mz = 0, turn = 0;
      for (const src of session.inputSources) {
        const gp = src.gamepad;
        if (!gp || !gp.axes) continue;
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        if (Math.hypot(ax, ay) > 0.2) { mx = ax; mz = -ay; }
        const tx = gp.axes[2] || 0;
        if (Math.abs(tx) > 0.7) turn = tx;
      }
      if (mx || mz) {
        const q = renderer.xr.getCamera().getWorldQuaternion(Q());
        const fwd = V().set(0, 0, -1).applyQuaternion(q); fwd.y = 0; fwd.normalize();
        const right = V().set(1, 0, 0).applyQuaternion(q); right.y = 0; right.normalize();
        const vx = fwd.x * mz + right.x * mx;
        const vz = fwd.z * mz + right.z * mx;
        const len = Math.hypot(vx, vz) || 1;
        let nx = dolly.position.x + (vx / len) * SPEED * dt;
        let nz = dolly.position.z + (vz / len) * SPEED * dt;
        const { target } = state.views;
        const ox = nx - target.x, oz = nz - target.z;
        const r = Math.hypot(ox, oz);
        if (r > WALK_RADIUS) { nx = target.x + ox / r * WALK_RADIUS; nz = target.z + oz / r * WALK_RADIUS; }
        dolly.position.x = nx;
        dolly.position.z = nz;
        dolly.position.y = state.views.groundY;   // stay on the street
        state.moves += 1;
      }
      if (turn && turnArmed) {
        dolly.rotateY(-Math.sign(turn) * TURN_DEG * Math.PI / 180);
        state.turns += 1;
        turnArmed = false;
      } else if (!turn) {
        turnArmed = true;
      }
      // keep the page's orbit camera from drifting under us
      camera.position.set(0, 0, 0);
      camera.quaternion.set(0, 0, 0, 1);
    }

    renderer.render(scene, camera);
  }

  btn.addEventListener('click', enter);

  (async () => {
    for (let i = 0; i < 200; i++) {
      if (window.__renderer && window.__scene && window.__camera) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    state.ready = !!(window.__renderer && window.__scene && window.__camera);
    const tip = document.getElementById('bootTip');
    if (tip) tip.remove();
    if (!state.ready) {
      setHint('场景加载超时，请刷新页面', '#ff8f8f');
      const t = document.getElementById('bootTip');
      if (t) t.innerHTML = '<b style="color:#ff8f8f">加载超时</b><span>请下拉刷新或重开应用</span>';
      return;
    }
    if (!navigator.xr) { setHint('此浏览器没有 WebXR：鼠标拖动即可环视'); return; }
    // Deliberately no auto-enter: requesting a session while the TWA is still
    // taking the foreground produces a session the runtime never shows, and the
    // page sits on a frozen frame with no controllers. The button is a real user
    // gesture, which is the path the runtime reliably promotes to focused VR.
    setHint('按「进入 VR」进入沉浸模式（手柄扳机点一下画面即可）', '#8fa6c8');
    const pressOnce = () => {
      if (state.presenting) return;
      document.removeEventListener('pointerdown', pressOnce, true);
      enter();
    };
    document.addEventListener('pointerdown', pressOnce, true);
  })();

  window.__xr = { state, enter, leave, setView, measure };
})();
