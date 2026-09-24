import * as THREE from 'three';

export interface VertexModification {
  vertexIndex: number;
  originalPosition: [number, number, number];
  newPosition: [number, number, number];
  direction: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
  expression: string;
  description?: string;
  offset: [number, number, number];
}

export interface ShapeVertexData {
  shapeId: string;
  modifications: VertexModification[];
}

export type VertexEditMode = 'select' | 'direction' | 'input';

export interface VertexState {
  selectedVertexIndex: number | null;
  hoveredVertexIndex: number | null;
  currentDirection: 'x' | 'y' | 'z';
  editMode: VertexEditMode;
  pendingOffset: number;
}

export function getBoxVertices(width: number, height: number, depth: number): THREE.Vector3[] {
  const w2 = width / 2;
  const h2 = height / 2;
  const d2 = depth / 2;

  return [
    new THREE.Vector3(-w2, -h2, -d2),
    new THREE.Vector3(w2, -h2, -d2),
    new THREE.Vector3(w2, h2, -d2),
    new THREE.Vector3(-w2, h2, -d2),
    new THREE.Vector3(-w2, -h2, d2),
    new THREE.Vector3(w2, -h2, d2),
    new THREE.Vector3(w2, h2, d2),
    new THREE.Vector3(-w2, h2, d2),
  ];
}

export async function getReplicadVertices(replicadShape: any): Promise<THREE.Vector3[]> {
  try {
    let vertices: any[] = [];

    if (typeof replicadShape.vertices === 'function') {
      vertices = replicadShape.vertices();
    } else if (Array.isArray(replicadShape.vertices)) {
      vertices = replicadShape.vertices;
    } else {
      const mesh = replicadShape.mesh({ tolerance: 0.1, angularTolerance: 30 });
      if (mesh && mesh.vertices) {
        const uniqueVertices = new Map<string, THREE.Vector3>();
        for (let i = 0; i < mesh.vertices.length; i += 3) {
          const x = Math.round(mesh.vertices[i] * 100) / 100;
          const y = Math.round(mesh.vertices[i + 1] * 100) / 100;
          const z = Math.round(mesh.vertices[i + 2] * 100) / 100;
          const key = `${x},${y},${z}`;
          if (!uniqueVertices.has(key)) {
            uniqueVertices.set(key, new THREE.Vector3(x, y, z));
          }
        }
        return Array.from(uniqueVertices.values());
      }
    }

    if (!vertices || !Array.isArray(vertices) || vertices.length === 0) {
      return [];
    }

    console.log(`Found ${vertices.length} vertices`);

    const vertexPositions = vertices.map((v: any, idx: number) => {
      console.log(`Vertex ${idx}:`, v);

      if (v && typeof v.point === 'function') {
        const point = v.point();
        console.log(`  Point from function:`, point);
        return new THREE.Vector3(point[0], point[1], point[2]);
      } else if (Array.isArray(v)) {
        console.log(`  Point from array:`, v);
        return new THREE.Vector3(v[0], v[1], v[2]);
      } else if (v && typeof v.x === 'number') {
        console.log(`  Point from x,y,z:`, v);
        return new THREE.Vector3(v.x, v.y, v.z);
      }
      return null;
    }).filter((v: THREE.Vector3 | null): v is THREE.Vector3 => v !== null);

    console.log(`✅ Extracted ${vertexPositions.length} vertices from Replicad shape`);
    return vertexPositions;
  } catch (error) {
    console.error('❌ Failed to get Replicad vertices:', error);
    console.error('Error details:', error);
    return [];
  }
}

/**
 * VERTEX DÜZENLEME — TEK KAYNAK TABAN LİSTESİ.
 * Editördeki noktalar, terminal işleyicisi (handleVertexOffset) ve sahnedeki
 * mesh AYNI listeyi kullanmak ZORUNDA: vertexIndex bu listenin indeksidir,
 * mesh tamponunun indeksi DEĞİL. Öncelik VertexEditor ile birebir:
 * scaledBaseVertices → replicad köşeleri → kutu parametreleri.
 */
