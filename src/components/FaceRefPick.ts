import * as THREE from 'three';
import { extractFacesFromGeometry, groupCoplanarFaces, snapToFlatGroup } from './GeometryUtils';
import { pointInTriangle3D } from './FaceRegion';

// ─── REFERANS YÜZ SEÇİMİ: IŞIN BOYUNCA DERİNLİK DÖNGÜSÜ ─────────────────────
// Panel yerleştirirkenki (FaceRaycastOverlay) "aynı noktaya her tıklamada bir
// arkadaki yüze geç" davranışının, panel-extrude REFERANS seçimine taşınmış
// hâli. Fark: adaylar tek şekle değil, imlecin altındaki ışının deldiği TÜM
// şekillere (parent küp + paneller) yayılır. Küpün dış yüzüne tıklarsın, bir
// daha tıklarsan arkadaki panel yüzü, bir daha arkadakinin arkası... gelir.
//
// TEK KAYNAK: hem PanelDrawing hem ShapeWithTransform aynı fonksiyonu çağırır;
// döngü durumu (aynı ekran noktası + sıra indeksi) burada modül düzeyinde tutulur
// (aynı anda tek bir referans seçimi olduğundan güvenli).

export interface RefFaceCandidate {
  shapeId: string;
  faceGroupIndex: number;
  depth: number;
  pointWorld: [number, number, number];
  normalWorld: [number, number, number];
}

interface CachedGeom { uuid: string; faces: any[]; groups: any[]; }
const geomCache = new Map<string, CachedGeom>();

function getFacesGroups(geometry: THREE.BufferGeometry): { faces: any[]; groups: any[] } {
  const uuid = geometry.uuid;
  const hit = geomCache.get(uuid);
  if (hit) return hit;
  const faces = extractFacesFromGeometry(geometry);
  const groups = groupCoplanarFaces(faces);
  const entry = { uuid, faces, groups };
  // Basit LRU sınırı: cache şişmesin.
  if (geomCache.size > 64) geomCache.clear();
  geomCache.set(uuid, entry);
  return entry;
}

function shapeMatrix(s: any): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(s.position[0], s.position[1], s.position[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rotation[0], s.rotation[1], s.rotation[2], 'XYZ')),
    new THREE.Vector3(s.scale[0], s.scale[1], s.scale[2])
  );
}

// Işının deldiği tüm referans yüz gruplarını (parent küp + paneller, hedef
// panel hariç) derinliğe göre sıralı döndürür. Her aday DÜZ (snap edilmiş) gruba
// indirgenir; aynı şekilde aynı düz gruba düşen kopyalar (en yakın derinlik
// tutularak) elenir — böylece bir panelin ön/arka yüzü ayrı, aynı yüzün iç
// üçgenleri tek kalır.
export function gatherRefFaceCandidates(
  rayOrigin: THREE.Vector3,
  rayDir: THREE.Vector3,
  shapes: any[],
  targetPanelId: string | null
): RefFaceCandidate[] {
  const dir = rayDir.clone().normalize();
  const out: RefFaceCandidate[] = [];

  for (const s of shapes) {
    if (!s?.geometry) continue;
    if (s.id === targetPanelId) continue;

    const M = shapeMatrix(s);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(M);
    const { faces, groups } = getFacesGroups(s.geometry);

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const nWorld = group.normal.clone().normalize().applyMatrix3(normalMatrix).normalize();
      const denom = nWorld.dot(dir);
      if (Math.abs(denom) < 1e-6) continue;
      const planePt = group.center.clone().applyMatrix4(M);
      const t = planePt.clone().sub(rayOrigin).dot(nWorld) / denom;
      if (t < 0) continue;
      const hit = rayOrigin.clone().addScaledVector(dir, t);

      // Bu grubun üçgenlerinden biri, çarpma noktasını gerçekten içeriyor mu?
      let inside = false;
      for (const fi of group.faceIndices) {
        const f = faces[fi];
        if (!f) continue;
        const a = f.vertices[0].clone().applyMatrix4(M);
        const b = f.vertices[1].clone().applyMatrix4(M);
        const c = f.vertices[2].clone().applyMatrix4(M);
        if (pointInTriangle3D(hit, a, b, c)) { inside = true; break; }
      }
      if (!inside) continue;

      // Düz gruba indir; normalWorld'u snap edilen grubun normalinden hesapla.
      const snapped = snapToFlatGroup(gi, groups);
      const sGroup = groups[snapped] || group;
      const sNormalWorld = sGroup.normal.clone().normalize().applyMatrix3(normalMatrix).normalize();

      out.push({
        shapeId: s.id,
        faceGroupIndex: snapped,
        depth: t,
        pointWorld: [hit.x, hit.y, hit.z],
        normalWorld: [sNormalWorld.x, sNormalWorld.y, sNormalWorld.z],
      });
    }
  }

  out.sort((a, b) => a.depth - b.depth);

  // Aynı (şekil, snap grubu) çiftini tekille (en yakın derinlik tutulur).
  const seen = new Set<string>();
  const dedup: RefFaceCandidate[] = [];
  for (const c of out) {
    const key = `${c.shapeId}#${c.faceGroupIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(c);
  }
  return dedup;
}

// Döngü durumu: son ekran noktası + sıra indeksi + bağlam anahtarı.
let lastPick: { x: number; y: number; index: number; ctx: string } | null = null;
const SAME_SPOT_PX = 6;

export function resetRefFacePick() { lastPick = null; }

// R3F tıklama olayından: ışın + ekran koordinatı ile adayları toplar, aynı
// noktada arka arkaya tıklamada bir sonraki derinliğe geçer, seçilen adayı
// faceExtrudeRefCandidate olarak yazar. Aday bulunduysa true döner.
export function cycleRefFacePickFromEvent(
  e: any,
  shapes: any[],
  targetPanelId: string | null,
  setCandidate: (v: { panelId: string; faceGroupIndex: number; normalWorld: [number, number, number]; pointWorld: [number, number, number] }) => void
): boolean {
  const ray: THREE.Ray | undefined = e?.ray;
  if (!ray) return false;
  const cands = gatherRefFaceCandidates(ray.origin.clone(), ray.direction.clone(), shapes, targetPanelId);
  if (cands.length === 0) return false;

  const sx = e?.nativeEvent?.clientX ?? 0;
  const sy = e?.nativeEvent?.clientY ?? 0;
  const ctx = String(targetPanelId ?? '');
  const sameSpot = !!lastPick && lastPick.ctx === ctx &&
    Math.hypot(sx - lastPick.x, sy - lastPick.y) < SAME_SPOT_PX;

  const index = sameSpot ? (lastPick!.index + 1) % cands.length : 0;
  lastPick = { x: sx, y: sy, index, ctx };

  const c = cands[index];
  setCandidate({
    panelId: c.shapeId,
    faceGroupIndex: c.faceGroupIndex,
    normalWorld: c.normalWorld,
    pointWorld: c.pointWorld,
  });
  return true;
}
