import React, { useMemo, useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../store';
import type { VirtualFace, EdgeAnchor, NormalizedHitDistances } from '../store';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  createFaceHighlightGeometry,
  createFaceDescriptor,
  FaceData,
  CoplanarFaceGroup,
} from './FaceEditor';

export interface Point2D { x: number; y: number; }
interface RayLine { start: THREE.Vector3; end: THREE.Vector3; hit: boolean; }
interface FaceRaycastOverlayProps { shape: any; allShapes?: any[]; }

export function getFacePlaneAxes(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const n = normal.clone().normalize();
  const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(n, up).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v };
}

export function getShapeMatrix(shape: any): THREE.Matrix4 {
  if (!shape) return new THREE.Matrix4();
  const pos = new THREE.Vector3(...(shape.position || [0, 0, 0]));
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(shape.rotation || [0, 0, 0]), 'XYZ'));
  const scale = new THREE.Vector3(...(shape.scale || [1, 1, 1]));
  return new THREE.Matrix4().compose(pos, quat, scale);
}

export function collectBoundaryEdgesWorld(faces: FaceData[], faceIndices: number[], localToWorld: THREE.Matrix4): Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> {
  const edgeMap = new Map<string, { v1: THREE.Vector3; v2: THREE.Vector3; count: number }>();
  faceIndices.forEach(fi => {
    const face = faces[fi];
    if (!face) return;
    for (let i = 0; i < 3; i++) {
      const va = face.vertices[i].clone().applyMatrix4(localToWorld);
      const vb = face.vertices[(i + 1) % 3].clone().applyMatrix4(localToWorld);
      const key = [va, vb].map(v => `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`).sort().join('|');
      if (!edgeMap.has(key)) edgeMap.set(key, { v1: va, v2: vb, count: 0 });
      edgeMap.get(key)!.count++;
    }
  });
  return Array.from(edgeMap.values()).filter(e => e.count === 1).map(e => ({ v1: e.v1, v2: e.v2 }));
}

export function projectTo2D(p: THREE.Vector3, origin: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): Point2D {
  const d = new THREE.Vector3().subVectors(p, origin);
  return { x: d.dot(u), y: d.dot(v) };
}

export function computeVisibilityPolygon2D(
  segments: Array<{ ax: number; ay: number; bx: number; by: number }>,
  maxDist: number,
  fanCount: number = 32
): { poly: Point2D[]; samples: Point2D[] } {
  const angles: number[] = [];
  const EPS = 4e-3;
  for (const s of segments) {
    const a1 = Math.atan2(s.ay, s.ax), a2 = Math.atan2(s.by, s.bx);
    angles.push(a1 - EPS, a1, a1 + EPS, a2 - EPS, a2, a2 + EPS);
  }
  for (let i = 0; i < fanCount; i++) angles.push((i / fanCount) * Math.PI * 2 - Math.PI);
  angles.sort((a, b) => a - b);

  const samples: Point2D[] = [];
  let lastA = Infinity;
  for (const ang of angles) {
    if (Math.abs(ang - lastA) < 1e-6) continue;
    lastA = ang;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let minT = maxDist;
    for (const s of segments) {
      const denom = dx * (s.by - s.ay) - dy * (s.bx - s.ax);
      if (Math.abs(denom) < 1e-10) continue;
      const t = ((s.ax) * (s.by - s.ay) - (s.ay) * (s.bx - s.ax)) / denom;
      const uVal = ((s.ax) * dy - (s.ay) * dx) / denom;
      if (t > 1e-4 && uVal >= -1e-4 && uVal <= 1.0 + 1e-4 && t < minT) minT = t;
    }
    samples.push({ x: dx * minT, y: dy * minT });
  }
  return { poly: simplifyCollinear2D(samples, 0.05), samples };
}