export async function resolveBaseVertices(shape: any): Promise<THREE.Vector3[]> {
  const p = shape?.parameters;
  if (!p) return [];
  if (Array.isArray(p.scaledBaseVertices) && p.scaledBaseVertices.length > 0) {
    return p.scaledBaseVertices.map((v: number[]) => new THREE.Vector3(v[0], v[1], v[2]));
  }
  if (shape.replicadShape) return getReplicadVertices(shape.replicadShape);
  if (shape.type === 'box') return getBoxVertices(p.width, p.height, p.depth);
  return [];
}

/**
 * Her köşenin NİHAİ konumu: taban köşeden başlanır, o köşeye ait her düzenleme
 * yalnız KENDİ ekseninde newPosition değerini yazar (aynı eksende sonraki kazanır).
 * Eski kod köşe başına ilk düzenlemeyi alıyor / tüm newPosition'ı kopyalıyordu —
 * aynı köşede X sonra Y taşıyınca ilki kayboluyordu.
 */
export function composeVertexTargets(base: THREE.Vector3[], mods: any[] | undefined): Map<number, THREE.Vector3> {
  const out = new Map<number, THREE.Vector3>();
  for (const mod of mods || []) {
    const b = base[mod?.vertexIndex];
    if (!b || !mod?.direction || !Array.isArray(mod.newPosition)) continue;
    const ai = mod.direction.startsWith('x') ? 0 : mod.direction.startsWith('y') ? 1 : 2;
    const t = out.get(mod.vertexIndex) || b.clone();
    t.setComponent(ai, mod.newPosition[ai]);
    out.set(mod.vertexIndex, t);
  }
  return out;
}

/**
 * VERTEX DÜZENLEMELERİNİ GEOMETRİYE UYGULA (koordinat eşlemeli, sırasız).
 * Her düzenleme kendi `originalPosition`'ını taşır; mesh'te o koordinattaki
 * TÜM kopyalar (bir köşe 3 yüzde 3+ kez bulunur) bulunur ve yalnız düzenlemenin
 * EKSENİ hedef değere çekilir (aynı köşede X sonra Y taşımaları birleşir).
 * Taban listesine/indeksine ihtiyaç yok → senkron, her geometride çalışır.
 * Girdi değişmez; düzenleme yoksa girdinin KENDİSİ döner (klon yok).
 */
export function applyVertexModsToGeometry(
  base: THREE.BufferGeometry, mods: any[] | undefined
): THREE.BufferGeometry {
  if (!base || !Array.isArray(mods) || mods.length === 0) return base;
  const src = base.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!src) return base;
  const geom = base.clone();
  const attr = geom.getAttribute('position') as THREE.BufferAttribute;
  const positions = attr.array as Float32Array;
  const K = (x: number, y: number, z: number) =>
    `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100},${Math.round(z * 100) / 100}`;
  const vertexMap = new Map<string, number[]>();
  for (let i = 0; i < positions.length; i += 3) {
    const key = K(positions[i], positions[i + 1], positions[i + 2]);
    const g = vertexMap.get(key); if (g) g.push(i); else vertexMap.set(key, [i]);
  }
  // Aynı taban köşeye ait düzenlemeler eksen bazlı birleştirilir.
  const targets = new Map<string, { idx: number[]; t: [number, number, number] }>();
  for (const mod of mods) {
    const op = mod?.originalPosition, np = mod?.newPosition, d = mod?.direction;
    if (!Array.isArray(op) || !Array.isArray(np) || typeof d !== 'string') continue;
    const key = K(op[0], op[1], op[2]);
    const idx = vertexMap.get(key);
    if (!idx) continue;
    const ai = d.startsWith('x') ? 0 : d.startsWith('y') ? 1 : 2;
    const e = targets.get(key) || { idx, t: [op[0], op[1], op[2]] as [number, number, number] };
    e.t[ai] = np[ai];
    targets.set(key, e);
  }
  targets.forEach(({ idx, t }) => {
    for (const i of idx) { positions[i] = t[0]; positions[i + 1] = t[1]; positions[i + 2] = t[2]; }
  });
  attr.needsUpdate = true;
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/** Düzenleme listesinin kimliği (önbellek anahtarı). */
export function vertexModsKey(mods: any[] | undefined): string {
  if (!Array.isArray(mods) || mods.length === 0) return '';
  return JSON.stringify(mods.map(m => [m?.vertexIndex, m?.direction, m?.originalPosition, m?.newPosition]));
}

