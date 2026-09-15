import { useState, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Shape } from '../store';

// ═══════════════════════════════════════════════════════════════════════════
// GizmoDot — taşıma (referans köşe) ve döndürme (pivot) gizmolarının ORTAK
// köşe noktası. Tek tasarım, tek davranış:
//  • Nokta sahnenin İÇİNDE, köşenin tam dünya konumunda duran kameraya dönük
//    bir disktir; boyutu her karede "1 piksel kaç mm" ile ekranda sabit
//    tutulur → her zoom/açıda köşenin üstünde. (DOM/Html katmanı köşeden
//    kayıyordu, çakışma çözümü de pikselle itiyordu — ikisi de kaldırıldı.)
//  • depthTest kapalı: panelin arkasında kalsa da görünür; tıklama önceliği
//    panellerin önünde.
//  • Gerçek köşeler: özellik kenarlarının YÖN DEĞİŞTİRDİĞİ noktalar; düz
//    kenar ortasındaki tesselasyon ara noktaları köşe sayılmaz.
// ═══════════════════════════════════════════════════════════════════════════

export const DOT_RENDER_ORDER = 1009;
const DOT_UNIT = new THREE.CircleGeometry(1, 32);
const DOT_IVORY = '#fffdf9';

/** Dünya biriminde "1 CSS pikselin karşılığı" — perspektif ve ortografik için. */
export function worldPerPixel(camera: THREE.Camera, viewportHeight: number, worldPos: THREE.Vector3): number {
  const persp = camera as THREE.PerspectiveCamera;
  if (persp.isPerspectiveCamera) {
    const dist = persp.position.distanceTo(worldPos);
    return (2 * Math.tan(((persp.fov * Math.PI) / 180) / 2) * dist) / Math.max(viewportHeight, 1);
  }
  const ortho = camera as THREE.OrthographicCamera;
  const span = (ortho.top - ortho.bottom) / (ortho.zoom || 1);
  return span / Math.max(viewportHeight, 1);
}

export interface GizmoDotProps {
  position: [number, number, number];
  isSelected: boolean;
  /** Aksan rengi: kaynak/pivot koyu taş, hedef turuncu. */
  accent?: string;
  onClick: (pos: [number, number, number]) => void;
  groupRef?: (g: THREE.Group | null) => void;
}

export function GizmoDot({ position, isSelected, accent = '#44403c', onClick, groupRef }: GizmoDotProps) {
  const [hovered, setHovered] = useState(false);
  const g = useRef<THREE.Group | null>(null);
  const filled = hovered || isSelected;
  const diameterPx = isSelected ? 12 : hovered ? 13 : 10;

  useFrame(({ camera, size }) => {
    const o = g.current;
    if (!o) return;
    o.quaternion.copy(camera.quaternion);
    const wpp = worldPerPixel(camera, size.height, o.position);
    o.scale.setScalar((diameterPx / 2) * wpp);
  });

  // Tıklama önceliği: disk panellerin önünde sayılsın (mesafe 0); gizliyken
  // (çakışan köşe) hiç yakalanmasın.
  const hitRaycast = function (this: THREE.Mesh, rc: THREE.Raycaster, hits: THREE.Intersection[]) {
    if (!g.current?.visible) return;
    const before = hits.length;
    THREE.Mesh.prototype.raycast.call(this, rc, hits);
    for (let i = before; i < hits.length; i++) hits[i].distance = 0;
  };

  const mat = (color: string, opacity = 1) => (
    <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} toneMapped={false} />
  );

  return (
    <group
      ref={el => { g.current = el; groupRef?.(el); }}
      position={position}
      renderOrder={DOT_RENDER_ORDER}
    >
      {isSelected && (
        <mesh geometry={DOT_UNIT} scale={2.1} renderOrder={DOT_RENDER_ORDER} raycast={() => null}>
          {mat(accent, 0.2)}
        </mesh>
      )}
      <mesh geometry={DOT_UNIT} scale={1.3} position={[0.12, -0.18, 0]} renderOrder={DOT_RENDER_ORDER + 1} raycast={() => null}>
        {mat('#281e14', 0.22)}
      </mesh>
      <mesh geometry={DOT_UNIT} renderOrder={DOT_RENDER_ORDER + 2} raycast={() => null}>
        {mat(filled ? DOT_IVORY : accent)}
      </mesh>
      <mesh geometry={DOT_UNIT} scale={0.6} renderOrder={DOT_RENDER_ORDER + 3} raycast={() => null}>
        {mat(filled ? accent : DOT_IVORY)}
      </mesh>
      <mesh
        geometry={DOT_UNIT}
        scale={2.4}
        raycast={hitRaycast}
        onClick={e => { e.stopPropagation(); onClick(position); }}
        onPointerOver={e => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default'; }}
      >
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

export function panelWorldMatrix(panelShape: Shape): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...panelShape.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
    new THREE.Vector3(...panelShape.scale)
  );
}

