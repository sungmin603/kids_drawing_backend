import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from core.config import get_settings
from core.executor import projection_executor
from routers.api_router import api_router
from routers.pages import router as pages_router


def create_app() -> FastAPI:
    settings = get_settings()

    application = FastAPI(
        title="Kids Drawing Projection API",
        description="2D projection coloring workflow for 3D models.",
        version="3.0.0",
    )

    application.mount(
        settings.static_url,
        StaticFiles(directory=str(settings.static_dir)),
        name="static",
    )
    application.state.templates = Jinja2Templates(directory=str(settings.templates_dir))

    application.include_router(pages_router)
    application.include_router(api_router, prefix=settings.api_prefix)

    @application.on_event("shutdown")
    def shutdown_event() -> None:
        projection_executor.shutdown()

    return application


app = create_app()


if __name__ == "__main__":
    import uvicorn

    reload_enabled = os.getenv("UVICORN_RELOAD", "").lower() in {"1", "true", "yes"}
    uvicorn.run(app, host="127.0.0.1", port=8000, reload=reload_enabled)
    # uvicorn main:app --reload
