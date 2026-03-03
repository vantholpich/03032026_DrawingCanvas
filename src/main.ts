import * as THREE from 'three';
import { Hands, type Results, HAND_CONNECTIONS } from '@mediapipe/hands';
import { Camera } from '@mediapipe/camera_utils';
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils';
import { createClient } from '@supabase/supabase-js';
import { Line2 } from 'three/examples/jsm/lines/Line2';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry';

// --- Supabase Config ---
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// --- Three.js Setup ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('app')?.appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);
const pointLight = new THREE.PointLight(0xffffff, 1);
pointLight.position.set(5, 5, 5);
scene.add(pointLight);

camera.position.z = 5;

// --- State Management ---
let isDrawing = false;
let currentPath: THREE.Vector3[] = [];
let currentLine: Line2 | null = null;
const solidifiedObjects: THREE.Object3D[] = [];
const smoothedPos = new THREE.Vector3();
const LERP_FACTOR = 0.4;

// Gesture Persistence
let gestureBuffer = 0;
const GESTURE_THRESHOLD_START = 2;
const GESTURE_THRESHOLD_EXIT = 3; // Reduced for near-instant termination
let stablePointing = false;

// Raycasting Setup
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();
const drawingPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // Plane at Z=0
const intersectionPoint = new THREE.Vector3();

// --- UI Elements ---
const modal = document.getElementById('metadata-modal');
const modalNameInput = document.getElementById('shape-name') as HTMLInputElement;
const modalDescInput = document.getElementById('shape-desc') as HTMLTextAreaElement;
const modalSaveBtn = document.getElementById('save-metadata');
const tooltip = document.getElementById('shape-tooltip');
const tooltipName = document.getElementById('tooltip-name');
const tooltipDesc = document.getElementById('tooltip-desc');

let activeObjectForMetadata: THREE.Object3D | null = null;
let activePathForMetadata: THREE.Vector3[] = [];

// --- Particle System (Sparkles) ---
class Sparkle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;

  constructor(pos: THREE.Vector3) {
    const geometry = new THREE.SphereGeometry(0.02 + Math.random() * 0.03, 4, 4);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x3b82f6,
      emissiveIntensity: 5,
      transparent: true,
      opacity: 1
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(pos).add(new THREE.Vector3(
      (Math.random() - 0.5) * 0.1,
      (Math.random() - 0.5) * 0.1,
      (Math.random() - 0.5) * 0.1
    ));
    this.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 0.02,
      (Math.random() - 0.5) * 0.02,
      (Math.random() - 0.5) * 0.02
    );
    this.maxLife = 30 + Math.random() * 20;
    this.life = this.maxLife;
    scene.add(this.mesh);
  }

  update() {
    this.mesh.position.add(this.velocity);
    this.life--;
    const alpha = this.life / this.maxLife;
    (this.mesh.material as THREE.MeshStandardMaterial).opacity = alpha;
    this.mesh.scale.setScalar(alpha);
    if (this.life <= 0) {
      scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.MeshStandardMaterial).dispose();
      return false;
    }
    return true;
  }
}

const sparkles: Sparkle[] = [];
function emitSparkle(pos: THREE.Vector3, count = 1) {
  for (let i = 0; i < count; i++) {
    sparkles.push(new Sparkle(pos));
  }
}

// --- Static Glitter Particles (pulse in place) ---
class GlitterParticle {
  mesh: THREE.Mesh;
  phase: number;

  constructor(pos: THREE.Vector3) {
    const size = 0.015 + Math.random() * 0.02;
    const geometry = new THREE.SphereGeometry(size, 4, 4);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x3b82f6,
      emissiveIntensity: 5,
      transparent: true,
      opacity: 0.9
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(pos).add(new THREE.Vector3(
      (Math.random() - 0.5) * 0.03,
      (Math.random() - 0.5) * 0.03,
      (Math.random() - 0.5) * 0.03
    ));
    this.phase = Math.random() * Math.PI * 2;
    scene.add(this.mesh);
  }

  update(time: number) {
    const mat = this.mesh.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 5 + Math.sin(time * 10 + this.phase) * 2;
    mat.opacity = 0.85 + Math.sin(time * 8 + this.phase) * 0.15;
  }

  dispose() {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.MeshStandardMaterial).dispose();
  }
}

const glitterParticles: GlitterParticle[] = [];

