// static/js/three_loader.js
import * as THREE from './three.module.js';
import { GLTFLoader } from './GLTFLoader.js';
import { OrbitControls } from './OrbitControls.js';

export default function initThree(texturePath) {
  const container = document.getElementById("threeContainer");
  container.innerHTML = ""; // 기존 모델 제거

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    0.1,
    1000
  );

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);

  // OrbitControls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.enablePan = false;

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  const directional1 = new THREE.DirectionalLight(0xffffff, 1);
  directional1.position.set(1, 1, 1);
  const directional2 = new THREE.DirectionalLight(0xffffff, 0.5);
  directional2.position.set(-1, 2, 2);
  scene.add(ambient, directional1, directional2);

  // GLTF 모델 로드
  const gltfLoader = new GLTFLoader();
  const textureLoader = new THREE.TextureLoader();
  const texture = textureLoader.load(texturePath, tex => {
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
  });

  let model; // 전역 변수로 선언

  gltfLoader.load(
    '/static/models/car.gltf',
    gltf => {
      model = gltf.scene;
      model.scale.set(0.005, 0.005, 0.005);

      let uvExists = false;
      model.traverse(child => {
        if (child.isMesh) {
          if (child.geometry.attributes.uv) uvExists = true;

          child.material = new THREE.MeshStandardMaterial({
            map: texture,
            side: THREE.DoubleSide
          });
          child.material.needsUpdate = true;
        }
      });

      if (!uvExists) console.warn("GLTF 모델에 UV 좌표가 없습니다!");

      model.position.set(0, 0, 0); // 가운데로
      scene.add(model);
    },
    undefined,
    err => console.error("GLTF load error:", err)
  );

  // 카메라 초기 위치
  const radius = 3;
  const angle = THREE.MathUtils.degToRad(60);
  camera.position.x = 0;
  camera.position.y = radius * Math.sin(angle);
  camera.position.z = radius * Math.cos(angle);
  camera.lookAt(0, 0, 0);

  // Animate
  let rotate = true; // 회전 상태
  const animate = () => {
    requestAnimationFrame(animate);

    if (rotate && model) {
      model.rotation.y += 0.01;
    }

    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  // 창 크기 리사이징 대응
  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  // Rotate 버튼 토글
  const toggleBtn = document.getElementById('toggleAnimateBtn');
  toggleBtn.addEventListener('click', () => {
    rotate = !rotate;
    toggleBtn.textContent = rotate ? 'Rotate ON' : 'Rotate OFF';
  });

  // Zoom 버튼 생성 (+, -) – 재호출 시 중복 방지
  container.parentElement.querySelectorAll('.zoom-wrapper').forEach(el => el.remove());
  const zoomWrapper = document.createElement('div');
  zoomWrapper.className = 'zoom-wrapper';
  zoomWrapper.style.position = 'absolute';
  zoomWrapper.style.top = '10px';
  zoomWrapper.style.left = '10px';
  zoomWrapper.style.display = 'flex';
  zoomWrapper.style.gap = '5px';
  zoomWrapper.style.zIndex = '10';
  container.parentElement.appendChild(zoomWrapper);

  ['+', '-'].forEach(sym => {
    const btn = document.createElement('button');
    btn.textContent = sym;
    btn.style.padding = '4px 8px';
    btn.style.fontSize = '14px';
    btn.style.cursor = 'pointer';
    btn.style.backgroundColor = 'rgba(255,255,255,0.8)';
    btn.style.border = '1px solid #888';
    btn.style.borderRadius = '3px';
    zoomWrapper.appendChild(btn);

    btn.addEventListener('click', () => {
      const factor = sym === '+' ? 0.9 : 1.1;
      camera.position.multiplyScalar(factor); // 카메라 거리 조정
    });
  });
}



// // static/js/three_loader.js
// import * as THREE from "./three.module.js";
// import { GLTFLoader } from "./GLTFLoader.js";
// import { OrbitControls } from "./OrbitControls.js";

// export default function initThree(texturePath) {
//   const container = document.getElementById("threeContainer");
//   container.innerHTML = ""; // 기존 모델 제거

//   // Scene & Camera
//   const scene = new THREE.Scene();
//   const camera = new THREE.PerspectiveCamera(
//     60,
//     container.clientWidth / container.clientHeight,
//     0.1,
//     1000
//   );

//   const radius = 3;
//   const angle = THREE.MathUtils.degToRad(60); // 60도 내려다보기
//   camera.position.set(0, radius * Math.sin(angle), radius * Math.cos(angle));
//   camera.lookAt(0, 0, 0);

