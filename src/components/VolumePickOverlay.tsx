import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useStoreFields, type CavityBox, type CavityPick } from '../store';
import { getShapeMatrix } from './PanelMath';
import {
  panelLocalBox, buildCavityGrid, rayCavityCandidates, createPanelGroupFromCavity,
  GROUP_PANEL_THICKNESS, boxSpan, fmtBox,
} from './PanelGroupService';

/* ══════════════════════════════════════════════════════════════════════════
   HACİM SEÇME (raf / dikme atma) — gövdenin yerel grubunun içinde çizilir.
   Tıklanan noktadan geçen ışın gövde kutusunu hücre hücre yürür; ışının ilk
   girdiği SERBEST hücreden taşılarak şekilli bölge bulunur (gövde katısı —
   çentik/çıkarma dahil — ve paneller sınırlar; PanelGroupService.CavityGrid).
   • Fare hareketi: ilk aday soluk kehribar (nereye düşeceği görülsün).
   • Sol tık: aynı ışındaki adaylar arasında döner (1/3, 2/3 …) — mavi dolgu,
     KIRMIZI kalın dış çizgiler (Goker: "dış çizgiler kırmızı olsun, göze batsın").
   • Sağ tık (ya da şeritteki ✓): seçili hacimden grup oluşur, mod kapanır.
   Gövde/panel ışınları bu modda bastırılır (ShapeWithTransform / PanelDrawing);
   olayları burada görünmez bir kutu mesh'i alır — açık yüzlerde de çalışır.
══════════════════════════════════════════════════════════════════════════ */
const PICK_COLORS = { hover: 0xfcd34d, selected: 0x38bdf8, selectedEdge: '#dc2626' };

interface Props { shape: any; allShapes: any[] }

/** Bölge dış yüzeyi → mesh geometrisi + siluet kenar noktaları (eş-düzlem dikişler elenir). */
function surfaceMesh(surface: number[]): { geo: THREE.BufferGeometry; edgePts: [number, number, number][] } {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(surface), 3));
  const edges = new THREE.EdgesGeometry(geo, 1);
  const p = edges.getAttribute('position');
  const edgePts: [number, number, number][] = [];
  for (let i = 0; i < p.count; i++) edgePts.push([p.getX(i), p.getY(i), p.getZ(i)]);
  edges.dispose();
  return { geo, edgePts };
}

