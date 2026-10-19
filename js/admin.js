// Menu admin dashboard: menu items (add / edit / sold out / reorder / delete), categories and settings.
// Talks to the menu server (server/server.js); the login is checked on the server.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const $ = (id) => document.getElementById(id);
const MAX_UPLOAD_MB = 25;

let menu = null;
let view = "items";
let editing = null; // dish being edited, or null for a new one
let modelFile = null; // newly chosen GLB
let photoFile = null; // newly chosen photo
let preparedModel = null; // { glb, png, width, height } after scaling
let previewUrl = null;

// ------------------------------------------------------------------ server API

async function api(method, path, body) {
  const res = await fetch(`api/${path}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && path !== "login") {
    showLogin("Your session ended. Log in again.");
    throw new Error("Please log in again.");
  }
  if (!res.ok) throw new Error(data?.error || `The server answered ${res.status}.`);
  return data;
}

async function reloadMenu() {
  menu = await api("GET", "menu");
  $("side-name").textContent = menu.restaurant.name;
  render();
}

function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function upload(kind, name, bytes) {
  const { path } = await api("POST", "uploads", { kind, name, data: toBase64(bytes) });
  return path;
}

// ------------------------------------------------------------------ toast

let toastTimer = 0;
function toast(text, isError = false) {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), isError ? 5000 : 2500);
}

// ------------------------------------------------------------------ start / login

function showLogin(message = "") {
  $("app").hidden = true;
  $("login").hidden = false;
  $("login-message").textContent = message;
  $("login-message").className = message ? "form-message error" : "form-message";
  if ($("editor").open) $("editor").close();
}

async function start() {
  let session;
  try {
    const res = await fetch("api/session", { credentials: "same-origin" });
    session = await res.json();
  } catch {
    $("no-server").hidden = false;
    return;
  }
  if (!session.loggedIn) return showLogin();
  await openDashboard();
}

async function openDashboard() {
  $("login").hidden = true;
  $("app").hidden = false;
  await reloadMenu();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-button").disabled = true;
  $("login-message").textContent = "";
  try {
    await api("POST", "login", { username: $("username").value.trim(), password: $("password").value });
    $("password").value = "";
    await openDashboard();
  } catch (err) {
    $("login-message").className = "form-message error";
    $("login-message").textContent = err.message;
  } finally {
    $("login-button").disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  await api("POST", "logout").catch(() => {});
  showLogin();
});

// ------------------------------------------------------------------ navigation

function setView(name) {
  view = ["items", "categories", "settings"].includes(name) ? name : "items";
  for (const v of ["items", "categories", "settings"]) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll(".sidebar nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  if (menu) render();
}
window.addEventListener("hashchange", () => setView(location.hash.slice(1)));
setView(location.hash.slice(1));

function render() {
  if (view === "items") renderItems();
  if (view === "categories") renderCategories();
  if (view === "settings") renderSettings();
}

const money = (p) => `${menu.restaurant.currency}${Number(p).toFixed(2)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ------------------------------------------------------------------ menu items

function renderItems() {
  const filterSelect = $("filter-category");
  const chosen = filterSelect.value || "all";
  filterSelect.innerHTML = `<option value="all">All categories</option>` +
    menu.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  filterSelect.value = menu.categories.some((c) => c.id === chosen) ? chosen : "all";

  const query = $("search").value.trim().toLowerCase();
  const status = $("filter-status").value;
  const total = menu.categories.reduce((n, c) => n + c.dishes.length, 0);
  const soldOut = menu.categories.reduce((n, c) => n + c.dishes.filter((d) => d.available === false).length, 0);
  $("items-summary").textContent = `${total} item${total === 1 ? "" : "s"} in ${menu.categories.length} categor${menu.categories.length === 1 ? "y" : "ies"}${soldOut ? ` · ${soldOut} sold out` : ""}`;

  const list = $("items-list");
  list.innerHTML = "";
  let shown = 0;
  for (const category of menu.categories) {
    if (filterSelect.value !== "all" && category.id !== filterSelect.value) continue;
    const dishes = category.dishes.filter((d) => {
      if (query && !`${d.name} ${d.description} ${(d.tags || []).join(" ")}`.toLowerCase().includes(query)) return false;
      if (status === "available" && d.available === false) return false;
      if (status === "soldout" && d.available !== false) return false;
      if (status === "no3d" && d.model) return false;
      return true;
    });
    if (!dishes.length && (query || status !== "all")) continue;

    const group = document.createElement("section");
    group.className = "item-group";
    group.innerHTML = `<h2>${esc(category.name)} <span>${category.dishes.length}</span></h2>`;
    if (!dishes.length) group.insertAdjacentHTML("beforeend", `<p class="empty">No items yet. Use <strong>+ New item</strong> to add one.</p>`);

    dishes.forEach((dish) => {
      shown++;
      const index = category.dishes.indexOf(dish);
      const row = document.createElement("div");
      row.className = `item-row${dish.available === false ? " sold-out" : ""}`;
      row.innerHTML = `
        <button class="item-main" type="button" aria-label="Edit ${esc(dish.name)}">
          <span class="thumb">${dish.image ? `<img src="${esc(dish.image)}" alt="" loading="lazy">` : ""}</span>
          <span class="item-text">
            <strong>${esc(dish.name)}</strong>
            <small>${esc(dish.description || "No description")}</small>
            <span class="badges">${dish.model ? `<span class="badge three">3D</span>` : `<span class="badge none">No 3D</span>`}${(dish.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join("")}</span>
          </span>
        </button>
        <span class="item-price">${money(dish.price)}</span>
        <label class="avail" title="Available">
          <input type="checkbox" class="switch" ${dish.available === false ? "" : "checked"} aria-label="${esc(dish.name)} available">
          <span>${dish.available === false ? "Sold out" : "Available"}</span>
        </label>
        <span class="order">
          <button class="icon-button" type="button" data-move="-1" aria-label="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
          <button class="icon-button" type="button" data-move="1" aria-label="Move down" ${index === category.dishes.length - 1 ? "disabled" : ""}>↓</button>
        </span>`;
      row.querySelector(".item-main").addEventListener("click", () => openEditor(dish, category.id));
      row.querySelector(".switch").addEventListener("change", async (e) => {
        const available = e.target.checked;
        try {
          await api("PUT", `dishes/${dish.id}`, { available });
          toast(available ? `${dish.name} is available` : `${dish.name} marked sold out`);
        } catch (err) {
          toast(err.message, true);
        }
        await reloadMenu();
      });
      row.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", async () => {
        await api("POST", `dishes/${dish.id}/move`, { direction: Number(b.dataset.move) }).catch((err) => toast(err.message, true));
        await reloadMenu();
      }));
      group.append(row);
    });
    list.append(group);
  }
  if (!shown && (query || status !== "all")) list.innerHTML = `<p class="empty">No items match. Try another search or filter.</p>`;
}

