/**
 * paint.js – 어린이 색칠 놀이 (모델 선택 + UV 리매핑 + 저장)
 *
 * 흐름:
 *  1. /api/models → 모델 목록 로드
 *  2. 모델 선택 → 미처리면 "처리" 버튼, 처리됐으면 "로드" 버튼
 *  3. 로드 → projection.png 배경 + drawCanvas 활성화
 *  4. 칠하기 (연필/채우기/지우개/스포이드)
 *  5. 저장 → uvmap.png로 투영 픽셀 → UV 좌표 변환 → diffuse_painted.png 생성
 *             → 대칭 UV 쌍 적용 → /api/models/{name}/save_paint POST
 *  6. 3D 뷰 갱신
 */

import initThree from "./three_loader.js";

// ─── 상수 ──────────────────────────────────────────────────────────────────
const DEFAULT_CANVAS_SIZE = 512;
const DEFAULT_TEX_SIZE    = 512;
const MAX_HISTORY    = 20;
const FLOOD_TOL      = 35;    // 버킷 채우기 허용 오차

const KID_PALETTE = [
  "#FF0000","#FF6600","#FFCC00","#00CC00",
  "#0066FF","#9900CC","#FF69B4","#FF99AA",
  "#FF8800","#8B4513","#FFFFFF","#000000",
  "#888888","#00CCCC","#FF1493","#7CFC00",
];

// ─── 앱 상태 ───────────────────────────────────────────────────────────────
const state = {
  // 그리기
  tool:      "pencil",
  color:     "#FF0000",
  brushSize: 15,
  opacity:   1.0,
  isDrawing: false,
  lastX: 0,
  lastY: 0,
  history:      [],
  historyIndex: -1,

  // 현재 프로젝트
  project: null,          // ModelProject 객체
  uvMapImg: null,         // HTMLImageElement (projmap png)
  baseTextureImg: null,   // HTMLImageElement (diffuse texture)
  projectionMapping: null,
  coverageMask: null,     // OffscreenCanvas: 모델 커버리지 마스크 (모델 외부 페인트 방지)
  currentTab: "draw",     // "draw" | "ref"
  canvasSize: DEFAULT_CANVAS_SIZE,
  textureSize: DEFAULT_TEX_SIZE,
};

function deriveAxisAssetUrl(project, prefix) {
  if (!project?.projmap_image) return null;
  return project.projmap_image.replace(/projmap_([^/]+)\.png$/, `${prefix}_$1.png`);
}

// ─── DOM 요소 ──────────────────────────────────────────────────────────────
let bgCanvas, bgCtx, drawCanvas, drawCtx, refCanvas, refCtx;

// ─────────────────────────────────────────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  bgCanvas   = document.getElementById("bgCanvas");
  drawCanvas = document.getElementById("drawCanvas");
  refCanvas  = document.getElementById("refCanvas");
  bgCtx      = bgCanvas.getContext("2d");
  drawCtx    = drawCanvas.getContext("2d");
  refCtx     = refCanvas.getContext("2d");

  resizeWorkspace(DEFAULT_CANVAS_SIZE);

  setupDrawEvents();
  setupUI();
  await loadModelList();
}

