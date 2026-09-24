// Quinlan model preview: a lineup of instanced Quinlans in every gait (high and
// low detail) plus a turntable, and a single-model "studio" view. Open
// /src/npc/preview.html on the Vite dev server. Add ?manual to stop the render
// loop and drive frames from the console / Playwright via window.__quinlan.shot().
// It shows the textured model (public/models/, rows = LOD 0, 1, 2) when it loads;
// ?procedural shows the procedural one instead.

import {
  ACESFilmicToneMapping,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshNormalMaterial,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  MeshDepthMaterial,
  RGBADepthPacking,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type InstancedBufferAttribute,
  type Material,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  QUINLAN_GAIT,
  createQuinlanDepthMaterial,
  createQuinlanGeometry,
  createQuinlanInstancedGeometry,
  createQuinlanPreviewMaterial,
  patchQuinlanRigVertexShader,
  patchQuinlanVertexShader,
  quinlanFurPalette,
} from './quinlanModel';
import { loadQuinlanAsset } from './quinlanAsset';

const params = new URLSearchParams(location.search);
const manual = params.has('manual');
const asset = params.has('procedural') ? null : await loadQuinlanAsset();
// ?pose={"lean":0.3,...} overrides the model's pose adjustments (for tuning)
if (asset && params.has('pose')) asset.rig.pose = { ...asset.rig.pose, ...JSON.parse(params.get('pose')!) };
const uTime = { value: 0 };

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(manual ? 1 : Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0xaeb8bf);
const camera = new PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.05, 200);

const hemi = new HemisphereLight(0xdfe8f5, 0x6a5a48, 1.15);
scene.add(hemi);
const sun = new DirectionalLight(0xfff0dc, 2.6);
sun.position.set(-4, 7, -5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 30 });
scene.add(sun, sun.target);

// neutral ground with a 1 m grid
function gridTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#9c9a8c';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(60,58,50,0.35)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(40, 40);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const ground = new Mesh(new PlaneGeometry(40, 40), new MeshStandardMaterial({ map: gridTexture(), roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const waterMat = new MeshStandardMaterial({ color: 0x3d7f96, transparent: true, opacity: 0.5, roughness: 0.15, depthWrite: false });

// Quinlans
const geoHigh = asset ? asset.lods[0] : createQuinlanGeometry('high');
const geoMid = asset ? asset.lods[1] : geoHigh;
const geoLow = asset ? asset.lods[asset.lods.length - 1] : createQuinlanGeometry('low');
const mat = asset ? rigMaterial(true) : createQuinlanPreviewMaterial(uTime);
const matVC = asset ? rigMaterial(false) : mat;
const depthMat = asset ? rigDepthMaterial() : createQuinlanDepthMaterial(uTime);

function rigMaterial(textured: boolean): Material {
  const m = new MeshStandardMaterial({ vertexColors: true, map: textured ? asset!.albedo : null, roughness: 0.85, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = patchQuinlanRigVertexShader(shader.vertexShader, asset!.rig, textured);
  };
  m.customProgramCacheKey = () => `quinlan-rig-preview-${textured}`;
  return m;
}
function rigDepthMaterial(): MeshDepthMaterial {
  const m = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = patchQuinlanRigVertexShader(shader.vertexShader, asset!.rig, false);
  };
  m.customProgramCacheKey = () => 'quinlan-rig-depth';
  return m;
}

interface Crowd {
  mesh: InstancedMesh;
  anim: InstancedBufferAttribute;
}
function crowd(base: BufferGeometry, n: number, material?: Material): Crowd {
  const g = createQuinlanInstancedGeometry(base, n);
  const mesh = new InstancedMesh(g, material ?? (base === geoHigh ? mat : matVC), n);
  mesh.customDepthMaterial = material ? createQuinlanDepthMaterial(uTime) : depthMat;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return { mesh, anim: g.getAttribute('aAnim') as InstancedBufferAttribute };
}

