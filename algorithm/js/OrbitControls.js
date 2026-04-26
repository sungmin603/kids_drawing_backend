// OrbitControls.js
import * as THREE from './three.module.js';

class OrbitControls extends THREE.EventDispatcher {
  constructor(object, domElement) {
    super();
    this.object = object;
    this.domElement = domElement;

    // Control parameters
    this.enabled = true;
    this.target = new THREE.Vector3();
    this.minDistance = 0;
    this.maxDistance = Infinity;
    this.minPolarAngle = 0;
    this.maxPolarAngle = Math.PI;
    this.enableDamping = false;
    this.dampingFactor = 0.05;
    this.screenSpacePanning = true;

    // Internal state
    this.state = { NONE: -1, ROTATE: 0, DOLLY: 1, PAN: 2, TOUCH_ROTATE: 3, TOUCH_DOLLY_PAN: 4 };
    this.currentState = this.state.NONE;

    // Event handlers
    this.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
    this.domElement.addEventListener('mousedown', this.onMouseDown.bind(this));
    this.domElement.addEventListener('mousemove', this.onMouseMove.bind(this));
    this.domElement.addEventListener('mouseup', this.onMouseUp.bind(this));
    this.domElement.addEventListener('wheel', this.onMouseWheel.bind(this));

    // TODO: Touch events, key events, update(), rotate(), pan(), dolly() 구현
  }

  onMouseDown(event) {
    if (!this.enabled) return;
    this.currentState = this.state.ROTATE;
    this.startX = event.clientX;
    this.startY = event.clientY;
  }

  onMouseMove(event) {
    if (!this.enabled) return;
    if (this.currentState === this.state.ROTATE) {
      const deltaX = event.clientX - this.startX;
      const deltaY = event.clientY - this.startY;
      this.rotate(deltaX, deltaY);
      this.startX = event.clientX;
      this.startY = event.clientY;
    }
  }

  onMouseUp() {
    this.currentState = this.state.NONE;
  }

  onMouseWheel(event) {
    if (!this.enabled) return;
    this.dolly(event.deltaY);
  }

  rotate(deltaX, deltaY) {
    const offset = new THREE.Vector3();
    offset.copy(this.object.position).sub(this.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);

    const ROTATE_SPEED = 0.005;
    spherical.theta -= deltaX * ROTATE_SPEED;
    spherical.phi -= deltaY * ROTATE_SPEED;

    spherical.phi = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, spherical.phi));
    spherical.makeSafe();

    offset.setFromSpherical(spherical);
    this.object.position.copy(this.target).add(offset);
    this.object.lookAt(this.target);
  }

  dolly(delta) {
    const offset = new THREE.Vector3();
    offset.copy(this.object.position).sub(this.target);

    const dollyScale = Math.pow(0.95, delta * 0.01);
    offset.multiplyScalar(dollyScale);

    const distance = offset.length();
    if (distance >= this.minDistance && distance <= this.maxDistance) {
      this.object.position.copy(this.target).add(offset);
    }
  }

  update() {
    if (this.enableDamping) {
      // TODO: implement damping
    }
  }
}

export { OrbitControls };
