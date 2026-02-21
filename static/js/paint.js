/**
 * paint.js – 어린이 색칠 놀이 캔버스
 *
 * 도구: 연필 / 버킷 채우기 / 지우개 / 색상 스포이드
 * 기능: 실행취소(Ctrl+Z) / 다시실행(Ctrl+Y) / 팔레트 / 브러시 크기 / 지우기
 *
 * 구조:
 *   bgCanvas   – UV 맵 배경 (읽기 전용)
 *   drawCanvas – 사용자 그림 (픽셀 연산 대상)
 *   두 캔버스를 겹쳐서 표시, 저장 시 합성
 */

import initThree from "./three_loader.js";

// ─── 상수 ────────────────────────────────────────────────────────────────────
const CANVAS_SIZE   = 512;
const MAX_HISTORY   = 20;
const FLOOD_TOLERANCE = 35;   // 버킷 채우기 색 허용 오차 (0–255)

const KID_PALETTE = [
  "#FF0000","#FF6600","#FFCC00","#00CC00",
  "#0066FF","#9900CC","#FF69B4","#FF99AA",
  "#FF8800","#8B4513","#FFFFFF","#000000",
  "#888888","#00CCCC","#FF1493","#7CFC00",
];

// ─── 상태 ────────────────────────────────────────────────────────────────────
const state = {
  tool:      "pencil",   // pencil | fill | eraser | eyedropper
  color:     "#FF0000",
  brushSize: 15,
  opacity:   1.0,
  isDrawing: false,
  lastX: 0,
  lastY: 0,
  history: [],
  historyIndex: -1,
};

// ─── 캔버스 요소 ─────────────────────────────────────────────────────────────
let bgCanvas, bgCtx, drawCanvas, drawCtx;

// ─────────────────────────────────────────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────────────────────────────────────────

function initPaint(uvUrl) {
  bgCanvas   = document.getElementById("bgCanvas");
  drawCanvas = document.getElementById("drawCanvas");
  bgCtx      = bgCanvas.getContext("2d");
  drawCtx    = drawCanvas.getContext("2d");

  bgCanvas.width   = drawCanvas.width   = CANVAS_SIZE;
  bgCanvas.height  = drawCanvas.height  = CANVAS_SIZE;

  // UV 맵 배경 로드
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    bgCtx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
    saveHistory();  // 초기 상태 저장
  };
  img.onerror = () => console.warn("UV 맵 이미지 로드 실패:", uvUrl);
  img.src = uvUrl;

  setupEvents();
  setupUI();
}

// ─────────────────────────────────────────────────────────────────────────────
// 히스토리 (실행취소 / 다시실행)
// ─────────────────────────────────────────────────────────────────────────────

function saveHistory() {
  // 현재 인덱스 이후 히스토리 제거 (redo 스택 삭제)
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(drawCanvas.toDataURL());
  if (state.history.length > MAX_HISTORY) {
    state.history.shift();
  }
  state.historyIndex = state.history.length - 1;
  updateUndoRedoButtons();
}

function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  restoreHistory();
}

function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  restoreHistory();
}

function restoreHistory() {
  const url = state.history[state.historyIndex];
  const img = new Image();
  img.onload = () => {
    drawCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    drawCtx.drawImage(img, 0, 0);
  };
  img.src = url;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  if (undoBtn) undoBtn.disabled = state.historyIndex <= 0;
  if (redoBtn) redoBtn.disabled = state.historyIndex >= state.history.length - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 그리기 (연필 / 지우개)
// ─────────────────────────────────────────────────────────────────────────────

function startDraw(x, y) {
  state.isDrawing = true;
  state.lastX = x;
  state.lastY = y;

  drawCtx.save();
  applyBrushStyle();
  drawCtx.beginPath();
  drawCtx.arc(x, y, state.brushSize / 2, 0, Math.PI * 2);
  drawCtx.fill();
  drawCtx.restore();
}

function continueDraw(x, y) {
  if (!state.isDrawing) return;
  drawCtx.save();
  applyBrushStyle();
  drawCtx.beginPath();
  drawCtx.moveTo(state.lastX, state.lastY);
  drawCtx.lineTo(x, y);
  drawCtx.lineWidth   = state.brushSize;
  drawCtx.lineCap     = "round";
  drawCtx.lineJoin    = "round";
  drawCtx.stroke();
  drawCtx.restore();
  state.lastX = x;
  state.lastY = y;
}

function applyBrushStyle() {
  if (state.tool === "eraser") {
    drawCtx.globalCompositeOperation = "destination-out";
    drawCtx.fillStyle   = "rgba(0,0,0,1)";
    drawCtx.strokeStyle = "rgba(0,0,0,1)";
  } else {
    drawCtx.globalCompositeOperation = "source-over";
    drawCtx.globalAlpha = state.opacity;
    drawCtx.fillStyle   = state.color;
    drawCtx.strokeStyle = state.color;
  }
}

function endDraw() {
  if (!state.isDrawing) return;
  state.isDrawing = false;
  drawCtx.globalCompositeOperation = "source-over";
  drawCtx.globalAlpha = 1.0;
  saveHistory();
}

// ─────────────────────────────────────────────────────────────────────────────
// 버킷 채우기 (Flood Fill)
// ─────────────────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(c => c.toString(16).padStart(2, "0")).join("");
}

