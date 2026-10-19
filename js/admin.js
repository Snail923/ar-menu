// Menu admin: add, edit and delete dishes, with their 3D models.
// The site is static (GitHub Pages), so saving = committing to the site's GitHub repository.
// Only people with a GitHub token that can write to that repository can publish: that's the admin check.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const $ = (id) => document.getElementById(id);
const BRANCH = "main";
const TOKEN_KEY = "arMenuAdminToken";
const MAX_MODEL_MB = 25;

// Admin login. NOTE: this site has no server, so this check runs in the browser and anyone can read these
// values in the page source. It keeps casual visitors out of the admin screen; it is not real security.
// Publishing additionally needs a GitHub token (below), which is never stored in the site's code.
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "1234";
const LOGIN_KEY = "arMenuAdminLoggedIn";

// owner/repo: from the GitHub Pages address (owner.github.io/repo/), or this project's repository.
const REPO = (() => {
  const host = location.hostname;
  if (host.endsWith(".github.io")) {
    const owner = host.split(".")[0];
    const repo = location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
    return `${owner}/${repo}`;
  }
  return "Snail923/ar-menu";
})();

let token = null;
let menu = null; // { restaurant, categories: [{ id, name, dishes: [...] }] }
let editing = null; // { dish, categoryId } or null for a new dish
let prepared = null; // processed model: { glb, png, width, height, depth }
let previewUrl = null;

// ------------------------------------------------------------------ storage (may be unavailable)

// Files straight from the repository: available immediately, unlike the Pages site which takes ~1 minute.
const repoFile = (path) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${path}`;

const session = {
  loggedIn: () => { try { return sessionStorage.getItem(LOGIN_KEY) === "1"; } catch { return false; } },
  set: () => { try { sessionStorage.setItem(LOGIN_KEY, "1"); } catch { /* lasts until reload */ } },
  clear: () => { try { sessionStorage.removeItem(LOGIN_KEY); } catch { /* ignore */ } },
};

const store = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (value, remember) => {
    try { (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value); } catch { /* not saved */ }
  },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

// ------------------------------------------------------------------ GitHub API

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch { /* no body */ }
    const err = new Error(`GitHub ${res.status}${detail ? `: ${detail}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64Text(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function loadMenuFromRepo() {
  const file = await gh(`/contents/data/menu.json?ref=${BRANCH}`);
  return JSON.parse(fromBase64Text(file.content));
}

/**
 * One commit with several file changes. files: [{ path, bytes | text }] to write, deletes: [path] to remove.
 * Retries once if someone else published in between.
 */
async function commitFiles(message, files, deletes = [], attempt = 0) {
  const ref = await gh(`/git/ref/heads/${BRANCH}`);
  const head = ref.object.sha;
  const base = await gh(`/git/commits/${head}`);

  const tree = [];
  for (const f of files) {
    const bytes = f.bytes ?? new TextEncoder().encode(f.text);
    const blob = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content: toBase64(bytes), encoding: "base64" }) });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const path of deletes) tree.push({ path, mode: "100644", type: "blob", sha: null });

  const newTree = await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
  const commit = await gh("/git/commits", {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }),
  });
  try {
    await gh(`/git/refs/heads/${BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  } catch (err) {
    if (err.status === 422 && attempt === 0) return commitFiles(message, files, deletes, 1); // branch moved on
    throw err;
  }
  return commit.sha;
}

// ------------------------------------------------------------------ sign in

async function signIn(candidate, remember) {
  token = candidate;
  const repo = await gh("");
  if (!repo.permissions?.push) {
    token = null;
    throw new Error("This token can read the menu but not change it. Give it Contents: Read and write.");
  }
  store.set(candidate, remember);
  $("sign-in-panel").hidden = true;
  $("admin-main").hidden = false;
  $("sign-out").hidden = false;
  $("repo-line").textContent = `Publishing to github.com/${REPO} · the live menu updates about a minute after each change.`;
  menu = await loadMenuFromRepo();
  renderDishes();
}

$("sign-in-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("sign-in-message");
  msg.textContent = "Checking…";
  msg.className = "form-message";
  try {
    await signIn($("token").value.trim(), $("remember").checked);
    msg.textContent = "";
  } catch (err) {
    msg.className = "form-message error";
    msg.textContent = err.status === 401
      ? "That token isn't valid (or has expired). Create a new one and try again."
      : err.status === 404
        ? `This token has no access to github.com/${REPO}. Give it access to that repository.`
        : err.message;
  }
});