//   // Renderer
//   const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
//   renderer.setSize(container.clientWidth, container.clientHeight);
//   renderer.setClearColor(0x000000, 0);
//   container.appendChild(renderer.domElement);

//   // Lights
//   const ambient = new THREE.AmbientLight(0xffffff, 0.7);
//   const directional1 = new THREE.DirectionalLight(0xffffff, 1);
//   directional1.position.set(1, 1, 1);
//   const directional2 = new THREE.DirectionalLight(0xffffff, 0.5);
//   directional2.position.set(-1, 2, 2);
//   scene.add(ambient, directional1, directional2);

//   // OrbitControls
//   const controls = new OrbitControls(camera, renderer.domElement);
//   controls.enableDamping = true;
//   controls.dampingFactor = 0.05;
//   controls.enablePan = false;

//   // GLTF Loader
//   const gltfLoader = new GLTFLoader();
//   const textureLoader = new THREE.TextureLoader();

//   let model = null;
//   gltfLoader.load(
//     "/static/models/car.gltf",
//     gltf => {
//       model = gltf.scene;
//       model.scale.set(0.005, 0.005, 0.005);

//       // 텍스처 적용
//       const texture = textureLoader.load(texturePath);
//       texture.flipY = false;
//       texture.colorSpace = THREE.SRGBColorSpace;

//       let uvExists = false;
//       model.traverse(child => {
//         if (child.isMesh) {
//           if (child.geometry.attributes.uv) uvExists = true;

//           child.material = new THREE.MeshStandardMaterial({
//             map: texture,
//             side: THREE.DoubleSide
//           });
//           child.material.needsUpdate = true;
//         }
//       });

//       if (!uvExists) console.warn("GLTF 모델에 UV 좌표가 없습니다!");

//       // 모델 중앙 배치
//       model.position.set(0, 0, 0);
//       scene.add(model);
//     },
//     undefined,
//     err => console.error("GLTF load error:", err)
//   );

//   // Animate on/off
//   let animateOnOff = true;
//   document.getElementById("toggleAnimateBtn").addEventListener("click", () => {
//     animateOnOff = !animateOnOff;
//   });

//   // Animate loop
//   const animate = () => {
//     requestAnimationFrame(animate);

//     if (model && animateOnOff) {
//       model.rotation.y += 0.01;
//     }

//     controls.update();
//     renderer.render(scene, camera);
//   };
//   animate();
// }


// // static/js/three_loader.js : gltf 사용 : 완료
// import * as THREE from "./three.module.js";
// import { GLTFLoader } from "./GLTFLoader.js";
// import { OrbitControls } from "./OrbitControls.js";

// export default function initThree(texturePath) {
//   const container = document.getElementById("threeContainer");
//   container.innerHTML = "";

//   // Scene & Camera
//   const scene = new THREE.Scene();
//   const camera = new THREE.PerspectiveCamera(
//     60,
//     container.clientWidth / container.clientHeight,
//     0.1,
//     1000
//   );

//   // 카메라 위에서 60도 내려다보는 뷰
//   const radius = 3;
//   const angle = THREE.MathUtils.degToRad(60);
//   camera.position.set(0, radius * Math.sin(angle), radius * Math.cos(angle));
//   camera.lookAt(0, 0, 0);

//   // Renderer
//   const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
//   renderer.setSize(container.clientWidth, container.clientHeight);
//   renderer.setClearColor(0x000000, 0); // 배경 투명
//   container.appendChild(renderer.domElement);

//   // Lights
//   const ambient = new THREE.AmbientLight(0xffffff, 0.7);
//   const directional1 = new THREE.DirectionalLight(0xffffff, 1);
//   directional1.position.set(1, 1, 1);
//   const directional2 = new THREE.DirectionalLight(0xffffff, 0.5);
//   directional2.position.set(-1, 2, 2);
//   scene.add(ambient, directional1, directional2);

//   // OrbitControls
//   const controls = new OrbitControls(camera, renderer.domElement);
//   controls.target.set(0, 0, 0);
//   controls.update();

//   // Texture
//   const textureLoader = new THREE.TextureLoader();
//   const texture = textureLoader.load(texturePath, tex => {
//     tex.flipY = false;
//     tex.colorSpace = THREE.SRGBColorSpace;
//   });

//   // GLTF 모델 로드
//   const gltfLoader = new GLTFLoader();
//   gltfLoader.load(
//     "/static/models/car.gltf",
//     gltf => {
//       const model = gltf.scene;

