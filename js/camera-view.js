// Camera view: for phones without native AR (no Google Play Services for AR).
// The live camera fills the screen and the dish is drawn on top at real size. The phone's motion sensors
// keep the dish in place as the guest turns the phone, so it looks like it sits in front of them.
// Drag to turn the dish or move it nearer/further, pinch to resize, "Place here" to put it where you look.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const TABLE_DROP = 0.32; // assumed height of the phone above the table (m) when seated
const START_DISTANCE = 0.45;

let active = null;

/** Ask for motion-sensor access. Must be called directly inside a tap handler (iPhone requirement). */
export function requestMotionPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === "function") {
    return DOE.requestPermission().then((r) => r === "granted").catch(() => false);
  }
  return Promise.resolve(true);
}

export async function openCameraView(dish, motionPermission = Promise.resolve(true)) {
  if (active) active.close();
  const ui = buildUI(dish);
  document.body.append(ui.root);
  document.documentElement.classList.add("camera-open");

  const state = {
    stream: null,
    renderer: null,
    raf: 0,
    listeners: [],
    closed: false,
  };
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    state.listeners.push(() => target.removeEventListener(type, fn, opts));
  };

  const close = () => {
    if (state.closed) return;
    state.closed = true;
    cancelAnimationFrame(state.raf);
    state.listeners.forEach((off) => off());
    state.stream?.getTracks().forEach((t) => t.stop());
    if (state.renderer) {
      state.renderer.dispose();
      state.renderer.forceContextLoss?.();
    }
    ui.root.remove();
    document.documentElement.classList.remove("camera-open");
    active = null;
  };
  active = { close };
  ui.close.addEventListener("click", close);

  // ---------------------------------------------------------------- camera feed
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    ui.message(cameraError(err));
    return;
  }
  if (state.closed) return close();
  ui.video.srcObject = state.stream;
  await ui.video.play().catch(() => {});

  // ---------------------------------------------------------------- 3D scene
  const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, alpha: true, antialias: true });
  state.renderer = renderer;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.02, 20);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -0.3;
  sun.shadow.camera.right = sun.shadow.camera.top = 0.3;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 3;
  sun.shadow.radius = 4;

  // The dish sits on an invisible "table" that only catches its shadow.
  const anchor = new THREE.Group();
  const turntable = new THREE.Group();
  anchor.add(turntable);
  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.ShadowMaterial({ opacity: 0.32 }));
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.receiveShadow = true;
  anchor.add(shadowCatcher);
  sun.position.set(0.25, 0.9, 0.35);
  sun.target = anchor;
  anchor.add(sun);
  scene.add(anchor);

  ui.status("Loading the dish…");
  let model;
  try {
    const gltf = await new GLTFLoader().loadAsync(dish.model);
    model = gltf.scene;
  } catch (err) {
    console.error(err);
    ui.message("Couldn't load this dish's 3D model. Check your connection and try again.");
    return;
  }
  if (state.closed) return;
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  turntable.add(model);

  // ---------------------------------------------------------------- motion sensors → camera direction
  const sensor = { q: new THREE.Quaternion(), has: false };
  const euler = new THREE.Euler();
  const zee = new THREE.Vector3(0, 0, 1);
  const q0 = new THREE.Quaternion();
  const qBack = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // camera looks out the back of the phone
  const onOrientation = (e) => {
    if (e.alpha == null) return;
    const d2r = THREE.MathUtils.DEG2RAD;
    const screenAngle = (screen.orientation?.angle ?? window.orientation ?? 0) * d2r;
    euler.set(e.beta * d2r, e.alpha * d2r, -e.gamma * d2r, "YXZ");
    sensor.q.setFromEuler(euler).multiply(qBack).multiply(q0.setFromAxisAngle(zee, -screenAngle));
    sensor.has = true;
  };
  const motionOK = await motionPermission;
  if (motionOK) listen(window, "deviceorientation", onOrientation);

  // Without motion sensors (desktop, or permission refused) the view looks down at the table, like a seated guest.
  const fallbackLook = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.62, 0, 0, "YXZ"));
  camera.quaternion.copy(fallbackLook);
  await waitFor(() => sensor.has, 700);
  if (sensor.has) camera.quaternion.copy(sensor.q);

  // ---------------------------------------------------------------- placing the dish
  const view = { yaw: 0, scale: 1, distance: START_DISTANCE };
  const forward = new THREE.Vector3();

  function placeInFront() {
    // Where the guest is looking, on a table TABLE_DROP below the phone; straight ahead if they look up.
    camera.getWorldDirection(forward);
    let dist = START_DISTANCE;
    if (forward.y < -0.15) dist = THREE.MathUtils.clamp(TABLE_DROP / -forward.y, 0.25, 1.0);
    const flat = new THREE.Vector3(forward.x, 0, forward.z);
    if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1);
    flat.normalize();
    const horizontal = forward.y < -0.15 ? Math.sqrt(Math.max(0, dist * dist - TABLE_DROP * TABLE_DROP)) : dist;
    view.distance = horizontal;
    view.heading = Math.atan2(flat.x, flat.z);
    updateAnchor();
  }
  function updateAnchor() {
    anchor.position.set(Math.sin(view.heading) * view.distance, -TABLE_DROP, Math.cos(view.heading) * view.distance);
    // Models face -Z (dish_scanner puts the side scanned first there): turn that side towards the guest.
    anchor.rotation.set(0, view.heading, 0);
    turntable.rotation.y = view.yaw;
    turntable.scale.setScalar(view.scale);
    ui.scale.textContent = view.scale === 1 ? "Real size" : `${view.scale.toFixed(1)}× size`;
  }
  placeInFront();
  ui.status(sensor.has ? "Move your phone to look around · drag to turn · pinch to resize" : "Drag to turn the dish · pinch to resize");

  ui.place.addEventListener("click", placeInFront);
  ui.scale.addEventListener("click", () => {
    view.scale = 1;
    updateAnchor();
  });

  // ---------------------------------------------------------------- gestures
  const pointers = new Map();
  let pinchStart = 0;
  let scaleStart = 1;
  listen(ui.canvas, "pointerdown", (e) => {
    ui.canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      scaleStart = view.scale;
    }
  });
  listen(ui.canvas, "pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart > 0) view.scale = THREE.MathUtils.clamp(scaleStart * (dist / pinchStart), 0.4, 3);
    } else {
      view.yaw += (dx / window.innerWidth) * Math.PI * 2;
      view.distance = THREE.MathUtils.clamp(view.distance - dy * 0.002, 0.2, 1.5);
    }
    updateAnchor();
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = 0;
  };
  listen(ui.canvas, "pointerup", up);
  listen(ui.canvas, "pointercancel", up);

  // ---------------------------------------------------------------- render loop
  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Roughly a phone's main camera: ~65° along the long side of the picture.
    camera.fov = w < h ? 65 : 65 / camera.aspect;
    camera.updateProjectionMatrix();
  };
  resize();
  listen(window, "resize", resize);

  const loop = () => {
    state.raf = requestAnimationFrame(loop);
    if (sensor.has) camera.quaternion.slerp(sensor.q, 0.35); // smooth out sensor jitter
    renderer.render(scene, camera);
  };
  loop();
}