/**
 * ETKİN GÖVDE GEOMETRİSİ — vertex düzenlemeleri uygulanmış gövde.
 * SÖZLEŞME: store'daki `shape.geometry` her zaman TABAN'dır (replicad çıktısı);
 * düzenlemeler çizimde, panel yerleştirmede (yüz yakalama), VF yeniden
 * hesabında ve motorun gövde kutusunda BU fonksiyonla uygulanır. Böylece küpün
 * "yeni şekli" tek kaynaktan gelir; panel, düzenlenmiş yüze yerleşir.
 * Düzenleme yoksa `shape.geometry`'nin kendisi döner (davranış değişmez).
 * Önbellek: taban geometri × düzenleme anahtarı.
 */
const _effCache = new WeakMap<THREE.BufferGeometry, { key: string; geo: THREE.BufferGeometry }>();
export function effectiveBodyGeometry(shape: any): THREE.BufferGeometry {
  const base: THREE.BufferGeometry | undefined = shape?.geometry;
  if (!base) return base as any;
  const key = vertexModsKey(shape.vertexModifications);
  if (!key) return base;
  const hit = _effCache.get(base);
  if (hit && hit.key === key) return hit.geo;
  const geo = applyVertexModsToGeometry(base, shape.vertexModifications);
  _effCache.set(base, { key, geo });
  return geo;
}

export function applyVertexModifications(
  geometry: THREE.BufferGeometry,
  modifications: VertexModification[]
): THREE.BufferGeometry {
  const positionAttribute = geometry.getAttribute('position');
  const positions = positionAttribute.array as Float32Array;

  const vertexMap = new Map<number, THREE.Vector3>();

  modifications.forEach(mod => {
    const idx = mod.vertexIndex;

    if (!vertexMap.has(idx)) {
      vertexMap.set(idx, new THREE.Vector3(
        positions[idx * 3],
        positions[idx * 3 + 1],
        positions[idx * 3 + 2]
      ));
    }

    const currentPos = vertexMap.get(idx)!;
    currentPos.x += mod.offset[0];
    currentPos.y += mod.offset[1];
    currentPos.z += mod.offset[2];
  });

  vertexMap.forEach((pos, idx) => {
    positions[idx * 3] = pos.x;
    positions[idx * 3 + 1] = pos.y;
    positions[idx * 3 + 2] = pos.z;
  });

  positionAttribute.needsUpdate = true;
  geometry.computeVertexNormals();

  return geometry;
}

export function getVertexWorldPosition(
  vertex: THREE.Vector3,
  objectMatrix: THREE.Matrix4
): THREE.Vector3 {
  return vertex.clone().applyMatrix4(objectMatrix);
}

export function getDirectionVector(direction: 'x' | 'y' | 'z'): THREE.Vector3 {
  switch (direction) {
    case 'x':
      return new THREE.Vector3(1, 0, 0);
    case 'y':
      return new THREE.Vector3(0, 1, 0);
    case 'z':
      return new THREE.Vector3(0, 0, 1);
  }
}

export function cycleDirection(current: 'x' | 'y' | 'z'): 'x' | 'y' | 'z' {
  switch (current) {
    case 'x':
      return 'y';
    case 'y':
      return 'z';
    case 'z':
      return 'x';
  }
}