/** Gerçek köşeler (dünya): özellik kenarlarının yön değiştirdiği noktalar. */
export function computeRealCorners(panelShape: Shape): [number, number, number][] {
  if (!panelShape.geometry) return [];
  const edges = new THREE.EdgesGeometry(panelShape.geometry, 1);
  const ep = edges.getAttribute('position') as THREE.BufferAttribute;
  const k = (x: number, y: number, z: number) => `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
  const incident = new Map<string, THREE.Vector3[]>();
  const pts = new Map<string, THREE.Vector3>();
  for (let i = 0; i + 1 < ep.count; i += 2) {
    const a = new THREE.Vector3(ep.getX(i), ep.getY(i), ep.getZ(i));
    const b = new THREE.Vector3(ep.getX(i + 1), ep.getY(i + 1), ep.getZ(i + 1));
    if (a.distanceToSquared(b) < 1e-8) continue;
    const ka = k(a.x, a.y, a.z), kb = k(b.x, b.y, b.z);
    const d = b.clone().sub(a).normalize();
    if (!incident.has(ka)) incident.set(ka, []);
    if (!incident.has(kb)) incident.set(kb, []);
    incident.get(ka)!.push(d.clone());
    incident.get(kb)!.push(d.clone().negate());
    pts.set(ka, a); pts.set(kb, b);
  }
  edges.dispose();
  const mat = panelWorldMatrix(panelShape);
  const result: [number, number, number][] = [];
  for (const [key, v] of pts) {
    const dirs = incident.get(key);
    if (!dirs || dirs.length === 0) continue;
    if (dirs.length === 2 && dirs[0].dot(dirs[1]) < -0.999) continue; // düz kenarın ara noktası
    const w = v.clone().applyMatrix4(mat);
    result.push([w.x, w.y, w.z]);
  }
  return result;
}

/**
 * Ekranda TAM üst üste binen (≤ overlapPx) noktalardan yalnız kameraya en yakın
 * olanı görünür bırakır; `preferred` (seçili) noktalar her zaman görünür.
 * Nokta konumu asla ötelenmez. Her karede çağrılır.
 */
export function resolveDotOverlap(
  camera: THREE.Camera,
  size: { width: number; height: number },
  marks: Array<{ pos: [number, number, number]; group: number }>,
  preferred: (i: number) => boolean,
  groups: (THREE.Group | null)[],
  tmp: THREE.Vector3,
  overlapPx = 4,
): void {
  const n = marks.length;
  if (!n) return;
  const sx = new Array<number>(n), sy = new Array<number>(n), dist = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const p = marks[i].pos;
    tmp.set(p[0], p[1], p[2]);
    dist[i] = camera.position.distanceTo(tmp);
    const v = tmp.project(camera);
    sx[i] = (v.x * 0.5 + 0.5) * size.width;
    sy[i] = (1 - (v.y * 0.5 + 0.5)) * size.height;
  }
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (Number(preferred(b)) - Number(preferred(a))) || (dist[a] - dist[b]));
  const shown: number[] = [];
  const visible = new Array<boolean>(n).fill(false);
  for (const i of order) {
    let clash = false;
    for (const j of shown) {
      if (marks[j].group !== marks[i].group) continue;
      if (Math.hypot(sx[i] - sx[j], sy[i] - sy[j]) < overlapPx) { clash = true; break; }
    }
    if (!clash) { shown.push(i); visible[i] = true; }
  }
  for (let i = 0; i < n; i++) {
    const el = groups[i];
    if (el && el.visible !== visible[i]) el.visible = visible[i];
  }
}