function waitFor(test, ms) {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => (test() || performance.now() - start > ms ? resolve() : setTimeout(tick, 50));
    tick();
  });
}

function cameraError(err) {
  if (!window.isSecureContext) return "The camera only works on a secure (https) page.";
  if (err?.name === "NotAllowedError") return "Camera access was blocked. Allow the camera for this site in your browser settings, then try again.";
  if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") return "No camera was found on this device.";
  return "The camera couldn't be started on this device.";
}

function buildUI(dish) {
  const root = document.createElement("div");
  root.className = "camera-view";
  root.innerHTML = `
    <video playsinline muted autoplay></video>
    <canvas></canvas>
    <div class="cv-top">
      <div><strong></strong><span>Camera view</span></div>
      <button class="cv-close" aria-label="Close camera view">✕</button>
    </div>
    <div class="cv-bottom">
      <p class="cv-status"></p>
      <div class="cv-actions">
        <button class="cv-btn cv-scale" type="button">Real size</button>
        <button class="cv-btn cv-place" type="button">Place here</button>
      </div>
    </div>`;
  root.querySelector(".cv-top strong").textContent = dish.name;
  const statusEl = root.querySelector(".cv-status");
  return {
    root,
    video: root.querySelector("video"),
    canvas: root.querySelector("canvas"),
    close: root.querySelector(".cv-close"),
    place: root.querySelector(".cv-place"),
    scale: root.querySelector(".cv-scale"),
    status: (text) => { statusEl.textContent = text; },
    message: (text) => {
      statusEl.textContent = text;
      statusEl.classList.add("cv-error");
      root.querySelector(".cv-actions").hidden = true;
    },
  };
}
