import base64
import json
import re
import time
from io import BytesIO
from pathlib import Path

from fastapi import HTTPException
from PIL import Image

from core.config import Settings, get_settings
from schemas.models import ModelProject, ModelSource, ResetResult, SaveResult


class ModelCatalogService:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    def list_processed_projects(self) -> list[ModelProject]:
        projects: list[ModelProject] = []
        if not self.settings.models_dir.exists():
            return projects

        for directory in sorted(self.settings.models_dir.iterdir()):
            if not directory.is_dir():
                continue

            project = self._build_project(directory)
            if project is not None:
                projects.append(project)

        return projects

    def list_source_models(self, processed_names: set[str]) -> list[ModelSource]:
        sources: list[ModelSource] = []
        if not self.settings.models_dir.exists():
            return sources

        for model_file in sorted(self.settings.models_dir.iterdir()):
            if model_file.suffix.lower() not in self.settings.allowed_model_extensions:
                continue
            if model_file.stem in processed_names:
                continue

            sources.append(
                ModelSource(
                    name=model_file.stem,
                    source_path=f"{self.settings.static_url}/target_models/{model_file.name}",
                    ext=model_file.suffix.lower(),
                )
            )

        return sources

    def list_models(self) -> list[ModelProject | ModelSource]:
        processed = self.list_processed_projects()
        processed_names = {project.name for project in processed}
        return [*processed, *self.list_source_models(processed_names)]

    def get_project(self, name: str, axis: str | None = None) -> ModelProject:
        directory = self.settings.models_dir / name
        if not directory.exists() or not directory.is_dir():
            raise HTTPException(status_code=404, detail=f"Project not found: {name}")

        project = self._build_project(directory, axis=axis)
        if project is None:
            if axis:
                raise HTTPException(
                    status_code=404,
                    detail=f"Project not found for axis '{axis}': {name}",
                )
            raise HTTPException(status_code=404, detail=f"Project not found: {name}")
        return project

    def save_paint(
        self,
        name: str,
        image_data_url: str,
        canvas_state_data_url: str | None,
        axis: str,
    ) -> SaveResult:
        project_dir = self.settings.models_dir / name
        if not project_dir.exists():
            raise HTTPException(status_code=404, detail=f"Project not found: {name}")

        painted_filename = f"painted_{axis}.png"
        canvas_state_filename = f"canvas_state_{axis}.png"
        base_texture_path = project_dir / "diffuse_origin.png"

        self._decode_and_save(
            project_dir,
            image_data_url,
            painted_filename,
            expand_edges=True,
            base_texture_path=base_texture_path if base_texture_path.exists() else None,
        )
        if canvas_state_data_url:
            self._decode_and_save(project_dir, canvas_state_data_url, canvas_state_filename)

        timestamp = int(time.time())
        return SaveResult(
            status="ok",
            painted_url=(
                f"{self.settings.static_url}/models/{name}/{painted_filename}?t={timestamp}"
            ),
            timestamp=timestamp,
        )

    def reset_paint(self, name: str, axis: str) -> ResetResult:
        project_dir = self.settings.models_dir / name
        if not project_dir.exists():
            raise HTTPException(status_code=404, detail=f"Project not found: {name}")

        for filename in (f"painted_{axis}.png", f"canvas_state_{axis}.png"):
            target = project_dir / filename
            if target.exists():
                target.unlink()

        return ResetResult(status="ok", timestamp=int(time.time()))

    @staticmethod
    def _decode_and_save(
        project_dir: Path,
        data_url: str,
        filename: str,
        expand_edges: bool = False,
        base_texture_path: Path | None = None,
    ) -> None:
        raw = re.sub(r"^data:image/\w+;base64,", "", data_url)
        try:
            decoded = base64.b64decode(raw)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid image payload.") from exc
        target = project_dir / filename
        if expand_edges:
            decoded = ModelCatalogService._expand_painted_texture_edges(
                decoded,
                base_texture_path=base_texture_path,
            )
        target.write_bytes(decoded)

    @staticmethod
    def _expand_painted_texture_edges(
        image_bytes: bytes,
        base_texture_path: Path | None = None,
    ) -> bytes:
        image = Image.open(BytesIO(image_bytes)).convert("RGBA")
        width, height = image.size

        if base_texture_path is not None and base_texture_path.exists():
            base_image = Image.open(base_texture_path).convert("RGBA").resize((width, height))
        else:
            base_image = image.copy()

        src = image.load()
        base = base_image.load()
        expanded = image.copy()
        dst = expanded.load()

        changed_mask = [
            [src[x, y] != base[x, y] for x in range(width)]
            for y in range(height)
        ]

        # Expand the actually changed texels outward more aggressively so triangle
        # boundaries do not reveal the original base texture as visible mesh/grid lines.
        expansion_passes = 4
        neighbor_radius = 2

        for _ in range(expansion_passes):
            current = expanded.copy()
            current_px = current.load()
            next_mask = [row[:] for row in changed_mask]

            for y in range(height):
                for x in range(width):
                    if changed_mask[y][x]:
                        continue

                    changed_neighbors: list[tuple[int, int, int, int]] = []
                    for dy in range(-neighbor_radius, neighbor_radius + 1):
                        for dx in range(-neighbor_radius, neighbor_radius + 1):
                            if dx == 0 and dy == 0:
                                continue
                            nx = x + dx
                            ny = y + dy
                            if nx < 0 or ny < 0 or nx >= width or ny >= height:
                                continue
                            if changed_mask[ny][nx]:
                                changed_neighbors.append(current_px[nx, ny])

                    if not changed_neighbors:
                        continue

                    dominant = max(set(changed_neighbors), key=changed_neighbors.count)
                    dst[x, y] = dominant
                    next_mask[y][x] = True

            changed_mask = next_mask

        output = BytesIO()
        expanded.save(output, format="PNG")
        return output.getvalue()

    def _build_project(
        self,
        directory: Path,
        axis: str | None = None,
    ) -> ModelProject | None:
        metadata = self._load_metadata(directory, axis=axis)
        if metadata is None:
            return None

        base_url = f"{self.settings.static_url}/target_models/{directory.name}"
        axis_name = metadata.get("axis", "front")
        painted_filename = f"painted_{axis_name}.png"
        canvas_state_filename = f"canvas_state_{axis_name}.png"
        painted_path = directory / painted_filename
        canvas_state_path = directory / canvas_state_filename
        return ModelProject(
            name=directory.name,
            axis=axis_name,
            symmetry_axis=metadata.get("symmetry_axis"),
            image_size=metadata.get("image_size", self.settings.default_image_size),
            texture_size=metadata.get(
                "texture_size",
                metadata.get("image_size", self.settings.default_image_size),
            ),
            model_path=f"{base_url}/{metadata.get('model_file', '')}",
            projection_image=f"{base_url}/{metadata.get('projection_image', '')}",
            reference_image=(
                f"{base_url}/{metadata['reference_image']}"
                if metadata.get("reference_image")
                else None
            ),
            projmap_image=(
                f"{base_url}/"
                f"{metadata.get('projmap_image') or metadata.get('uvmap_image', '')}"
            ),
            projection_mapping_data=(
                f"{base_url}/{metadata['projection_mapping_data']}"
                if metadata.get("projection_mapping_data")
                else None
            ),
            diffuse_texture_image=(
                f"{base_url}/{metadata['diffuse_texture_image']}"
                if metadata.get("diffuse_texture_image")
                else None
            ),
            painted_url=f"{base_url}/{painted_filename}" if painted_path.exists() else None,
            canvas_state_url=(
                f"{base_url}/{canvas_state_filename}" if canvas_state_path.exists() else None
            ),
            uv_mirror_pairs=metadata.get("uv_mirror_pairs", []),
        )

    @staticmethod
    def _load_metadata(directory: Path, axis: str | None = None) -> dict | None:
        if axis:
            metadata_files = [directory / f"mapping_{axis}.json"]
        else:
            preferred = directory / "mapping_front.json"
            metadata_files = [preferred] if preferred.exists() else sorted(directory.glob("mapping_*.json"))

        for metadata_file in metadata_files:
            if not metadata_file.exists():
                continue
            try:
                return json.loads(metadata_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
        return None
