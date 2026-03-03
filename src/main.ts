import * as THREE from 'three';
import { Hands, type Results, HAND_CONNECTIONS } from '@mediapipe/hands';
import { Camera } from '@mediapipe/camera_utils';
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils';
import { createClient } from '@supabase/supabase-js';

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
let currentLine: THREE.Line | null = null;
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

// No sparkles as requested

// Wand Tip Cursor
const cursorGeometry = new THREE.SphereGeometry(0.04, 8, 8);
const cursorMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  emissive: 0xffffff,
  emissiveIntensity: 10,
  transparent: true,
  opacity: 1
});
const cursor = new THREE.Mesh(cursorGeometry, cursorMaterial);
const cursorLight = new THREE.PointLight(0x3b82f6, 3, 5);
cursor.add(cursorLight);
scene.add(cursor);

// Manipulation State
let grabbedObject: THREE.Object3D | null = null; // Changed to Object3D to support Lines
let grabOffset = new THREE.Vector3();

// UI Status
const statusEl = document.getElementById('status');
function setStatus(msg: string) { if (statusEl) statusEl.innerText = msg; }

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
  setStatus('✨ Drawing...');
  updateStatusDot('#3b82f6');

  const geometry = new THREE.BufferGeometry().setFromPoints(currentPath);
  const material = new THREE.LineBasicMaterial({
    color: 0x3b82f6,
    linewidth: 10
  });
  currentLine = new THREE.Line(geometry, material);
  currentLine.frustumCulled = false;
  scene.add(currentLine);
}

function updateDrawing(point: THREE.Vector3) {
  if (!isDrawing || !currentLine) return;
  if (currentPath.length === 0 || currentPath[currentPath.length - 1].distanceTo(point) > 0.02) {
    currentPath.push(point.clone());
    const oldGeom = currentLine.geometry;
    currentLine.geometry = new THREE.BufferGeometry().setFromPoints(currentPath);
    oldGeom.dispose();
  }
}

function endDrawing() {
  if (!isDrawing) return;
  isDrawing = false;
  setStatus('Ready');
  updateStatusDot('#22c55e');
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

  if (isMouseDown) {
    updateDrawing(intersectionPoint);
  } else {
    // Hover cursor
    smoothedPos.lerp(intersectionPoint, LERP_FACTOR);
    cursor.position.copy(smoothedPos);
    cursor.visible = true;
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

    const currentPos = intersectionPoint.clone();
    smoothedPos.lerp(currentPos, LERP_FACTOR);
    cursor.position.copy(smoothedPos);
    cursor.visible = true;

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
    finalObj = currentLine;
  }

  // Center the geometry for better grabbing/moving
  if (finalObj instanceof THREE.Mesh || finalObj instanceof THREE.Line) {
    finalObj.geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    finalObj.geometry.boundingBox!.getCenter(center);
    finalObj.geometry.translate(-center.x, -center.y, -center.z);
    finalObj.position.copy(center);
  }

  scene.add(finalObj);
  solidifiedObjects.push(finalObj);
  (finalObj as any).userData = { isShape: isClosed };

  currentLine = null;

  if (supabase) {
    const { data, error } = await supabase
      .from('drawings')
      .insert({
        points: currentPath.map(p => ({ x: p.x, y: p.y, z: p.z })),
        color: color,
        position: { x: finalObj.position.x, y: finalObj.position.y, z: finalObj.position.z },
        is_shape: isClosed
      })
      .select('id')
      .single();

    if (data) (finalObj as any).userData.id = data.id;
    if (error) console.error('Supabase Error:', error);
  }
}

function createSolidObject(points: THREE.Vector3[], color: string, pos: { x: number, y: number, z: number }, id: string, isShape: boolean = false) {
  if (points.length < 2) return;

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
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: threeColor,
      linewidth: 10
    });
    obj = new THREE.Line(geometry, material);
  }

  // Center geometry
  if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
    obj.geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    obj.geometry.boundingBox!.getCenter(center);
    obj.geometry.translate(-center.x, -center.y, -center.z);
  }

  obj.position.set(pos.x, pos.y, pos.z);
  (obj as any).userData = { id, isShape };

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
      createSolidObject(points, draw.color || '#3b82f6', draw.position || { x: 0, y: 0, z: 0 }, draw.id, draw.is_shape);
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
        createSolidObject(points, draw.color || '#3b82f6', draw.position || { x: 0, y: 0, z: 0 }, draw.id, draw.is_shape);
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

  // Spin 3D Shapes
  solidifiedObjects.forEach(obj => {
    if ((obj as any).userData?.isShape) {
      obj.rotation.y += 0.01;
      obj.rotation.x += 0.004;
    }
  });

  renderer.render(scene, camera);
}
animate();

// Clear Local Session
document.getElementById('clear-btn')?.addEventListener('click', () => {
  solidifiedObjects.forEach(obj => scene.remove(obj as any));
  solidifiedObjects.length = 0;
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
});
