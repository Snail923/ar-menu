import { CATEGORIES, RESTAURANT } from "./menu.js";

const $ = (id) => document.getElementById(id);
const price = (p) => `${RESTAURANT.currency}${p.toFixed(2)}`;

const hasWebGL = (() => {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
})();

const menuEl = $("menu");
const tabsEl = $("tabs");
const sheet = $("preview");
const viewer = $("viewer");

// ------------------------------------------------------------------ menu list

function renderMenu() {
  document.title = RESTAURANT.name;
  $("restaurant-name").textContent = RESTAURANT.name;
  $("restaurant-tagline").textContent = RESTAURANT.tagline;

  for (const category of CATEGORIES) {
    const tab = document.createElement("a");
    tab.href = `#${category.id}`;
    tab.textContent = category.name;
    tabsEl.append(tab);

    const section = document.createElement("section");
    section.id = category.id;
    section.innerHTML = `<h2 class="category">${category.name}</h2>`;
    const list = document.createElement("div");
    list.className = "cards";

    for (const dish of category.dishes) {
      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = `
        <div class="card-image"><img src="${dish.image}" alt="${dish.name}" loading="lazy"></div>
        <div class="card-body">
          <div class="card-head">
            <h3>${dish.name}</h3>
            <span class="price">${price(dish.price)}</span>
          </div>
          <p>${dish.description}</p>
          <div class="card-foot">
            <div class="tags">${dish.tags.map((t) => `<span class="tag${dish.scanned && t.includes("scan") ? " scan" : ""}">${t}</span>`).join("")}</div>
            <button class="preview-button" type="button">
              <span class="ar-icon" aria-hidden="true"></span> Preview
            </button>
          </div>
        </div>`;
      card.querySelector(".preview-button").addEventListener("click", () => openPreview(dish));
      card.querySelector(".card-image").addEventListener("click", () => openPreview(dish));
      list.append(card);
    }
    section.append(list);
    menuEl.append(section);
  }
  tabsEl.firstElementChild?.classList.add("active");
}

// ------------------------------------------------------------------ preview (3D + AR)

function openPreview(dish, push = true) {
  $("preview-name").textContent = dish.name;
  $("preview-price").textContent = price(dish.price);
  $("preview-desc").textContent = dish.description;
  $("preview-size").textContent = `Real size: ${dish.size}${dish.scanned ? " · 3D-scanned from the real dish" : ""}`;
  $("no-ar").hidden = true;
  $("ar-tip").hidden = true;

  // Without WebGL there's no 3D or AR: show the dish picture and say why.
  viewer.hidden = !hasWebGL;
  $("fallback-image").hidden = hasWebGL;
  $("no-3d").hidden = hasWebGL;
  if (hasWebGL) {
    viewer.alt = `3D model of ${dish.name}`;
    viewer.poster = dish.image;
    viewer.src = dish.model;
    viewer.cameraOrbit = "0deg 65deg auto";
  } else {
    $("fallback-image").src = dish.image;
    $("fallback-image").alt = dish.name;
  }

  if (!sheet.open) sheet.showModal();
  if (push) history.pushState({ dish: dish.id }, "", `#dish-${dish.id}`);
}

function closePreview() {
  if (sheet.open) sheet.close();
}

viewer.addEventListener("load", () => {
  // model-viewer knows after loading whether this device can show AR (phone camera + AR support).
  const canAR = viewer.canActivateAR;
  $("no-ar").hidden = canAR;
  $("ar-tip").hidden = !canAR;
});

// Thin loading bar along the top of the 3D view.
const progressBar = viewer.querySelector(".progress span");
viewer.addEventListener("progress", (e) => {
  const p = e.detail.totalProgress;
  progressBar.style.width = `${Math.round(p * 100)}%`;
  progressBar.parentElement.style.opacity = p >= 1 ? "0" : "1";
});

viewer.addEventListener("ar-status", (e) => {
  if (e.detail.status === "failed") {
    $("no-ar").hidden = false;
    $("ar-tip").hidden = true;
  }
});

$("preview-close").addEventListener("click", () => history.back());
sheet.addEventListener("cancel", (e) => {
  e.preventDefault();
  history.back();
});
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) history.back(); // tap outside the sheet
});
window.addEventListener("popstate", closePreview);

// Highlight the category tab for the section in view.
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    for (const a of tabsEl.children) a.classList.toggle("active", a.getAttribute("href") === `#${entry.target.id}`);
  }
}, { rootMargin: "-40% 0px -55% 0px" });

renderMenu();
document.querySelectorAll(".menu section").forEach((s) => observer.observe(s));

// Open a dish directly from a link like …/#dish-classic-cheeseburger (e.g. a QR code next to the dish).
function openFromLink() {
  const linked = location.hash.match(/^#dish-(.+)$/);
  const dish = linked && CATEGORIES.flatMap((c) => c.dishes).find((d) => d.id === linked[1]);
  if (!dish) return;
  // Put the plain menu underneath, so "back" / close returns to it.
  history.replaceState(null, "", location.pathname);
  openPreview(dish);
}

window.addEventListener("hashchange", openFromLink);
openFromLink();
