import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store';
import type { Shape } from '../store';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  createFaceHighlightGeometry,
  type FaceData,
  type CoplanarFaceGroup,
} from './GeometryUtils';

// ─────────────────────────────────────────────────────────────────────────────
// REFERANS-YÜZ SEÇİM KATMANI (Face Extrude → "Ref" modu)
//
// Akış: Kesici panelin yüzü seçildikten sonra bu katman devreye girer. Hedef
// panel DIŞINDAKİ tüm şekiller (paneller + küpler) için görünmez birer seçim
// yüzeyi (pick-mesh) çizilir:
//   • fare üzerine gelince    → turuncu vurgu (ön plandaki aday)
//   • SOL TIK                 → o yüz "aday" olur (yeşil kalır)
//   • AYNI YERE TEKRAR SOL TIK→ üst üste yüzler arasında bir arkadakine geçer
//   • SAĞ TIK (aday varken)   → onay: referans düzleme kadar uzat/kes + çık
//
// KÖK NEDEN (panel tıklanamıyordu): Referans/ana küp, panelleri İÇİNE ALAN dolu
// bir kutudur; kameraya en yakın yüzü (çoğu kez opacity=0, görünmez) iç panelin
// ÖNÜNDEDİR. Tek "en yakın" ışın-kesişimi bu görünmez ön duvarı yakalayıp içteki
// paneli hep gölgeliyordu. Çözüm: ışın üzerindeki TÜM kesişimler toplanır,
// ÖNCE paneller (görünen parçalar) tercih edilir; küp yüzleri de aynı yere
// tekrar tıklayarak (derinlik döngüsü) erişilebilir kalır.
//
// TEK YETKİLİ SEÇİCİ: Ref modunda küplerin kendi tıklaması ShapeWithTransform'da,
// hedef-dışı panellerin raycast'i PanelDrawing'de bastırılır. Onay anında referans
// düzlemi hedef panelin yerel çerçevesine taşınıp net ölçüye çevrilir
// (FaceExtrudeService.executeFaceExtrudeToReference).
// ─────────────────────────────────────────────────────────────────────────────

const REF_COLORS = {
  hover: 0xea580c,     // turuncu — ön plandaki aday
  candidate: 0x10b981, // yeşil — onay bekleyen referans yüz
};
const SAME_SPOT_TOL = 8; // aynı-nokta (döngü) toleransı, dünya birimi

interface FaceRef { shapeId: string; groupIndex: number; }
interface Resolved extends FaceRef { point: THREE.Vector3; distance: number; isPanel: boolean; }
interface TargetEntry { shape: Shape; faces: FaceData[]; groups: CoplanarFaceGroup[]; }

function shapeLocalToWorld(shape: Shape): THREE.Matrix4 {
  const pos = new THREE.Vector3(shape.position[0], shape.position[1], shape.position[2]);
  const quat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ')
  );
  const scl = new THREE.Vector3(shape.scale[0], shape.scale[1], shape.scale[2]);
  return new THREE.Matrix4().compose(pos, quat, scl);
}

interface TargetProps {
  entry: TargetEntry;
  hoveredGroup: number | null;
  candidateGroup: number | null;
  onDown: (e: any) => void;
  onMove: (e: any) => void;
  onOut: (e: any) => void;
}