function floodFill(startX, startY) {
  startX = Math.floor(startX);
  startY = Math.floor(startY);
  if (startX < 0 || startX >= CANVAS_SIZE || startY < 0 || startY >= CANVAS_SIZE) return;

  // 배경 + 드로잉 레이어를 합성해 경계선 인식
  const composite = document.createElement("canvas");
  composite.width = composite.height = CANVAS_SIZE;
  const cc = composite.getContext("2d");
  cc.drawImage(bgCanvas, 0, 0);
  cc.drawImage(drawCanvas, 0, 0);
  const srcData = cc.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // 드로잉 레이어에만 색칠
  const fillData = drawCtx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const src  = srcData.data;
  const fill = fillData.data;

  const idx0 = (startY * CANVAS_SIZE + startX) * 4;
  const sr = src[idx0], sg = src[idx0 + 1], sb = src[idx0 + 2], sa = src[idx0 + 3];

  const [fr, fg, fb] = hexToRgb(state.color);

  // 이미 같은 색이면 스킵
  if (Math.abs(sr - fr) + Math.abs(sg - fg) + Math.abs(sb - fb) < 6 && sa > 200) return;

  function matchesStart(i) {
    return Math.abs(src[i]     - sr) <= FLOOD_TOLERANCE &&
           Math.abs(src[i + 1] - sg) <= FLOOD_TOLERANCE &&
           Math.abs(src[i + 2] - sb) <= FLOOD_TOLERANCE &&
           Math.abs(src[i + 3] - sa) <= FLOOD_TOLERANCE;
  }

  const visited = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE);
  const stack   = [startX + startY * CANVAS_SIZE];

  while (stack.length > 0) {
    const pos = stack.pop();
    if (visited[pos]) continue;
    visited[pos] = 1;

    const i = pos * 4;
    if (!matchesStart(i)) continue;

    fill[i]     = fr;
    fill[i + 1] = fg;
    fill[i + 2] = fb;
    fill[i + 3] = 255;

    const x = pos % CANVAS_SIZE;
    const y = Math.floor(pos / CANVAS_SIZE);
    if (x > 0)              stack.push(pos - 1);
    if (x < CANVAS_SIZE - 1) stack.push(pos + 1);
    if (y > 0)              stack.push(pos - CANVAS_SIZE);
    if (y < CANVAS_SIZE - 1) stack.push(pos + CANVAS_SIZE);
  }

  drawCtx.putImageData(fillData, 0, 0);
  saveHistory();
}

// ─────────────────────────────────────────────────────────────────────────────
// 스포이드 (색상 추출)
// ─────────────────────────────────────────────────────────────────────────────

function pickColor(x, y) {
  // 합성 캔버스에서 색 추출
  const composite = document.createElement("canvas");
  composite.width = composite.height = CANVAS_SIZE;
  const cc = composite.getContext("2d");
  cc.drawImage(bgCanvas, 0, 0);
  cc.drawImage(drawCanvas, 0, 0);
  const d = cc.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  const hex = rgbToHex(d[0], d[1], d[2]);
  setColor(hex);
  setTool("pencil");
}

// ─────────────────────────────────────────────────────────────────────────────
// UI 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll(".tool-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tool === tool);
  });
  // 커서 변경
  const cursorMap = {
    pencil:     "crosshair",
    fill:       "cell",
    eraser:     "cell",
    eyedropper: "crosshair",
  };
  drawCanvas.style.cursor = cursorMap[tool] || "crosshair";
}

function setColor(hex) {
  state.color = hex;
  const picker = document.getElementById("colorPicker");
  if (picker) picker.value = hex;
  const preview = document.getElementById("colorPreview");
  if (preview) preview.style.backgroundColor = hex;
}

// ─────────────────────────────────────────────────────────────────────────────
// 이벤트 핸들러
// ─────────────────────────────────────────────────────────────────────────────

function getCanvasPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  const scaleX = CANVAS_SIZE / rect.width;
  const scaleY = CANVAS_SIZE / rect.height;
  let cx, cy;
  if (e.touches && e.touches.length > 0) {
    cx = (e.touches[0].clientX - rect.left) * scaleX;
    cy = (e.touches[0].clientY - rect.top)  * scaleY;
  } else {
    cx = (e.clientX - rect.left) * scaleX;
    cy = (e.clientY - rect.top)  * scaleY;
  }
  return { x: cx, y: cy };
}

function onPointerDown(e) {
  e.preventDefault();
  const { x, y } = getCanvasPos(e);

  if (state.tool === "pencil" || state.tool === "eraser") {
    startDraw(x, y);
  } else if (state.tool === "fill") {
    floodFill(x, y);
  } else if (state.tool === "eyedropper") {
    pickColor(x, y);
  }
}

