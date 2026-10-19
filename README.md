# AR Menu — web version

Guests open a link or scan a QR code, browse the menu, tap **Preview** on a dish and **View on your table**
to see it at real size through the phone camera. Staff manage the menu from the **admin dashboard**.

- 3D and AR: Google's [`<model-viewer>`](https://modelviewer.dev) and three.js (both bundled in `vendor/`)
  - **Android with Google's AR service:** WebXR in Chrome (the dish is placed on the table)
  - **iPhone / iPad:** Apple AR Quick Look
  - **Any other phone:** camera view (the dish over the live camera, kept in place with the motion sensors)
  - **Computers:** rotatable 3D view
- Dishes are shown at real size: a 26 cm plate is 26 cm on the table.

## Run the menu server

Plain Node.js 18+, nothing to install:

```bash
cd web
node server/server.js
```

- Menu: <http://localhost:8080>
- Admin dashboard: <http://localhost:8080/admin.html> (default login **admin / 1234**)

Settings are environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `ADMIN_USERNAME` | `admin` | Admin login |
| `ADMIN_PASSWORD` | `1234` | Admin password — **change it before going online** |
| `SECURE_COOKIES` | off | Set to `1` when the site is served over https |

```bash
ADMIN_PASSWORD='a-long-password' SECURE_COOKIES=1 PORT=8080 node server/server.js
```

## Admin dashboard

- **Menu items:** search, filter by category or availability, switch items between *Available* and *Sold out*,
  reorder, add, edit and delete. The editor takes the name, category, price, description, tags, a **3D model
  (.glb)** with its real width in cm (it's scaled to real size and previewed), and an optional photo. Without a
  photo, the menu card uses a picture rendered from the 3D model.
- **Categories:** add, rename, reorder, delete (empty ones only). Empty categories don't show on the menu.
- **Settings:** restaurant name, tagline, currency symbol.

The login is checked by the server and kept in an HttpOnly cookie for 12 hours. Every change is saved to
`data/menu.json`; the previous 30 versions are kept in `data/backups/`. Uploaded models and pictures go to
`models/` and `images/`, and files no item uses any more are removed.

## Putting it online

The server needs a host that runs Node.js (a VPS, Render, Railway, Fly.io…) and keeps files on disk
(`data/`, `models/`, `images/`). Phones only allow the camera on **https**, so put it behind https —
for example Caddy (`your-domain { reverse_proxy localhost:8080 }`) or the host's built-in https — and
set `SECURE_COOKIES=1`.

On a static-only host (like GitHub Pages) the public menu still works, but the admin dashboard shows
"needs the menu server", since there's nowhere to save changes.

For a quick test on a phone from this computer: `npx localtunnel --port 8080` gives a temporary https link.

Make a QR code of the menu link for the tables. Links can open a dish directly:
`https://your-site/#dish-classic-cheeseburger`.

## Folder layout

| Path | What it is |
|---|---|
| `index.html`, `js/app.js`, `js/camera-view.js`, `css/style.css` | Public menu |
| `admin.html`, `js/admin.js`, `css/admin.css` | Admin dashboard |
| `server/server.js` | Menu server (static files + admin API) |
| `data/menu.json` | The menu (edited through the dashboard) |
| `models/*.glb`, `images/*` | 3D dishes and card pictures |
| `tools/build_models.py` | Generates the built-in burger models and pictures |
| `vendor/` | model-viewer 4.1.0, three.js 0.170 |

## 3D models

Export from KIRI Engine, Polycam or Sketchfab as **GLB** and upload it in the dashboard. For OBJ scans or
RealSense scans, use `../dish_scanner` first. Keep models under about 5 MB so they load quickly on phones.