export const VolumePickOverlay: React.FC<Props> = ({ shape, allShapes }) => {
  const { volumePickMode, volumePickCandidates, volumePickIndex, setVolumePick, setVolumePickMode } =
    useStoreFields('volumePickMode', 'volumePickCandidates', 'volumePickIndex', 'setVolumePick', 'setVolumePickMode');
  const [hoverPick, setHoverPick] = useState<CavityPick | null>(null);
  const lastRef = useRef<{ keys: string; index: number } | null>(null);

  const obstacles = useMemo(() => {
    const out: CavityBox[] = [];
    for (const s of allShapes) {
      if (s.type !== 'panel' || s.parameters?.parentShapeId !== shape.id) continue;
      const b = panelLocalBox(s, shape);
      if (b) out.push(b);
    }
    return out;
  }, [allShapes, shape]);
  const grid = useMemo(() => (volumePickMode ? buildCavityGrid(shape, obstacles) : null), [shape, obstacles, volumePickMode]);
  const worldToLocal = useMemo(() => getShapeMatrix(shape).invert(),
    [shape.position[0], shape.position[1], shape.position[2], shape.rotation[0], shape.rotation[1], shape.rotation[2], shape.scale[0], shape.scale[1], shape.scale[2]]);

  // Görünmez yakalama kutusu: gövde kutusundan bir tık büyük (açık yüzlerde de tıklanır).
  const pickGeo = useMemo(() => {
    if (!grid) return null;
    const b = grid.body;
    const g = new THREE.BoxGeometry(boxSpan(b, 0) + 2, boxSpan(b, 1) + 2, boxSpan(b, 2) + 2);
    g.translate((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    return g;
  }, [grid]);
  useEffect(() => () => { pickGeo?.dispose(); }, [pickGeo]);

  const selected = volumePickCandidates[volumePickIndex] || null;
  const selectedMesh = useMemo(() => (selected ? surfaceMesh(selected.surface) : null), [selected]);
  const hoverMesh = useMemo(() => (hoverPick ? surfaceMesh(hoverPick.surface) : null), [hoverPick]);
  useEffect(() => () => { selectedMesh?.geo.dispose(); }, [selectedMesh]);
  useEffect(() => () => { hoverMesh?.geo.dispose(); }, [hoverMesh]);
  useEffect(() => { if (!volumePickMode) { setHoverPick(null); lastRef.current = null; } }, [volumePickMode]);

  const candidatesFromEvent = (e: any): CavityPick[] => {
    if (!grid || !volumePickMode || !e?.ray) return [];
    const o = e.ray.origin.clone().applyMatrix4(worldToLocal);
    const p = e.ray.origin.clone().add(e.ray.direction).applyMatrix4(worldToLocal);
    const d = p.sub(o).normalize();
    return rayCavityCandidates([o.x, o.y, o.z], [d.x, d.y, d.z], grid, GROUP_PANEL_THICKNESS * 2);
  };
  const keysOf = (c: CavityPick[]) => c.map(b => b.key).join(';');

  const onPointerMove = (e: any) => {
    if (!volumePickMode) return;
    e.stopPropagation();
    const c = candidatesFromEvent(e);
    const first = c[0] || null;
    setHoverPick(prev => (prev?.key === first?.key ? prev : first));
  };
  const onPointerDown = (e: any) => {
    if (!volumePickMode) return;
    e.stopPropagation();
    if (e.button === 2) {
      if (selected) {
        createPanelGroupFromCavity(shape.id, volumePickMode, selected);
        setVolumePickMode(null);
      }
      return;
    }
    if (e.button !== 0) return;
    const c = candidatesFromEvent(e);
    if (!c.length) { setVolumePick([], 0); lastRef.current = null; console.log('[YAGO][HACİM] ışın boyunca serbest hacim yok'); return; }
    const keys = keysOf(c);
    let index = 0;
    if (lastRef.current && lastRef.current.keys === keys) index = (lastRef.current.index + 1) % c.length;
    lastRef.current = { keys, index };
    setVolumePick(c, index);
    const s = c[index];
    console.log('[YAGO][HACİM] aday', index + 1, '/', c.length, s.shape === 'box' ? 'DÜZ' : 'ŞEKİLLİ', fmtBox(s.bbox),
      'boyut=', [0, 1, 2].map(a => boxSpan(s.bbox, a).toFixed(0)).join('x'), 'parçaN=', s.boxes.length, 'engelN=', obstacles.length);
  };

  if (!volumePickMode || !pickGeo) return null;
  const hoverIsSelected = !!hoverPick && !!selected && hoverPick.key === selected.key;
  return (
    <>
      <mesh geometry={pickGeo} visible={false} onPointerMove={onPointerMove} onPointerOut={() => setHoverPick(null)}
        onPointerDown={onPointerDown} onContextMenu={(e: any) => e.stopPropagation()} />
      {hoverMesh && !hoverIsSelected && (
        <mesh geometry={hoverMesh.geo} raycast={() => null} renderOrder={5}>
          <meshBasicMaterial color={PICK_COLORS.hover} transparent opacity={0.14} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      {selectedMesh && (
        <>
          <mesh geometry={selectedMesh.geo} raycast={() => null} renderOrder={6}>
            <meshBasicMaterial color={PICK_COLORS.selected} transparent opacity={0.28} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          {selectedMesh.edgePts.length >= 2 && (
            <Line
              points={selectedMesh.edgePts}
              segments
              color={PICK_COLORS.selectedEdge}
              lineWidth={2.6}
              transparent={false}
              depthTest={false}
              depthWrite={false}
              renderOrder={7}
              raycast={() => null}
            />
          )}
        </>
      )}
    </>
  );
};