// Wand Tip Cursor
const cursorGeometry = new THREE.SphereGeometry(0.04, 8, 8);
const cursorMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  emissive: 0xffffff,
  emissiveIntensity: 2,
  transparent: true,
  opacity: 0.8
});
const cursor = new THREE.Mesh(cursorGeometry, cursorMaterial);
const cursorLight = new THREE.PointLight(0x3b82f6, 2, 2);
cursor.add(cursorLight);
scene.add(cursor);

// Manipulation State
let grabbedObject: THREE.Object3D | null = null; // Changed to Object3D to support Lines
let grabOffset = new THREE.Vector3();

// UI Status
const statusEl = document.getElementById('status');
function setStatus(msg: string) { if (statusEl) statusEl.innerText = msg; }

function updateTooltip(obj: THREE.Object3D | null, x: number, y: number) {
  if (!tooltip || !tooltipName || !tooltipDesc) return;

  if (obj && obj.userData && (obj.userData.name || obj.userData.description)) {
    tooltipName.innerText = obj.userData.name || 'Untitled creation';
    tooltipDesc.innerText = obj.userData.description || '';
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.classList.add('active');
  } else {
    tooltip.classList.remove('active');
  }
}

function updateStatusDot(color: string) {
  const dot = document.getElementById('status-dot');
  if (dot) {
    dot.style.background = color;
    dot.style.boxShadow = `0 0 10px ${color}`;
  }
}

// --- Hand Tracking Logic ---
const videoElement = document.querySelector('.debug-video') as HTMLVideoElement;
const canvasElement = document.querySelector('.debug-canvas') as HTMLCanvasElement;
const canvasCtx = canvasElement.getContext('2d')!;

const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7,
});

// --- Input Handling Helpers ---
function startDrawing(point: THREE.Vector3) {
  if (isDrawing || grabbedObject) return;
  isDrawing = true;
  currentPath = [point.clone()];
  setStatus('✨ Drawing Magical Line...');
  updateStatusDot('#ffffff');

  const geometry = new LineGeometry();
  geometry.setPositions(currentPath.flatMap(p => [p.x, p.y, p.z]));

  const material = new LineMaterial({
    color: 0xffffff,
    linewidth: 0,
    transparent: true,
    opacity: 0.3 // Subtle core — glitter particles are the main visual
  });
  material.resolution.set(window.innerWidth, window.innerHeight);

  currentLine = new Line2(geometry, material);
  currentLine.computeLineDistances();
  scene.add(currentLine);
}

function updateDrawing(point: THREE.Vector3) {
  if (!isDrawing || !currentLine) return;
  if (currentPath.length === 0 || currentPath[currentPath.length - 1].distanceTo(point) > 0.02) {
    currentPath.push(point.clone());
    const geometry = new LineGeometry();
    geometry.setPositions(currentPath.flatMap(p => [p.x, p.y, p.z]));

    currentLine.geometry.dispose();
    currentLine.geometry = geometry;
    currentLine.computeLineDistances();

    // Place static glitter particles along the new segment
    const prev = currentPath[currentPath.length - 2];
    const dist = prev.distanceTo(point);
    const numParticles = Math.max(2, Math.floor(dist / 0.015)); // Dense placement
    for (let i = 0; i < numParticles; i++) {
      const t = i / numParticles;
      const p = prev.clone().lerp(point, t);
      glitterParticles.push(new GlitterParticle(p));
    }

    // Also emit a few floating sparkles from the tip
    emitSparkle(point, 3);
  }
}

function endDrawing() {
  if (!isDrawing) return;
  isDrawing = false;
  setStatus('Ready');
  updateStatusDot('#22c55e');
  // Remove glitter particles before solidifying into a shape
  glitterParticles.forEach(gp => gp.dispose());
  glitterParticles.length = 0;
  solidify();
}

function handleGrab(point: THREE.Vector3) {
  if (grabbedObject) {
    (grabbedObject as THREE.Object3D).position.copy(point).add(grabOffset);
  } else {
    let closest: THREE.Object3D | null = null;
    let minDist = 0.5;
    solidifiedObjects.forEach(obj => {
      const d = obj.position.distanceTo(point);
      if (d < minDist) {
        minDist = d;
        closest = obj;
      }
    });

    if (closest) {
      grabbedObject = closest;
      grabOffset.copy((closest as THREE.Object3D).position).sub(point);
      setStatus('✊ Grabbed Object');
      updateStatusDot('#f59e0b');
    }
  }
}

function releaseGrab() {
  if (grabbedObject) {
    grabbedObject = null;
    setStatus('Ready');
    updateStatusDot('#22c55e');
  }
}