const GAITS = [QUINLAN_GAIT.idle, QUINLAN_GAIT.walk, QUINLAN_GAIT.run, QUINLAN_GAIT.swim, QUINLAN_GAIT.sing, QUINLAN_GAIT.smile];
const NAMES = ['idle', 'walk', 'run (all fours)', 'swim', 'sit & sing', 'jaw-rub smile'];
// columns run right-to-left in X so that they read left-to-right from the front (-Z) camera
const COL_X = (i: number) => -(i - 2.5) * 1.9;
const ROW_Z = [0, 2.1, 4.2];
const SWIM_Y = 0.7;

const m4 = new Matrix4();
const q = new Quaternion();
const up = new Vector3(0, 1, 0);
const one = new Vector3(1, 1, 1);
const tmp = new Vector3();
const col = new Color();

const lineupHigh = crowd(geoHigh, GAITS.length + 1); // first row + turntable
const lineupMid = crowd(geoMid, GAITS.length);
const lineupLow = crowd(geoLow, GAITS.length);
const lineup: Crowd[] = [lineupHigh, lineupMid, lineupLow];
const TURN = GAITS.length;

function layoutLineup(turn: number) {
  GAITS.forEach((gait, i) => {
    for (let r = 0; r < 3; r++) {
      const c = lineup[r];
      const idx = i;
      const y = gait === QUINLAN_GAIT.swim ? SWIM_Y : 0;
      m4.compose(tmp.set(COL_X(i), y, ROW_Z[r]), q.identity(), one);
      c.mesh.setMatrixAt(idx, m4);
      const variant = (i * 0.37 + r * 0.29 + 0.11) % 1;
      c.anim.setXYZW(idx, gait, (r * 0.33 + i * 0.07) % 1, 1, variant);
      c.mesh.setColorAt(idx, quinlanFurPalette(variant, col));
    }
  });
  m4.compose(tmp.set(COL_X(6.3), 0, ROW_Z[1]), q.setFromAxisAngle(up, turn), one);
  lineupHigh.mesh.setMatrixAt(TURN, m4);
  lineupHigh.anim.setXYZW(TURN, QUINLAN_GAIT.idle, 0.5, 1, 0.5);
  lineupHigh.mesh.setColorAt(TURN, col.setRGB(1, 1, 1));
  for (const c of lineup) {
    c.mesh.instanceMatrix.needsUpdate = true;
    if (c.mesh.instanceColor) c.mesh.instanceColor.needsUpdate = true;
    c.anim.needsUpdate = true;
    c.mesh.computeBoundingSphere();
  }
}
layoutLineup(0);

const swimPool = new Mesh(new BoxGeometry(1.7, SWIM_Y, 6.4), waterMat);
swimPool.position.set(COL_X(3), SWIM_Y / 2, ROW_Z[1]);
swimPool.renderOrder = 2;
scene.add(swimPool);

function label(text: string, x: number, z: number): Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.font = '600 44px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(20,24,28,0.55)';
  g.fillRect(0, 12, 512, 72);
  g.fillStyle = '#fff';
  g.fillText(text, 256, 50);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  const s = new Sprite(new SpriteMaterial({ map: t, depthTest: false, toneMapped: false }));
  s.scale.set(1.6, 0.3, 1);
  s.position.set(x, 0.02, z);
  s.renderOrder = 5;
  scene.add(s);
  return s;
}
const labels = NAMES.map((n, i) => label(n, COL_X(i), -1.25));
labels.push(label('turntable', COL_X(6.3), -1.25));
(asset ? ['LOD 0', 'LOD 1', 'LOD 2'] : ['high', 'high', 'low']).forEach((t, r) => labels.push(label(t, COL_X(-1.05), ROW_Z[r])));

// studio: one high and one low model
const studioHigh = crowd(geoHigh, 1);
const studioLow = crowd(geoLow, 1);
const studioPool = new Mesh(new BoxGeometry(3.2, SWIM_Y, 3.2), waterMat);
studioPool.position.set(0.6, SWIM_Y / 2, 0);
studioPool.renderOrder = 2;
scene.add(studioPool);

