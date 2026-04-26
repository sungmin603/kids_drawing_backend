#!/usr/bin/env python3
"""
GLB/GLTF → 2D Projection Tool
================================
3D 모델에서 2D 투영 이미지와 UV 매핑 규칙을 생성합니다.
CLI 스크립트이자 app.py에서 import하여 사용할 수 있는 모듈입니다.

사용법 (CLI):
    python algorithm/glb_projection.py algorithm/target_models/Lamborghini_Aventador.glb
    python algorithm/glb_projection.py algorithm/target_models/car.gltf --axis side
    python tools/glb_projection.py model.glb --axis top --size 1024
    python tools/glb_projection.py model.glb --axis front --no-symmetry

axis ↔ symmetry 자동 연동 (--no-symmetry로 해제 가능):
    front → yz  (YZ 평면 대칭, X 반전: 좌우 대칭)
    side  → xz  (XZ 평면 대칭, Y 반전: 상하 대칭)
    top   → xy  (XY 평면 대칭, Z 반전: 앞뒤 대칭)

출력 디렉토리: algorithm/target_models/<모델명>/
    <모델명>.glb               ← 모델 파일 복사 (GLTF는 관련 파일 전체)
    diffuse_origin.png         ← 추출된 원본 텍스처
    diffuse_painted.png        ← 사용자가 칠한 텍스처 (초기: diffuse_origin 복사)
    projection_<axis>.png      ← 색칠용 외곽선 이미지
    projection_diffuse_<axis>.png ← 원본 텍스처를 투영한 이미지 (참고용)
    uvmap_<axis>.png           ← UV 맵 이미지 (R=U, G=V, A=유효영역)
    mapping_<axis>.json        ← 메타데이터 + 대칭 UV 쌍
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from urllib.parse import unquote

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

try:
    import trimesh
except ImportError:
    print("trimesh가 설치되지 않았습니다.\n  pip install trimesh[easy]")
    sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# 상수
# ─────────────────────────────────────────────────────────────────────────────

# axis → 자동 연동 대칭 평면
AXIS_SYMMETRY: dict[str, str] = {
    "front": "yz",   # X 반전 (좌우 대칭)
    "side":  "xz",   # Y 반전 (상하 대칭)
    "top":   "xy",   # Z 반전 (앞뒤 대칭)
}

# axis → 2D 투영에 사용할 축 인덱스 (xi, yi)
AXIS_PROJECT: dict[str, tuple[int, int]] = {
    "front": (0, 1),   # X, Y
    "side":  (2, 1),   # Z, Y
    "top":   (0, 2),   # X, Z
}

AXIS_DEPTH: dict[str, int] = {
    "front": 2,
    "side": 0,
    "top": 1,
}

# 대칭 평면 → 뒤집을 3D 좌표 인덱스
SYMMETRY_FLIP: dict[str, int] = {
    "yz": 0,   # X 반전
    "xz": 1,   # Y 반전
    "xy": 2,   # Z 반전
}

SUPPORTED_EXT = {".glb", ".gltf"}

# axis → 투영 뷰 기준 광원 방향 (정규화 전)
AXIS_LIGHT: dict[str, list[float]] = {
    "front": [0.3, 0.6, 1.0],   # +Z 방향에서 보는 뷰: 전면 위쪽
    "side":  [1.0, 0.6, 0.3],   # +X 방향에서 보는 뷰
    "top":   [0.3, 1.0, 0.5],   # +Y 방향에서 보는 뷰
}


# ─────────────────────────────────────────────────────────────────────────────
# 1. 모델 로딩
# ─────────────────────────────────────────────────────────────────────────────

def _detect_project_root() -> Path:
    """이 스크립트 위치로부터 프로젝트 루트 추정."""
    return Path(__file__).resolve().parent.parent


def _uv_from_geom(geom: trimesh.Trimesh) -> np.ndarray:
    """메시에서 UV 좌표 추출. 없으면 0벡터 반환."""
    uv = None
    if hasattr(geom.visual, "uv") and geom.visual.uv is not None:
        uv = np.asarray(geom.visual.uv, dtype=np.float32)
        if len(uv) == len(geom.vertices):
            return uv
    try:
        tv = geom.visual.to_texture()
        if tv is not None and hasattr(tv, "uv") and tv.uv is not None:
            uv = np.asarray(tv.uv, dtype=np.float32)
            if len(uv) == len(geom.vertices):
                return uv
    except Exception:
        pass
    return np.zeros((len(geom.vertices), 2), dtype=np.float32)


def load_mesh_for_geometry(path: str) -> trimesh.Trimesh:
    """
    GLB/GLTF를 단일 Trimesh로 로드.

    핵심 수정:
    - 씬 그래프 노드를 순회하며 각 메시에 월드 변환(T)을 적용합니다.
      (이전 코드는 geometry.values()를 로컬 좌표 그대로 합쳐 휠 4개가
       모두 원점 주변에 겹쳐 투영되는 문제가 있었습니다.)
    - UV를 명시적으로 수집해 concatenate 시 손실을 방지합니다.
    """
    loaded = trimesh.load(path, force="scene", process=False)

    if isinstance(loaded, trimesh.Trimesh):
        print(f"  메쉬 로드: 정점 {len(loaded.vertices):,}개, 면 {len(loaded.faces):,}개")
        return loaded

    if not isinstance(loaded, trimesh.Scene):
        raise ValueError(f"지원하지 않는 로드 결과: {type(loaded)}")

    all_vertices: list[np.ndarray] = []
    all_faces:    list[np.ndarray] = []
    all_uvs:      list[np.ndarray] = []
    vertex_offset = 0

    for node_name in loaded.graph.nodes_geometry:
        T, geom_name = loaded.graph[node_name]
        geom = loaded.geometry.get(geom_name)
        if not isinstance(geom, trimesh.Trimesh):
            continue

        # 월드 변환 적용 (UV는 변환 불필요)
        verts = np.array(
            trimesh.transformations.transform_points(geom.vertices, T),
            dtype=np.float64,
        )
        uv = _uv_from_geom(geom)

        all_vertices.append(verts)
        all_faces.append(geom.faces + vertex_offset)
        all_uvs.append(uv)
        vertex_offset += len(verts)

    if not all_vertices:
        raise ValueError(f"유효한 Trimesh 없음: {path}")

    vertices = np.vstack(all_vertices)
    faces    = np.vstack(all_faces)
    uvs      = np.vstack(all_uvs)

    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    mesh.visual = trimesh.visual.TextureVisuals(uv=uvs)

    print(f"  메쉬 로드: 정점 {len(mesh.vertices):,}개, 면 {len(mesh.faces):,}개")
    return mesh


def extract_uvs(mesh: trimesh.Trimesh) -> np.ndarray:
    """UV 좌표 추출. 없으면 XY 평면 정규화 매핑으로 폴백."""
    uv = None

    if hasattr(mesh.visual, "uv") and mesh.visual.uv is not None:
        uv = np.asarray(mesh.visual.uv, dtype=np.float32)
        if len(uv) == len(mesh.vertices):
            print(f"  UV: {uv.shape} (TextureVisuals)")
            return uv

    try:
        tv = mesh.visual.to_texture()
        if tv is not None and hasattr(tv, "uv") and tv.uv is not None:
            uv = np.asarray(tv.uv, dtype=np.float32)
            if len(uv) == len(mesh.vertices):
                print(f"  UV: {uv.shape} (to_texture 변환)")
                return uv
    except Exception:
        pass

    print("  경고: UV 없음 → XY 평면 매핑 사용")
    v = mesh.vertices
    mn, mx = v.min(0), v.max(0)
    rng = np.where(mx - mn > 0, mx - mn, 1.0)
    uv = np.stack([(v[:, 0] - mn[0]) / rng[0],
                   1.0 - (v[:, 1] - mn[1]) / rng[1]], axis=1).astype(np.float32)
    return uv


def extract_diffuse_texture(path: str) -> Image.Image | None:
    """
    GLB/GLTF에서 diffuse/baseColor 텍스처를 PIL Image로 추출.

    1차: trimesh material 속성에서 직접 추출
    2차: GLTF의 images[].uri를 파싱해 외부 이미지 파일 직접 로드
         (Blender 등이 내보낸 .gltf + .jpg/.png 구조 지원)
    """
    from urllib.parse import unquote

    # ── 1차: trimesh material에서 직접 추출 ──────────────────────────────
    try:
        scene = trimesh.load(path, force="scene", process=False)
        geometries = scene.geometry.values() if isinstance(scene, trimesh.Scene) else [scene]
        for mesh in geometries:
            if not isinstance(mesh, trimesh.Trimesh):
                continue
            visual = mesh.visual
            if not hasattr(visual, "material"):
                continue
            mat = visual.material
            for attr in ("baseColorTexture", "image"):
                img = getattr(mat, attr, None)
                if isinstance(img, Image.Image):
                    print(f"  diffuse 추출 성공 (attr={attr})")
                    return img.convert("RGBA")
    except Exception as e:
        print(f"  trimesh 추출 실패: {e}")

    # ── 2차: GLTF JSON의 images[].uri 직접 파싱 ──────────────────────────
    if Path(path).suffix.lower() == ".gltf":
        try:
            with open(path, "r", encoding="utf-8") as f:
                gltf_data = json.load(f)
            src_dir = Path(path).parent
            for img_entry in gltf_data.get("images", []):
                uri = img_entry.get("uri", "")
                if not uri or uri.startswith("data:"):
                    continue
                # URL 인코딩 디코드 (예: Lamborginhi%20Aventador_diffuse.jpg)
                img_file = src_dir / unquote(uri)
                if img_file.exists():
                    print(f"  외부 텍스처 직접 로드: {img_file.name}")
                    return Image.open(str(img_file)).convert("RGBA")
        except Exception as e:
            print(f"  GLTF 외부 이미지 로드 실패: {e}")

    print("  diffuse 텍스처 없음")
    return None


def copy_model_files(src_path: str, out_dir: str) -> str:
    """
    GLB → 파일 1개 복사.
    GLTF → .gltf + .bin + 참조 텍스처 파일 모두 복사.
    반환값: 복사된 모델 파일명 (basename).
    """
    ext = Path(src_path).suffix.lower()
    os.makedirs(out_dir, exist_ok=True)

    if ext == ".glb":
        dst = os.path.join(out_dir, Path(src_path).name)
        # 원본과 대상이 동일한 파일이면 복사 건너뜀 (재처리 시 WinError 32 방지)
        if Path(src_path).resolve() != Path(dst).resolve():
            shutil.copy2(src_path, dst)
        return Path(src_path).name

    # GLTF: JSON 파싱 후 참조 파일 복사
    src_dir = Path(src_path).parent
    with open(src_path, "r", encoding="utf-8") as f:
        gltf_data = json.load(f)

    out_dir_path = Path(out_dir)

    # 메인 .gltf 파일
    gltf_dst = out_dir_path / Path(src_path).name
    if Path(src_path).resolve() != gltf_dst.resolve():
        shutil.copy2(src_path, out_dir)

    # buffers (.bin 등)
    for buf in gltf_data.get("buffers", []):
        uri = buf.get("uri", "")
        if uri and not uri.startswith("data:"):
            src_file = src_dir / unquote(uri)   # URL 인코딩 디코드
            if src_file.exists():
                buf_dst = out_dir_path / src_file.name
                if src_file.resolve() != buf_dst.resolve():
                    shutil.copy2(str(src_file), out_dir)

    # images (텍스처)
    for img in gltf_data.get("images", []):
        uri = img.get("uri", "")
        if uri and not uri.startswith("data:"):
            src_file = src_dir / unquote(uri)   # URL 인코딩 디코드
            if src_file.exists():
                img_dst = out_dir_path / src_file.name
                if src_file.resolve() != img_dst.resolve():
                    shutil.copy2(str(src_file), out_dir)

    return Path(src_path).name


def cleanup_axis_outputs(out_dir: Path, axis: str) -> None:
    """Rebuild the selected axis from scratch to avoid stale artifacts."""
    for filename in (
        f"projection_{axis}.png",
        f"projection_diffuse_{axis}.png",
        f"projmap_{axis}.png",
        f"projection_mapping_{axis}.json",
        f"mapping_{axis}.json",
    ):
        target = out_dir / filename
        if target.exists():
            target.unlink()


# ─────────────────────────────────────────────────────────────────────────────
# 2. 투영 & 정규화
# ─────────────────────────────────────────────────────────────────────────────

def project_and_normalize(vertices: np.ndarray, axis: str, img_size: int,
                           padding: float = 0.06) -> np.ndarray:
    """3D 정점 → 2D 이미지 좌표 (패딩 포함 정규화).

    이미지 좌표계(row=0=상단)와 3D 좌표계(Y-up)의 차이를 보정하기 위해
    투영된 Y축(두 번째 열)을 반전합니다.
    이렇게 해야 3D에서 위쪽에 있는 점이 이미지 상단에 나타납니다.
    """
    xi, yi = AXIS_PROJECT[axis]
    pts = vertices[:, [xi, yi]].astype(np.float64)

    # Y축 반전: 3D Y-up → 이미지 row-down (row=0이 상단)
    pts[:, 1] = -pts[:, 1]

    mn, mx = pts.min(0), pts.max(0)
    rng = mx - mn
    max_r = rng.max() or 1.0

    pad = img_size * padding
    scale = (img_size - 2 * pad) / max_r
    offset = (img_size - rng * scale) / 2 - mn * scale
    return pts * scale + offset


# ─────────────────────────────────────────────────────────────────────────────
# 3. 래스터화 (numpy 벡터화)
# ─────────────────────────────────────────────────────────────────────────────

def rasterize(verts2d: np.ndarray, faces: np.ndarray,
              vertices: np.ndarray, axis: str, uvs: np.ndarray, img_size: int,
              vertex_normals: np.ndarray | None = None,
              ) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """
    삼각형 래스터라이저. 각 픽셀에 UV 좌표와 보간된 법선 저장.
    Returns: uv_buf (H,W,2), coverage (H,W) bool, normal_buf (H,W,3) or None
    """
    uv_buf   = np.full((img_size, img_size, 2), np.nan, dtype=np.float32)
    coverage = np.zeros((img_size, img_size), dtype=bool)
    depth_buf = np.full((img_size, img_size), -np.inf, dtype=np.float32)
    normal_buf = (np.zeros((img_size, img_size, 3), dtype=np.float32)
                  if vertex_normals is not None else None)
    n = len(faces)
    depth_idx = AXIS_DEPTH[axis]

    for fi, face in enumerate(faces):
        if fi % 5000 == 0:
            print(f"    래스터화: {fi}/{n} ({100*fi//n}%)\r", end="", flush=True)

        v0, v1, v2 = verts2d[face[0]], verts2d[face[1]], verts2d[face[2]]
        uv0, uv1, uv2 = uvs[face[0]], uvs[face[1]], uvs[face[2]]
        z0, z1, z2 = vertices[face, depth_idx].astype(np.float32)

        x0 = max(0, int(np.floor(min(v0[0], v1[0], v2[0]))))
        x1 = min(img_size - 1, int(np.ceil(max(v0[0], v1[0], v2[0]))))
        y0 = max(0, int(np.floor(min(v0[1], v1[1], v2[1]))))
        y1 = min(img_size - 1, int(np.ceil(max(v0[1], v1[1], v2[1]))))
        if x0 > x1 or y0 > y1:
            continue

        xs = np.arange(x0, x1 + 1, dtype=np.float32) + 0.5
        ys = np.arange(y0, y1 + 1, dtype=np.float32) + 0.5
        gx, gy = np.meshgrid(xs, ys)
        gx, gy = gx.ravel(), gy.ravel()

        denom = (v1[1]-v2[1])*(v0[0]-v2[0]) + (v2[0]-v1[0])*(v0[1]-v2[1])
        if abs(denom) < 1e-10:
            continue

        w0_arr = ((v1[1]-v2[1])*(gx-v2[0]) + (v2[0]-v1[0])*(gy-v2[1])) / denom
        w1_arr = ((v2[1]-v0[1])*(gx-v2[0]) + (v0[0]-v2[0])*(gy-v2[1])) / denom
        w2_arr = 1.0 - w0_arr - w1_arr

        inside = (w0_arr >= 0) & (w1_arr >= 0) & (w2_arr >= 0)
        if not inside.any():
            continue

        px = np.clip((gx[inside] - 0.5).astype(np.int32), 0, img_size - 1)
        py = np.clip((gy[inside] - 0.5).astype(np.int32), 0, img_size - 1)

        wi0, wi1, wi2 = w0_arr[inside], w1_arr[inside], w2_arr[inside]
        depth = wi0 * z0 + wi1 * z1 + wi2 * z2
        current_depth = depth_buf[py, px]
        visible = depth > current_depth
        if not visible.any():
            continue

        px = px[visible]
        py = py[visible]
        wi0 = wi0[visible]
        wi1 = wi1[visible]
        wi2 = wi2[visible]
        depth = depth[visible]

        u = np.clip(wi0*uv0[0] + wi1*uv1[0] + wi2*uv2[0], 0.0, 1.0)
        v = np.clip(wi0*uv0[1] + wi1*uv1[1] + wi2*uv2[1], 0.0, 1.0)

        uv_buf[py, px, 0] = u
        uv_buf[py, px, 1] = v
        coverage[py, px] = True
        depth_buf[py, px] = depth

        # 법선 보간 (Gouraud shading용)
        if vertex_normals is not None and normal_buf is not None:
            n0, n1, n2 = vertex_normals[face[0]], vertex_normals[face[1]], vertex_normals[face[2]]
            nx_i = wi0*n0[0] + wi1*n1[0] + wi2*n2[0]
            ny_i = wi0*n0[1] + wi1*n1[1] + wi2*n2[1]
            nz_i = wi0*n0[2] + wi1*n1[2] + wi2*n2[2]
            lengths = np.sqrt(nx_i**2 + ny_i**2 + nz_i**2) + 1e-8
            normal_buf[py, px, 0] = nx_i / lengths
            normal_buf[py, px, 1] = ny_i / lengths
            normal_buf[py, px, 2] = nz_i / lengths

    print()
    return uv_buf, coverage, normal_buf


# ─────────────────────────────────────────────────────────────────────────────
# 4. 대칭 면 매핑
# ─────────────────────────────────────────────────────────────────────────────

def find_symmetric_uv_pairs(mesh: trimesh.Trimesh, uvs: np.ndarray,
                             sym_axis: str, tol: float = 0.02) -> list[dict]:
    """
    대칭 면 쌍 → (source_uv, target_uv) 리스트.
    sym_axis: 'yz' | 'xz' | 'xy'
    """
    flip_idx = SYMMETRY_FLIP[sym_axis]
    faces = mesh.faces
    verts = mesh.vertices

    centroids = verts[faces].mean(axis=1)
    mirror = centroids.copy()
    mirror[:, flip_idx] *= -1

    pairs: list[dict] = []
    used = np.zeros(len(faces), dtype=bool)
    chunk = 1000

    for i in range(0, len(faces), chunk):
        batch = mirror[i:i + chunk]
        diff = centroids[np.newaxis] - batch[:, np.newaxis]
        dist = np.abs(diff).max(axis=2)

        for bi in range(len(batch)):
            fi = i + bi
            if used[fi]:
                continue
            dist[bi, fi] = np.inf
            dist[bi, used] = np.inf
            j = int(dist[bi].argmin())
            if dist[bi, j] > tol:
                continue
            used[fi] = True
            used[j] = True
            source_vertices = verts[faces[fi]]
            target_vertices = verts[faces[j]]
            mirrored_vertices = source_vertices.copy()
            mirrored_vertices[:, flip_idx] *= -1

            for source_idx, mirrored_vertex in zip(faces[fi], mirrored_vertices):
                offsets = target_vertices - mirrored_vertex
                match_idx = int(np.argmin(np.linalg.norm(offsets, axis=1)))
                target_idx = faces[j][match_idx]
                pairs.append({
                    "source": uvs[source_idx].tolist(),
                    "target": uvs[target_idx].tolist(),
                })

    sym_faces = len(pairs) // 3
    print(f"  대칭 UV 쌍: {len(pairs)}개 (face {sym_faces}쌍, 대칭축={sym_axis})")
    return pairs


# ─────────────────────────────────────────────────────────────────────────────
# 5. 이미지 빌드
# ─────────────────────────────────────────────────────────────────────────────

def build_projection_outline(coverage: np.ndarray, verts2d: np.ndarray,
                              faces: np.ndarray, img_size: int) -> Image.Image:
    """색칠용 외곽선 이미지: 흰 배경 + 연한 채움 + 와이어프레임."""
    arr = np.full((img_size, img_size, 4), 255, dtype=np.uint8)
    arr[coverage] = [230, 235, 248, 255]
    img = Image.fromarray(arr, "RGBA")

    draw = ImageDraw.Draw(img)
    v2i = np.clip(verts2d, 0, img_size - 1).astype(int)
    for face in faces:
        pts = [(int(v2i[face[k], 0]), int(v2i[face[k], 1])) for k in range(3)]
        draw.polygon(pts, outline=(80, 100, 180, 180))

    return img.filter(ImageFilter.SMOOTH)


def build_projmap(uv_buf: np.ndarray, coverage: np.ndarray,
                  proj_size: int, tex_size: int) -> Image.Image:
    """
    프로젝션 픽셀 → UV 텍스처 픽셀 좌표 매핑 (고정밀도).

    기존 uvmap (8비트 UV 정규화 값) 대신 정수 텍스처 픽셀 좌표를 10비트로 저장.
    tex_size ≤ 512 (tx, ty ∈ [0, 511]) 기준 인코딩:
        R = tx >> 1          (상위 8비트)
        G = ty >> 1          (상위 8비트)
        B = (tx&1)<<7 | (ty&1)<<6   (하위 1비트씩)
        A = 255 (유효) / 0 (무효)

    JS 디코딩:
        tx = (R << 1) | ((B >> 7) & 1)
        ty = (G << 1) | ((B >> 6) & 1)
    """
    projmap = np.zeros((proj_size, proj_size, 4), dtype=np.uint8)

    cy, cx = np.where(coverage)
    if len(cy) == 0:
        return Image.fromarray(projmap, "RGBA")

    # mod 1.0으로 tiling UV 처리 (UV > 1 또는 < 0 인 모델 지원)
    u = np.mod(uv_buf[cy, cx, 0], 1.0).astype(np.float32)
    v = np.mod(uv_buf[cy, cx, 1], 1.0).astype(np.float32)

    # UV → 텍스처 픽셀 좌표 (V 반전: glTF V=0=하단 → row=0=상단)
    tx = np.clip((u * (tex_size - 1)).astype(np.int32), 0, tex_size - 1)
    ty = np.clip(((1.0 - v) * (tex_size - 1)).astype(np.int32), 0, tex_size - 1)

    # 10비트 인코딩
    projmap[cy, cx, 0] = (tx >> 1).astype(np.uint8)
    projmap[cy, cx, 1] = (ty >> 1).astype(np.uint8)
    projmap[cy, cx, 2] = (((tx & 1) << 7) | ((ty & 1) << 6)).astype(np.uint8)
    projmap[cy, cx, 3] = 255

    return Image.fromarray(projmap, "RGBA")


def build_projection_mapping_data(
    verts2d: np.ndarray,
    faces: np.ndarray,
    uvs: np.ndarray,
    proj_size: int,
    tex_size: int,
) -> dict:
    """
    프로젝션 픽셀 하나가 여러 면과 겹칠 수 있도록 다중 텍스처 매핑 데이터를 생성.

    Returns:
        {
            "projection_size": int,
            "texture_size": int,
            "pixels": [
                {"pixel": int, "texels": [[tx, ty], ...]},
                ...
            ]
        }
    """
    pixel_to_texels: dict[int, set[tuple[int, int]]] = {}

    for face in faces:
        v0, v1, v2 = verts2d[face[0]], verts2d[face[1]], verts2d[face[2]]
        uv0, uv1, uv2 = uvs[face[0]], uvs[face[1]], uvs[face[2]]

        x0 = max(0, int(np.floor(min(v0[0], v1[0], v2[0]))))
        x1 = min(proj_size - 1, int(np.ceil(max(v0[0], v1[0], v2[0]))))
        y0 = max(0, int(np.floor(min(v0[1], v1[1], v2[1]))))
        y1 = min(proj_size - 1, int(np.ceil(max(v0[1], v1[1], v2[1]))))
        if x0 > x1 or y0 > y1:
            continue

        xs = np.arange(x0, x1 + 1, dtype=np.float32) + 0.5
        ys = np.arange(y0, y1 + 1, dtype=np.float32) + 0.5
        gx, gy = np.meshgrid(xs, ys)
        gx, gy = gx.ravel(), gy.ravel()

        denom = (v1[1] - v2[1]) * (v0[0] - v2[0]) + (v2[0] - v1[0]) * (v0[1] - v2[1])
        if abs(denom) < 1e-10:
            continue

        w0_arr = ((v1[1] - v2[1]) * (gx - v2[0]) + (v2[0] - v1[0]) * (gy - v2[1])) / denom
        w1_arr = ((v2[1] - v0[1]) * (gx - v2[0]) + (v0[0] - v2[0]) * (gy - v2[1])) / denom
        w2_arr = 1.0 - w0_arr - w1_arr

        inside = (w0_arr >= 0) & (w1_arr >= 0) & (w2_arr >= 0)
        if not inside.any():
            continue

        px = np.clip((gx[inside] - 0.5).astype(np.int32), 0, proj_size - 1)
        py = np.clip((gy[inside] - 0.5).astype(np.int32), 0, proj_size - 1)
        wi0, wi1, wi2 = w0_arr[inside], w1_arr[inside], w2_arr[inside]

        u = np.mod(wi0 * uv0[0] + wi1 * uv1[0] + wi2 * uv2[0], 1.0)
        v = np.mod(wi0 * uv0[1] + wi1 * uv1[1] + wi2 * uv2[1], 1.0)
        tx = np.clip((u * (tex_size - 1)).astype(np.int32), 0, tex_size - 1)
        ty = np.clip(((1.0 - v) * (tex_size - 1)).astype(np.int32), 0, tex_size - 1)

        for pixel_x, pixel_y, tex_x, tex_y in zip(px, py, tx, ty):
            pixel_index = int(pixel_y * proj_size + pixel_x)
            pixel_to_texels.setdefault(pixel_index, set()).add((int(tex_x), int(tex_y)))

    pixels = [
        {
            "pixel": pixel_index,
            "texels": [[tex_x, tex_y] for tex_x, tex_y in sorted(texels)],
        }
        for pixel_index, texels in sorted(pixel_to_texels.items())
    ]
    return {
        "projection_size": proj_size,
        "texture_size": tex_size,
        "pixels": pixels,
    }


def build_diffuse_projected(uv_buf: np.ndarray, coverage: np.ndarray,
                             diffuse_img: Image.Image, img_size: int) -> Image.Image:
    """
    원본 텍스처를 투영 뷰에 베이킹한 이미지.
    projection 캔버스의 각 픽셀에 대응하는 UV로 원본 텍스처 색상을 샘플링.
    V 좌표: glTF/OpenGL 기준(V=0=하단) → 이미지 행(row=0=상단) 변환: 1-v
    """
    # diffuse를 numpy로 변환 (RGBA 보장)
    diff = diffuse_img.convert("RGBA").resize((img_size, img_size), Image.LANCZOS)
    diff_arr = np.array(diff)

    result = np.full((img_size, img_size, 4), 255, dtype=np.uint8)

    cy, cx = np.where(coverage)
    # mod 1.0으로 tiling UV 처리
    u = np.mod(uv_buf[cy, cx, 0], 1.0).astype(np.float32)
    v = np.mod(uv_buf[cy, cx, 1], 1.0).astype(np.float32)

    # glTF UV V=0=하단 → 이미지 row=0=상단 변환
    tx = np.clip((u * (img_size - 1)).astype(int), 0, img_size - 1)
    ty = np.clip(((1.0 - v) * (img_size - 1)).astype(int), 0, img_size - 1)

    result[cy, cx] = diff_arr[ty, tx]
    return Image.fromarray(result, "RGBA")


def build_textured_projection(uv_buf: np.ndarray, coverage: np.ndarray,
                               diffuse_img: Image.Image | None, verts2d: np.ndarray,
                               faces: np.ndarray, img_size: int,
                               normal_buf: np.ndarray | None = None,
                               axis: str = "front") -> Image.Image:
    """
    색칠용 메인 투영 이미지.
    원본 텍스처 베이킹 + Gouraud 조명 + 외곽선 오버레이.

    diffuse_img=None 이면 흰색 기반 + 조명만 적용 (단색 모델도 입체감 표현).
    배경(모델 외부)은 투명으로 처리합니다.
    """
    # 1. 베이스 이미지 결정
    if diffuse_img is not None:
        result = build_diffuse_projected(uv_buf, coverage, diffuse_img, img_size)
        arr = np.array(result, dtype=np.float32)
    else:
        # 텍스처 없음 → 순수 흰색 기반 (조명으로 형태 표현)
        arr = np.zeros((img_size, img_size, 4), dtype=np.float32)
        arr[coverage] = [255.0, 255.0, 255.0, 255.0]

    # 2. Gouraud 조명 적용
    if normal_buf is not None:
        light = np.array(AXIS_LIGHT.get(axis, AXIS_LIGHT["front"]), dtype=np.float32)
        light /= np.linalg.norm(light) + 1e-8

        ambient   = 0.35   # 전체 최소 밝기
        diffuse_k = 0.50   # 직사 조명 강도
        spec_k    = 0.15   # 스펙큘러 강도 (하이라이트)
        spec_exp  = 32.0   # 스펙큘러 날카로움

        cy, cx = np.where(coverage)
        normals = normal_buf[cy, cx]
        dots    = np.clip(np.dot(normals, light), 0, 1)

        view_dirs = {"front": [0., 0., 1.], "side": [1., 0., 0.], "top": [0., 1., 0.]}
        view = np.array(view_dirs.get(axis, [0., 0., 1.]), dtype=np.float32)
        halfway = (light + view)
        halfway /= np.linalg.norm(halfway) + 1e-8
        spec_dots = np.clip(np.dot(normals, halfway), 0, 1) ** spec_exp

        shading = ambient + diffuse_k * dots + spec_k * spec_dots
        arr[cy, cx, :3] = np.clip(arr[cy, cx, :3] * shading[:, None], 0, 255)

    # 3. 배경(비커버 영역)은 투명 처리
    arr[~coverage] = [0.0, 0.0, 0.0, 0.0]
    result = Image.fromarray(arr.astype(np.uint8), "RGBA")

    # 4. 경계선 오버레이 (얇고 반투명)
    draw = ImageDraw.Draw(result)
    v2i = np.clip(verts2d, 0, img_size - 1).astype(int)
    for face in faces:
        pts = [(int(v2i[face[k], 0]), int(v2i[face[k], 1])) for k in range(3)]
        draw.polygon(pts, outline=(20, 20, 40, 60))

    return result.filter(ImageFilter.SMOOTH)


# ─────────────────────────────────────────────────────────────────────────────
# 6. 메인 처리 함수 (CLI & import 공용)
# ─────────────────────────────────────────────────────────────────────────────

def run_projection(model_path: str, axis: str = "front",
                   size: int = 512, use_symmetry: bool = True) -> dict:
    """
    GLB/GLTF 파일을 처리해 2D 투영 + UV 맵 + 대칭 쌍을 생성합니다.

    Parameters
    ----------
    model_path  : GLB 또는 GLTF 파일 경로 (절대 또는 상대)
    axis        : 'front' | 'side' | 'top'
    size        : 출력 이미지 크기 (px)
    use_symmetry: True면 axis에 연동된 대칭 평면 자동 적용

    Returns
    -------
    dict with project metadata (mapping_<axis>.json 내용 포함)
    """
    model_path = str(Path(model_path).resolve())
    ext = Path(model_path).suffix.lower()
    if ext not in SUPPORTED_EXT:
        raise ValueError(f"지원하지 않는 형식: {ext}  (지원: .glb, .gltf)")
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"파일 없음: {model_path}")

    stem = Path(model_path).stem

    # 출력 디렉토리: {project_root}/algorithm/target_models/{stem}/
    project_root = _detect_project_root()
    out_dir = project_root / "algorithm" / "target_models" / stem
    out_dir.mkdir(parents=True, exist_ok=True)
    out_dir_str = str(out_dir)

    sym_axis = AXIS_SYMMETRY[axis] if use_symmetry else None
    suffix = f"_{axis}"

    # ── 1. 모델 파일 복사 ──
    print(f"\n[1/5] 모델 파일 복사 → {out_dir_str}")
    model_filename = copy_model_files(model_path, out_dir_str)
    cleanup_axis_outputs(out_dir, axis)

    # ── 2. diffuse 텍스처 추출 및 정규화 ──
    print("[2/5] diffuse 텍스처 추출")
    diffuse_img = extract_diffuse_texture(model_path)
    if diffuse_img is None:
        print("  원본 텍스처 없음 → 밝은 회색 텍스처로 대체")
        diffuse_img = Image.new("RGBA", (size, size), (200, 200, 200, 255))
    else:
        print(f"  추출 성공 ({diffuse_img.size})")
    diffuse_img = diffuse_img.convert("RGBA").resize((size, size), Image.LANCZOS)
    diffuse_texture_file = "diffuse_origin.png"
    diffuse_img.save(str(out_dir / diffuse_texture_file))

    # ── 3. 메쉬 로드 & UV 추출 ──
    print("[3/5] 메쉬 & UV 로드")
    mesh = load_mesh_for_geometry(model_path)
    uvs = extract_uvs(mesh)

    # ── 4. 투영 정규화 & 래스터화 (법선 보간 포함) ──
    print(f"[4/5] 투영+래스터화 ({axis} 방향, {size}×{size})")
    verts2d = project_and_normalize(mesh.vertices, axis, size)
    try:
        vertex_normals = mesh.vertex_normals  # trimesh가 자동 계산
    except Exception:
        vertex_normals = None
        print("  법선 계산 실패 → 조명 없이 진행")

    uv_buf, coverage, normal_buf = rasterize(
        verts2d, mesh.faces, mesh.vertices, axis, uvs, size, vertex_normals
    )
    covered_px = int(coverage.sum())
    print(f"  커버리지: {covered_px:,}px ({100*covered_px/size**2:.1f}%)")

    # ── 5. 이미지 저장 & JSON ──
    print("[5/5] 이미지 저장 & JSON")

    # projection: 조명 적용 텍스처 베이킹 + 외곽선
    proj_file = f"projection{suffix}.png"
    proj_path = out_dir / proj_file
    build_textured_projection(
        uv_buf, coverage, diffuse_img, verts2d, mesh.faces, size,
        normal_buf=normal_buf, axis=axis
    ).save(str(proj_path))
    print(f"  {proj_file}")

    reference_file = f"projection_diffuse{suffix}.png"
    build_diffuse_projected(uv_buf, coverage, diffuse_img, size).save(
        str(out_dir / reference_file)
    )
    print(f"  {reference_file}")

    # projmap: 프로젝션 픽셀 → UV 텍스처 픽셀 좌표 (10비트 고정밀도)
    projmap_file = f"projmap{suffix}.png"
    projmap_path = out_dir / projmap_file
    build_projmap(uv_buf, coverage, size, size).save(str(projmap_path))
    print(f"  {projmap_file}")

    projection_mapping_file = f"projection_mapping{suffix}.json"
    projection_mapping_path = out_dir / projection_mapping_file
    projection_mapping = build_projection_mapping_data(
        verts2d, mesh.faces, uvs, size, size
    )
    with open(projection_mapping_path, "w", encoding="utf-8") as f:
        json.dump(projection_mapping, f, ensure_ascii=False)
    print(f"  {projection_mapping_file}")

    # 대칭 UV 쌍
    sym_pairs: list[dict] = []
    if sym_axis:
        sym_pairs = find_symmetric_uv_pairs(mesh, uvs, sym_axis)

    meta: dict = {
        "name":           stem,
        "model_file":     model_filename,
        "axis":           axis,
        "symmetry_axis":  sym_axis,
        "image_size":     size,
        "texture_size":   size,
        "processed_at":   int(os.path.getmtime(proj_path)),
        "coverage_px":    covered_px,
        "projection_image": proj_file,
        "reference_image": reference_file,
        "projmap_image":  projmap_file,
        "projection_mapping_data": projection_mapping_file,
        "diffuse_texture_image": diffuse_texture_file,
        "uv_mirror_pairs": sym_pairs,
    }

    json_file = f"mapping{suffix}.json"
    json_path = out_dir / json_file
    with open(str(json_path), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"  {json_file}")

    print(f"\n완료! → {out_dir_str}/")
    return meta


# ─────────────────────────────────────────────────────────────────────────────
# CLI 진입점
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="GLB/GLTF → 2D 투영 + UV 맵 + diffuse 텍스처 추출",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("model", help="GLB 또는 GLTF 파일 경로")
    parser.add_argument("--axis", default="front",
                        choices=["front", "side", "top"],
                        help=f"투영 방향 (기본: front). "
                             f"대칭: front→yz, side→xz, top→xy 자동 연동")
    parser.add_argument("--size", type=int, default=512,
                        help="출력 이미지 크기 px (기본: 512)")
    parser.add_argument("--no-symmetry", action="store_true",
                        help="대칭 UV 쌍 계산 비활성화")
    args = parser.parse_args()

    if not os.path.exists(args.model):
        print(f"오류: 파일 없음 → {args.model}")
        sys.exit(1)

    ext = Path(args.model).suffix.lower()
    if ext not in SUPPORTED_EXT:
        print(f"오류: 지원하지 않는 형식 '{ext}'. 지원: .glb, .gltf")
        sys.exit(1)

    print(f"axis={args.axis}  →  대칭={AXIS_SYMMETRY[args.axis] if not args.no_symmetry else '없음'}")

    meta = run_projection(
        model_path=args.model,
        axis=args.axis,
        size=args.size,
        use_symmetry=not args.no_symmetry,
    )

    stem = meta["name"]
    print(f"\n출력 파일 위치: algorithm/target_models/{stem}/")
    print(f"  색칠 이미지    : {meta['projection_image']}")
    print(f"  프로젝션 맵    : {meta['projmap_image']}")
    print(f"  매핑 JSON      : mapping_{args.axis}.json")


if __name__ == "__main__":
    main()
