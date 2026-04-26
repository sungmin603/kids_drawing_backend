from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    base_dir: Path
    static_dir: Path
    templates_dir: Path
    models_dir: Path
    static_url: str = "/static"
    api_prefix: str = "/api"
    projection_workers: int = 2
    default_image_size: int = 512
    allowed_axes: tuple[str, ...] = ("front", "side", "top")
    allowed_model_extensions: tuple[str, ...] = (".glb", ".gltf")


@lru_cache
def get_settings() -> Settings:
    base_dir = Path(__file__).resolve().parents[1]
    static_dir = base_dir / "algorithm"
    return Settings(
        base_dir=base_dir,
        static_dir=static_dir,
        templates_dir=base_dir / "templates",
        models_dir=static_dir / "target_models",
    )