function resizeWorkspace(size) {
  state.canvasSize = size;
  [bgCanvas, drawCanvas, refCanvas].forEach(c => {
    c.width = size;
    c.height = size;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 모델 목록 & 선택
// ─────────────────────────────────────────────────────────────────────────────

async function loadModelList() {
  const sel = document.getElementById("modelSelect");
  try {
    const models = await fetch("/api/models").then(r => r.json());
    sel.innerHTML = '<option value="">— 모델을 선택하세요 —</option>';
    models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.dataset.processed = m.processed ? "1" : "0";
      opt.textContent = m.processed
        ? `✅ ${m.name}  (${m.axis || ""})`
        : `⚙ ${m.name}  (미처리)`;
      sel.appendChild(opt);
    });
  } catch (e) {
    console.error("모델 목록 로드 실패:", e);
    setStatus("모델 목록 조회 실패", true);
  }
}

function getSelectedModelInfo() {
  const sel = document.getElementById("modelSelect");
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return null;
  return { name: opt.value, processed: opt.dataset.processed === "1" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 투영 처리 (process)
// ─────────────────────────────────────────────────────────────────────────────

async function processModel() {
  const info = getSelectedModelInfo();
  if (!info) return showToast("모델을 선택하세요.", true);

  const axis = document.getElementById("axisSelect").value;
  const btn  = document.getElementById("processBtn");
  btn.disabled = true;
  setStatus(`처리 중 (${axis})…`);

  // 소스 경로 결정:
  //   미처리 모델 → source_path (원본 위치)
  //   처리된 모델 → model_path  (서브디렉토리 내 복사본)
  const models = await fetch("/api/models").then(r => r.json());
  const src = models.find(m => m.name === info.name);
  const sourcePath = src?.source_path || src?.model_path;
  if (!sourcePath) {
    setStatus("소스 경로를 찾을 수 없습니다.", true);
    btn.disabled = false;
    return;
  }

  try {
    const fd = new FormData();
    fd.append("source_path", sourcePath);
    fd.append("axis", axis);
    const res = await fetch("/api/models/process", { method: "POST", body: fd });
    const data = await res.json();

    if (data.status === "ok") {
      setStatus("처리 완료!", false);
      await loadModelList();
      // 자동으로 해당 모델 선택
      document.getElementById("modelSelect").value = info.name;
      await loadProject();
      showToast(`✅ ${info.name} ${axis} 처리 완료! 해당 축 결과를 불러왔어요.`);
    } else {
      setStatus("처리 실패: " + (data.error || ""), true);
    }
  } catch (e) {
    setStatus("네트워크 오류", true);
  } finally {
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 모델 로드 (load)
// ─────────────────────────────────────────────────────────────────────────────

async function loadProject() {
  const info = getSelectedModelInfo();
  if (!info) return showToast("모델을 선택하세요.", true);
  if (!info.processed) return showToast("먼저 '처리' 버튼을 눌러주세요.", true);

  setStatus("로딩 중…");
  try {
    const axis = document.getElementById("axisSelect").value;
    const project = await fetch(`/api/models/${encodeURIComponent(info.name)}?axis=${encodeURIComponent(axis)}`).then(r => r.json());
    state.project = project;
    state.textureSize = project.texture_size || project.image_size || DEFAULT_TEX_SIZE;
    resizeWorkspace(project.image_size || DEFAULT_CANVAS_SIZE);

    // projmap 이미지 프리로드 (프로젝션 픽셀 → UV 텍스처 픽셀 10비트 매핑)
    state.uvMapImg = await loadImage(project.projmap_image + "?t=" + Date.now());
    state.baseTextureImg = project.diffuse_texture_image
      ? await loadImage(project.diffuse_texture_image + "?t=" + Date.now())
      : null;
    state.projectionMapping = project.projection_mapping_data
      ? await fetch(project.projection_mapping_data + "?t=" + Date.now()).then(r => r.json())
      : null;

    // 커버리지 마스크 생성 (projmap alpha > 0 인 영역 = 모델 내부)
    const maskOff = document.createElement("canvas");
    maskOff.width = maskOff.height = state.canvasSize;
    const maskOffCtx = maskOff.getContext("2d");
    maskOffCtx.drawImage(state.uvMapImg, 0, 0, state.canvasSize, state.canvasSize);
    const uvPx = maskOffCtx.getImageData(0, 0, state.canvasSize, state.canvasSize);
    for (let i = 0; i < uvPx.data.length; i += 4) {
      const covered = uvPx.data[i + 3] > 128;
      uvPx.data[i] = uvPx.data[i + 1] = uvPx.data[i + 2] = 255;
      uvPx.data[i + 3] = covered ? 255 : 0;
    }
    maskOffCtx.putImageData(uvPx, 0, 0);
    state.coverageMask = maskOff;

    // 기본 색칠 배경은 더 깔끔한 diffuse projection을 우선 사용
    const bgUrl =
      project.reference_image ||
      deriveAxisAssetUrl(project, "projection_diffuse") ||
      project.projection_image;
    const bgImg = await loadImage(bgUrl + "?t=" + Date.now());
    bgCtx.clearRect(0, 0, state.canvasSize, state.canvasSize);
    bgCtx.drawImage(bgImg, 0, 0, state.canvasSize, state.canvasSize);

    // 참고 레이어는 와이어프레임 projection을 사용
    refCtx.clearRect(0, 0, state.canvasSize, state.canvasSize);
    const refUrl =
      project.projection_image ||
      deriveAxisAssetUrl(project, "projection") ||
      project.reference_image;
    const refImg = await loadImage(refUrl + "?t=" + Date.now());
    refCtx.drawImage(refImg, 0, 0, state.canvasSize, state.canvasSize);

    // 저장된 캔버스 상태 복원 (축별 파일만 사용)
    drawCtx.clearRect(0, 0, state.canvasSize, state.canvasSize);
    if (project.canvas_state_url) {
      try {
        const stateImg = await loadImage(project.canvas_state_url + "?t=" + Date.now());
        drawCtx.drawImage(stateImg, 0, 0, state.canvasSize, state.canvasSize);
      } catch (_) { /* canvas_state 없으면 무시 */ }
    }

    // UI 전환
    document.getElementById("placeholder").style.display  = "none";
    document.getElementById("canvasWrapper").style.display = "block";

    // 3D 뷰 갱신 (painted.png 있으면 적용, 없으면 GLB 내장 텍스처 사용)
    const texUrl = project.painted_url ? project.painted_url + "?t=" + Date.now() : null;
    initThree(project.model_path, texUrl);

    state.history = [];
    state.historyIndex = -1;
    saveHistory();

    const showRef = state.currentTab === "ref";
    refCanvas.style.opacity = showRef ? "1" : "0";
    drawCanvas.style.opacity = showRef ? "0" : "1";
    drawCanvas.style.pointerEvents = showRef ? "none" : "auto";

    setStatus(`로드 완료: ${project.name}`, false);
    showToast(`🎨 ${project.name} 로드 완료! 색칠해보세요.`);
  } catch (e) {
    console.error(e);
    setStatus("로드 실패: " + e.message, true);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error("이미지 로드 실패: " + url));
    img.src = url;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 히스토리 (실행취소/다시실행)
// ─────────────────────────────────────────────────────────────────────────────

function saveHistory() {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(drawCanvas.toDataURL());
  if (state.history.length > MAX_HISTORY) state.history.shift();
  state.historyIndex = state.history.length - 1;
  updateHistoryBtns();
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
  const img = new Image();
  img.onload = () => {
    drawCtx.clearRect(0, 0, state.canvasSize, state.canvasSize);
    drawCtx.drawImage(img, 0, 0);
  };
  img.src = state.history[state.historyIndex];
  updateHistoryBtns();
}

function updateHistoryBtns() {
  const u = document.getElementById("undoBtn");
  const r = document.getElementById("redoBtn");
  if (u) u.disabled = state.historyIndex <= 0;
  if (r) r.disabled = state.historyIndex >= state.history.length - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 그리기 도구
// ─────────────────────────────────────────────────────────────────────────────

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

function startDraw(x, y) {
  state.isDrawing = true;
  state.lastX = x; state.lastY = y;
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
  drawCtx.lineWidth  = state.brushSize;
  drawCtx.lineCap    = "round";
  drawCtx.lineJoin   = "round";
  drawCtx.stroke();
  drawCtx.restore();
  state.lastX = x; state.lastY = y;
}

function endDraw() {
  if (!state.isDrawing) return;
  state.isDrawing = false;
  drawCtx.globalCompositeOperation = "source-over";
  drawCtx.globalAlpha = 1.0;
  // 모델 외부 영역 지우기 (커버리지 마스크 적용)
  applyMask();
  saveHistory();
}

function applyMask() {
  if (!state.coverageMask) return;
  drawCtx.save();
  drawCtx.globalCompositeOperation = "destination-in";
  drawCtx.drawImage(state.coverageMask, 0, 0, state.canvasSize, state.canvasSize);
  drawCtx.restore();
}

// ─── 버킷 채우기 ───────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(c => c.toString(16).padStart(2, "0")).join("");
}

function floodFill(startX, startY) {
  startX = Math.floor(startX); startY = Math.floor(startY);
  if (startX < 0 || startX >= state.canvasSize || startY < 0 || startY >= state.canvasSize) return;

  // 배경 + 드로잉 합성 → 경계선 인식
  const comp = document.createElement("canvas");
  comp.width = comp.height = state.canvasSize;
  const cc = comp.getContext("2d");
  cc.drawImage(bgCanvas, 0, 0);
  cc.drawImage(drawCanvas, 0, 0);
  const src = cc.getImageData(0, 0, state.canvasSize, state.canvasSize).data;

  const fillData = drawCtx.getImageData(0, 0, state.canvasSize, state.canvasSize);
  const fill = fillData.data;

  const i0 = (startY * state.canvasSize + startX) * 4;
  const [sr, sg, sb, sa] = [src[i0], src[i0+1], src[i0+2], src[i0+3]];
  const [fr, fg, fb] = hexToRgb(state.color);

  if (Math.abs(sr-fr)+Math.abs(sg-fg)+Math.abs(sb-fb) < 6 && sa > 200) return;

  const matches = i => (
    Math.abs(src[i]   - sr) <= FLOOD_TOL &&
    Math.abs(src[i+1] - sg) <= FLOOD_TOL &&
    Math.abs(src[i+2] - sb) <= FLOOD_TOL &&
    Math.abs(src[i+3] - sa) <= FLOOD_TOL
  );

  const visited = new Uint8Array(state.canvasSize * state.canvasSize);
  const stack = [startX + startY * state.canvasSize];

  while (stack.length > 0) {
    const pos = stack.pop();
    if (visited[pos]) continue;
    visited[pos] = 1;
    const i = pos * 4;
    if (!matches(i)) continue;
    fill[i] = fr; fill[i+1] = fg; fill[i+2] = fb; fill[i+3] = 255;
    const x = pos % state.canvasSize, y = Math.floor(pos / state.canvasSize);
    if (x > 0)              stack.push(pos - 1);
    if (x < state.canvasSize - 1) stack.push(pos + 1);
    if (y > 0)              stack.push(pos - state.canvasSize);
    if (y < state.canvasSize - 1) stack.push(pos + state.canvasSize);
  }
  drawCtx.putImageData(fillData, 0, 0);
  applyMask();
  saveHistory();
}

// ─── 스포이드 ──────────────────────────────────────────────────────────────
function pickColor(x, y) {
  const comp = document.createElement("canvas");
  comp.width = comp.height = state.canvasSize;
  const cc = comp.getContext("2d");
  cc.drawImage(bgCanvas, 0, 0); cc.drawImage(drawCanvas, 0, 0);
  const d = cc.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  setColor(rgbToHex(d[0], d[1], d[2]));
  setTool("pencil");
}

// ─────────────────────────────────────────────────────────────────────────────
// UV 리매핑 → 텍스처 생성
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 투영 캔버스에서 칠한 픽셀을 UV 텍스처로 변환합니다.
 *
 * projmap 이미지 인코딩 (proj_size/tex_size ≤ 512):
 *   R = tx >> 1, G = ty >> 1, B = (tx&1)<<7 | (ty&1)<<6, A = 255(유효)
 *
 * 디코딩:
 *   tx = (R << 1) | ((B >> 7) & 1)
 *   ty = (G << 1) | ((B >> 6) & 1)
 *
 * 기존 8비트 UV 정규화 대신 10비트 정수 텍스처 좌표를 사용해
 * 양자화 갭(~2px)을 완전히 제거합니다.
 */
function remapToTexture() {
  const { project, uvMapImg, baseTextureImg, projectionMapping } = state;
  if (!project || !uvMapImg) return null;

  // projmap 픽셀 읽기 (canvasSize × canvasSize, 10비트 텍스처 좌표 인코딩)
  const pmOff = document.createElement("canvas");
  pmOff.width = pmOff.height = state.canvasSize;
  const pmCtx = pmOff.getContext("2d");
  pmCtx.drawImage(uvMapImg, 0, 0, state.canvasSize, state.canvasSize);
  const pmData = pmCtx.getImageData(0, 0, state.canvasSize, state.canvasSize).data;

  // 칠한 픽셀 (drawCanvas)
  const paintData = drawCtx.getImageData(0, 0, state.canvasSize, state.canvasSize).data;

  // 출력 텍스처: 원본 diffuse 기준으로 덧칠
  const texOff = document.createElement("canvas");
  texOff.width = texOff.height = state.textureSize;
  const texCtx = texOff.getContext("2d");
  if (baseTextureImg) {
    texCtx.drawImage(baseTextureImg, 0, 0, state.textureSize, state.textureSize);
  } else {
    texCtx.fillStyle = "#ffffff";
    texCtx.fillRect(0, 0, state.textureSize, state.textureSize);
  }

  const texImg = texCtx.getImageData(0, 0, state.textureSize, state.textureSize);
  const basePixels = new Uint8ClampedArray(texImg.data);
  const tex = texImg.data;

  if (projectionMapping?.pixels?.length) {
    for (const entry of projectionMapping.pixels) {
      const pixelIndex = entry.pixel;
      const pmIdx = pixelIndex * 4;
      if (paintData[pmIdx + 3] < 10) continue;

      for (const [tx, ty] of entry.texels) {
        const safeX = Math.min(tx, state.textureSize - 1);
        const safeY = Math.min(ty, state.textureSize - 1);
        const tIdx = (safeY * state.textureSize + safeX) * 4;
        tex[tIdx]     = paintData[pmIdx];
        tex[tIdx + 1] = paintData[pmIdx + 1];
        tex[tIdx + 2] = paintData[pmIdx + 2];
        tex[tIdx + 3] = 255;
      }
    }
  } else {
    for (let y = 0; y < state.canvasSize; y++) {
      for (let x = 0; x < state.canvasSize; x++) {
        const pmIdx = (y * state.canvasSize + x) * 4;
        if (pmData[pmIdx + 3] < 128) continue;
        if (paintData[pmIdx + 3] < 10) continue;

        const tx = (pmData[pmIdx]     << 1) | ((pmData[pmIdx + 2] >> 7) & 1);
        const ty = (pmData[pmIdx + 1] << 1) | ((pmData[pmIdx + 2] >> 6) & 1);

        const safeX = Math.min(tx, state.textureSize - 1);
        const safeY = Math.min(ty, state.textureSize - 1);
        const tIdx = (safeY * state.textureSize + safeX) * 4;
        tex[tIdx]     = paintData[pmIdx];
        tex[tIdx + 1] = paintData[pmIdx + 1];
        tex[tIdx + 2] = paintData[pmIdx + 2];
        tex[tIdx + 3] = 255;
      }
    }
  }

  const pairs = project.uv_mirror_pairs || [];
  for (const { source, target } of pairs) {
    const sx = Math.min(Math.round(source[0] * (state.textureSize - 1)), state.textureSize - 1);
    const sy = Math.min(Math.round((1 - source[1]) * (state.textureSize - 1)), state.textureSize - 1);
    const tx = Math.min(Math.round(target[0] * (state.textureSize - 1)), state.textureSize - 1);
    const ty = Math.min(Math.round((1 - target[1]) * (state.textureSize - 1)), state.textureSize - 1);
    const si = (sy * state.textureSize + sx) * 4;
    const ti = (ty * state.textureSize + tx) * 4;
    const sourceChanged =
      tex[si + 3] > 0 &&
      (tex[si] !== basePixels[si] ||
        tex[si + 1] !== basePixels[si + 1] ||
        tex[si + 2] !== basePixels[si + 2] ||
        tex[si + 3] !== basePixels[si + 3]);
    if (sourceChanged) {
      tex[ti] = tex[si];
      tex[ti + 1] = tex[si + 1];
      tex[ti + 2] = tex[si + 2];
      tex[ti + 3] = 255;
    }
  }

  texCtx.putImageData(texImg, 0, 0);
  return texOff;
}

// ─────────────────────────────────────────────────────────────────────────────
// 저장
// ─────────────────────────────────────────────────────────────────────────────

async function savePaint() {
  if (!state.project) return showToast("먼저 모델을 로드해주세요.", true);

  const btn = document.getElementById("saveBtn");
  btn.textContent = "저장 중…"; btn.disabled = true;

  try {
    // 1. UV 리매핑으로 텍스처 생성
    const texCanvas = remapToTexture();
    if (!texCanvas) throw new Error("UV 리매핑 실패");

    const texDataUrl = texCanvas.toDataURL("image/png");

    // 2. 캔버스 상태 (복원용)
    const canvasStateUrl = drawCanvas.toDataURL("image/png");

    // 3. 서버에 저장
    const fd = new FormData();
    fd.append("image", texDataUrl);
    fd.append("canvas_state", canvasStateUrl);
    fd.append("axis", state.project.axis);

    const res = await fetch(
      `/api/models/${encodeURIComponent(state.project.name)}/save_paint`,
      { method: "POST", body: fd }
    );
    const data = await res.json();

    if (data.status === "ok") {
      // 4. 3D 뷰 갱신
      initThree(state.project.model_path, data.painted_url);
      showToast("저장 완료! 3D 뷰가 업데이트됐어요 🎨");
    } else {
      showToast("저장 실패", true);
    }
  } catch (e) {
    showToast("오류: " + e.message, true);
  } finally {
    btn.textContent = "💾 저장 & 3D 반영";
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 이벤트 & UI 셋업
// ─────────────────────────────────────────────────────────────────────────────

function getCanvasPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  const sx = state.canvasSize / rect.width;
  const sy = state.canvasSize / rect.height;
  const src = e.touches ? e.touches[0] : e;
  return { x: (src.clientX - rect.left) * sx, y: (src.clientY - rect.top) * sy };
}

function onPointerDown(e) {
  e.preventDefault();
  if (!state.project) return;
  const { x, y } = getCanvasPos(e);
  if (state.tool === "pencil" || state.tool === "eraser") startDraw(x, y);
  else if (state.tool === "fill")       floodFill(x, y);
  else if (state.tool === "eyedropper") pickColor(x, y);
}

function onPointerMove(e) {
  e.preventDefault();
  if ((state.tool === "pencil" || state.tool === "eraser") && state.project) {
    continueDraw(...Object.values(getCanvasPos(e)));
  }
}

function setupDrawEvents() {
  drawCanvas.addEventListener("mousedown",  onPointerDown);
  drawCanvas.addEventListener("mousemove",  onPointerMove);
  drawCanvas.addEventListener("mouseup",    () => endDraw());
  drawCanvas.addEventListener("mouseleave", () => endDraw());
  drawCanvas.addEventListener("touchstart", onPointerDown, { passive: false });
  drawCanvas.addEventListener("touchmove",  onPointerMove, { passive: false });
  drawCanvas.addEventListener("touchend",   () => endDraw());
  document.addEventListener("keydown", e => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    if (ctrl && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  });
}

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll(".tool-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
  const cursors = { pencil: "crosshair", fill: "cell", eraser: "cell", eyedropper: "crosshair" };
  drawCanvas.style.cursor = cursors[tool] || "crosshair";
}

function setColor(hex) {
  state.color = hex;
  const p = document.getElementById("colorPicker");
  const pv = document.getElementById("colorPreview");
  if (p) p.value = hex;
  if (pv) pv.style.backgroundColor = hex;
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("processStatus");
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? "status-error" : (msg.includes("완료") ? "status-ok" : "");
}

function buildPalette() {
  const el = document.getElementById("palette");
  if (!el) return;
  el.innerHTML = "";
  KID_PALETTE.forEach(hex => {
    const sw = document.createElement("button");
    sw.className = "swatch";
    sw.style.backgroundColor = hex;
    sw.title = hex;
    sw.addEventListener("click", () => { setColor(hex); setTool("pencil"); });
    el.appendChild(sw);
  });
}

function setupUI() {
  buildPalette();

  // 모델 바 버튼
  document.getElementById("processBtn")?.addEventListener("click", processModel);
  document.getElementById("loadBtn")?.addEventListener("click", loadProject);

  // 도구 버튼
  document.querySelectorAll(".tool-btn").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));

  // 색상 피커
  document.getElementById("colorPicker")?.addEventListener("input", e => setColor(e.target.value));

  // 슬라이더
  const bsSlider = document.getElementById("brushSize");
  const bsLabel  = document.getElementById("brushSizeLabel");
  bsSlider?.addEventListener("input", e => {
    state.brushSize = +e.target.value;
    if (bsLabel) bsLabel.textContent = state.brushSize + "px";
  });

  const opSlider = document.getElementById("opacity");
  const opLabel  = document.getElementById("opacityLabel");
  opSlider?.addEventListener("input", e => {
    state.opacity = +e.target.value / 100;
    if (opLabel) opLabel.textContent = e.target.value + "%";
  });

  // 실행취소/다시실행
  document.getElementById("undoBtn")?.addEventListener("click", undo);
  document.getElementById("redoBtn")?.addEventListener("click", redo);

  // 지우기
  document.getElementById("clearBtn")?.addEventListener("click", () => {
    if (!confirm("그림을 모두 지울까요?")) return;
    drawCtx.clearRect(0, 0, state.canvasSize, state.canvasSize);
    saveHistory();
  });

  // 저장
  document.getElementById("saveBtn")?.addEventListener("click", savePaint);

  // 캔버스 탭 (색칠/참고 전환)
  document.querySelectorAll(".canvas-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      state.currentTab = tab.dataset.tab;
      document.querySelectorAll(".canvas-tab").forEach(t => t.classList.toggle("active", t === tab));
      const showRef = state.currentTab === "ref";
      refCanvas.style.opacity   = showRef ? "1" : "0";
      drawCanvas.style.opacity  = showRef ? "0" : "1";
      drawCanvas.style.pointerEvents = showRef ? "none" : "auto";
    });
  });

  setTool("pencil");
  setColor("#FF0000");
  updateHistoryBtns();
}

// ─── 토스트 ────────────────────────────────────────────────────────────────
function showToast(msg, isError = false) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = "toast" + (isError ? " toast-error" : "");
  t.style.opacity = "1";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = "0"; }, 2800);
}

// ─── 실행 ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