// --- Mouse Interaction ---
let isMouseDown = false;
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // Only left click
  isMouseDown = true;
  updateMouseNDC(e);
  raycaster.setFromCamera(mouseNDC, camera);
  raycaster.ray.intersectPlane(drawingPlane, intersectionPoint);
  startDrawing(intersectionPoint);
});

window.addEventListener('mousemove', (e) => {
  updateMouseNDC(e);
  raycaster.setFromCamera(mouseNDC, camera);
  raycaster.ray.intersectPlane(drawingPlane, intersectionPoint);

  // Update cursor position and visibility regardless of drawing state
  smoothedPos.lerp(intersectionPoint, LERP_FACTOR);
  cursor.position.copy(smoothedPos);
  cursor.visible = true;
  emitSparkle(smoothedPos, isMouseDown ? 3 : 1);

  // Tooltip Logic
  if (!isMouseDown && !isDrawing && !grabbedObject) {
    let closest: THREE.Object3D | null = null;
    let minDist = 0.3;
    solidifiedObjects.forEach(obj => {
      const d = obj.position.distanceTo(smoothedPos);
      if (d < minDist) {
        minDist = d;
        closest = obj;
      }
    });
    updateTooltip(closest, e.clientX, e.clientY);
  } else if (grabbedObject) {
    updateTooltip(grabbedObject, e.clientX, e.clientY);
  } else {
    updateTooltip(null, 0, 0);
  }

  if (isMouseDown) {
    updateDrawing(intersectionPoint);
  }
});

window.addEventListener('mouseup', () => {
  isMouseDown = false;
  endDrawing();
});

// Right click to grab
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('mousedown', (e) => {
  if (e.button === 2) { // Right click
    updateMouseNDC(e);
    raycaster.setFromCamera(mouseNDC, camera);
    raycaster.ray.intersectPlane(drawingPlane, intersectionPoint);
    handleGrab(intersectionPoint);
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 2) releaseGrab();
});

function updateMouseNDC(e: MouseEvent) {
  mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
}

function onResults(results: Results) {
  // Draw landmarks on debug canvas
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  if (results.multiHandLandmarks) {
    for (const landmarks of results.multiHandLandmarks) {
      drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: '#00ffff', lineWidth: 5 });
      drawLandmarks(canvasCtx, landmarks, { color: '#ffffff', lineWidth: 2, radius: 4 });
    }
  }
  canvasCtx.restore();

  // If mouse is being used, prioritize it or at least don't let hands interfere with drawing
  if (isMouseDown) return;

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const landmarks = results.multiHandLandmarks[0];
    const indexTipPos = landmarks[8];

    mouseNDC.x = (1 - indexTipPos.x) * 2 - 1;
    mouseNDC.y = (1 - indexTipPos.y) * 2 - 1;

    raycaster.setFromCamera(mouseNDC, camera);
    raycaster.ray.intersectPlane(drawingPlane, intersectionPoint);

    const getDist = (l1: any, l2: any) => Math.sqrt(Math.pow(l1.x - l2.x, 2) + Math.pow(l1.y - l2.y, 2) + Math.pow(l1.z - l2.z, 2));
    const indexDist = getDist(landmarks[8], landmarks[5]);
    const middleDist = getDist(landmarks[12], landmarks[9]);
    const ringDist = getDist(landmarks[16], landmarks[13]);
    const pinkyDist = getDist(landmarks[20], landmarks[17]);

    const indexExtended = indexDist > 0.10;
    const othersFolded = middleDist < 0.07 && ringDist < 0.07 && pinkyDist < 0.07;
    const rawIsPointing = indexExtended && othersFolded;

    if (rawIsPointing) {
      gestureBuffer = Math.min(gestureBuffer + 1, GESTURE_THRESHOLD_EXIT);
    } else {
      gestureBuffer = Math.max(gestureBuffer - 1, 0);
    }

    if (gestureBuffer >= GESTURE_THRESHOLD_START) stablePointing = true;
    if (gestureBuffer === 0) stablePointing = false;

    const isPointing = stablePointing;

    const currentPos = intersectionPoint.clone();
    smoothedPos.lerp(currentPos, LERP_FACTOR);
    cursor.position.copy(smoothedPos);
    cursor.visible = true;

    // Discrete cursor sparkles: 2 when pointing, 0 when idle
    emitSparkle(smoothedPos, isPointing ? 2 : 0);

    const isPinching = getDist(landmarks[8], landmarks[4]) < 0.08;
    const isOpen = indexExtended && middleDist > 0.12 && ringDist > 0.12;

    if (isPointing) {
      if (!isDrawing) startDrawing(smoothedPos);
      else updateDrawing(smoothedPos);
    } else if (isDrawing) {
      endDrawing();
    } else if (isPinching) {
      handleGrab(smoothedPos);
    } else if (isOpen) {
      releaseGrab();
    }
  } else {
    if (!isMouseDown) cursor.visible = false;
  }
}

