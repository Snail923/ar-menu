# AR Menu — web version

A plain website (no app to install): guests open a link or scan a QR code, browse the menu, tap
**Preview** on a dish, and tap **View on your table** to see it in AR at real size through the phone camera.

- 3D and AR: Google's [`<model-viewer>`](https://modelviewer.dev) (bundled in `vendor/`, no CDN needed)
  - **Android:** WebXR in Chrome, or Google's Scene Viewer
  - **iPhone / iPad:** Apple AR Quick Look (model-viewer converts the model for iOS automatically)
  - **Computers:** the rotatable 3D view only (no camera AR)
- Dishes are shown at real size (`ar-scale="fixed"`): a 26 cm plate is 26 cm on the table.

## Folder layout

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/app.js` | The site |
| `js/menu.js` | **The menu**: names, prices, descriptions, which 3D model to use |
| `models/*.glb` | 3D dishes (meters, Y up, standing on y = 0) |
| `images/*.png` | Card pictures |
| `tools/build_models.py` | Generates the burger models + pictures, and brings in scanned dishes |
| `vendor/model-viewer.min.js` | model-viewer 4.1.0 |

## Run it on this computer

```bash
python3 -m http.server 8080 --directory web
```

Open <http://localhost:8080>. (Opening `index.html` directly as a file doesn't work: the browser blocks the scripts.)

## Try it on a phone

Phone browsers only allow the camera / AR on **HTTPS** pages, so `http://<laptop-ip>:8080` shows the menu and
3D view but not AR. Two ways to get HTTPS:

1. **Quick test with a tunnel** (temporary public HTTPS link to your laptop):
   ```bash
   npx localtunnel --port 8080
   ```
   or install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run
   `cloudflared tunnel --url http://localhost:8080`. Open the printed `https://…` link on the phone.
2. **Publish it** (permanent link for guests): the `web/` folder is a static site, so any static host works
   for free: GitHub Pages, Netlify (drag the folder onto app.netlify.com/drop), Cloudflare Pages or Vercel.

Then make a QR code of the link for the tables. Links can open a dish directly:
`https://your-site/#dish-classic-cheeseburger`.

## Add or change dishes

- **Edit** `js/menu.js`: name, price, description, tags.
- **New burger recipe:** add it to `RECIPES` in `tools/build_models.py`, then rebuild:
  ```bash
  ../dish_scanner/.venv/bin/python tools/build_models.py
  ```
- **Scanned dish** (KIRI Engine, Polycam…): bring it to real size with the scanner, then rebuild:
  ```bash
  cd ../dish_scanner
  .venv/bin/python -m dish_scanner import 3DModel.obj --name fries --width 18
  cd ../web
  ```
  Add `"fries"` to the scanned list in `tools/build_models.py`, run it, and add the dish to `js/menu.js`.

Keep each model under about 2 MB so it loads quickly on mobile data.