export function simplifyCollinear2D(poly: Point2D[], eps: number): Point2D[] {
  if (poly.length < 3) return poly;
  const pts = poly.filter((p, i) => !i || Math.hypot(p.x - poly[i-1].x, p.y - poly[i-1].y) > eps);
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const n = pts.length, a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(cross) / (Math.hypot(c.x - a.x, c.y - a.y) || 1) <= eps) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

export function collectPanelObstacleEdgesWorld(
  panelShapes: any[],
  facePlaneNormal: THREE.Vector3,
  facePlaneOrigin: THREE.Vector3,
  planeTolerance: number = 1.5,
  boundaryEdges?: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>
): Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> {
  const obstacleEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> = [];
  
  for (const panel of panelShapes) {
    if (!panel.geometry) continue;
    const panelMatrix = getShapeMatrix(panel);
    const edgesGeo = new THREE.EdgesGeometry(panel.geometry);
    const pos = edgesGeo.getAttribute('position');
    const panelEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> = [];

    for (let i = 0; i < pos.count; i += 2) {
      const va = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(panelMatrix);
      const vb = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)).applyMatrix4(panelMatrix);
      const distA = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(va, facePlaneOrigin)));
      const distB = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(vb, facePlaneOrigin)));
      
      if (distA < planeTolerance && distB < planeTolerance) {
        panelEdges.push({ v1: va, v2: vb });
      }
    }
    edgesGeo.dispose();
    obstacleEdges.push(...panelEdges);
  }
  return obstacleEdges;
}

export function convexHull2D(points: Point2D[]): Point2D[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point2D, a: Point2D, b: Point2D) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  
  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

export function filterStrictCoplanarFaceIndices(
  faces: FaceData[],
  groupIndices: number[],
  localToWorld: THREE.Matrix4,
  normalMatrix: THREE.Matrix3,
  clickWorld: THREE.Vector3
): number[] {
  if (groupIndices.length === 0) return [];
  let bestIdx = groupIndices[0];
  let bestDist = Infinity;
  
  for (const fi of groupIndices) {
    const face = faces[fi];
    if (!face) continue;
    const nW = face.normal.clone().applyMatrix3(normalMatrix).normalize();
    const cw = face.center.clone().applyMatrix4(localToWorld);
    const d = new THREE.Vector3().subVectors(clickWorld, cw).length();
    if (d < bestDist) { bestDist = d; bestIdx = fi; }
  }
  return [bestIdx];
}

export function pickDominantEdgeDirection(
  boundaryEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  normal: THREE.Vector3
): THREE.Vector3 | null {
  if (boundaryEdges.length === 0) return null;
  const longestEdge = boundaryEdges.reduce((prev, current) => {
    const prevLen = prev.v1.distanceTo(prev.v2);
    const curLen = current.v1.distanceTo(current.v2);
    return curLen > prevLen ? current : prev;
  });
  return new THREE.Vector3().subVectors(longestEdge.v2, longestEdge.v1).normalize();
}