//       // 모델 크기 및 위치 중앙
//       model.scale.set(0.005, 0.005, 0.005); 
//       model.position.set(0, 0, 0);

//       // 모든 Mesh에 texture 적용
//       let uvExists = false;
//       model.traverse(child => {
//         if (child.isMesh) {
//           if (child.geometry.attributes.uv) uvExists = true;
//           child.material = new THREE.MeshStandardMaterial({
//             map: texture,
//             side: THREE.DoubleSide
//           });
//           child.material.needsUpdate = true;
//         }
//       });
//       if (!uvExists) console.warn("GLTF 모델에 UV 좌표가 없습니다!");

//       scene.add(model);
//       console.log("GLTF model loaded with painted texture");
//     },
//     undefined,
//     err => console.error("GLTF load error:", err)
//   );

//   // Animate
//   const animate = () => {
//     requestAnimationFrame(animate);
//     renderer.render(scene, camera);
//   };
//   animate();

//   // 창 크기 변경 시 리사이즈
//   window.addEventListener("resize", () => {
//     camera.aspect = container.clientWidth / container.clientHeight;
//     camera.updateProjectionMatrix();
//     renderer.setSize(container.clientWidth, container.clientHeight);
//   });
// }


// // static/js/three_loader.js : gltf 사용 : 완료
// import * as THREE from "./three.module.js";
// import { GLTFLoader } from "./GLTFLoader.js";

// export default function initThree(texturePath) {
//   const container = document.getElementById("threeContainer");
//   container.innerHTML = ""; // 기존 모델 제거

//   // Scene & Camera
//   const scene = new THREE.Scene();
//   const camera = new THREE.PerspectiveCamera(
//     60,
//     container.clientWidth / container.clientHeight,
//     0.1,
//     1000
//   );

//   // 카메라를 위에서 60도 내려다보도록 설정
//   const radius = 3; // 모델로부터의 거리
//   const angle = THREE.MathUtils.degToRad(60); // 60도 -> 라디안
//   camera.position.x = 0;
//   camera.position.y = radius * Math.sin(angle); // 위쪽 높이
//   camera.position.z = radius * Math.cos(angle); // 앞쪽 거리
//   camera.lookAt(0, 0, 0);

//   // Renderer
//   const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
//   renderer.setSize(container.clientWidth, container.clientHeight);
//   renderer.setClearColor(0x000000, 0); // 배경 투명
//   container.appendChild(renderer.domElement);

//   // Lights
//   const ambient = new THREE.AmbientLight(0xffffff, 0.7);
//   const directional1 = new THREE.DirectionalLight(0xffffff, 1);
//   directional1.position.set(1, 1, 1);
//   const directional2 = new THREE.DirectionalLight(0xffffff, 0.5);
//   directional2.position.set(-1, 2, 2);
//   scene.add(ambient, directional1, directional2);

//   // =============================
//   // 1️⃣ 텍스처 테스트용 Plane
//   // =============================
//   const textureLoader = new THREE.TextureLoader();
//   textureLoader.load(
//     texturePath,
//     texture => {
//       texture.flipY = false;
//       texture.colorSpace = THREE.SRGBColorSpace;

//       // const testPlane = new THREE.Mesh(
//       //   new THREE.PlaneGeometry(1, 1),
//       //   new THREE.MeshStandardMaterial({ map: texture })
//       // );
//       // testPlane.position.set(-1.5, 0, 0);
//       // scene.add(testPlane);

//       console.log("Plane geometry texture test done");
//     },
//     undefined,
//     err => console.error("Texture load error:", err)
//   );

//   // =============================
//   // 2️⃣ GLTF 모델 로드 (외부 텍스처)
//   // =============================
//   const gltfLoader = new GLTFLoader();
//   gltfLoader.load(
//     "/static/models/car.gltf",
//     gltf => {
//       const model = gltf.scene;
//       model.scale.set(0.005, 0.005, 0.005)
//       // 모델에 모든 MeshStandardMaterial에 paint texture 적용
//       const texture = textureLoader.load(texturePath);
//       texture.flipY = false;
//       texture.colorSpace = THREE.SRGBColorSpace;

//       let uvExists = false;
//       model.traverse(child => {
//         if (child.isMesh) {
//           if (child.geometry.attributes.uv) uvExists = true;

//           child.material = new THREE.MeshStandardMaterial({
//             map: texture,
//             side: THREE.DoubleSide
//           });
//           child.material.needsUpdate = true;
//         }
//       });

