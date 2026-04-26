from typing import Annotated

from fastapi import APIRouter, Form, Query

from schemas.models import Axis, ModelProject, ModelSource, ProcessResult, ResetResult, SaveResult
from services.model_service import ModelCatalogService
from services.projection_service import ProjectionService


router = APIRouter()
catalog_service = ModelCatalogService()
projection_service = ProjectionService()


@router.get("", response_model=list[ModelProject | ModelSource], summary="List models")
async def list_models() -> list[ModelProject | ModelSource]:
    return catalog_service.list_models()


@router.get("/{name}", response_model=ModelProject, summary="Get processed model")
async def get_model(
    name: str,
    axis: Axis | None = Query(default=None),
) -> ModelProject:
    return catalog_service.get_project(name, axis=axis)


@router.post("/process", response_model=ProcessResult, summary="Process GLB/GLTF model")
async def process_model(
    source_path: Annotated[str, Form(...)],
    axis: Annotated[Axis, Form()] = "front",
) -> ProcessResult:
    return await projection_service.process_model(source_path=source_path, axis=axis)


@router.post("/{name}/save_paint", response_model=SaveResult, summary="Save painted texture")
async def save_paint(
    name: str,
    image: Annotated[str, Form(...)],
    canvas_state: Annotated[str | None, Form()] = None,
    axis: Annotated[Axis, Form()] = "front",
) -> SaveResult:
    return catalog_service.save_paint(
        name=name,
        image_data_url=image,
        canvas_state_data_url=canvas_state,
        axis=axis,
    )


@router.post("/{name}/reset_paint", response_model=ResetResult, summary="Reset painted texture")
async def reset_paint(
    name: str,
    axis: Annotated[Axis, Form()] = "front",
) -> ResetResult:
    return catalog_service.reset_paint(name=name, axis=axis)