$("sign-out").addEventListener("click", () => {
  session.clear(); // the GitHub token stays remembered on this device, if it was saved
  location.reload();
});

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const ok = $("username").value.trim() === ADMIN_USERNAME && $("password").value === ADMIN_PASSWORD;
  if (!ok) {
    $("login-message").className = "form-message error";
    $("login-message").textContent = "Wrong username or password.";
    $("password").value = "";
    return;
  }
  session.set();
  afterLogin();
});

/** Logged in: use the remembered GitHub token, or ask for it once on this device. */
function afterLogin() {
  $("login-panel").hidden = true;
  $("sign-out").hidden = false;
  const saved = store.get();
  if (!saved) {
    $("sign-in-panel").hidden = false;
    return;
  }
  signIn(saved, true).catch(() => {
    store.clear();
    token = null;
    $("sign-in-panel").hidden = false;
    $("sign-in-message").className = "form-message error";
    $("sign-in-message").textContent = "The saved GitHub token no longer works. Paste a new one.";
  });
}

$("repo-name-help").textContent = REPO;

// ------------------------------------------------------------------ dish list

const allDishes = () => menu.categories.flatMap((c) => c.dishes.map((d) => ({ dish: d, category: c })));
const money = (p) => `${menu.restaurant.currency}${Number(p).toFixed(2)}`;

function renderDishes() {
  const wrap = $("dishes");
  wrap.innerHTML = "";
  for (const category of menu.categories) {
    const h = document.createElement("h3");
    h.textContent = category.name;
    wrap.append(h);
    if (!category.dishes.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "No dishes yet.";
      wrap.append(p);
    }
    for (const dish of category.dishes) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dish-row";
      row.innerHTML = `<img alt="" src="${repoFile(dish.image)}?v=${dish.updated || 0}"><span><strong></strong><small></small></span><em></em>`;
      row.querySelector("strong").textContent = dish.name;
      row.querySelector("small").textContent = dish.size || "";
      row.querySelector("em").textContent = money(dish.price);
      row.addEventListener("click", () => openEditor(dish, category.id));
      wrap.append(row);
    }
  }
}

$("add-dish").addEventListener("click", () => openEditor(null, menu.categories[0]?.id));

// ------------------------------------------------------------------ editor

function fillCategories(selectedId) {
  const select = $("f-category");
  select.innerHTML = "";
  for (const c of menu.categories) select.add(new Option(c.name, c.id, false, c.id === selectedId));
  select.add(new Option("+ New category…", "__new"));
  $("new-category-field").hidden = select.value !== "__new";
}

$("f-category").addEventListener("change", () => {
  $("new-category-field").hidden = $("f-category").value !== "__new";
});

function openEditor(dish, categoryId) {
  editing = dish ? { dish, categoryId } : null;
  prepared = null;
  $("editor").hidden = false;
  $("editor-title").textContent = dish ? `Edit ${dish.name}` : "Add dish";
  $("delete-dish").hidden = !dish;
  resetDeleteButton();
  fillCategories(categoryId);
  $("f-name").value = dish?.name ?? "";
  $("f-price").value = dish?.price ?? "";
  $("f-description").value = dish?.description ?? "";
  $("f-tags").value = (dish?.tags ?? []).join(", ");
  $("f-scanned").checked = !!dish?.scanned;
  $("f-width").value = dish?.widthCm ?? 26;
  $("f-model").value = "";
  $("f-model").required = !dish;
  $("model-hint").textContent = dish
    ? "Leave empty to keep the current model, or choose a new .glb to replace it."
    : "From KIRI Engine, Polycam, Sketchfab… export as GLB. For OBJ scans, convert with the dish scanner first.";
  $("form-message").textContent = "";
  $("form-message").className = "form-message";
  showPreview(dish ? `${repoFile(dish.model)}?v=${dish.updated || 0}` : null, dish?.size);
  $("editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("cancel-edit").addEventListener("click", () => {
  $("editor").hidden = true;
  editing = null;
});

function showPreview(src, info) {
  const viewer = $("admin-viewer");
  if (src) viewer.src = src;
  else viewer.removeAttribute("src");
  $("model-info").textContent = info ? `Real size: ${info}` : "Choose a model to preview it at real size.";
}

// ------------------------------------------------------------------ model processing (in the browser)

/**
 * Scale a GLB to the given real width, stand it on y = 0 and centre it, then export it again as GLB.
 * Baking the size into the file means every AR viewer (and the camera view) shows it at real size.
 */
