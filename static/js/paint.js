// paint.js
import initThree from "./three_loader.js";

// paint.js (ES 모듈 구조)
export default function initPaint(uvUrl) {
  document.addEventListener("DOMContentLoaded", () => {
    const width = 512;
    const height = 512;

    const stage = new Konva.Stage({
      container: "container",
      width: width,
      height: height,
    });

    const layer = new Konva.Layer();
    stage.add(layer);

    const imageObj = new Image();
    imageObj.src = uvUrl; // 서버에서 제공하는 static URL 사용

    imageObj.onload = () => {
      const bg = new Konva.Image({
        image: imageObj,
        x: 0,
        y: 0,
        width: width,
        height: height,
      });
      layer.add(bg);
      layer.draw();
    };

    // 브러시용 레이어
    const drawLayer = new Konva.Layer();
    stage.add(drawLayer);


    // 브러시 설정
    let brushColor = document.getElementById("colorPicker").value;
    let brushWidth = document.getElementById("brushSize").value;

    const brush = new Konva.Line({
      stroke: brushColor,
      strokeWidth: brushWidth,
      lineCap: "round",
      lineJoin: "round",
      globalCompositeOperation: "source-over",
      points: [],
    });

    // **라인 레이어의 맨 아래로 배치**
    drawLayer.add(brush);
    // brush.moveToTop(); // brush.moveToBottom(); // 기존 라인 뒤쪽으로 이동

    let isDrawing = false;

    stage.on("mousedown touchstart", () => {
      isDrawing = true;
      const pos = stage.getPointerPosition();
      brush.points([pos.x, pos.y]);
    });

    stage.on("mouseup touchend", () => {
      isDrawing = false;
    });

    stage.on("mousemove touchmove", () => {
      if (!isDrawing) return;
      const pos = stage.getPointerPosition();
      const newPoints = brush.points().concat([pos.x, pos.y]);
      brush.points(newPoints);
      drawLayer.batchDraw();
    });

    // 브러시 색상 변경 이벤트
    document.getElementById("colorPicker").addEventListener("change", e => {
      brush.stroke(e.target.value);
    });

    document.getElementById("brushSize").addEventListener("change", e => {
      brush.strokeWidth(parseInt(e.target.value));
    });

    document.getElementById("saveBtn").addEventListener("click", async () => {
      const dataURL = stage.toDataURL({ mimeType: "image/png" });
      const formData = new FormData();
      formData.append("image", dataURL);
      const res = await fetch("/save_paint", { method: "POST", body: formData });
      if (res.ok) {
        alert("저장 완료 및 3D 텍스처 갱신!");
        initThree("/static/models/Lamborginhi Aventador_diffuse.jpg");
      }
    });
  });
}
initPaint("/static/models/Lamborginhi Aventador_diffuse_origin.jpg");
