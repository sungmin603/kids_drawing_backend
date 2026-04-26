import asyncio
from pathlib import Path

from fastapi import HTTPException

from algorithm.glb_projection import run_projection
from core.config import Settings, get_settings
from core.executor import projection_executor
from schemas.models import Axis, ProcessResult
from services.model_service import ModelCatalogService


class ProjectionService:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.catalog = ModelCatalogService(self.settings)

    async def process_model(self, source_path: str, axis: Axis) -> ProcessResult:
        absolute_path = self._resolve_source_path(source_path)
        self._validate_model_file(absolute_path, axis)

        loop = asyncio.get_running_loop()
        try:
            metadata = await loop.run_in_executor(
                projection_executor.instance,
                self._run_projection_sync,
                absolute_path,
                axis,
            )
        except Exception as exc:  # noqa: BLE001 - surface processing failure to the API
            return ProcessResult(status="error", error=str(exc))

        project_name = metadata.get("name", absolute_path.stem)
        project = self.catalog.get_project(project_name, axis=axis)
        return ProcessResult(status="ok", project=project)

    def _resolve_source_path(self, source_path: str) -> Path:
        relative = source_path.lstrip("/").replace("\\", "/")
        public_parts = Path(relative).parts
        if len(public_parts) < 2 or public_parts[0] != "static":
            raise HTTPException(status_code=400, detail="Invalid source path.")

        absolute_path = (self.settings.static_dir / Path(*public_parts[1:])).resolve()

        try:
            absolute_path.relative_to(self.settings.models_dir.resolve())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid source path.") from exc

        return absolute_path

    def _validate_model_file(self, absolute_path: Path, axis: Axis) -> None:
        if not absolute_path.exists():
            raise HTTPException(status_code=400, detail=f"File not found: {absolute_path}")

        if absolute_path.suffix.lower() not in self.settings.allowed_model_extensions:
            raise HTTPException(
                status_code=400,
                detail="Only GLB and GLTF files are supported.",
            )

        if axis not in self.settings.allowed_axes:
            raise HTTPException(
                status_code=400,
                detail="axis must be one of: front, side, top.",
            )

    @staticmethod
    def _run_projection_sync(absolute_path: Path, axis: Axis) -> dict:
        return run_projection(str(absolute_path), axis=axis)