async function prepareModel(arrayBuffer, widthCm) {
  let gltf;
  try {
    gltf = await new GLTFLoader().parseAsync(arrayBuffer, "");
  } catch (err) {
    if (/draco/i.test(String(err))) throw new Error("This model uses Draco compression. Export it again without compression.");
    if (/ktx|basis/i.test(String(err))) throw new Error("This model uses KTX2 textures. Export it again with PNG or JPEG textures.");
    throw new Error("Couldn't read this file as a 3D model (GLB/glTF).");
  }
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) throw new Error("The model is empty.");
  const size = box.getSize(new THREE.Vector3());
  const scale = widthCm / 100 / Math.max(size.x, size.z);

  const centre = new THREE.Group();
  centre.add(root);
  centre.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const dish = new THREE.Group();
  dish.name = "dish";
  dish.add(centre);
  dish.scale.setScalar(scale);
  dish.updateMatrixWorld(true);

  const glb = await new GLTFExporter().parseAsync(dish, { binary: true, animations: gltf.animations });
  const real = size.clone().multiplyScalar(scale * 100);
  const png = await renderThumbnail(dish);
  return { glb, png, width: real.x, height: real.y, depth: real.z };
}

/** Card picture: the dish from the front and a little above, on a transparent background. */
function renderThumbnail(object) {
  const sizePx = 512;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(sizePx, sizePx);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(0.4, 1, -0.6);
  scene.add(sun);
  scene.add(object);

  const box = new THREE.Box3().setFromObject(object);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const camera = new THREE.PerspectiveCamera(32, 1, radius / 50, radius * 20);
  camera.position.copy(centre).add(new THREE.Vector3(0, radius * 1.0, -radius * 1.9).multiplyScalar(1.15));
  camera.lookAt(centre);
  renderer.render(scene, camera);
  return new Promise((resolve) => renderer.domElement.toBlob(async (blob) => {
    scene.remove(object);
    renderer.dispose();
    resolve(new Uint8Array(await blob.arrayBuffer()));
  }, "image/png"));
}

const sizeLabel = (p) => `${Math.round(p.width)} cm wide · ${p.height.toFixed(1)} cm tall`;

async function processChosenModel() {
  const file = $("f-model").files[0];
  const widthCm = Number($("f-width").value);
  if (!(widthCm >= 3)) return;
  let buffer;
  if (file) {
    if (file.size > MAX_MODEL_MB * 1024 * 1024) throw new Error(`This file is ${Math.round(file.size / 1048576)} MB. Keep models under ${MAX_MODEL_MB} MB (aim for under 5 MB so they load fast on phones).`);
    buffer = await file.arrayBuffer();
  } else if (editing) {
    // Same model, new width: rescale the current one.
    buffer = await fetch(`${repoFile(editing.dish.model)}?v=${Date.now()}`).then((r) => r.arrayBuffer());
  } else {
    return;
  }
  setMessage("Preparing the model…");
  prepared = await prepareModel(buffer, widthCm);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(new Blob([prepared.glb], { type: "model/gltf-binary" }));
  showPreview(previewUrl, sizeLabel(prepared));
  const mb = prepared.glb.byteLength / 1048576;
  setMessage(mb > 6 ? `Ready. The model is ${mb.toFixed(1)} MB, which may load slowly on mobile data.` : "Model ready.");
}

async function onModelInput() {
  try {
    await processChosenModel();
  } catch (err) {
    prepared = null;
    setMessage(err.message, true);
  }
}
$("f-model").addEventListener("change", onModelInput);
$("f-width").addEventListener("change", () => {
  if ($("f-model").files[0] || editing) onModelInput();
});

function setMessage(text, isError = false, isOk = false) {
  const el = $("form-message");
  el.textContent = text;
  el.className = `form-message${isError ? " error" : ""}${isOk ? " ok" : ""}`;
}

// ------------------------------------------------------------------ save / delete

const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dish";