//       if (!uvExists) console.warn("GLTF 모델에 UV 좌표가 없습니다!");

//       model.position.set(1.5, 0, 0); // Plane과 구분
//       scene.add(model);

//       console.log("GLTF model loaded with painted texture");
//     },
//     undefined,
//     err => console.error("GLTF load error:", err)
//   );

//   // =============================
//   // Animate
//   // =============================
//   const animate = () => {
//     requestAnimationFrame(animate);

//     // 회전 애니메이션
//     scene.traverse(child => {
//       if (child.isMesh) {
//         child.rotation.y += 0.01;
//       }
//     });

//     renderer.render(scene, camera);
//   };
//   animate();
// }


// // static/js/three_loader.js : obj, mtl 사용 : 완료
// import * as THREE from "./three.module.js";
// import { MTLLoader } from "./MTLLoader.js";
// import { OBJLoader } from "./OBJLoader.js";

// export default function initThree(texturePath) {
//   const container = document.getElementById("threeContainer");
//   container.innerHTML = ""; // 기존 모델 제거

//   // Scene & Camera
//   const scene = new THREE.Scene();
//   const camera = new THREE.PerspectiveCamera(
//     60,
//     container.clientWidth / container.clientHeight,
//     0.1,
//     1000
//   );
  
//   // 카메라를 위에서 60도 내려다보도록 설정
//   const radius = 3; // 모델로부터의 거리
//   const angle = THREE.MathUtils.degToRad(60); // 60도 -> 라디안
//   camera.position.x = 0;
//   camera.position.y = radius * Math.sin(angle); // 위쪽 높이
//   camera.position.z = radius * Math.cos(angle); // 앞쪽 거리

//   // 모델 중심을 바라보도록 설정
//   camera.lookAt(0, 0, 0);

//   // Renderer
//   const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
//   renderer.setSize(container.clientWidth, container.clientHeight);
//   renderer.setClearColor(0x000000, 0); // 배경 투명
//   container.appendChild(renderer.domElement);

//   // Lights
//   const ambient = new THREE.AmbientLight(0xffffff, 0.7);
//   const directional1 = new THREE.DirectionalLight(0xffffff, 1);
//   directional1.position.set(1, 1, 1);
//   const directional2 = new THREE.DirectionalLight(0xffffff, 0.5);
//   directional2.position.set(-1, 2, 2);
//   scene.add(ambient, directional1, directional2);

//   // =============================
//   // 1️⃣ 텍스처 테스트용 Plane
//   // =============================
//   const textureLoader = new THREE.TextureLoader();
//   textureLoader.load(
//     texturePath,
//     texture => {
//       texture.flipY = false;
//       texture.colorSpace = THREE.SRGBColorSpace;

//       const testPlane = new THREE.Mesh(
//         new THREE.PlaneGeometry(1, 1),
//         new THREE.MeshStandardMaterial({ map: texture })
//       );
//       testPlane.position.set(-1.5, 0, 0);
//       scene.add(testPlane);

//       console.log("Plane geometry texture test done");
//     },
//     undefined,
//     err => console.error("Texture load error:", err)
//   );

//   // =============================
//   // 2️⃣ OBJ/MTL 모델 로드
//   // =============================
//   const mtlLoader = new MTLLoader();
//   mtlLoader.load(
//     "/static/models/bear.mtl",
//     materials => {
//       materials.preload();

//       const objLoader = new OBJLoader();
//       objLoader.setMaterials(materials);
//       objLoader.load(
//         "/static/models/bear.obj",
//         obj => {
//           // Texture 적용
//           textureLoader.load(
//             texturePath,
//             texture => {
//               texture.flipY = false;
//               texture.colorSpace = THREE.SRGBColorSpace;

//               let uvExists = false;
//               obj.traverse(child => {
//                 if (child.isMesh) {
//                   // UV 확인
//                   if (child.geometry.attributes.uv) uvExists = true;

//                   child.material = new THREE.MeshStandardMaterial({
//                     map: texture,
//                     side: THREE.DoubleSide
//                   });
//                   child.material.needsUpdate = true;
//                 }
//               });

//               if (!uvExists) console.warn("OBJ 모델에 UV 좌표가 없습니다!");

//               obj.position.set(1.5, 0, 0); // Plane과 구분
//               scene.add(obj);