function onPointerMove(e) {
  e.preventDefault();
  if (state.tool === "pencil" || state.tool === "eraser") {
    const { x, y } = getCanvasPos(e);
    continueDraw(x, y);
  }
}

function onPointerUp(e) {
  endDraw();
}

function onKeyDown(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  if (ctrl && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
}

function setupEvents() {
  // 마우스
  drawCanvas.addEventListener("mousedown",  onPointerDown);
  drawCanvas.addEventListener("mousemove",  onPointerMove);
  drawCanvas.addEventListener("mouseup",    onPointerUp);
  drawCanvas.addEventListener("mouseleave", onPointerUp);

  // 터치
  drawCanvas.addEventListener("touchstart", onPointerDown, { passive: false });
  drawCanvas.addEventListener("touchmove",  onPointerMove, { passive: false });
  drawCanvas.addEventListener("touchend",   onPointerUp);

  // 키보드
  document.addEventListener("keydown", onKeyDown);
}

// ─────────────────────────────────────────────────────────────────────────────
// UI 컨트롤 연결
// ─────────────────────────────────────────────────────────────────────────────

function buildPalette() {
  const paletteEl = document.getElementById("palette");
  if (!paletteEl) return;
  paletteEl.innerHTML = "";
  KID_PALETTE.forEach(hex => {
    const swatch = document.createElement("button");
    swatch.className = "swatch";
    swatch.style.backgroundColor = hex;
    swatch.title = hex;
    swatch.addEventListener("click", () => {
      setColor(hex);
      setTool("pencil");
    });
    paletteEl.appendChild(swatch);
  });
}

function setupUI() {
  buildPalette();

  // 도구 버튼
  document.querySelectorAll(".tool-btn").forEach(btn => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  });

  // 색상 피커
  const colorPicker = document.getElementById("colorPicker");
  if (colorPicker) {
    colorPicker.addEventListener("input", e => setColor(e.target.value));
  }

  // 브러시 크기
  const brushSlider = document.getElementById("brushSize");
  const brushLabel  = document.getElementById("brushSizeLabel");
  if (brushSlider) {
    brushSlider.value = state.brushSize;
    brushSlider.addEventListener("input", e => {
      state.brushSize = parseInt(e.target.value);
      if (brushLabel) brushLabel.textContent = state.brushSize + "px";
    });
  }

  // 불투명도
  const opacitySlider = document.getElementById("opacity");
  const opacityLabel  = document.getElementById("opacityLabel");
  if (opacitySlider) {
    opacitySlider.value = 100;
    opacitySlider.addEventListener("input", e => {
      state.opacity = parseInt(e.target.value) / 100;
      if (opacityLabel) opacityLabel.textContent = e.target.value + "%";
    });
  }

  // 실행취소 / 다시실행
  document.getElementById("undoBtn")?.addEventListener("click", undo);
  document.getElementById("redoBtn")?.addEventListener("click", redo);

  // 전체 지우기
  document.getElementById("clearBtn")?.addEventListener("click", () => {
    if (!confirm("그림을 모두 지울까요?")) return;
    drawCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    saveHistory();
  });

  // 저장 & 3D 텍스처 반영
  document.getElementById("saveBtn")?.addEventListener("click", async () => {
    // bgCanvas + drawCanvas 합성
    const composite = document.createElement("canvas");
    composite.width = composite.height = CANVAS_SIZE;
    const cc = composite.getContext("2d");
    cc.drawImage(bgCanvas, 0, 0);
    cc.drawImage(drawCanvas, 0, 0);

    const dataURL = composite.toDataURL("image/png");
    const formData = new FormData();
    formData.append("image", dataURL);

    const saveBtn = document.getElementById("saveBtn");
    saveBtn.textContent = "저장 중...";
    saveBtn.disabled = true;

    try {
      const res = await fetch("/save_paint", { method: "POST", body: formData });
      if (res.ok) {
        // 3D 뷰 갱신 (캐시 무효화용 타임스탬프 쿼리)
        const ts = Date.now();
        initThree(`/static/models/Lamborginhi Aventador_diffuse.jpg?t=${ts}`);
        showToast("저장 완료! 3D 텍스처가 업데이트됐어요 🎨");
      } else {
        showToast("저장에 실패했어요. 다시 시도해주세요.", true);
      }
    } catch (err) {
      showToast("네트워크 오류가 발생했어요.", true);
    } finally {
      saveBtn.textContent = "저장 & 3D 반영";
      saveBtn.disabled = false;
    }
  });

  // 초기 도구 설정
  setTool("pencil");
  setColor(state.color);
  updateUndoRedoButtons();
}

// ─────────────────────────────────────────────────────────────────────────────
// 토스트 알림
// ─────────────────────────────────────────────────────────────────────────────

function showToast(msg, isError = false) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = "toast" + (isError ? " toast-error" : "");
  toast.style.opacity = "1";
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => { toast.style.opacity = "0"; }, 2500);
}

// ─────────────────────────────────────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initPaint("/static/models/Lamborginhi Aventador_diffuse_origin.jpg");
  initThree("/static/models/Lamborginhi Aventador_diffuse.jpg");
});