function uniqueId(base, taken) {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

$("dish-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("f-name").value.trim();
  const price = Number($("f-price").value);
  const widthCm = Number($("f-width").value);
  let categoryId = $("f-category").value;
  const newCategory = $("f-new-category").value.trim();

  if (!name) return setMessage("Give the dish a name.", true);
  if (!(price >= 0) || $("f-price").value === "") return setMessage("Enter a price.", true);
  if (categoryId === "__new" && !newCategory) return setMessage("Name the new category.", true);
  if (!editing && !$("f-model").files[0]) return setMessage("Choose the dish's 3D model (.glb).", true);
  if (!(widthCm >= 3)) return setMessage("Enter the dish's real width in cm.", true);

  const save = $("save-dish");
  save.disabled = true;
  try {
    // Model needs (re)processing if a new file was chosen or the width changed.
    const widthChanged = editing && Number(editing.dish.widthCm ?? 26) !== widthCm;
    if (!prepared && ($("f-model").files[0] || widthChanged)) await processChosenModel();

    setMessage("Loading the latest menu…");
    menu = await loadMenuFromRepo(); // don't overwrite someone else's change

    if (categoryId === "__new") {
      categoryId = uniqueId(slug(newCategory), new Set(menu.categories.map((c) => c.id)));
      menu.categories.push({ id: categoryId, name: newCategory, dishes: [] });
    }
    const category = menu.categories.find((c) => c.id === categoryId);
    const takenIds = new Set(allDishes().map((x) => x.dish.id));

    let dish;
    if (editing) {
      // Find the dish again in the freshly loaded menu and take it out of its old category.
      for (const c of menu.categories) {
        const i = c.dishes.findIndex((d) => d.id === editing.dish.id);
        if (i >= 0) [dish] = c.dishes.splice(i, 1);
      }
      if (!dish) throw new Error("This dish was deleted by someone else meanwhile. Reload the page.");
    } else {
      const id = uniqueId(slug(name), takenIds);
      dish = { id, model: `models/${id}.glb`, image: `images/${id}.png` };
    }

    Object.assign(dish, {
      name,
      description: $("f-description").value.trim(),
      price: Math.round(price * 100) / 100,
      tags: $("f-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      scanned: $("f-scanned").checked,
      widthCm,
      updated: Date.now(),
    });
    const files = [];
    if (prepared) {
      // New files for a replaced model, so phones don't keep showing a cached old one.
      dish.model = `models/${dish.id}-${dish.updated}.glb`;
      dish.image = `images/${dish.id}-${dish.updated}.png`;
      dish.size = sizeLabel(prepared);
      files.push({ path: dish.model, bytes: prepared.glb }, { path: dish.image, bytes: prepared.png });
    }
    category.dishes.push(dish);
    files.push({ path: "data/menu.json", text: JSON.stringify(menu, null, 2) + "\n" });

    // Old model/picture files that nothing uses any more.
    const deletes = [];
    if (editing && prepared) {
      const used = new Set(allDishes().flatMap(({ dish: d }) => [d.model, d.image]));
      for (const old of [editing.dish.model, editing.dish.image]) if (old && !used.has(old)) deletes.push(old);
    }

    setMessage("Publishing…");
    await commitFiles(`${editing ? "Update" : "Add"} ${name}`, files, deletes);
    renderDishes();
    editing = { dish, categoryId };
    prepared = null;
    $("f-model").value = "";
    $("editor-title").textContent = `Edit ${dish.name}`;
    $("delete-dish").hidden = false;
    setMessage("Published. The live menu shows it in about a minute.", false, true);
  } catch (err) {
    console.error(err);
    setMessage(err.status === 401 ? "The GitHub token stopped working. Log out, log in again and connect a new token." : `Not published: ${err.message}`, true);
  } finally {
    save.disabled = false;
  }
});

// Delete needs a second tap to confirm.
let deleteArmed = false;
function resetDeleteButton() {
  deleteArmed = false;
  $("delete-dish").textContent = "Delete dish";
}
$("delete-dish").addEventListener("click", async () => {
  if (!editing) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $("delete-dish").textContent = `Tap again to delete ${editing.dish.name}`;
    setTimeout(resetDeleteButton, 4000);
    return;
  }
  resetDeleteButton();
  try {
    setMessage("Deleting…");
    menu = await loadMenuFromRepo();
    let removed = null;
    for (const c of menu.categories) {
      const i = c.dishes.findIndex((d) => d.id === editing.dish.id);
      if (i >= 0) [removed] = c.dishes.splice(i, 1);
    }
    if (!removed) throw new Error("It was already deleted.");
    const used = new Set(allDishes().flatMap(({ dish: d }) => [d.model, d.image]));
    const deletes = [removed.model, removed.image].filter((p) => p && !used.has(p));
    await commitFiles(`Remove ${removed.name}`, [{ path: "data/menu.json", text: JSON.stringify(menu, null, 2) + "\n" }], deletes);
    $("editor").hidden = true;
    editing = null;
    renderDishes();
  } catch (err) {
    setMessage(`Not deleted: ${err.message}`, true);
  }
});

// ------------------------------------------------------------------ start

if (session.loggedIn()) afterLogin();