export function isPointInsidePolygon(p: Point2D, poly: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function subtractPolygon(subject: Point2D[], hole: Point2D[]): Point2D[] {
  // Basitleştirilmiş delik çıkarma filtresi
  return subject.filter(pt => !isPointInsidePolygon(pt, hole));
}

/**
 * FaceRaycastOverlay Bileşeni
 * Sadece seçilen yüzey (seçili VirtualFace) koordinatları üzerinde grid tabanlı ışınlar yayar.
 * Işınlar sadece belirtilen panellere (allShapes) veya Referans Kübüne çarpar.
 */
export function FaceRaycastOverlay({ shape, allShapes = [] }: FaceRaycastOverlayProps) {
  // Mağazadan aktif seçili yüzeyi, referans küpü ve 3D sahneyi çekiyoruz
  const { selectedFace, referenceCube, sceneRef } = useAppStore(state => ({
    selectedFace: state.selectedFace as VirtualFace | null,
    referenceCube: state.referenceCube as THREE.Mesh | null,
    sceneRef: state.sceneRef as React.RefObject<THREE.Scene> | null
  }));

  const [rays, setRays] = useState<RayLine[]>([]);

  useEffect(() => {
    if (!selectedFace || !sceneRef?.current) {
      setRays([]);
      return;
    }

    const scene = sceneRef.current;
    const faceNormal = new THREE.Vector3(...selectedFace.normal);
    const faceCenter = new THREE.Vector3(...selectedFace.center);
    
    // Yüzey düzlemine ait 2D eksenleri bulalım
    const { u, v } = getFacePlaneAxes(faceNormal);

    // Tarama yapılacak hedef 3D nesneleri toplayalım (Paneller ve Referans Kübü)
    const targets: THREE.Object3D[] = [];
    
    // Sahnede panelleri temsil eden mesh'leri bulup hedeflere ekleyelim
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        // Eğer obje bir referans kübüyse ya da adı panel şablonuyla eşleşiyorsa taranacak hedef yapalım
        if (child === referenceCube || child.name?.toLowerCase().includes('panel') || child.name?.toLowerCase().includes('shape')) {
          targets.push(child);
        }
      }
    });

    // Raycaster kurulumu
    const raycaster = new THREE.Raycaster();
    // Işınların yüzeyin kendi kalınlığına hemen çarpmaması için küçük bir ofset veriyoruz
    raycaster.near = 0.1;
    raycaster.far = 1000;

    const computedRays: RayLine[] = [];
    const gridSize = 8; // Yüzey üzerinde 8x8 tarama matrisi oluşturuyoruz
    const scanRadius = 150; // Tarama yapılacak lokal genişlik (mm)

    // Seçilen yüzeyin merkezinden dışarı doğru grid noktalarını tarayalım
    for (let i = -gridSize / 2; i <= gridSize / 2; i++) {
      for (let j = -gridSize / 2; j <= gridSize / 2; j++) {
        const offsetU = u.clone().multiplyScalar(i * (scanRadius / gridSize));
        const offsetV = v.clone().multiplyScalar(j * (scanRadius / gridSize));
        
        // Işın başlangıç noktası seçilen yüzeyin üstündedir
        const rayStart = faceCenter.clone().add(offsetU).add(offsetV);
        // Işın yönü seçilen yüzeyin normalinin tersine (yani içe doğru) gönderilir
        const rayDir = faceNormal.clone().negate().normalize();

        raycaster.set(rayStart, rayDir);
        const intersects = raycaster.intersectObjects(targets, true);

        if (intersects.length > 0) {
          // İlk çarpılan panel ya da referans kübünün noktası bitiş olarak ayarlanır
          computedRays.push({
            start: rayStart,
            end: intersects[0].point,
            hit: true
          });
        } else {
          // Eğer hiçbir şeye çarpmazsa sonsuza gitmemesi için belli bir mesafe çizilir
          computedRays.push({
            start: rayStart,
            end: rayStart.clone().addScaledVector(rayDir, 100),
            hit: false
          });
        }
      }
    }

    setRays(computedRays);
  }, [selectedFace, referenceCube, allShapes, sceneRef]);

  if (!selectedFace || rays.length === 0) return null;

  return (
    <group name="FaceRaycastVisualization">
      {/* Tarama noktalarını ve çarpan ışınları görselleştiren 3D çizgiler */}
      {rays.map((ray, idx) => (
        <group key={idx}>
          {/* Işın Çizgisi */}
          <line>
            <bufferGeometry attach="geometry" onUpdate={(self) => {
              self.setFromPoints([ray.start, ray.end]);
            }} />
            <lineBasicMaterial 
              attach="material" 
              color={ray.hit ? 0x00ffcc : 0xff3344} 
              opacity={0.6} 
              transparent 
              linewidth={1}
            />
          </line>
          
          {/* Çarpma Noktası (Kesişim Küresi) */}
          {ray.hit && (
            <mesh position={ray.end}>
              <sphereGeometry args={[2, 8, 8]} />
              <meshBasicMaterial color={0x00ffcc} />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}