$("search").addEventListener("input", renderItems);
$("filter-category").addEventListener("change", renderItems);
$("filter-status").addEventListener("change", renderItems);
$("new-item").addEventListener("click", () => {
  if (!menu.categories.length) {
    toast("Add a category first.", true);
    location.hash = "#categories";
    return;
  }
  const filter = $("filter-category").value;
  openEditor(null, filter !== "all" ? filter : menu.categories[0].id);
});

// ------------------------------------------------------------------ item editor

function openEditor(dish, categoryId) {
  editing = dish;
  modelFile = null;
  photoFile = null;
  preparedModel = null;
  $("editor-title").textContent = dish ? "Edit item" : "New item";
  $("f-category").innerHTML = menu.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  $("f-category").value = categoryId;
  $("f-name").value = dish?.name ?? "";
  $("f-price").value = dish?.price ?? "";
  $("f-description").value = dish?.description ?? "";
  $("f-tags").value = (dish?.tags ?? []).join(", ");
  $("f-available").checked = dish ? dish.available !== false : true;
  $("f-scanned").checked = !!dish?.scanned;
  $("f-width").value = dish?.widthCm ?? 26;
  $("f-model").value = "";
  $("f-photo").value = "";
  $("delete-item").hidden = !dish;
  resetDelete();
  setFormMessage("");
  showModel(dish?.model ?? null, dish?.size ? `Real size: ${dish.size}` : null);
  showPhoto(dish?.image ?? null);
  $("editor").showModal();
  $("f-name").focus();
}

function closeEditor() {
  if ($("editor").open) $("editor").close();
  editing = null;
}
$("editor-close").addEventListener("click", closeEditor);
$("editor").addEventListener("cancel", (e) => { e.preventDefault(); closeEditor(); });

function showModel(src, info) {
  const viewer = $("viewer");
  if (src) viewer.src = src;
  else viewer.removeAttribute("src");
  viewer.classList.toggle("empty", !src);
  $("model-info").textContent = info || (src ? "" : "No 3D model yet. Guests will see the photo only.");
}

