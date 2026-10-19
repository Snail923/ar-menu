// AR Menu server: serves the public menu and the admin dashboard, and stores menu changes.
// Plain Node.js (18+), no packages to install:
//
//   node server/server.js
//
// Settings (environment variables):
//   PORT             port to listen on                       (default 8080)
//   ADMIN_USERNAME   admin login                              (default "admin")
//   ADMIN_PASSWORD   admin password                           (default "1234" — change it when you deploy!)
//   SECURE_COOKIES   "1" when served over https (sets the Secure flag on the login cookie)

import http from "node:http";
import { promises as fs, createReadStream, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MENU_FILE = path.join(ROOT, "data", "menu.json");
const BACKUPS = path.join(ROOT, "data", "backups");
const PORT = Number(process.env.PORT) || 8080;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";
const SECURE_COOKIES = process.env.SECURE_COOKIES === "1";
const SESSION_HOURS = 12;
const MAX_UPLOAD_MB = 25;
const KEEP_BACKUPS = 30;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".md": "text/plain; charset=utf-8",
};

// ------------------------------------------------------------------ helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(data);
}

async function readJson(req, limitMb = MAX_UPLOAD_MB * 1.4 + 1) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitMb * 1024 * 1024) throw new HttpError(413, `That's too big (limit ${MAX_UPLOAD_MB} MB per file).`);
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request isn't valid JSON.");
  }
}

const slug = (s) =>
  String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";

