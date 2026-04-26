from concurrent.futures import ThreadPoolExecutor

from core.config import get_settings


class ProjectionExecutor:
    def __init__(self, max_workers: int) -> None:
        self._executor = ThreadPoolExecutor(max_workers=max_workers)

    @property
    def instance(self) -> ThreadPoolExecutor:
        return self._executor

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)


projection_executor = ProjectionExecutor(
    max_workers=get_settings().projection_workers
)