function showPhoto(src) {
  $("photo-preview").hidden = !src;
  if (src) $("photo-preview").src = src;
}

function setFormMessage(text, isError = false) {
  $("form-message").textContent = text;
  $("form-message").className = `form-message${isError ? " error" : ""}`;
}

$("f-model").addEventListener("change", () => prepareChosenModel());
$("f-width").addEventListener("change", () => {
  if (modelFile || editing?.model) prepareChosenModel();
});

$("f-photo").addEventListener("change", () => {
  photoFile = $("f-photo").files[0] || null;
  if (photoFile) showPhoto(URL.createObjectURL(photoFile));
});

async function prepareChosenModel() {
  modelFile = $("f-model").files[0] || null;
  const widthCm = Number($("f-width").value);
  if (!(widthCm >= 3)) return setFormMessage("Enter the real width in cm.", true);
  try {
    let buffer;
    if (modelFile) {
      if (modelFile.size > MAX_UPLOAD_MB * 1048576) throw new Error(`This file is ${Math.round(modelFile.size / 1048576)} MB. Keep models under ${MAX_UPLOAD_MB} MB (ideally under 5 MB).`);
      buffer = await modelFile.arrayBuffer();
    } else if (editing?.model) {
      buffer = await fetch(editing.model).then((r) => r.arrayBuffer()); // same model, new width
    } else {
      return;
    }
    setFormMessage("Preparing the 3D model…");
    preparedModel = await prepareModel(buffer, widthCm);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([preparedModel.glb], { type: "model/gltf-binary" }));
    showModel(previewUrl, `Real size: ${sizeLabel(preparedModel)}`);
    const mb = preparedModel.glb.byteLength / 1048576;
    setFormMessage(mb > 6 ? `The model is ${mb.toFixed(1)} MB, which may load slowly on phones.` : "");
  } catch (err) {
    preparedModel = null;
    setFormMessage(err.message, true);
  }
}

const sizeLabel = (m) => `${Math.round(m.width)} cm wide · ${m.height.toFixed(1)} cm tall`;

/** Scale to the real width, stand on y = 0, centre, and export again as GLB (so every AR viewer shows real size). */
async function prepareModel(arrayBuffer, widthCm) {
  let gltf;
  try {
    gltf = await new GLTFLoader().parseAsync(arrayBuffer, "");
  } catch (err) {
    if (/draco/i.test(String(err))) throw new Error("This model uses Draco compression. Export it again without compression.");
    if (/ktx|basis/i.test(String(err))) throw new Error("This model uses KTX2 textures. Export it again with PNG or JPEG textures.");
    throw new Error("Couldn't read this file as a GLB 3D model.");
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
  dish.add(centre);
  dish.scale.setScalar(scale);
  dish.updateMatrixWorld(true);

  const glb = await new GLTFExporter().parseAsync(dish, { binary: true, animations: gltf.animations });
  const png = await renderThumbnail(dish);
  return { glb, png, width: size.x * scale * 100, height: size.y * scale * 100 };
}

function renderThumbnail(object) {
  const px = 512;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(px, px);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(0.4, 1, -0.6);
  scene.add(sun, object);
  const box = new THREE.Box3().setFromObject(object);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const camera = new THREE.PerspectiveCamera(32, 1, radius / 50, radius * 20);
  camera.position.copy(centre).add(new THREE.Vector3(0, radius, -radius * 1.9).multiplyScalar(1.15));
  camera.lookAt(centre);
  renderer.render(scene, camera);
  return new Promise((resolve) => renderer.domElement.toBlob(async (blob) => {
    scene.remove(object);
    renderer.dispose();
    resolve(new Uint8Array(await blob.arrayBuffer()));
  }, "image/png"));
}

$("item-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("f-name").value.trim();
  const priceText = $("f-price").value;
  if (!name) return setFormMessage("Give the item a name.", true);
  if (priceText === "" || !(Number(priceText) >= 0)) return setFormMessage("Enter a price.", true);

  const save = $("save-item");
  save.disabled = true;
  try {
    const widthCm = Number($("f-width").value) || 26;
    const widthChanged = editing?.model && Number(editing.widthCm ?? 26) !== widthCm;
    if (!preparedModel && ($("f-model").files[0] || widthChanged)) await prepareChosenModel();
    if ($("f-model").files[0] && !preparedModel) throw new Error($("form-message").textContent || "The 3D model couldn't be prepared.");

    const fields = {
      name,
      categoryId: $("f-category").value,
      price: Number(priceText),
      description: $("f-description").value.trim(),
      tags: $("f-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      available: $("f-available").checked,
      scanned: $("f-scanned").checked,
      widthCm,
    };

    const slugName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (preparedModel) {
      setFormMessage("Uploading the 3D model…");
      fields.model = await upload("model", slugName, preparedModel.glb);
      fields.size = sizeLabel(preparedModel);
    }
    if (photoFile) {
      setFormMessage("Uploading the photo…");
      fields.image = await upload("image", slugName, new Uint8Array(await photoFile.arrayBuffer()));
      fields.photo = true;
    } else if (preparedModel && !editing?.photo) {
      // No photo of their own: the menu card uses a picture rendered from the 3D model.
      fields.image = await upload("image", slugName, preparedModel.png);
      fields.photo = false;
    }

    setFormMessage("Saving…");
    if (editing) await api("PUT", `dishes/${editing.id}`, fields);
    else await api("POST", "dishes", fields);
    closeEditor();
    toast(`${name} saved`);
    await reloadMenu();
  } catch (err) {
    setFormMessage(err.message, true);
  } finally {
    save.disabled = false;
  }
});

// Delete: second tap confirms.
let deleteArmed = false;
function resetDelete() {
  deleteArmed = false;
  $("delete-item").textContent = "Delete";
}
$("delete-item").addEventListener("click", async () => {
  if (!editing) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $("delete-item").textContent = "Tap again to delete";
    setTimeout(resetDelete, 4000);
    return;
  }
  const name = editing.name;
  try {
    await api("DELETE", `dishes/${editing.id}`);
    closeEditor();
    toast(`${name} deleted`);
    await reloadMenu();
  } catch (err) {
    setFormMessage(err.message, true);
  }
});

