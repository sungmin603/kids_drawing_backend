from fastapi import APIRouter

from routers.models import router as models_router


api_router = APIRouter()
api_router.include_router(models_router, prefix="/models", tags=["models"])
