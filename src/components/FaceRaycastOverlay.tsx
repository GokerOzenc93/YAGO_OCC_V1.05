import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../store';
import type { VirtualFace } from '../store';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  createFaceHighlightGeometry,
  createFaceDescriptor,
  FaceData,
  CoplanarFaceGroup,
} from './FaceEditor';
import { convertReplicadToThreeGeometry } from './ReplicadService';

interface FaceRaycastOverlayProps { shape: any; allShapes?: any[]; }

export * from './FaceRegion';
import * as FR from './FaceRegion';
// Yerel kısayollar (UI gövdesi bare isim kullanır):
const {
  getFacePlaneAxes, getShapeMatrix, projectTo2D, raySegmentIntersect2D, getSubtractionWorldMatrix, getSubtractorFootprints2D, convexHull2D, pickDominantEdgeDirection, buildBoundaryLoop2D, sutherlandHodgmanClip, isInsideEdge, isConvexPolygon2D, lineIntersect2D, subtractPolygon, isPointInsidePolygon, findEdgeIntersections, segmentIntersect2D, traceHoleEdge, earClipTriangulate, pointInTriangle, sign, pointInTriangle3D, ensureCCW, castRayOnFaceWorldDetailed, castRayOnFaceWorld, panelFootprintOnPlane, findPanelCoveringPoint, isWorldPointInsidePanelFootprint, collectVirtualFaceObstacleEdgesWorld, computeFaceComponentContour, panelFootprintInParentLocal, traceReachBoundary, snapPolygonToSourceLines, clipByHalfPlane, canonicalStripFrame, computeFreeRegionLocal
} = FR;

interface PendingPreview {
  geo: THREE.BufferGeometry;
  edgeGeo: THREE.BufferGeometry;
  virtualFace: VirtualFace;
}


