"""
Build the 3D models used by the web menu (web/models/*.glb) and their card pictures (web/images/*.png).

  - Burgers are generated procedurally — same shapes and colours as the Unity app's BurgerView —
    in meters, Y up, standing on y = 0, so they appear at real size in AR.
  - Scanned dishes (dish_scanner output) are copied in with a JPEG texture to keep downloads small.

Run with the dish_scanner environment (it has numpy, trimesh, open3d):

    ../dish_scanner/.venv/bin/python tools/build_models.py
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path

import numpy as np
import open3d as o3d
import trimesh
from PIL import Image

WEB = Path(__file__).resolve().parents[1]
MODELS = WEB / "models"
IMAGES = WEB / "images"
SCANS = WEB.parent / "dish_scanner" / "models"
rng = np.random.default_rng(7)

# ---------------------------------------------------------------- materials (colour, roughness, two-sided)

MATERIALS = {
    "bun": ((0.86, 0.55, 0.24), 0.62, False),
    "bun_inside": ((0.93, 0.76, 0.50), 0.85, False),
    "sesame": ((0.99, 0.94, 0.80), 0.55, False),
    "beef": ((0.40, 0.22, 0.13), 0.70, False),
    "chicken": ((0.88, 0.58, 0.22), 0.80, False),
    "cheese": ((1.00, 0.74, 0.10), 0.40, True),
    "bacon": ((0.66, 0.24, 0.17), 0.55, True),
    "lettuce": ((0.42, 0.78, 0.20), 0.45, True),
    "tomato": ((0.88, 0.14, 0.09), 0.25, False),
    "onion": ((0.86, 0.74, 0.90), 0.35, False),
    "pickle": ((0.44, 0.56, 0.16), 0.40, False),
    "ketchup": ((0.74, 0.05, 0.03), 0.12, False),
    "mayo": ((0.98, 0.95, 0.84), 0.18, False),
    "plate": ((0.97, 0.97, 0.96), 0.12, False),
}


def material(name: str) -> trimesh.visual.material.PBRMaterial:
    color, rough, two_sided = MATERIALS[name]
    return trimesh.visual.material.PBRMaterial(
        name=name,
        baseColorFactor=[*color, 1.0],
        roughnessFactor=rough,
        metallicFactor=0.0,
        doubleSided=two_sided,
    )


# ---------------------------------------------------------------- mesh generators (ported from FoodMeshFactory.cs)

def lathe(profile, segments, radius_scale=None, y_offset=None) -> trimesh.Trimesh:
    """Surface of revolution around Y; profile goes bottom-centre → rim → top-centre."""
    rows, cols = len(profile), segments + 1
    verts = np.zeros((rows * cols, 3))
    for i, (pr, py) in enumerate(profile):
        for j in range(cols):
            a = j / segments * 2 * math.pi
            aw = 0.0 if j == segments else a
            r = pr * (radius_scale(aw) if radius_scale else 1.0)
            y = py + (y_offset(aw, pr) if y_offset else 0.0)
            verts[i * cols + j] = (math.cos(a) * r, y, math.sin(a) * r)
    faces = []
    for i in range(rows - 1):
        for j in range(segments):
            a = i * cols + j
            b, c = a + 1, a + cols
            d = c + 1
            faces += [(a, c, b), (b, c, d)]
    mesh = trimesh.Trimesh(verts, np.array(faces), process=False)
    mesh.merge_vertices()  # weld the seam so shading is smooth
    return mesh


def rounded_slab(radius, height, bevel, steps=5):
    bevel = min(bevel, height * 0.5, radius)
    p = [(0.0, 0.0)]
    for i in range(steps + 1):
        a = -math.pi / 2 + math.pi / 2 * i / steps
        p.append((radius - bevel + math.cos(a) * bevel, bevel + math.sin(a) * bevel))
    for i in range(steps + 1):
        a = math.pi / 2 * i / steps
        p.append((radius - bevel + math.cos(a) * bevel, height - bevel + math.sin(a) * bevel))
    p.append((0.0, height))
    return p


def dome_point(radius, height, base_bevel, phi):
    r = radius * max(0.0, math.cos(phi)) ** 0.55
    return r, base_bevel + (height - base_bevel) * math.sin(phi)


def dome(radius, height, base_bevel, steps=18):
    p = [(0.0, 0.0)]
    for i in range(5):
        a = -math.pi / 2 + math.pi / 2 * i / 4
        p.append((radius - base_bevel + math.cos(a) * base_bevel, base_bevel + math.sin(a) * base_bevel))
    for i in range(1, steps + 1):
        p.append(dome_point(radius, height, base_bevel, math.pi / 2 * i / steps))
    return p


def plate_profile():
    return [(0, 0), (0.075, 0), (0.079, 0.002), (0.10, 0.007), (0.125, 0.0125), (0.131, 0.0145),
            (0.132, 0.0158), (0.129, 0.0162), (0.105, 0.0105), (0.088, 0.0068), (0.083, 0.006), (0, 0.006)]


def torus(major, minor, seg_major=40, seg_minor=10):
    m = trimesh.creation.torus(major_radius=major, minor_radius=minor, major_sections=seg_major, minor_sections=seg_minor)
    m.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))  # lie flat (axis → Y)
    m.apply_scale([1, 0.55, 1])
    return m


def melted_square(half, thickness, droop, grid=16):
    xs = np.linspace(-half, half, grid + 1)
    gx, gz = np.meshgrid(xs, xs)
    dist = np.hypot(gx, gz)
    t = np.clip((dist - half * 0.75) / (half * 0.7), 0, 1)
    top = np.stack([gx, thickness - droop * t * t, gz], -1).reshape(-1, 3)
    bottom = np.stack([gx, -droop * t * t, gz], -1).reshape(-1, 3)
    n = grid + 1
    faces = []
    for z in range(grid):
        for x in range(grid):
            a = z * n + x
            b, c = a + 1, a + n
            d = c + 1
            faces += [(a, c, b), (b, c, d)]
    faces = np.array(faces)
    bottom_faces = faces[:, ::-1] + len(top)
    return trimesh.Trimesh(np.vstack([top, bottom]), np.vstack([faces, bottom_faces]), process=False)


def wavy_strip(length, width, thickness, waves, amp, segments=40):
    corners = [(-width / 2, thickness), (width / 2, thickness), (width / 2, 0.0), (-width / 2, 0.0)]
    verts = []
    for i in range(segments + 1):
        t = i / segments
        x = -length / 2 + length * t
        y = math.sin(t * 2 * math.pi * waves) * amp * min(1.0, min(t, 1 - t) * 8)
        for c in range(len(corners) + 1):
            cx, cy = corners[c % len(corners)]
            wiggle = 0.0015 * math.sin(t * 37) * (1 if cx > 0 else -1)
            verts.append((x, y + cy, cx + wiggle))
    ring = len(corners) + 1
    faces = []
    for i in range(segments):
        for c in range(len(corners)):
            a = i * ring + c
            b, d = a + 1, a + ring
            e = d + 1
            faces += [(a, b, d), (b, e, d)]
    return trimesh.Trimesh(np.array(verts), np.array(faces), process=False)


def sesame_seeds(radius, height, base_bevel, count=34):
    seed = lathe(rounded_slab(0.0022, 0.0012, 0.0006, 3), 10)
    parts = []
    r = np.random.default_rng(7)
    for _ in range(count):
        phi = 0.45 + (1.42 - 0.45) * r.random()
        theta = r.random() * 2 * math.pi
        pr, py = dome_point(radius, height, base_bevel, phi)
        pos = np.array([math.cos(theta) * pr, py, math.sin(theta) * pr])
        normal = np.array([pos[0] / radius ** 2, (pos[1] - base_bevel) / height ** 2, pos[2] / radius ** 2])
        normal /= np.linalg.norm(normal)
        s = seed.copy()
        s.apply_scale([1.6, 1.0, 0.9])
        s.apply_transform(trimesh.transformations.rotation_matrix(r.random() * 2 * math.pi, [0, 1, 0]))
        rot = trimesh.geometry.align_vectors([0, 1, 0], normal)
        s.apply_transform(rot)
        s.apply_translation(pos - normal * 0.0003)
        parts.append(s)
    return trimesh.util.concatenate(parts)


# ---------------------------------------------------------------- burgers (same stacking rules as BurgerView.cs)

THICKNESS = {
    "bun_bottom": 0.018, "beef": 0.0135, "chicken": 0.0165, "cheese": 0.0024, "bacon": 0.0045,
    "lettuce": 0.0055, "tomato": 0.0055, "onion": 0.0035, "pickles": 0.0028, "ketchup": 0.0016, "mayo": 0.0016,
}


def layer_parts(kind: str, index: int):
    """[(mesh, material name)] for one layer, at its own origin."""
    yaw = math.radians(index * 47 + hash(kind) % 7 * 23)

    def place(mesh, x=0.0, y=0.0, z=0.0, rot=0.0, scale=(1, 1, 1)):
        m = mesh.copy()
        m.apply_scale(scale)
        m.apply_transform(trimesh.transformations.rotation_matrix(rot, [0, 1, 0]))
        m.apply_translation([x, y, z])
        return m

    if kind == "bun_bottom":
        return [(lathe(rounded_slab(0.053, 0.018, 0.007), 48), "bun_inside")]
    if kind == "bun_top":
        return [(lathe(dome(0.055, 0.034, 0.006), 48), "bun"), (sesame_seeds(0.055, 0.034, 0.006), "sesame")]
    if kind == "beef":
        m = lathe(rounded_slab(0.056, 0.014, 0.005), 48, lambda a: 1 + 0.025 * math.sin(5 * a) + 0.015 * math.sin(13 * a + 1.3))
        return [(place(m, rot=yaw), "beef")]
    if kind == "chicken":
        m = lathe(rounded_slab(0.058, 0.017, 0.007), 64,
                  lambda a: 1 + 0.05 * math.sin(4 * a + 0.4) + 0.03 * math.sin(11 * a) + 0.015 * math.sin(23 * a),
                  lambda a, r: 0.0015 * math.sin(17 * a) if r > 0.03 else 0.0)
        return [(place(m, rot=yaw, scale=(1.08, 1, 0.94)), "chicken")]
    if kind == "cheese":
        return [(place(melted_square(0.054, 0.0028, 0.011), rot=math.radians(45 + index * 28)), "cheese")]
    if kind == "bacon":
        strip = wavy_strip(0.115, 0.022, 0.003, 3.5, 0.004)
        return [(place(strip, z=-0.012, rot=math.radians(20 + index * 70)), "bacon"),
                (place(strip, y=0.0012, z=0.013, rot=math.radians(30 + index * 70), scale=(0.95, 1, 1)), "bacon")]
    if kind == "lettuce":
        m = lathe(rounded_slab(0.062, 0.004, 0.0018), 96, lambda a: 1 + 0.07 * math.sin(9 * a) + 0.04 * math.sin(19 * a + 0.7),
                  lambda a, r: min(1.0, max(0.0, (r - 0.035) / 0.03)) * 0.006 * math.sin(14 * a))
        return [(place(m, rot=yaw), "lettuce")]
    if kind == "tomato":
        m = lathe(rounded_slab(0.032, 0.006, 0.002), 40)
        return [(place(m, x=-0.019, z=0.008), "tomato"), (place(m, x=0.02, y=0.0004, z=-0.006), "tomato")]
    if kind == "onion":
        return [(place(torus(0.034, 0.0026), x=0.006, y=0.0026), "onion"),
                (place(torus(0.025, 0.0026), x=-0.01, y=0.0026, z=0.006), "onion"),
                (place(torus(0.016, 0.0026), x=0.012, y=0.0026, z=-0.012), "onion")]
    if kind == "pickles":
        m = lathe(rounded_slab(0.013, 0.003, 0.0012), 24, lambda a: 1 + 0.06 * math.sin(12 * a))
        out = []
        for i in range(4):
            a = math.radians(i * 90 + index * 45 + 20)
            out.append((place(m, x=math.cos(a) * 0.026, z=math.sin(a) * 0.026, rot=math.radians(i * 33)), "pickle"))
        return out
    if kind in ("ketchup", "mayo"):
        m = lathe(rounded_slab(0.047, 0.0022, 0.001), 72, lambda a: 1 + 0.08 * math.sin(7 * a) + 0.05 * math.sin(15 * a + 2))
        return [(place(m, rot=yaw + (math.pi / 2 if kind == "mayo" else 0)), kind)]
    raise ValueError(kind)


def burger_stack(recipe: dict) -> list[tuple[str, int]]:
    """Bottom-to-top layers. Each slice of cheese melts onto a patty, like BurgerView.BuildStack."""
    stack = [("bun_bottom", 0)]
    add = lambda k: stack.extend((k, i) for i in range(recipe.get(k, 0)))  # noqa: E731
    add("mayo"); add("lettuce"); add("tomato")
    patty = "chicken" if recipe.get("chicken") else "beef"
    patties, cheese, used = recipe.get(patty, 0), recipe.get("cheese", 0), 0
    for i in range(patties):
        stack.append((patty, i))
        here = cheese - used if i == patties - 1 else min(1, cheese - used)
        for _ in range(here):
            stack.append(("cheese", used))
            used += 1
    add("bacon"); add("onion"); add("pickles"); add("ketchup")
    stack.append(("bun_top", 0))
    return stack


def build_burger(recipe: dict) -> trimesh.Scene:
    scene = trimesh.Scene()
    plate = lathe(plate_profile(), 64)
    plate.visual = trimesh.visual.TextureVisuals(material=material("plate"))
    scene.add_geometry(plate, node_name="plate")

    y = 0.006  # top of the plate
    for kind, index in burger_stack(recipe):
        for n, (mesh, mat) in enumerate(layer_parts(kind, index)):
            m = mesh.copy()
            m.apply_translation([0, y, 0])
            m.visual = trimesh.visual.TextureVisuals(material=material(mat))
            scene.add_geometry(m, node_name=f"{kind}_{index}_{n}")
        y += THICKNESS.get(kind, 0.0)
    return scene


RECIPES = {
    "classic_cheeseburger": {"beef": 1, "cheese": 1, "lettuce": 1, "tomato": 1, "onion": 1, "pickles": 1, "ketchup": 1},
    "crispy_chicken": {"chicken": 1, "lettuce": 1, "pickles": 1, "mayo": 1},
    "double_bacon": {"beef": 2, "cheese": 2, "bacon": 1, "lettuce": 1, "pickles": 1, "ketchup": 1},
}

# ---------------------------------------------------------------- card pictures


def render_card(scene: trimesh.Scene, path: Path, size: int = 512) -> None:
    """Front-and-above picture with a transparent background (Open3D raycasting, no display needed)."""
    meshes, colors = [], []
    for name, geom in scene.geometry.items():
        node = scene.graph.geometry_nodes[name][0]
        transform, _ = scene.graph[node]
        g = geom.copy()
        g.apply_transform(transform)
        mat = g.visual.material
        if getattr(mat, "baseColorTexture", None) is not None and hasattr(g.visual, "uv") and g.visual.uv is not None:
            tex = np.asarray(mat.baseColorTexture.convert("RGB")).astype(np.float32) / 255
            uv = g.visual.uv[g.faces].mean(axis=1)
            px = np.clip((uv[:, 0] * tex.shape[1]).astype(int), 0, tex.shape[1] - 1)
            py = np.clip(((1 - uv[:, 1]) * tex.shape[0]).astype(int), 0, tex.shape[0] - 1)
            colors.append(tex[py, px])
        else:
            c = np.asarray(mat.baseColorFactor[:3], float)
            c = c / 255 if c.max() > 1 else c
            colors.append(np.repeat(c[None], len(g.faces), 0))
        meshes.append(g)

    merged = trimesh.util.concatenate(meshes)
    face_colors = np.vstack(colors)
    normals = merged.face_normals

    t = o3d.t.geometry.TriangleMesh()
    t.vertex.positions = o3d.core.Tensor(merged.vertices.astype(np.float32))
    t.triangle.indices = o3d.core.Tensor(merged.faces.astype(np.int32))
    rc = o3d.t.geometry.RaycastingScene()
    rc.add_triangles(t)

    lo, hi = merged.bounds
    center = (lo + hi) / 2
    radius = float(np.linalg.norm(hi - lo)) / 2
    eye = center + np.array([0.0, radius * 1.0, -radius * 1.9])
    fwd = center - eye
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    pose = np.eye(4)
    pose[:3, 0], pose[:3, 1], pose[:3, 2], pose[:3, 3] = right, down, fwd, eye
    f = size * 1.15
    K = np.array([[f, 0, size / 2], [0, f, size / 2], [0, 0, 1]])
    ans = rc.cast_rays(o3d.t.geometry.RaycastingScene.create_rays_pinhole(K, np.linalg.inv(pose), size, size))
    hit = np.isfinite(ans["t_hit"].numpy())
    prim = ans["primitive_ids"].numpy()[hit]

    light = np.array([0.35, 1.0, -0.6]); light /= np.linalg.norm(light)
    n = normals[prim]
    n = np.where((n @ -fwd)[:, None] < 0, -n, n)  # face the camera (thin two-sided parts)
    shade = 0.5 + 0.5 * np.clip(n @ light, 0, 1)
    rgba = np.zeros((size, size, 4), np.uint8)
    rgba[hit, :3] = np.clip(face_colors[prim] * shade[:, None] * 255, 0, 255).astype(np.uint8)
    rgba[hit, 3] = 255
    Image.fromarray(rgba).save(path)


# ---------------------------------------------------------------- scanned dishes


def import_scan(name: str) -> trimesh.Scene:
    """Load a dish_scanner model and give it a JPEG texture (a fraction of the PNG's download size)."""
    src = SCANS / name / f"{name}.glb"
    scene = trimesh.load(src, force="scene")
    for geom in scene.geometry.values():
        mat = geom.visual.material
        image = getattr(mat, "baseColorTexture", None)
        if image is not None:
            buf = io.BytesIO()
            image.convert("RGB").save(buf, format="JPEG", quality=88)
            buf.seek(0)
            mat.baseColorTexture = Image.open(buf)
            mat.roughnessFactor = 0.8
            mat.metallicFactor = 0.0
    return scene


def size_cm(scene: trimesh.Scene) -> dict:
    lo, hi = scene.bounds
    s = (hi - lo) * 100
    return {"width": round(float(s[0]), 1), "height": round(float(s[1]), 1), "depth": round(float(s[2]), 1)}


def main() -> None:
    MODELS.mkdir(exist_ok=True)
    IMAGES.mkdir(exist_ok=True)
    sizes = {}

    for name, recipe in RECIPES.items():
        scene = build_burger(recipe)
        scene.export(MODELS / f"{name}.glb")
        render_card(scene, IMAGES / f"{name}.png")
        sizes[name] = size_cm(scene)

    for name in ["sesame_bun"]:
        if not (SCANS / name / f"{name}.glb").exists():
            print(f"skip {name}: no scan at {SCANS / name}")
            continue
        scene = import_scan(name)
        scene.export(MODELS / f"{name}.glb")
        render_card(scene, IMAGES / f"{name}.png")
        sizes[name] = size_cm(scene)

    (MODELS / "sizes.json").write_text(json.dumps(sizes, indent=2))
    for name, s in sizes.items():
        kb = (MODELS / f"{name}.glb").stat().st_size / 1024
        print(f"{name:22s} {s['width']:5.1f} × {s['height']:4.1f} × {s['depth']:5.1f} cm   {kb:7.0f} KB")


if __name__ == "__main__":
    main()