hands.onResults(onResults);

const cameraUtils = new Camera(videoElement, {
  onFrame: async () => {
    if (videoElement.videoWidth > 0 && canvasElement.width !== videoElement.videoWidth) {
      canvasElement.width = videoElement.videoWidth;
      canvasElement.height = videoElement.videoHeight;
    }
    await hands.send({ image: videoElement });
  },
  width: 640,
  height: 480,
});
cameraUtils.start();

// --- Solidification ---
async function solidify() {
  if (currentPath.length < 2 || !currentLine) {
    if (currentLine) scene.remove(currentLine);
    currentLine = null;
    return;
  }

  // Check if closed loop
  const start = currentPath[0];
  const end = currentPath[currentPath.length - 1];
  const isClosed = start.distanceTo(end) < 0.5 && currentPath.length > 5;

  let finalObj: THREE.Object3D;
  const color = '#3b82f6';

  if (isClosed) {
    // Create 3D Extruded Shape
    const shape = new THREE.Shape();
    shape.moveTo(currentPath[0].x, currentPath[0].y);
    for (let i = 1; i < currentPath.length; i++) {
      shape.lineTo(currentPath[i].x, currentPath[i].y);
    }
    shape.closePath();

    const extrudeSettings = {
      steps: 2,
      depth: 0.1,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelOffset: 0,
      bevelSegments: 5
    };

    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    const material = new THREE.MeshPhysicalMaterial({
      color: color,
      metalness: 0.1,
      roughness: 0.2,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
    });

    finalObj = new THREE.Mesh(geometry, material);
    scene.remove(currentLine); // Remove the temporary 2D line
  } else {
    // Only shapes should be saved on the canvas
    scene.remove(currentLine);
    currentLine = null;
    return;
  }

  // Center the geometry for better grabbing/moving
  if (finalObj instanceof THREE.Mesh || finalObj instanceof Line2) {
    (finalObj as any).geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    (finalObj as any).geometry.boundingBox!.getCenter(center);
    (finalObj as any).geometry.translate(-center.x, -center.y, -center.z);
    finalObj.position.copy(center);
  }

  scene.add(finalObj);
  solidifiedObjects.push(finalObj);
  (finalObj as any).userData = { isShape: isClosed };

  // Show Metadata Modal after a short delay so the user can see the shape first
  activeObjectForMetadata = finalObj;
  activePathForMetadata = [...currentPath];
  if (modal && modalNameInput && modalDescInput) {
    setTimeout(() => {
      if (modal && modalNameInput && modalDescInput) {
        modalNameInput.value = '';
        modalDescInput.value = '';
        modal.classList.add('active');
        setTimeout(() => modalNameInput.focus(), 100);
      }
    }, 3000);
  }

  currentLine = null;
}

modalSaveBtn?.addEventListener('click', async () => {
  if (!activeObjectForMetadata || !modal) return;

  const name = modalNameInput?.value || 'Untitled Creation';
  const description = modalDescInput?.value || '';

  activeObjectForMetadata.userData.name = name;
  activeObjectForMetadata.userData.description = description;

  modal.classList.remove('active');

  if (supabase) {
    const { data, error } = await supabase
      .from('drawings')
      .insert({
        points: activePathForMetadata.map(p => ({ x: p.x, y: p.y, z: p.z })),
        color: '#3b82f6',
        position: { x: activeObjectForMetadata.position.x, y: activeObjectForMetadata.position.y, z: activeObjectForMetadata.position.z },
        is_shape: activeObjectForMetadata.userData.isShape,
        name: name,
        description: description
      })
      .select('id')
      .single();

    if (data) (activeObjectForMetadata as any).userData.id = data.id;
    if (error) console.error('Supabase Error:', error);
  }

  activeObjectForMetadata = null;
  activePathForMetadata = [];
});

document.getElementById('cancel-metadata')?.addEventListener('click', () => {
  if (modal) {
    modal.classList.remove('active');
  }
  activeObjectForMetadata = null;
  activePathForMetadata = [];
});

