import initThree from "./three_loader.js";

async function fetchSelectedProject() {
  const modelSelect = document.getElementById("modelSelect");
  const axisSelect = document.getElementById("axisSelect");
  const name = modelSelect?.value;
  const axis = axisSelect?.value || "front";

  if (!name) return null;

  const response = await fetch(
    `/api/models/${encodeURIComponent(name)}?axis=${encodeURIComponent(axis)}`
  );
  if (!response.ok) return null;
  return response.json();
}

function clearLoadedDrawing() {
  const drawCanvas = document.getElementById("drawCanvas");
  if (!drawCanvas) return;
  const ctx = drawCanvas.getContext("2d");
  ctx?.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
}

async function applyPureProjectionView() {
  const project = await fetchSelectedProject();
  if (!project) return false;

  clearLoadedDrawing();
  initThree(project.model_path, null);
  return true;
}

async function resetSavedPaint() {
  const modelSelect = document.getElementById("modelSelect");
  const axisSelect = document.getElementById("axisSelect");
  const name = modelSelect?.value;
  const axis = axisSelect?.value || "front";

  if (!name) return false;

  const formData = new FormData();
  formData.append("axis", axis);
  const response = await fetch(
    `/api/models/${encodeURIComponent(name)}/reset_paint`,
    { method: "POST", body: formData }
  );
  return response.ok;
}

function isProjectVisible() {
  const wrapper = document.getElementById("canvasWrapper");
  return wrapper && wrapper.style.display !== "none";
}

function schedulePureProjectionView({ retries = 10, delay = 400 } = {}) {
  let attempts = 0;

  const tick = async () => {
    attempts += 1;
    if (!isProjectVisible()) {
      if (attempts < retries) {
        window.setTimeout(tick, delay);
      }
      return;
    }

    const resetOk = await resetSavedPaint();
    const applied = resetOk ? await applyPureProjectionView() : false;
    if (!applied && attempts < retries) {
      window.setTimeout(tick, delay);
      return;
    }

    if (applied) {
      window.setTimeout(clearLoadedDrawing, 120);
      window.setTimeout(clearLoadedDrawing, 300);
    }
  };

  window.setTimeout(tick, delay);
}

function bindProjectionResetButtons() {
  document.getElementById("loadBtn")?.addEventListener("click", () => {
    schedulePureProjectionView({ retries: 6, delay: 250 });
  });

  document.getElementById("processBtn")?.addEventListener("click", () => {
    schedulePureProjectionView({ retries: 40, delay: 500 });
  });
}

document.addEventListener("DOMContentLoaded", bindProjectionResetButtons);