const RefPickTarget: React.FC<TargetProps> = React.memo(({
  entry, hoveredGroup, candidateGroup, onDown, onMove, onOut,
}) => {
  const { shape, faces, groups } = entry;

  const hoverGeo = useMemo(() => {
    if (hoveredGroup === null || !groups[hoveredGroup]) return null;
    return createFaceHighlightGeometry(faces, groups[hoveredGroup].faceIndices);
  }, [hoveredGroup, groups, faces]);

  const candidateGeo = useMemo(() => {
    if (candidateGroup === null || !groups[candidateGroup]) return null;
    return createFaceHighlightGeometry(faces, groups[candidateGroup].faceIndices);
  }, [candidateGroup, groups, faces]);

  return (
    <group
      position={shape.position as unknown as [number, number, number]}
      rotation={shape.rotation as unknown as [number, number, number]}
      scale={shape.scale as unknown as [number, number, number]}
    >
      {/* Görünmez seçim yüzeyi — DoubleSide sayesinde küpün hem ön hem arka
          duvarı ışında yer alır; derinlik döngüsü ikisine de ulaşabilir. */}
      <mesh
        geometry={shape.geometry}
        userData={{ refShapeId: shape.id }}
        renderOrder={20}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerOut={onOut}
      >
        <meshBasicMaterial transparent opacity={0.01} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
      </mesh>

      {candidateGeo && (
        <mesh geometry={candidateGeo} renderOrder={22} raycast={() => null}>
          <meshBasicMaterial color={REF_COLORS.candidate} transparent opacity={0.6} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
        </mesh>
      )}

      {hoverGeo && hoveredGroup !== candidateGroup && (
        <mesh geometry={hoverGeo} renderOrder={21} raycast={() => null}>
          <meshBasicMaterial color={REF_COLORS.hover} transparent opacity={0.4} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
});

interface OverlayProps { shapes: Shape[]; }

export const FaceReferenceOverlay: React.FC<OverlayProps> = ({ shapes }) => {
  const {
    faceExtrudeMode, faceExtrudeValueMode, faceExtrudeTargetPanelId,
    faceExtrudeSelectedFace, faceExtrudeRefCandidate,
    setFaceExtrudeRefCandidate, setFaceExtrudeSelectedFace, setFaceExtrudeMode,
    updateShape, updateVirtualFace,
  } = useAppStore(useShallow(state => ({
    faceExtrudeMode: state.faceExtrudeMode,
    faceExtrudeValueMode: state.faceExtrudeValueMode,
    faceExtrudeTargetPanelId: state.faceExtrudeTargetPanelId,
    faceExtrudeSelectedFace: state.faceExtrudeSelectedFace,
    faceExtrudeRefCandidate: state.faceExtrudeRefCandidate,
    setFaceExtrudeRefCandidate: state.setFaceExtrudeRefCandidate,
    setFaceExtrudeSelectedFace: state.setFaceExtrudeSelectedFace,
    setFaceExtrudeMode: state.setFaceExtrudeMode,
    updateShape: state.updateShape,
    updateVirtualFace: state.updateVirtualFace,
  })));

  const [hover, setHover] = useState<FaceRef | null>(null);
  const lastClick = useRef<{ point: THREE.Vector3 | null; idx: number }>({ point: null, idx: 0 });

  const active = faceExtrudeMode && faceExtrudeValueMode === 'ref'
    && faceExtrudeSelectedFace !== null && !!faceExtrudeTargetPanelId;

  // Aday şekiller (hedef panel hariç) için yüz gruplarını bir kez hesapla.
  const targets = useMemo(() => {
    const m = new Map<string, TargetEntry>();
    if (!active) return m;
    for (const shape of shapes) {
      if (shape.id === faceExtrudeTargetPanelId) continue;
      if (!shape.geometry) continue;
      if (shape.isolated === false) continue;
      const faces = extractFacesFromGeometry(shape.geometry);
      const groups = groupCoplanarFaces(faces);
      m.set(shape.id, { shape, faces, groups });
    }
    return m;
  }, [shapes, faceExtrudeTargetPanelId, active]);

  useEffect(() => { if (!active) { setHover(null); lastClick.current = { point: null, idx: 0 }; } }, [active]);

  // Işın üzerindeki tüm kesişimleri {shapeId,groupIndex} listesine indirger.
  // Sıralama: ÖNCE paneller (mesafeye göre), sonra diğerleri (mesafeye göre) —
  // görünen paneller varsayılan seçim; küp yüzleri döngüyle erişilir.
  const resolve = useCallback((e: any): Resolved[] => {
    const hits: any[] = (e.intersections && e.intersections.length)
      ? e.intersections
      : [{ object: e.object, faceIndex: e.faceIndex, point: e.point, distance: e.distance }];
    const out: Resolved[] = [];
    const seen = new Set<string>();
    for (const it of hits) {
      const sid: string | undefined = it.object?.userData?.refShapeId;
      if (!sid) continue;
      const entry = targets.get(sid);
      if (!entry) continue;
      const fi = it.faceIndex;
      if (fi === undefined || fi === null) continue;
      const gi = entry.groups.findIndex(g => g.faceIndices.includes(fi));
      if (gi === -1) continue;
      const key = sid + ':' + gi;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        shapeId: sid, groupIndex: gi, point: it.point.clone(),
        distance: it.distance ?? 0, isPanel: entry.shape.type === 'panel',
      });
    }
    out.sort((a, b) => (a.isPanel === b.isPanel ? a.distance - b.distance : a.isPanel ? -1 : 1));
    return out;
  }, [targets]);

  const onMove = useCallback((e: any) => {
    e.stopPropagation();
    const r = resolve(e);
    setHover(r.length ? { shapeId: r[0].shapeId, groupIndex: r[0].groupIndex } : null);
  }, [resolve]);

  const onOut = useCallback((e: any) => { e.stopPropagation(); setHover(null); }, []);

  const onConfirm = useCallback(async () => {
    const st = useAppStore.getState();
    const cand = st.faceExtrudeRefCandidate;
    const targetId = st.faceExtrudeTargetPanelId;
    const selFace = st.faceExtrudeSelectedFace;
    const clickPt = st.faceExtrudeClickPoint;
    if (!cand || !targetId || selFace === null) return;
    const ps = st.shapes.find(s => s.id === targetId);
    if (!ps) return;
    const vfId = ps.parameters?.virtualFaceId as string | undefined;
    const vf = vfId ? st.virtualFaces.find(f => f.id === vfId) : undefined;
    const { executeFaceExtrudeToReference } = await import('./FaceExtrudeService');
    await executeFaceExtrudeToReference({
      panelShape: ps,
      faceGroupIndex: selFace,
      referenceShapeId: cand.shapeId,
      referencePointWorld: cand.point,
      referenceNormalWorld: cand.normal,
      updateShape,
      clickPoint: clickPt ?? undefined,
      virtualFaceId: vfId,
      vfNormal: vf?.normal as [number, number, number] | undefined,
      vfVertex0: vf?.vertices?.[0] as [number, number, number] | undefined,
      updateVirtualFace,
    });
    setHover(null);
    lastClick.current = { point: null, idx: 0 };
    setFaceExtrudeRefCandidate(null);
    setFaceExtrudeSelectedFace(null);
    setFaceExtrudeMode(false);
  }, [updateShape, updateVirtualFace, setFaceExtrudeRefCandidate, setFaceExtrudeSelectedFace, setFaceExtrudeMode]);

  const onDown = useCallback((e: any) => {
    e.stopPropagation();
    if (e.button === 2) { if (useAppStore.getState().faceExtrudeRefCandidate) onConfirm(); return; }
    if (e.button !== 0) return;
    const r = resolve(e);
    if (!r.length) return;

    // Aynı noktaya tekrar tıklama → bir arkadaki yüze geç (derinlik döngüsü).
    const p = e.point as THREE.Vector3;
    const same = lastClick.current.point && lastClick.current.point.distanceTo(p) < SAME_SPOT_TOL;
    const idx = same ? (lastClick.current.idx + 1) % r.length : 0;
    lastClick.current = { point: p.clone(), idx };

    const chosen = r[idx];
    const entry = targets.get(chosen.shapeId);
    if (!entry) return;
    const g = entry.groups[chosen.groupIndex];
    const nMat = new THREE.Matrix3().getNormalMatrix(shapeLocalToWorld(entry.shape));
    const nW = g.normal.clone().applyMatrix3(nMat).normalize();

    console.log('[YAGO][EXTRUDE][REF] aday yüz=', chosen.shapeId,
      entry.shape.type === 'panel' ? '(panel)' : '(küp)', 'grup=', chosen.groupIndex,
      'derinlik#', idx, '/', r.length,
      'nokta=', `${chosen.point.x.toFixed(1)},${chosen.point.y.toFixed(1)},${chosen.point.z.toFixed(1)}`);

    setFaceExtrudeRefCandidate({
      shapeId: chosen.shapeId,
      groupIndex: chosen.groupIndex,
      point: [chosen.point.x, chosen.point.y, chosen.point.z],
      normal: [nW.x, nW.y, nW.z],
    });
  }, [resolve, targets, onConfirm, setFaceExtrudeRefCandidate]);

  if (!active) return null;

  return (
    <>
      {Array.from(targets.values()).map(entry => {
        const sid = entry.shape.id;
        const hoveredHere = hover && hover.shapeId === sid ? hover.groupIndex : null;
        const candHere = faceExtrudeRefCandidate && faceExtrudeRefCandidate.shapeId === sid
          ? faceExtrudeRefCandidate.groupIndex : null;
        return (
          <RefPickTarget
            key={sid}
            entry={entry}
            hoveredGroup={hoveredHere}
            candidateGroup={candHere}
            onDown={onDown}
            onMove={onMove}
            onOut={onOut}
          />
        );
      })}
    </>
  );
};