export interface Shot {
  mode?: 'lineup' | 'studio' | 'variants' | 'materials';
  time?: number;
  gait?: number;
  phase?: number;
  cadence?: number;
  variant?: number;
  fur?: number;
  /** degrees; 0 = front (camera on -Z), 90 = the Quinlan's right side (+X), 180 = back */
  az?: number;
  el?: number;
  dist?: number;
  target?: [number, number, number];
  low?: boolean;
  both?: boolean;
  width?: number;
  height?: number;
  fov?: number;
  shadows?: boolean;
}

// variants: a row of idle Quinlans showing fur tints, clothing dyes and proportions
const VARIANTS = 8;
const variants = crowd(geoHigh, VARIANTS);
function layoutVariants() {
  for (let i = 0; i < VARIANTS; i++) {
    m4.compose(tmp.set(-(i - (VARIANTS - 1) / 2) * 0.95, 0, 0), q.identity(), one);
    variants.mesh.setMatrixAt(i, m4);
    const v = (i + 0.5) / VARIANTS;
    variants.anim.setXYZW(i, QUINLAN_GAIT.idle, (i * 0.37) % 1, 1, v);
    variants.mesh.setColorAt(i, quinlanFurPalette(v, col));
  }
  variants.mesh.instanceMatrix.needsUpdate = true;
  variants.mesh.instanceColor!.needsUpdate = true;
  variants.anim.needsUpdate = true;
  variants.mesh.computeBoundingSphere();
}
layoutVariants();

// materials: the same snippet injected into several built-in materials
function patched<T extends Material>(m: T, key: string): T {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = patchQuinlanVertexShader(shader.vertexShader);
  };
  m.customProgramCacheKey = () => `quinlan-${key}`;
  return m;
}
const MATERIALS: [string, Material][] = [
  ['basic', patched(new MeshBasicMaterial({ vertexColors: true }), 'basic')],
  ['lambert', patched(new MeshLambertMaterial({ vertexColors: true }), 'lambert')],
  ['phong flat', patched(new MeshPhongMaterial({ vertexColors: true, flatShading: true, shininess: 12 }), 'phong')],
  ['toon', patched(new MeshToonMaterial({ vertexColors: true }), 'toon')],
  ['normal', patched(new MeshNormalMaterial(), 'normal')],
  ['physical sheen', patched(new MeshPhysicalMaterial({ vertexColors: true, roughness: 0.8, sheen: 1, sheenColor: 0xd8b08a, sheenRoughness: 0.6 }), 'physical')],
];
const geoProcedural = asset ? createQuinlanGeometry('high') : geoHigh;
const materialRow = MATERIALS.map(([name, m], i) => {
  const c = crowd(geoProcedural, 1, m);
  const x = -(i - (MATERIALS.length - 1) / 2) * 1.05;
  m4.compose(tmp.set(x, 0, 0), q.identity(), one);
  c.mesh.setMatrixAt(0, m4);
  c.anim.setXYZW(0, i % 2 === 0 ? QUINLAN_GAIT.walk : QUINLAN_GAIT.sing, i * 0.19, 1, i / MATERIALS.length);
  c.mesh.setColorAt(0, quinlanFurPalette(i / MATERIALS.length, col));
  return { c, sprite: label(name, x, -0.9) };
});

function setMode(mode: 'lineup' | 'studio' | 'variants' | 'materials') {
  for (const { c, sprite } of materialRow) c.mesh.visible = sprite.visible = mode === 'materials';
  const lu = mode === 'lineup';
  for (const c of lineup) c.mesh.visible = lu;
  for (const l of labels) l.visible = lu;
  swimPool.visible = lu;
  studioPool.visible = false;
  studioHigh.mesh.visible = studioLow.mesh.visible = mode === 'studio';
  variants.mesh.visible = mode === 'variants';
}

function placeCamera(target: Vector3, az: number, el: number, dist: number) {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  camera.position.set(target.x + Math.sin(a) * Math.cos(e) * dist, target.y + Math.sin(e) * dist, target.z - Math.cos(a) * Math.cos(e) * dist);
  camera.lookAt(target);
  camera.updateMatrixWorld();
}