function createSolidObject(points: THREE.Vector3[], color: string, pos: { x: number, y: number, z: number }, id: string, isShape: boolean = false, draw?: any) {
  if (points.length < 2 || !isShape) return;

  let obj: THREE.Object3D;
  const threeColor = new THREE.Color(color);

  if (isShape) {
    const shape = new THREE.Shape();
    shape.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      shape.lineTo(points[i].x, points[i].y);
    }
    shape.closePath();

    const extrudeSettings = {
      steps: 2,
      depth: 0.1,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelOffset: 0,
      bevelSegments: 5
    };

    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    const material = new THREE.MeshPhysicalMaterial({
      color: threeColor,
      metalness: 0.1,
      roughness: 0.2,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
    });
    obj = new THREE.Mesh(geometry, material);
  } else {
    const geometry = new LineGeometry();
    geometry.setPositions(points.flatMap(p => [p.x, p.y, p.z]));

    const material = new LineMaterial({
      color: threeColor,
      linewidth: 100,
      transparent: true,
      opacity: 0.9
    });
    material.resolution.set(window.innerWidth, window.innerHeight);

    obj = new Line2(geometry, material);
    (obj as Line2).computeLineDistances();
  }

  // Center geometry
  if (obj instanceof THREE.Mesh || obj instanceof Line2) {
    (obj as any).geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    (obj as any).geometry.boundingBox!.getCenter(center);
    (obj as any).geometry.translate(-center.x, -center.y, -center.z);
  }

  obj.position.set(pos.x, pos.y, pos.z);
  (obj as any).userData = { id, isShape, name: (draw as any)?.name, description: (draw as any)?.description };

  scene.add(obj);
  solidifiedObjects.push(obj);
}

// --- Persistence ---
async function fetchDrawings() {
  if (!supabase) return;
  const { data, error } = await supabase.from('drawings').select('*');
  if (error) {
    console.error('Fetch Error:', error);
    return;
  }
  if (data) {
    data.forEach(draw => {
      const points = draw.points.map((p: any) => new THREE.Vector3(p.x, p.y, p.z));
      createSolidObject(points, draw.color || '#3b82f6', draw.position || { x: 0, y: 0, z: 0 }, draw.id, draw.is_shape, draw);
    });
  }
}

// Initial Fetch and Subscribe
fetchDrawings();

if (supabase) {
  supabase
    .channel('schema-db-changes')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'drawings' },
      (payload) => {
        const draw = payload.new as any;
        const points = draw.points.map((p: any) => new THREE.Vector3(p.x, p.y, p.z));
        createSolidObject(points, draw.color || '#3b82f6', draw.position || { x: 0, y: 0, z: 0 }, draw.id, draw.is_shape, draw);
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'drawings' },
      (payload) => {
        const draw = payload.new as any;
        const obj = solidifiedObjects.find(o => (o as any).userData?.id === draw.id);
        if (obj && draw.position) {
          obj.position.set(draw.position.x, draw.position.y, draw.position.z);
        }
      }
    )
    .subscribe();
}

// --- Render Loop ---
function animate() {
  requestAnimationFrame(animate);

  // Update Sparkles
  for (let i = sparkles.length - 1; i >= 0; i--) {
    if (!sparkles[i].update()) {
      sparkles.splice(i, 1);
    }
  }

  // Update static glitter particles (color cycling)
  const time = performance.now() / 1000;
  for (const gp of glitterParticles) {
    gp.update(time);
  }

  // Spin 3D shapes
  solidifiedObjects.forEach(obj => {
    if ((obj as any).userData?.isShape) {
      obj.rotation.y += 0.01;
      obj.rotation.x += 0.004;
      if (Math.random() > 0.98) emitSparkle(obj.position, 1);
    }
  });

  renderer.render(scene, camera);
}
animate();

// Clear Local Session
document.getElementById('clear-btn')?.addEventListener('click', () => {
  solidifiedObjects.forEach(obj => scene.remove(obj as any));
  solidifiedObjects.length = 0;
  // Clean up glitter particles
  glitterParticles.forEach(gp => gp.dispose());
  glitterParticles.length = 0;
  if (currentLine) {
    scene.remove(currentLine);
    currentLine = null;
  }
});

// Handle Resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Update Line Materials Resolution
  solidifiedObjects.forEach(obj => {
    if (obj instanceof Line2) {
      (obj as any).material.resolution.set(window.innerWidth, window.innerHeight);
    }
  });
  if (currentLine) {
    (currentLine.material as any).resolution.set(window.innerWidth, window.innerHeight);
  }
});
