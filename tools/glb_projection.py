#!/usr/bin/env python3
"""
GLB/GLTF → 2D Projection Tool
================================
3D 모델에서 2D 투영 이미지와 UV 매핑 규칙을 생성합니다.

사용법:
    python tools/glb_projection.py static/models/Lamborghini_Aventador.glb
    python tools/glb_projection.py static/models/Shiba\ Inu.glb --axis front --symmetry yz

출력 파일 (static/models/ 폴더):
    <모델명>_projection_<axis>.png  - 사용자가 색칠할 투영 이미지 (외곽선)
    <모델명>_uvmap_<axis>.png       - UV 매핑 이미지 (R=U좌표, G=V좌표, A=유효영역)
    <모델명>_mapping_<axis>.json    - 대칭 UV 쌍 + 메타데이터

대칭 처리 원리:
    2D 투영은 앞면만 보이므로, 대칭 축을 기준으로 뒷면/반대쪽 UV에도
    동일한 색상을 적용하는 mirror 매핑을 생성합니다.
    예) yz 대칭 → X=-X 로 뒤집힌 면을 자동으로 같이 칠함
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

try:
    import trimesh
except ImportError:
    print("trimesh가 설치되지 않았습니다. 설치 후 다시 시도하세요:")
    print("  pip install trimesh[easy]")
    sys.exit(1)


# ─────────────────────────────────────────────
# 1. 모델 로딩
# ─────────────────────────────────────────────

def load_glb(path: str) -> trimesh.Trimesh:
    """GLB/GLTF 파일을 로드해 단일 Trimesh로 반환."""
    scene_or_mesh = trimesh.load(path, force="mesh", process=False)

    if isinstance(scene_or_mesh, trimesh.Scene):
        meshes = [g for g in scene_or_mesh.geometry.values()
                  if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise ValueError(f"GLB 파일에 Trimesh 지오메트리가 없습니다: {path}")
        mesh = trimesh.util.concatenate(meshes)
    else:
        mesh = scene_or_mesh

    print(f"  로드 완료: 정점 {len(mesh.vertices):,}개, 면 {len(mesh.faces):,}개")
    return mesh


def extract_uvs(mesh: trimesh.Trimesh) -> np.ndarray:
    """
    Trimesh에서 UV 좌표 추출.
    TextureVisuals → mesh.visual.uv (정점당 UV)
    없으면 XY 기반 평면 매핑으로 폴백.
    """
    uv = None
    if hasattr(mesh.visual, "uv") and mesh.visual.uv is not None:
        uv = np.array(mesh.visual.uv, dtype=np.float32)
        # 정점 수와 일치해야 함
        if len(uv) == len(mesh.vertices):
            print(f"  UV 좌표: {uv.shape} (TextureVisuals)")
            return uv

    # TextureVisuals → ColorVisuals로 변환 시 UV 손실. 대안 시도.
    try:
        tv = mesh.visual.to_texture()
        if tv is not None and hasattr(tv, "uv") and tv.uv is not None:
            uv = np.array(tv.uv, dtype=np.float32)
            if len(uv) == len(mesh.vertices):
                print(f"  UV 좌표: {uv.shape} (to_texture 변환)")
                return uv
    except Exception:
        pass

    # 폴백: XY 평면 정규화 매핑
    print("  경고: UV 좌표 없음 → XY 기반 평면 매핑 사용")
    verts = mesh.vertices
    mn, mx = verts.min(axis=0), verts.max(axis=0)
    rng = mx - mn
    rng[rng == 0] = 1.0
    uv = np.zeros((len(verts), 2), dtype=np.float32)
    uv[:, 0] = (verts[:, 0] - mn[0]) / rng[0]
    uv[:, 1] = 1.0 - (verts[:, 1] - mn[1]) / rng[1]
    return uv


# ─────────────────────────────────────────────
# 2. 정규화 & 투영
# ─────────────────────────────────────────────

AXIS_MAP = {
    "front": (0, 1),   # X, Y  (Z 방향으로 바라봄)
    "side":  (2, 1),   # Z, Y  (X 방향으로 바라봄)
    "top":   (0, 2),   # X, Z  (Y 방향으로 바라봄)
}


def project_and_normalize(vertices: np.ndarray, axis: str, img_size: int,
                           padding_ratio: float = 0.06) -> np.ndarray:
    """3D 정점을 2D 이미지 좌표로 투영·정규화."""
    xi, yi = AXIS_MAP[axis]
    pts2d = vertices[:, [xi, yi]].copy().astype(np.float64)

    mn, mx = pts2d.min(axis=0), pts2d.max(axis=0)
    rng = mx - mn
    max_range = rng.max()
    if max_range < 1e-9:
        max_range = 1.0

    pad = img_size * padding_ratio
    scale = (img_size - 2 * pad) / max_range
    offset = (img_size - rng * scale) / 2 - mn * scale

    return pts2d * scale + offset


# ─────────────────────────────────────────────
# 3. 삼각형 래스터화 (numpy 벡터화)
# ─────────────────────────────────────────────

def rasterize(verts2d: np.ndarray, faces: np.ndarray,
              uvs: np.ndarray, img_size: int) -> tuple[np.ndarray, np.ndarray]:
    """
    소프트웨어 래스터라이저.
    각 픽셀에 UV 좌표를 저장합니다 (R=U, G=V).

    Returns
    -------
    uv_buf   : float32 (H, W, 2)  – 픽셀별 UV 좌표, 미포함 픽셀은 NaN
    coverage : bool   (H, W)      – True이면 메쉬가 덮는 픽셀
    """
    uv_buf = np.full((img_size, img_size, 2), np.nan, dtype=np.float32)
    coverage = np.zeros((img_size, img_size), dtype=bool)

    for fi, face in enumerate(faces):
        if fi % 5000 == 0:
            print(f"    래스터화 진행: {fi}/{len(faces)} ({100*fi//len(faces)}%)\r", end="")

        v0, v1, v2 = verts2d[face[0]], verts2d[face[1]], verts2d[face[2]]
        uv0, uv1, uv2 = uvs[face[0]], uvs[face[1]], uvs[face[2]]

        # 바운딩 박스
        x0 = max(0, int(np.floor(min(v0[0], v1[0], v2[0]))))
        x1 = min(img_size - 1, int(np.ceil(max(v0[0], v1[0], v2[0]))))
        y0 = max(0, int(np.floor(min(v0[1], v1[1], v2[1]))))
        y1 = min(img_size - 1, int(np.ceil(max(v0[1], v1[1], v2[1]))))

        if x0 > x1 or y0 > y1:
            continue

        # 픽셀 센터 그리드
        xs = np.arange(x0, x1 + 1, dtype=np.float32) + 0.5
        ys = np.arange(y0, y1 + 1, dtype=np.float32) + 0.5
        gx, gy = np.meshgrid(xs, ys)
        gx, gy = gx.ravel(), gy.ravel()

        # 무게중심 좌표 (barycentric)
        denom = (v1[1] - v2[1]) * (v0[0] - v2[0]) + (v2[0] - v1[0]) * (v0[1] - v2[1])
        if abs(denom) < 1e-10:
            continue

        w0 = ((v1[1] - v2[1]) * (gx - v2[0]) + (v2[0] - v1[0]) * (gy - v2[1])) / denom
        w1 = ((v2[1] - v0[1]) * (gx - v2[0]) + (v0[0] - v2[0]) * (gy - v2[1])) / denom
        w2 = 1.0 - w0 - w1

        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue

        px = np.clip((gx[inside] - 0.5).astype(np.int32), 0, img_size - 1)
        py = np.clip((gy[inside] - 0.5).astype(np.int32), 0, img_size - 1)

        u = w0[inside] * uv0[0] + w1[inside] * uv1[0] + w2[inside] * uv2[0]
        v = w0[inside] * uv0[1] + w1[inside] * uv1[1] + w2[inside] * uv2[1]

        uv_buf[py, px, 0] = np.clip(u, 0.0, 1.0)
        uv_buf[py, px, 1] = np.clip(v, 0.0, 1.0)
        coverage[py, px] = True

    print()  # 줄바꿈
    return uv_buf, coverage


# ─────────────────────────────────────────────
# 4. 대칭 면 찾기
# ─────────────────────────────────────────────

SYMMETRY_FLIP = {"yz": 0, "xz": 1, "xy": 2}   # 뒤집을 축 인덱스


def find_symmetric_uv_pairs(mesh: trimesh.Trimesh, uvs: np.ndarray,
                             sym_axis: str, tol: float = 0.02) -> list[dict]:
    """
    대칭 면 쌍을 찾아 (source_uv, target_uv) 매핑 목록을 반환합니다.

    알고리즘
    --------
    1. 각 삼각형의 무게중심(centroid)을 계산합니다.
    2. 대칭 축에 대해 뒤집은 위치(mirror centroid)를 계산합니다.
    3. mirror centroid에 가장 가까운 다른 삼각형을 찾아 쌍으로 등록합니다.
    4. 쌍의 각 정점 UV를 매핑으로 기록합니다.

    Returns
    -------
    list of {"source": [u, v], "target": [u, v]}
    """
    flip_idx = SYMMETRY_FLIP[sym_axis]
    faces = mesh.faces
    verts = mesh.vertices

    # 면 무게중심
    centroids = verts[faces].mean(axis=1)          # (M, 3)

    # 대칭 무게중심
    mirror = centroids.copy()
    mirror[:, flip_idx] *= -1                       # 축 방향 반전

    pairs: list[dict] = []
    used = np.zeros(len(faces), dtype=bool)

    # KD-트리 없이: 행렬 계산으로 최근접 탐색
    # 메모리 절약을 위해 청크 처리
    chunk = 1000
    for i in range(0, len(faces), chunk):
        batch_mirror = mirror[i:i + chunk]          # (chunk, 3)
        # (chunk, M) 거리 행렬
        diff = centroids[np.newaxis, :, :] - batch_mirror[:, np.newaxis, :]
        dist = np.abs(diff).max(axis=2)             # Chebyshev

        for bi in range(len(batch_mirror)):
            fi = i + bi
            if used[fi]:
                continue

            dist[bi, fi] = np.inf                   # 자기 자신 제외
            dist[bi, used] = np.inf                 # 이미 사용된 면 제외

            j = int(dist[bi].argmin())
            if dist[bi, j] > tol:
                continue

            used[fi] = True
            used[j] = True

            # 정점 UV 매핑 수집
            for va, vb in zip(faces[fi], faces[j]):
                pairs.append({
                    "source": uvs[va].tolist(),
                    "target": uvs[vb].tolist(),
                })

    print(f"  대칭 UV 쌍: {len(pairs)}개 (대칭 면 {len(pairs)//3}쌍)")
    return pairs


# ─────────────────────────────────────────────
# 5. 이미지 생성
# ─────────────────────────────────────────────

def build_uvmap_image(uv_buf: np.ndarray, coverage: np.ndarray,
                      img_size: int) -> Image.Image:
    """UV 맵 이미지 생성: R=U×255, G=V×255, A=255(유효)/0(무효)."""
    rgba = np.zeros((img_size, img_size, 4), dtype=np.uint8)
    rgba[coverage, 0] = (uv_buf[coverage, 0] * 255).astype(np.uint8)
    rgba[coverage, 1] = (uv_buf[coverage, 1] * 255).astype(np.uint8)
    rgba[coverage, 3] = 255
    return Image.fromarray(rgba, "RGBA")


def build_projection_image(coverage: np.ndarray, verts2d: np.ndarray,
                           faces: np.ndarray, img_size: int) -> Image.Image:
    """
    사용자가 색칠할 투영 이미지 생성.
    - 흰 배경에 연한 회색으로 모델 영역 채움
    - 얇은 파란 와이어프레임으로 삼각형 경계 표시
    """
    img = Image.new("RGBA", (img_size, img_size), (255, 255, 255, 255))
    arr = np.array(img)

    # 모델 영역을 연한 회색으로
    arr[coverage] = [230, 235, 245, 255]
    img = Image.fromarray(arr, "RGBA")

    draw = ImageDraw.Draw(img)

    # 와이어프레임
    v2i = np.clip(verts2d, 0, img_size - 1).astype(int)
    for face in faces:
        pts = [(v2i[face[k], 0], v2i[face[k], 1]) for k in range(3)]
        draw.polygon(pts, outline=(100, 120, 200, 160))

    # 외곽선 강조 (blur된 엣지)
    img = img.filter(ImageFilter.SMOOTH_MORE)
    return img


# ─────────────────────────────────────────────
# 6. CLI 진입점
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="GLB/GLTF → 2D 투영 이미지 + UV 매핑 생성",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("model", help="GLB/GLTF 파일 경로")
    parser.add_argument("--axis", default="front",
                        choices=["front", "side", "top"],
                        help="투영 방향 (기본: front)")
    parser.add_argument("--size", type=int, default=512,
                        help="출력 이미지 크기 px (기본: 512)")
    parser.add_argument("--symmetry", default="yz",
                        choices=["yz", "xz", "xy", "none"],
                        help="대칭 축 (기본: yz = 좌우 대칭)")
    parser.add_argument("--output-dir", default=None,
                        help="출력 디렉토리 (기본: static/models/)")
    args = parser.parse_args()

    if not os.path.exists(args.model):
        print(f"오류: 파일 없음 → {args.model}")
        sys.exit(1)

    # 출력 경로 결정
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    if args.output_dir:
        out_dir = args.output_dir
    else:
        out_dir = os.path.join(project_root, "static", "models")
    os.makedirs(out_dir, exist_ok=True)

    stem = os.path.splitext(os.path.basename(args.model))[0]
    suffix = f"_{args.axis}"

    proj_path   = os.path.join(out_dir, f"{stem}_projection{suffix}.png")
    uvmap_path  = os.path.join(out_dir, f"{stem}_uvmap{suffix}.png")
    json_path   = os.path.join(out_dir, f"{stem}_mapping{suffix}.json")

    # ── 처리 시작 ──
    print(f"\n[1/5] 모델 로드: {args.model}")
    mesh = load_glb(args.model)

    print("[2/5] UV 좌표 추출")
    uvs = extract_uvs(mesh)

    print(f"[3/5] 정점 투영 ({args.axis} 방향)")
    verts2d = project_and_normalize(mesh.vertices, args.axis, args.size)

    print(f"[4/5] 래스터화 ({args.size}×{args.size})")
    uv_buf, coverage = rasterize(verts2d, mesh.faces, uvs, args.size)
    covered_px = coverage.sum()
    print(f"  커버리지: {covered_px:,}픽셀 ({100 * covered_px / args.size**2:.1f}%)")

    print("[5/5] 출력 파일 생성")

    # 투영 이미지 (색칠용 외곽선)
    proj_img = build_projection_image(coverage, verts2d, mesh.faces, args.size)
    proj_img.save(proj_path)
    print(f"  투영 이미지 → {proj_path}")

    # UV 맵 이미지 (R=U, G=V, A=유효)
    uvmap_img = build_uvmap_image(uv_buf, coverage, args.size)
    uvmap_img.save(uvmap_path)
    print(f"  UV 맵 이미지 → {uvmap_path}")

    # 대칭 UV 쌍
    sym_pairs: list[dict] = []
    if args.symmetry != "none":
        sym_pairs = find_symmetric_uv_pairs(mesh, uvs, args.symmetry)

    meta = {
        "model":         os.path.basename(args.model),
        "axis":          args.axis,
        "image_size":    args.size,
        "symmetry_axis": args.symmetry,
        "coverage_px":   int(covered_px),
        "projection_image": os.path.basename(proj_path),
        "uvmap_image":      os.path.basename(uvmap_path),
        "uv_mirror_pairs":  sym_pairs,
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"  매핑 JSON   → {json_path}")

    print("\n완료!")
    print(f"  색칠용 이미지 : {proj_path}")
    print(f"  UV 맵 이미지  : {uvmap_path}")
    print(f"  매핑 규칙     : {json_path}")
    print()
    print("사용 예시 (JS에서 UV 적용):")
    print("  uvMapPath = '/static/models/" + os.path.basename(uvmap_path) + "'")
    print("  mappingPath = '/static/models/" + os.path.basename(json_path) + "'")


if __name__ == "__main__":
    main()