function uniqueId(base, taken) {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ sessions (login)

const sessions = new Map(); // token → expiry (ms)

function sessionToken(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)arm_session=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

function isLoggedIn(req) {
  const token = sessionToken(req);
  const expiry = token && sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req) {
  if (!isLoggedIn(req)) throw new HttpError(401, "Please log in again.");
}

const cookie = (value, maxAge) =>
  `arm_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${SECURE_COOKIES ? "; Secure" : ""}`;

// Slow down password guessing: a short delay after each failed login.
const failedLogins = new Map(); // ip → count

// ------------------------------------------------------------------ menu storage

async function readMenu() {
  return JSON.parse(await fs.readFile(MENU_FILE, "utf8"));
}

let writeQueue = Promise.resolve();

/** Run a change against the menu and save it atomically (one change at a time, with a backup). */
function changeMenu(mutate) {
  const run = writeQueue.then(async () => {
    const menu = await readMenu();
    const result = await mutate(menu);
    await fs.mkdir(BACKUPS, { recursive: true });
    await fs.copyFile(MENU_FILE, path.join(BACKUPS, `menu-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    const tmp = `${MENU_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(menu, null, 2) + "\n");
    await fs.rename(tmp, MENU_FILE);
    pruneBackups().catch(() => {});
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

async function pruneBackups() {
  const files = (await fs.readdir(BACKUPS)).filter((f) => f.startsWith("menu-")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) await fs.unlink(path.join(BACKUPS, f));
}

const allDishes = (menu) => menu.categories.flatMap((c) => c.dishes);

function findDish(menu, id) {
  for (const category of menu.categories) {
    const index = category.dishes.findIndex((d) => d.id === id);
    if (index >= 0) return { category, index, dish: category.dishes[index] };
  }
  throw new HttpError(404, "That item doesn't exist any more.");
}

function findCategory(menu, id) {
  const category = menu.categories.find((c) => c.id === id);
  if (!category) throw new HttpError(404, "That category doesn't exist any more.");
  return category;
}

/** Delete uploaded files that no dish uses any more. Only touches models/ and images/. */
async function removeUnused(menu, paths) {
  const used = new Set(allDishes(menu).flatMap((d) => [d.model, d.image]));
  for (const p of paths) {
    if (!p || used.has(p) || !/^(models|images)\/[A-Za-z0-9._-]+$/.test(p)) continue;
    await fs.unlink(path.join(ROOT, p)).catch(() => {});
  }
}

// ------------------------------------------------------------------ validation

function cleanDish(input, existing = {}) {
  const dish = { ...existing };
  const text = (v, max) => String(v ?? "").trim().slice(0, max);

  if ("name" in input) dish.name = text(input.name, 80);
  if (!dish.name) throw new HttpError(400, "Give the item a name.");
  if ("description" in input) dish.description = text(input.description, 400);
  if ("price" in input) {
    const price = Number(input.price);
    if (!Number.isFinite(price) || price < 0 || price > 100000) throw new HttpError(400, "Enter a valid price.");
    dish.price = Math.round(price * 100) / 100;
  }
  if (dish.price === undefined) throw new HttpError(400, "Enter a price.");
  if ("tags" in input) dish.tags = (Array.isArray(input.tags) ? input.tags : []).map((t) => text(t, 30)).filter(Boolean).slice(0, 6);
  if ("available" in input) dish.available = input.available !== false;
  if ("scanned" in input) dish.scanned = !!input.scanned;
  if ("photo" in input) dish.photo = !!input.photo; // card picture is the admin's own photo (not rendered from 3D)
  if ("size" in input) dish.size = text(input.size, 60);
  if ("widthCm" in input) {
    const w = Number(input.widthCm);
    if (Number.isFinite(w) && w > 0) dish.widthCm = Math.round(w * 10) / 10;
  }
  for (const key of ["model", "image"]) {
    if (!(key in input)) continue;
    const p = input[key] ? String(input[key]) : "";
    if (p && !/^(models|images)\/[A-Za-z0-9._-]+$/.test(p)) throw new HttpError(400, `Invalid ${key} file.`);
    if (p && !existsSync(path.join(ROOT, p))) throw new HttpError(400, `The ${key} file wasn't uploaded.`);
    dish[key] = p || undefined;
  }
  dish.tags ??= [];
  dish.available ??= true;
  dish.updated = Date.now();
  return dish;
}

// ------------------------------------------------------------------ API

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route("GET", /^\/api\/session$/, (req) => ({ loggedIn: isLoggedIn(req) }));

route("POST", /^\/api\/login$/, async (req, res) => {
  const { username, password } = await readJson(req, 1);
  const ip = req.socket.remoteAddress || "?";
  if (!sameText(username ?? "", ADMIN_USERNAME) || !sameText(password ?? "", ADMIN_PASSWORD)) {
    const fails = (failedLogins.get(ip) || 0) + 1;
    failedLogins.set(ip, fails);
    await new Promise((r) => setTimeout(r, Math.min(5000, 400 * fails)));
    throw new HttpError(401, "Wrong username or password.");
  }
  failedLogins.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_HOURS * 3600 * 1000);
  return { body: { loggedIn: true }, headers: { "Set-Cookie": cookie(token, SESSION_HOURS * 3600) } };
});

route("POST", /^\/api\/logout$/, (req) => {
  const token = sessionToken(req);
  if (token) sessions.delete(token);
  return { body: { loggedIn: false }, headers: { "Set-Cookie": cookie("", 0) } };
});

route("GET", /^\/api\/menu$/, () => readMenu());

// Restaurant settings
route("PUT", /^\/api\/settings$/, async (req) => {
  requireAdmin(req);
  const input = await readJson(req, 1);
  return changeMenu((menu) => {
    const r = menu.restaurant;
    if ("name" in input) r.name = String(input.name).trim().slice(0, 60) || r.name;
    if ("tagline" in input) r.tagline = String(input.tagline).trim().slice(0, 140);
    if ("currency" in input) r.currency = String(input.currency).trim().slice(0, 4) || "$";
    return r;
  });
});

// Categories
route("POST", /^\/api\/categories$/, async (req) => {
  requireAdmin(req);
  const name = String((await readJson(req, 1)).name ?? "").trim().slice(0, 40);
  if (!name) throw new HttpError(400, "Name the category.");
  return changeMenu((menu) => {
    const category = { id: uniqueId(slug(name), new Set(menu.categories.map((c) => c.id))), name, dishes: [] };
    menu.categories.push(category);
    return category;
  });
});

route("PUT", /^\/api\/categories\/([\w-]+)$/, async (req, res, [id]) => {
  requireAdmin(req);
  const name = String((await readJson(req, 1)).name ?? "").trim().slice(0, 40);
  if (!name) throw new HttpError(400, "Name the category.");
  return changeMenu((menu) => {
    const category = findCategory(menu, id);
    category.name = name;
    return category;
  });
});

route("DELETE", /^\/api\/categories\/([\w-]+)$/, (req, res, [id]) => {
  requireAdmin(req);
  return changeMenu((menu) => {
    const category = findCategory(menu, id);
    if (category.dishes.length) throw new HttpError(409, "Move or delete this category's items first.");
    menu.categories = menu.categories.filter((c) => c !== category);
    return { deleted: id };
  });
});

route("POST", /^\/api\/categories\/([\w-]+)\/move$/, async (req, res, [id]) => {
  requireAdmin(req);
  const { direction } = await readJson(req, 1);
  return changeMenu((menu) => {
    const i = menu.categories.findIndex((c) => c.id === id);
    if (i < 0) throw new HttpError(404, "That category doesn't exist any more.");
    const j = i + (direction < 0 ? -1 : 1);
    if (j >= 0 && j < menu.categories.length) [menu.categories[i], menu.categories[j]] = [menu.categories[j], menu.categories[i]];
    return menu.categories.map((c) => c.id);
  });
});

// Menu items
route("POST", /^\/api\/dishes$/, async (req) => {
  requireAdmin(req);
  const input = await readJson(req, 1);
  return changeMenu((menu) => {
    const category = findCategory(menu, input.categoryId);
    const dish = cleanDish(input);
    dish.id = uniqueId(slug(dish.name), new Set(allDishes(menu).map((d) => d.id)));
    category.dishes.push(dish);
    return dish;
  });
});

route("PUT", /^\/api\/dishes\/([\w-]+)$/, async (req, res, [id]) => {
  requireAdmin(req);
  const input = await readJson(req, 1);
  return changeMenu(async (menu) => {
    const found = findDish(menu, id);
    const old = { model: found.dish.model, image: found.dish.image };
    const dish = cleanDish(input, found.dish);
    found.category.dishes[found.index] = dish;
    if (input.categoryId && input.categoryId !== found.category.id) {
      const target = findCategory(menu, input.categoryId);
      found.category.dishes.splice(found.index, 1);
      target.dishes.push(dish);
    }
    await removeUnused(menu, [old.model, old.image]);
    return dish;
  });
});

route("DELETE", /^\/api\/dishes\/([\w-]+)$/, (req, res, [id]) => {
  requireAdmin(req);
  return changeMenu(async (menu) => {
    const found = findDish(menu, id);
    found.category.dishes.splice(found.index, 1);
    await removeUnused(menu, [found.dish.model, found.dish.image]);
    return { deleted: id };
  });
});

route("POST", /^\/api\/dishes\/([\w-]+)\/move$/, async (req, res, [id]) => {
  requireAdmin(req);
  const { direction } = await readJson(req, 1);
  return changeMenu((menu) => {
    const { category, index } = findDish(menu, id);
    const j = index + (direction < 0 ? -1 : 1);
    if (j >= 0 && j < category.dishes.length) [category.dishes[index], category.dishes[j]] = [category.dishes[j], category.dishes[index]];
    return category.dishes.map((d) => d.id);
  });
});

// Uploads: { kind: "model" | "image", name, data: base64 } → { path }
route("POST", /^\/api\/uploads$/, async (req) => {
  requireAdmin(req);
  const { kind, name, data } = await readJson(req);
  const bytes = Buffer.from(String(data || ""), "base64");
  if (!bytes.length) throw new HttpError(400, "The file is empty.");
  if (bytes.length > MAX_UPLOAD_MB * 1024 * 1024) throw new HttpError(413, `Keep files under ${MAX_UPLOAD_MB} MB.`);

  let folder;
  let ext;
  if (kind === "model") {
    if (bytes.toString("ascii", 0, 4) !== "glTF") throw new HttpError(400, "That isn't a GLB 3D model.");
    [folder, ext] = ["models", ".glb"];
  } else if (kind === "image") {
    const sig = bytes.subarray(0, 12);
    if (sig[0] === 0x89 && sig.toString("ascii", 1, 4) === "PNG") ext = ".png";
    else if (sig[0] === 0xff && sig[1] === 0xd8) ext = ".jpg";
    else if (sig.toString("ascii", 0, 4) === "RIFF" && sig.toString("ascii", 8, 12) === "WEBP") ext = ".webp";
    else throw new HttpError(400, "Use a PNG, JPEG or WebP picture.");
    folder = "images";
  } else {
    throw new HttpError(400, "Unknown upload type.");
  }

  const file = `${slug(name || kind)}-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}${ext}`;
  await fs.mkdir(path.join(ROOT, folder), { recursive: true });
  await fs.writeFile(path.join(ROOT, folder, file), bytes);
  return { path: `${folder}/${file}` };
});

// ------------------------------------------------------------------ static files

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(ROOT, rel));
  // Never serve outside the site, the server's own code, backups or dotfiles.
  if (!file.startsWith(ROOT + path.sep) || /[\\/](server|backups|node_modules)[\\/]|[\\/]\./.test(file.slice(ROOT.length))) {
    return send(res, 404, { error: "Not found" });
  }
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return send(res, 404, { error: "Not found" });
  }
  if (stat.isDirectory()) return serveStatic(req, res, `${pathname.replace(/\/?$/, "/")}`);
  const ext = path.extname(file).toLowerCase();
  const fresh = [".html", ".json", ".js", ".css"].includes(ext);
  const modified = stat.mtime.toUTCString();
  if (req.headers["if-modified-since"] === modified) {
    res.writeHead(304, { "Last-Modified": modified });
    return res.end();
  }
  res.writeHead(200, {
    "Last-Modified": modified,
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    // Uploaded models/pictures get unique names, so they can be cached; pages and menu data must stay fresh.
    "Cache-Control": fresh ? "no-cache" : "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

// ------------------------------------------------------------------ server

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname.startsWith("/api/")) {
      // Same-site only: the admin dashboard is served by this server.
      const origin = req.headers.origin;
      if (req.method !== "GET" && origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Not allowed.");
      const match = routes.find((r) => r.method === req.method && r.pattern.test(pathname));
      if (!match) throw new HttpError(404, "Unknown API address.");
      const out = await match.handler(req, res, pathname.match(match.pattern).slice(1));
      if (out && out.body !== undefined && out.headers) return send(res, 200, out.body, out.headers);
      return send(res, 200, out);
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    await serveStatic(req, res, pathname);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err instanceof HttpError ? err.message : "Something went wrong on the server." });
  }
});

server.listen(PORT, () => {
  console.log(`AR Menu server: http://localhost:${PORT}  (admin: http://localhost:${PORT}/admin.html)`);
  if (!process.env.ADMIN_PASSWORD) console.log("Using the default admin password. Set ADMIN_PASSWORD before putting this online.");
});