export function buildFacePreview(
  clickWorld: THREE.Vector3,
  group: CoplanarFaceGroup,
  faces: FaceData[],
  worldToLocal: THREE.Matrix4,
  shapeId: string,
  geometry?: THREE.BufferGeometry,
  childPanels: any[] = []
): PendingPreview | null {
  const clickLocal = clickWorld.clone().applyMatrix4(worldToLocal);
  const contour = computeFaceComponentContour(faces, group.faceIndices, clickLocal, group.normal);
  if (!contour) return null;

  // ─── AKIŞLA ERİŞİLEBİLİR BÖLGE HIGHLIGHT'I ───
  // Highlight = tıklanan noktadan, bu yüzeye DEĞEN panellerin ayak izleri
  // (footprint) etrafında dolaşarak erişilebilen serbest alan. Panel yüzü
  // TAM bölüyorsa yalnız tıklanan taraf; panel kısaysa etrafından "sızılır"
  // ve yüzün tamamı seçilir — OCC üretim zinciri (kardeş kesimi + bağlantılı
  // parça seçimi) ile birebir aynı semantik. Grid + flood-fill ile hesaplanır;
  // VF kimliği (kontur/merkez) değişmez, yalnız görsel bölge daralır.
  //
  // UZAY UYUMU: Kontur ve düzlem YEREL uzaydadır (faceIndices yerel geometriden
  // gelir). panelFootprintOnPlane panel köşelerini DÜNYA uzayına taşır
  // (getShapeMatrix). Karşılaştırma doğru olsun diye panel ayak izleri dünya→
  // yerel ters-dönüşümüyle yerel düzleme getirilir.
  // TEK KAYNAK: bölge, ayak izleri ve grid tek fonksiyondan gelir. Highlight
  // ve sanal yüzey aynı sonuçtan türediği için ayrışmaları imkânsızdır.
  const region = computeFreeRegionLocal(
    contour.corners, group.normal, clickLocal, childPanels, worldToLocal, shapeId
  );
  if (!region) return null;
  const { u, v, planeN, uMin, vMin, cw, ch, nx, ny, reach, footprints, touchingSiblingIds } = region;
  const nrm = group.normal.clone().normalize();

  const to3D = (px: number, py: number) => new THREE.Vector3()
    .addScaledVector(u, px).addScaledVector(v, py).addScaledVector(nrm, planeN);
  const pos: number[] = [];
  const epos: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!reach[j * nx + i]) continue;
    const x0 = uMin + i * cw, x1 = x0 + cw, y0 = vMin + j * ch, y1 = y0 + ch;
    const p00 = to3D(x0, y0), p10 = to3D(x1, y0), p11 = to3D(x1, y1), p01 = to3D(x0, y1);
    pos.push(p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z,
             p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
    // Sınır kenarı: komşusu erişilemezse çiz
    const bnd: Array<[THREE.Vector3, THREE.Vector3]> = [];
    if (i === 0 || !reach[j * nx + i - 1]) bnd.push([p00, p01]);
    if (i === nx - 1 || !reach[j * nx + i + 1]) bnd.push([p10, p11]);
    if (j === 0 || !reach[(j - 1) * nx + i]) bnd.push([p00, p10]);
    if (j === ny - 1 || !reach[(j + 1) * nx + i]) bnd.push([p01, p11]);
    for (const [a, b] of bnd) epos.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  // YER YOKSA HIGHLIGHT YOK: yüzeyin tamamı kardeş izdüşümleriyle kaplıysa
  // (ör. tam-yüz eğik panel altındaki yüzey) serbest hücre kalmaz. Eskiden
  // burada "tam yüze düş" güvencesi vardı — kullanıcıyı kaplı yüzeye panel
  // atmaya davet ediyor, üretimde de kesimler paneli komple yutuyordu
  // ("panel aşağıya yerleşti"). Artık null dönülür: highlight çıkmaz,
  // panel yaratılmaz; kullanıcı yer olmadığını anında görür.
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(epos), 3));

  const bb2 = (pts: Point2D[]) => { let a=Infinity,b=-Infinity,c=Infinity,d=-Infinity;
    for (const q of pts){a=Math.min(a,q.x);b=Math.max(b,q.x);c=Math.min(c,q.y);d=Math.max(d,q.y);} 
    return `u[${a.toFixed(0)}..${b.toFixed(0)}] v[${c.toFixed(0)}..${d.toFixed(0)}]`; };
  console.log('[YAGO][TIK] BÖLGE yüz=', bb2(region.ring2D), 'VF=', bb2(region.polygon),
    'köşeN=', region.polygon.length, 'ayakİziN=', footprints.length,
    'ayakİzleri=', footprints.map(f => bb2(f)).join(' | ') || 'YOK');
  console.log('[YAGO][TIK]', 'clickLocal=',
    `${clickLocal.x.toFixed(1)},${clickLocal.y.toFixed(1)},${clickLocal.z.toFixed(1)}`,
    'konturKöşeN=', contour.corners.length,
    'konturBBox=', (() => { let a=[Infinity,Infinity,Infinity],b=[-Infinity,-Infinity,-Infinity];
      for (const c of contour.corners){a[0]=Math.min(a[0],c.x);a[1]=Math.min(a[1],c.y);a[2]=Math.min(a[2],c.z);
        b[0]=Math.max(b[0],c.x);b[1]=Math.max(b[1],c.y);b[2]=Math.max(b[2],c.z);}
      return a.map(n=>n.toFixed(0)).join(',')+' .. '+b.map(n=>n.toFixed(0)).join(','); })());
  const localNormal = group.normal.clone().normalize();
  // BÖLGE KİMLİĞİ: merkez, bileşen merkezi DEĞİL kullanıcının TIKLADIĞI
  // noktadır. Aynı yüzdeki iki panelin VF'leri aynı konturu taşısa da
  // merkezleri farklı kalır; rebuild'deki bölge seçimi ve kardeş kesimi bu
  // kimliğe göre doğru tarafı tutar. (Bileşen merkezine çökertmek, iki
  // paneli özdeşleştirip üst üste bindiriyordu.)
  const virtualFace: VirtualFace = {
    id: `vf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    shapeId,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    center: [clickLocal.x, clickLocal.y, clickLocal.z],
    // SANAL YÜZEY = highlight'ın gösterdiği serbest bölgenin ta kendisi.
    // Aynı region nesnesinden geldiği için gördüğünüz mavi alanla birebir aynı.
    vertices: region.polygon.map(p2 => {
      const c = to3D(p2.x, p2.y);
      return [c.x, c.y, c.z] as [number, number, number];
    }),
    description: '',
    hasPanel: false,
    parentFaceShape: true,
    touchingSiblingIds,
    // ÖLÇEK-BAĞIMSIZ YÜZ KİMLİĞİ: resize'da regen, yüzü bu descriptor ile
    // bulur (normalize merkez + eksen) — "en yakın düzlem" tahmini yerine
    // kesin eşleşme; VF asla komşu bir yüze (ör. çentik yanağına) savrulmaz.
    faceGroupDescriptor: geometry ? createFaceDescriptor(faces[contour.seedFi], geometry) : undefined,
  };
  return { geo, edgeGeo, virtualFace };
}

// Refined neutral palette — slate/zinc tones, subtle and professional
const RAYCAST_COLORS = {
  rayLine:        0x94a3b8, // slate-400 — muted line
  hitDot:         0x64748b, // slate-500 — subtle endpoint
  originDot:      0xe2e8f0, // slate-200 — bright origin
  previewFill:    0x38bdf8, // sky-400 — clean ice blue fill
  previewEdge:    0x0ea5e9, // sky-500 — crisper boundary
  hoverEmpty:     0xfcd34d, // amber-300 — warm highlight for empty face
  hoverHasVF:     0x7dd3fc, // sky-300 — cool highlight for placed face
  vfFill:         0x38bdf8, // sky-400 — consistent with preview
  vfFillHovered:  0x0ea5e9, // sky-500
  vfEdge:         0x0369a1, // sky-700 — visible edge
};

const RayLine3D: React.FC<{ start: THREE.Vector3; end: THREE.Vector3 }> = React.memo(({ start, end }) => {
  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints([start, end]), [start.x, start.y, start.z, end.x, end.y, end.z]);
  return (
    <lineSegments geometry={geometry} raycast={() => null}>
      <lineBasicMaterial color={RAYCAST_COLORS.rayLine} linewidth={1.5} depthTest={false} transparent opacity={0.7} />
    </lineSegments>
  );
});
RayLine3D.displayName = 'RayLine3D';

const HitDot: React.FC<{ position: THREE.Vector3 }> = React.memo(({ position }) => (
  <mesh position={[position.x, position.y, position.z]} raycast={() => null}>
    <sphereGeometry args={[2, 8, 8]} />
    <meshBasicMaterial color={RAYCAST_COLORS.hitDot} depthTest={false} transparent opacity={0.8} />
  </mesh>
));
HitDot.displayName = 'HitDot';

const OriginDot: React.FC<{ position: THREE.Vector3 }> = React.memo(({ position }) => (
  <mesh position={[position.x, position.y, position.z]} raycast={() => null}>
    <sphereGeometry args={[3, 8, 8]} />
    <meshBasicMaterial color={RAYCAST_COLORS.originDot} depthTest={false} transparent opacity={0.9} />
  </mesh>
));
OriginDot.displayName = 'OriginDot';

function buildSurfaceMeshes(vf: VirtualFace): { geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry } | null {
  if (vf.vertices.length < 3) return null;
  const corners = vf.vertices.map(v => new THREE.Vector3(v[0], v[1], v[2]));
  const normal = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
  const { u: uAxis, v: vAxis } = getFacePlaneAxes(normal);
  const origin = corners[0];
  const projected2D = corners.map(c => { const d = new THREE.Vector3().subVectors(c, origin); return { x: d.dot(uAxis), y: d.dot(vAxis) }; });
  let area = 0;
  for (let i = 0; i < projected2D.length; i++) {
    const j = (i + 1) % projected2D.length;
    area += projected2D[i].x * projected2D[j].y - projected2D[j].x * projected2D[i].y;
  }
  if (area < 0) { projected2D.reverse(); corners.reverse(); }
  const triIndices = earClipTriangulate(projected2D);
  const positions = new Float32Array(triIndices.length * 3);
  for (let i = 0; i < triIndices.length; i++) {
    const c = corners[triIndices[i]];
    positions[i * 3] = c.x; positions[i * 3 + 1] = c.y; positions[i * 3 + 2] = c.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const edgeVerts: number[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    edgeVerts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgeVerts), 3));
  return { geo, edgeGeo };
}

interface VirtualFaceOverlayProps { shape: any; }

export const VirtualFaceOverlay: React.FC<VirtualFaceOverlayProps> = ({ shape }) => {
  const { virtualFaces, showVirtualFaces, panelSurfaceSelectMode, waitingForSurfaceSelection, triggerPanelCreationForFace, setSelectedPanelRow, panelSelectMode } = useAppStore();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const shapeFaces = useMemo(() => virtualFaces.filter(f => f.shapeId === shape.id && !f.hasPanel), [virtualFaces, shape.id]);
  const meshes = useMemo(() => {
    return shapeFaces.map(vf => { const result = buildSurfaceMeshes(vf); return result ? { id: vf.id, vf, ...result } : null; }).filter(Boolean) as Array<{ id: string; vf: VirtualFace; geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry }>;
  }, [shapeFaces]);
  if (!showVirtualFaces || meshes.length === 0) return null;
  return (
    <>
      {meshes.map((surface, idx) => {
        const isHovered = hoveredId === surface.id;
        return (
          <React.Fragment key={surface.id}>
            <mesh
              geometry={surface.geo}
              onClick={(e) => {
                e.stopPropagation();
                if (panelSurfaceSelectMode) {
                  triggerPanelCreationForFace(-(idx + 1), shape.id, { center: surface.vf.center, normal: surface.vf.normal, constraintPanelId: surface.vf.id });
                  setSelectedPanelRow(`vf-${surface.vf.id}`);
                } else if (panelSelectMode) {
                  setSelectedPanelRow(`vf-${surface.vf.id}`);
                }
              }}
              onPointerOver={(e) => { e.stopPropagation(); setHoveredId(surface.id); }}
              onPointerOut={(e) => { e.stopPropagation(); setHoveredId(null); }}
            >
              <meshBasicMaterial color={isHovered && panelSurfaceSelectMode ? RAYCAST_COLORS.vfFillHovered : RAYCAST_COLORS.vfFill} transparent opacity={isHovered ? 0.55 : 0.30} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} depthTest={false} />
            </mesh>
            <lineSegments geometry={surface.edgeGeo}>
              <lineBasicMaterial color={RAYCAST_COLORS.vfEdge} linewidth={2} depthTest={false} transparent opacity={0.85} />
            </lineSegments>
          </React.Fragment>
        );
      })}
    </>
  );
};

export const FaceRaycastOverlay: React.FC<FaceRaycastOverlayProps> = ({ shape, allShapes = [] }) => {
  const { raycastMode, setRaycastMode, addVirtualFace, virtualFaces, setSelectedPanelRow } = useAppStore();
  const [faces, setFaces] = useState<FaceData[]>([]);
  const [faceGroups, setFaceGroups] = useState<CoplanarFaceGroup[]>([]);
  const [hoveredGroupIndex, setHoveredGroupIndex] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const lastClickRef = useRef<{ point: THREE.Vector3; groupIndex: number; cycleIndex: number } | null>(null);
  const shapeVirtualFaces = useMemo(() => virtualFaces.filter(vf => vf.shapeId === shape.id), [virtualFaces, shape.id]);
  const geometryUuid = shape.geometry?.uuid || '';
  const localToWorld = useMemo(() => getShapeMatrix(shape), [shape.position[0], shape.position[1], shape.position[2], shape.rotation[0], shape.rotation[1], shape.rotation[2], shape.scale[0], shape.scale[1], shape.scale[2]]);
  const worldToLocal = useMemo(() => localToWorld.clone().invert(), [localToWorld]);
  useEffect(() => {
    if (!shape.geometry) return;
    setFaces(extractFacesFromGeometry(shape.geometry));
    setFaceGroups(groupCoplanarFaces(extractFacesFromGeometry(shape.geometry)));
    setPending(null);
    lastClickRef.current = null;
  }, [shape.geometry, shape.id, geometryUuid]);
  useEffect(() => { if (!raycastMode) { setHoveredGroupIndex(null); setPending(null); lastClickRef.current = null; } }, [raycastMode]);
  // Use current (post-extrude) geometry so that shortened panels produce correct
  // obstacle edges — the void area left by a shortened panel must be visitable.
  const childPanels = useMemo(
    () => allShapes.filter(s => s.type === 'panel' && s.parameters?.parentShapeId === shape.id),
    [allShapes, shape.id]
  );
  // Aynı DÜZLEMDEKİ tüm VF'ler (merkez artık tıklama noktası olduğundan
  // grup merkeziyle nokta eşleşmesi yerine düzlem eşleşmesi kullanılır;
  // bir yüzde birden çok panel olabilir → liste döner).
  const findVirtualFacesForGroup = useCallback((gi: number): VirtualFace[] => {
    if (gi < 0 || gi >= faceGroups.length || shapeVirtualFaces.length === 0) return [];
    const gn = faceGroups[gi].normal.clone().normalize();
    const gc = faceGroups[gi].center.clone();
    return shapeVirtualFaces.filter(vf => {
      const vn = new THREE.Vector3(...vf.normal).normalize();
      if (Math.abs(gn.dot(vn)) < 0.98) return false;
      const vc = new THREE.Vector3(...vf.center);
      return Math.abs(vc.clone().sub(gc).dot(gn)) < 2; // düzleme mesafe
    });
  }, [faceGroups, shapeVirtualFaces]);
  const groupHasVirtualFace = useCallback((gi: number) => findVirtualFacesForGroup(gi).length > 0, [findVirtualFacesForGroup]);
  const hoverHighlightGeometry = useMemo(() => {
    if (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex]) return null;
    return createFaceHighlightGeometry(faces, faceGroups[hoveredGroupIndex].faceIndices);
  }, [hoveredGroupIndex, faceGroups, faces]);
  const handlePointerMove = (e: any) => {
    if (!raycastMode || faces.length === 0) return;
    e.stopPropagation();
    if (e.faceIndex !== undefined) {
      const gi = faceGroups.findIndex(g => g.faceIndices.includes(e.faceIndex));
      if (gi !== -1) setHoveredGroupIndex(gi);
    }
  };
  const handlePointerOut = (e: any) => { e.stopPropagation(); setHoveredGroupIndex(null); };
  const handlePointerDown = (e: any) => {
    if (!raycastMode) return;
    if (e.button === 2) {
      e.stopPropagation();
      if (pending) { addVirtualFace(pending.virtualFace); setPending(null); lastClickRef.current = null; setRaycastMode(false); }
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    if (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex]) return;

    const clickPoint: THREE.Vector3 = e.point.clone();
    const clickLocal = clickPoint.clone().applyMatrix4(worldToLocal);

    const isSameSpot = lastClickRef.current && lastClickRef.current.point.distanceTo(clickLocal) < 5;
    // A face is considered "defined" (has an active panel under the cursor) only when
    // the click point falls inside the panel's CURRENT GEOMETRY footprint on the face
    // plane — not the VF polygon (which stays as original full-face for correct rebuild).
    // This lets users click in the void left by a shortened panel.
    const _normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
    // PANEL-İÇİ TIKLAMA: tıklanan düzlem noktası, bu yüzeye DEĞEN herhangi
    // bir panelin ayak izi içindeyse yüz o noktada "tanımlıdır" — panel
    // TAŞINMIŞ olsa bile (test VF konumuna değil panelin GÜNCEL geometrisine
    // dayanır). Panellerin arasındaki/dışındaki boşluk serbesttir ve
    // highlight yalnız oradan akar.
    const hoveredNormalW = faceGroups[hoveredGroupIndex].normal.clone()
      .applyMatrix3(_normalMatrix).normalize();
    const coveringPanel = findPanelCoveringPoint(clickPoint, childPanels, hoveredNormalW, clickPoint);
    const hoveredIsDefined = coveringPanel !== null;

    let targetGroupIndex = hoveredGroupIndex;
    let previewClickPoint = clickPoint;
    let cycleCandidates: Array<{ index: number; depth: number; hitPoint: THREE.Vector3 }> | null = null;

    const cameraPos = e.camera?.position?.clone();
    if (cameraPos && (isSameSpot || hoveredIsDefined)) {
      const rayOrigin = cameraPos;
      const rayDir = clickPoint.clone().sub(rayOrigin).normalize();
      const candidateGroups: Array<{ index: number; depth: number; hitPoint: THREE.Vector3 }> = [];

      for (let gi = 0; gi < faceGroups.length; gi++) {
        // Skip this face group only when the ray's hit point on its plane is actually
        // INSIDE an existing panel VF — void areas on the same group are allowed.

        const group = faceGroups[gi];
        const groupNormalWorld = group.normal.clone().normalize().applyMatrix3(
          new THREE.Matrix3().getNormalMatrix(localToWorld)
        ).normalize();
        const planePoint = group.center.clone().applyMatrix4(localToWorld);
        const denom = groupNormalWorld.dot(rayDir);
        if (Math.abs(denom) < 1e-6) continue;
        const t = planePoint.clone().sub(rayOrigin).dot(groupNormalWorld) / denom;
        if (t < 0) continue;
        const hitOnPlane = rayOrigin.clone().addScaledVector(rayDir, t);

        // Skip if the hit point on this plane falls inside the panel's current geometry
        // footprint. Do NOT skip void areas — those are valid raycast targets.
        {
          const giNormalW = group.normal.clone().normalize().applyMatrix3(
            new THREE.Matrix3().getNormalMatrix(localToWorld)
          ).normalize();
          if (findPanelCoveringPoint(hitOnPlane, childPanels, giNormalW, hitOnPlane)) continue;
        }

        let inside = false;
        for (const fi of group.faceIndices) {
          const face = faces[fi];
          if (!face) continue;
          const vA = face.vertices[0].clone().applyMatrix4(localToWorld);
          const vB = face.vertices[1].clone().applyMatrix4(localToWorld);
          const vC = face.vertices[2].clone().applyMatrix4(localToWorld);
          if (pointInTriangle3D(hitOnPlane, vA, vB, vC)) { inside = true; break; }
        }
        if (inside) {
          candidateGroups.push({ index: gi, depth: t, hitPoint: hitOnPlane });
        }
      }
      candidateGroups.sort((a, b) => a.depth - b.depth);
      cycleCandidates = candidateGroups;
    }

    if (cycleCandidates && cycleCandidates.length > 0) {
      let nextCycleIndex = 0;
      if (isSameSpot && !hoveredIsDefined) {
        const prevCycleIndex = lastClickRef.current!.cycleIndex;
        nextCycleIndex = (prevCycleIndex + 1) % cycleCandidates.length;
      }
      targetGroupIndex = cycleCandidates[nextCycleIndex].index;
      previewClickPoint = cycleCandidates[nextCycleIndex].hitPoint;
      lastClickRef.current = { point: clickLocal, groupIndex: targetGroupIndex, cycleIndex: nextCycleIndex };
    } else if (hoveredIsDefined) {
      const vfId = coveringPanel?.parameters?.virtualFaceId;
      if (vfId) setSelectedPanelRow(`vf-${vfId}`, null, shape.id);
      return;
    } else {
      lastClickRef.current = { point: clickLocal, groupIndex: targetGroupIndex, cycleIndex: 0 };
    }

    setHoveredGroupIndex(targetGroupIndex);
    // TAM YÜZ SEÇİMİ: tıklanan yüzün bağlantılı bileşeni komple seçilir.
    // Derinlik döngüsü (aynı noktaya tekrar tıklayınca arkadaki yüz) korunur.
    setPending(buildFacePreview(previewClickPoint, faceGroups[targetGroupIndex], faces, worldToLocal, shape.id, shape.geometry, childPanels));
  };
  if (!raycastMode) return null;
  return (
    <>
      <mesh geometry={shape.geometry} visible={false} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut} onPointerDown={handlePointerDown} />
      {hoverHighlightGeometry && (
        <mesh geometry={hoverHighlightGeometry} raycast={() => null}>
          <meshBasicMaterial color={hoveredGroupIndex !== null && groupHasVirtualFace(hoveredGroupIndex) ? RAYCAST_COLORS.hoverHasVF : RAYCAST_COLORS.hoverEmpty} transparent opacity={0.28} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
        </mesh>
      )}
      {pending && (
        <>
          <mesh geometry={pending.geo} raycast={() => null}>
            <meshBasicMaterial color={RAYCAST_COLORS.previewFill} transparent opacity={0.38} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} depthTest={false} />
          </mesh>
          <lineSegments geometry={pending.edgeGeo} raycast={() => null}>
            <lineBasicMaterial color={RAYCAST_COLORS.previewEdge} linewidth={2} depthTest={false} transparent opacity={1.0} />
          </lineSegments>
        </>
      )}
    </>
  );
};

