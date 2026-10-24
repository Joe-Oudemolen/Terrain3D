import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Grid } from '../core/grid';
import { WORLD_SIZE_M } from '../core/grid';

export interface CameraPose { x: number; z: number; yaw: number }
export interface Viewport {
  setTerrain(g: Grid, rgba: Uint8Array): void;
  getCameraPose(): CameraPose;
  setContainer(el: HTMLElement): void;
  dispose(): void;
}

export function createViewport(container: HTMLElement): Viewport {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.domElement.setAttribute('aria-label', 'Orbitable 3D terrain');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#17242c');
  const camera = new THREE.PerspectiveCamera(45, 1, 10, 100000);
  camera.position.set(12500, 10000, 14000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(WORLD_SIZE_M / 2, 0, WORLD_SIZE_M / 2);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 100;
  controls.maxDistance = 35000;
  scene.add(new THREE.HemisphereLight(0xc6e2ff, 0x555044, 2));
  const sun = new THREE.DirectionalLight(0xffe7c0, 3);
  sun.position.set(-4000, 10000, -3000);
  scene.add(sun);
  let mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | undefined;
  const resize = () => {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  const attach = (el: HTMLElement) => {
    observer.disconnect();
    container = el;
    el.append(renderer.domElement);
    observer.observe(el);
    resize();
  };
  attach(container);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  const freeMesh = () => {
    if (!mesh) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.map?.dispose();
    mesh.material.dispose();
  };
  return {
    setTerrain(g, rgba) {
      freeMesh();
      const nx = Math.min(g.width - 1, 1024), nz = Math.min(g.height - 1, 1024);
      const width = (g.width - 1) * g.cellSize, depth = (g.height - 1) * g.cellSize;
      const geometry = new THREE.PlaneGeometry(width, depth, nx, nz);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(width / 2, 0, depth / 2);
      const pos = geometry.attributes.position;
      for (let z = 0; z <= nz; z++) for (let x = 0; x <= nx; x++) {
        const ix = Math.round(x / nx * (g.width - 1)), iz = Math.round(z / nz * (g.height - 1));
        pos.setY(z * (nx + 1) + x, g.data[iz * g.width + ix]);
      }
      geometry.computeVertexNormals();
      const texture = new THREE.DataTexture(rgba, g.width, g.height, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = true;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }));
      scene.add(mesh);
    },
    getCameraPose() {
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      return { x: camera.position.x, z: camera.position.z, yaw: Math.atan2(direction.x, direction.z) };
    },
    setContainer: attach,
    dispose() { observer.disconnect(); renderer.setAnimationLoop(null); controls.dispose(); freeMesh(); renderer.dispose(); renderer.domElement.remove(); },
  };
}