//               console.log("OBJ/MTL model loaded with painted texture");
//             },
//             undefined,
//             err => console.error("Texture load error:", err)
//           );
//         },
//         undefined,
//         err => console.error("OBJ load error:", err)
//       );
//     },
//     undefined,
//     err => console.error("MTL load error:", err)
//   );

//   // =============================
//   // Animate
//   // =============================
//   const animate = () => {
//     requestAnimationFrame(animate);

//     // 회전 애니메이션 (OBJ)
//     scene.traverse(child => {
//       if (child.isMesh && child !== undefined) {
//         child.rotation.y += 0.01;
//       }
//     });

//     renderer.render(scene, camera);
//   };
//   animate();
// }








// // static/js/three_loader.js
// import * as THREE from "./three.module.js";
// import { MTLLoader } from "./MTLLoader.js";
// import { OBJLoader } from "./OBJLoader.js";

// export default function initThree(texturePath) {
//   const container = document.getElementById("threeContainer");
//   container.innerHTML = ""; // 기존 모델 제거

//   // Scene & Camera
//   const scene = new THREE.Scene();
//   const camera = new THREE.PerspectiveCamera(
//     60,
//     container.clientWidth / container.clientHeight,
//     0.1,
//     1000
//   );
//   camera.position.z = 3;

//   // Renderer
//   const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
//   renderer.setSize(container.clientWidth, container.clientHeight);
//   container.appendChild(renderer.domElement);

//   // Lights
//   const ambient = new THREE.AmbientLight(0xffffff, 0.5);
//   const directional = new THREE.DirectionalLight(0xffffff, 1);
//   directional.position.set(1, 1, 1);
//   scene.add(ambient, directional);

//   // Load MTL
//   const mtlLoader = new MTLLoader();
//   mtlLoader.load("/static/models/bear.mtl", materials => {
//     materials.preload();

//     const objLoader = new OBJLoader();
//     objLoader.setMaterials(materials);
//     objLoader.load("/static/models/bear.obj", obj => {

//       // Load paint texture
//       const textureLoader = new THREE.TextureLoader();
//       textureLoader.load(texturePath, texture => {
//         texture.flipY = false;
//         texture.colorSpace = THREE.SRGBColorSpace;

//         obj.traverse(child => {
//           if (child.isMesh) {
//             // 기존 material 덮어쓰기
//             child.material = new THREE.MeshStandardMaterial({
//               map: texture,
//               side: THREE.DoubleSide
//             });
//             child.material.needsUpdate = true;
//           }
//         });

//         scene.add(obj);

//         // Animate
//         const animate = () => {
//           requestAnimationFrame(animate);
//           obj.rotation.y += 0.01;
//           renderer.render(scene, camera);
//         };
//         animate();
//       }, undefined, err => {
//         console.error("Texture load error:", err);
//       });

//     }, undefined, err => {
//       console.error("OBJ load error:", err);
//     });

//   }, undefined, err => {
//     console.error("MTL load error:", err);
//   });
// }





// // static/js/three_loader.js
// import * as THREE from "./three.module.js";
// import { GLTFLoader } from "./GLTFLoader.js";

// export default function initThree(texturePath) {
//   const container = document.getElementById("threeContainer");
//   container.innerHTML = ""; // 기존 모델 제거 후 새로 렌더링

//   const scene = new THREE.Scene();
//   const camera = new THREE.PerspectiveCamera(
//     60,
//     container.clientWidth / container.clientHeight,
//     0.1,
//     1000
//   );
//   camera.position.z = 3;

//   const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
//   renderer.setSize(container.clientWidth, container.clientHeight);
//   container.appendChild(renderer.domElement);

//   // 라이트
//   const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
//   scene.add(ambientLight);
//   const dirLight = new THREE.DirectionalLight(0xffffff, 1);
//   dirLight.position.set(1, 1, 1);
//   scene.add(dirLight);

//   const loader = new GLTFLoader();
//   loader.load("/static/models/bear.glb", gltf => {
//     const model = gltf.scene;

//     const textureLoader = new THREE.TextureLoader();
//     textureLoader.load(texturePath, texture => {
//       texture.flipY = false; // Blender UV 맞춤

//       model.traverse(obj => {
//         if (obj.isMesh) {
//           // 기존 Material 덮어쓰기
//           obj.material = new THREE.MeshStandardMaterial({ map: texture });
//         }
//       });

//       scene.add(model);

//       const animate = () => {
//         requestAnimationFrame(animate);
//         model.rotation.y += 0.01;
//         renderer.render(scene, camera);
//       };
//       animate();
//     });
//   });
// }