// ------------------------------------------------------------------ categories

function renderCategories() {
  const list = $("categories-list");
  list.innerHTML = "";
  if (!menu.categories.length) list.innerHTML = `<p class="empty">No categories yet. Add the first one above.</p>`;
  menu.categories.forEach((category, i) => {
    const row = document.createElement("form");
    row.className = "category-row";
    row.innerHTML = `
      <input value="${esc(category.name)}" maxlength="40" aria-label="Category name">
      <span class="count">${category.dishes.length} item${category.dishes.length === 1 ? "" : "s"}</span>
      <button class="secondary" type="submit">Rename</button>
      <span class="order">
        <button class="icon-button" type="button" data-move="-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="icon-button" type="button" data-move="1" aria-label="Move down" ${i === menu.categories.length - 1 ? "disabled" : ""}>↓</button>
      </span>
      <button class="danger small" type="button" data-delete ${category.dishes.length ? "disabled title=\"Move or delete its items first\"" : ""}>Delete</button>`;
    row.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("PUT", `categories/${category.id}`, { name: row.querySelector("input").value });
        toast("Category renamed");
      } catch (err) {
        toast(err.message, true);
      }
      await reloadMenu();
    });
    row.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", async () => {
      await api("POST", `categories/${category.id}/move`, { direction: Number(b.dataset.move) }).catch((err) => toast(err.message, true));
      await reloadMenu();
    }));
    row.querySelector("[data-delete]").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.textContent = "Tap again";
        setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Delete"; }, 4000);
        return;
      }
      try {
        await api("DELETE", `categories/${category.id}`);
        toast(`${category.name} deleted`);
      } catch (err) {
        toast(err.message, true);
      }
      await reloadMenu();
    });
    list.append(row);
  });
}

$("new-category-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("new-category-name").value.trim();
  if (!name) return;
  try {
    await api("POST", "categories", { name });
    $("new-category-name").value = "";
    toast(`${name} added`);
  } catch (err) {
    toast(err.message, true);
  }
  await reloadMenu();
});

// ------------------------------------------------------------------ settings

function renderSettings() {
  $("s-name").value = menu.restaurant.name;
  $("s-tagline").value = menu.restaurant.tagline || "";
  $("s-currency").value = menu.restaurant.currency;
}

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("PUT", "settings", { name: $("s-name").value, tagline: $("s-tagline").value, currency: $("s-currency").value });
    toast("Settings saved");
  } catch (err) {
    toast(err.message, true);
  }
  await reloadMenu();
});

start();