function shot(o: Shot = {}): string {
  const w = o.width ?? 1280, h = o.height ?? 720;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = o.fov ?? 35;
  camera.updateProjectionMatrix();
  const mode = o.mode ?? 'studio';
  setMode(mode);
  uTime.value = o.time ?? 0;
  renderer.shadowMap.enabled = o.shadows ?? true;
  if (mode === 'lineup') {
    layoutLineup(uTime.value * 0.6);
    placeCamera(new Vector3(...(o.target ?? [-0.9, 0.2, 2.0])), o.az ?? -8, o.el ?? 26, o.dist ?? 15.5);
  } else if (mode === 'variants' || mode === 'materials') {
    placeCamera(new Vector3(...(o.target ?? [0, 0.55, 0])), o.az ?? 0, o.el ?? 8, o.dist ?? 7.5);
  } else {
    const gait = o.gait ?? 0;
    const y = gait === QUINLAN_GAIT.swim ? SWIM_Y : 0;
    studioPool.visible = gait === QUINLAN_GAIT.swim;
    const both = o.both ?? false;
    const setOne = (c: Crowd, x: number, show: boolean) => {
      c.mesh.visible = show;
      m4.compose(tmp.set(x, y, 0), q.identity(), one);
      c.mesh.setMatrixAt(0, m4);
      c.anim.setXYZW(0, gait, o.phase ?? 0, o.cadence ?? 1, o.variant ?? 0.5);
      c.mesh.setColorAt(0, o.fur === undefined ? col.setRGB(1, 1, 1) : quinlanFurPalette(o.fur, col));
      c.mesh.instanceMatrix.needsUpdate = true;
      c.mesh.instanceColor!.needsUpdate = true;
      c.anim.needsUpdate = true;
      c.mesh.computeBoundingSphere();
    };
    setOne(studioHigh, both ? -0.55 : 0, both || !o.low);
    setOne(studioLow, both ? 0.55 : 0, both || !!o.low);
    const tgt = o.target ?? [0, y + 0.6, 0];
    placeCamera(new Vector3(...tgt), o.az ?? 0, o.el ?? 8, o.dist ?? 3.4);
  }
  sun.target.position.copy(camera.position).setY(0);
  sun.position.copy(sun.target.position).add(new Vector3(-4, 7, -5));
  sun.target.updateMatrixWorld();
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

function restBounds(g: BufferGeometry): string {
  const p = g.getAttribute('position');
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.count; i++) {
    const v = [p.getX(i), p.getY(i), p.getZ(i)];
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], v[k]);
      mx[k] = Math.max(mx[k], v[k]);
    }
  }
  return `x ${mn[0].toFixed(3)}..${mx[0].toFixed(3)}  y ${mn[1].toFixed(3)}..${mx[1].toFixed(3)}  z ${mn[2].toFixed(3)}..${mx[2].toFixed(3)}`;
}
const info = {
  trianglesHigh: geoHigh.userData.triangles as number,
  trianglesLow: geoLow.userData.triangles as number,
  verticesHigh: geoHigh.getAttribute('position').count,
  verticesLow: geoLow.getAttribute('position').count,
  boundsHigh: restBounds(geoHigh),
  boundsLow: restBounds(geoLow),
};
(window as unknown as { __quinlan: unknown }).__quinlan = { shot, info, renderer, scene, camera, uTime };
document.getElementById('hud')!.textContent =
  `Quinlan preview\nhigh: ${info.trianglesHigh} tris / ${info.verticesHigh} verts  ${info.boundsHigh}\nlow:  ${info.trianglesLow} tris / ${info.verticesLow} verts  ${info.boundsLow}`;

if (!manual) {
  setMode('lineup');
  renderer.setSize(window.innerWidth, window.innerHeight);
  placeCamera(new Vector3(-0.9, 0.2, 2.0), -8, 26, 15.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(-0.9, 0.4, 2.0);
  controls.update();
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });
  const t0 = performance.now();
  const loop = () => {
    uTime.value = (performance.now() - t0) / 1000;
    m4.compose(tmp.set(COL_X(6.3), 0, ROW_Z[1]), q.setFromAxisAngle(up, uTime.value * 0.6), one);
    lineupHigh.mesh.setMatrixAt(TURN, m4);
    lineupHigh.mesh.instanceMatrix.needsUpdate = true;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();
}
