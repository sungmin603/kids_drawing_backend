from typing import Literal

from pydantic import BaseModel, Field


Axis = Literal["front", "side", "top"]


class ModelProject(BaseModel):
    name: str
    processed: bool = True
    axis: Axis
    symmetry_axis: str | None = None
    image_size: int
    texture_size: int
    model_path: str
    projection_image: str
    reference_image: str | None = None
    projmap_image: str
    projection_mapping_data: str | None = None
    diffuse_texture_image: str | None = None
    painted_url: str | None = None
    canvas_state_url: str | None = None
    uv_mirror_pairs: list[dict] = Field(default_factory=list)


class ModelSource(BaseModel):
    name: str
    processed: bool = False
    source_path: str
    ext: str


class ProcessResult(BaseModel):
    status: str
    project: ModelProject | None = None
    error: str | None = None


class SaveResult(BaseModel):
    status: str
    painted_url: str
    timestamp: int


class ResetResult(BaseModel):
    status: str
    timestamp: int
