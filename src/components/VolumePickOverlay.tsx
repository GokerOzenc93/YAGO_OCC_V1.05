import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useStoreFields, type CavityBox } from '../store';
import { getShapeMatrix, type Vec3 } from './PanelMath';
import {
  bodyLocalBox, panelLocalBox, rayCavityCandidates, createPanelGroupFromCavity, groupAxisOf,
  GROUP_PANEL_THICKNESS, boxSpan, fmtBox,
} from './PanelGroupService';

/* ══════════════════════════════════════════════════════════════════════════
   HACİM SEÇME (raf / dikme atma) — gövdenin yerel grubunun içinde çizilir.
   Tıklanan noktadan geçen ışın gövde kutusunu keser; ışının panellere değmeyen
   parçalarından serbest HACİMLER büyütülür (PanelGroupService.rayCavityCandidates).
   • Fare hareketi: ilk aday soluk kehribar (nereye düşeceği görülsün).
   • Sol tık: aynı ışındaki adaylar arasında döner (1/3, 2/3 …) — mavi.
   • Sağ tık (ya da şeritteki ✓): seçili hacimden grup oluşur, mod kapanır.
   Gövde/panel ışınları bu modda bastırılır (ShapeWithTransform / PanelDrawing);
   olayları burada görünmez bir kutu mesh'i alır — açık yüzlerde de çalışır.
══════════════════════════════════════════════════════════════════════════ */
const PICK_COLORS = { hover: 0xfcd34d, selected: 0x38bdf8, selectedEdge: 0x0369a1 };

interface Props { shape: any; allShapes: any[] }

function boxMesh(b: CavityBox): { geo: THREE.BoxGeometry; edges: THREE.EdgesGeometry } {
  const sx = Math.max(boxSpan(b, 0), 0.1), sy = Math.max(boxSpan(b, 1), 0.1), sz = Math.max(boxSpan(b, 2), 0.1);
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  geo.translate((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  return { geo, edges: new THREE.EdgesGeometry(geo) };
}

export const VolumePickOverlay: React.FC<Props> = ({ shape, allShapes }) => {
  const { volumePickMode, volumePickCandidates, volumePickIndex, setVolumePick, setVolumePickMode } =
    useStoreFields('volumePickMode', 'volumePickCandidates', 'volumePickIndex', 'setVolumePick', 'setVolumePickMode');
  const [hoverBox, setHoverBox] = useState<CavityBox | null>(null);
  const lastRef = useRef<{ keys: string; index: number } | null>(null);

  const vertexModsKeyStr = JSON.stringify(shape.vertexModifications || []);
  const body = useMemo(() => bodyLocalBox(shape), [shape.geometry, shape.geometry?.uuid, vertexModsKeyStr]);
  const obstacles = useMemo(() => {
    const out: CavityBox[] = [];
    for (const s of allShapes) {
      if (s.type !== 'panel' || s.parameters?.parentShapeId !== shape.id) continue;
      const b = panelLocalBox(s, shape);
      if (b) out.push(b);
    }
    return out;
  }, [allShapes, shape]);
  const worldToLocal = useMemo(() => getShapeMatrix(shape).invert(),
    [shape.position[0], shape.position[1], shape.position[2], shape.rotation[0], shape.rotation[1], shape.rotation[2], shape.scale[0], shape.scale[1], shape.scale[2]]);

  // Görünmez yakalama kutusu: gövde kutusundan bir tık büyük (açık yüzlerde de tıklanır).
  const pickGeo = useMemo(() => {
    if (!body) return null;
    const grown: CavityBox = { min: body.min.map(v => v - 1) as Vec3, max: body.max.map(v => v + 1) as Vec3 };
    return boxMesh(grown).geo;
  }, [body]);
  useEffect(() => () => { pickGeo?.dispose(); }, [pickGeo]);

  const selected = volumePickCandidates[volumePickIndex] || null;
  const selectedMesh = useMemo(() => (selected ? boxMesh(selected) : null), [selected]);
  const hoverMesh = useMemo(() => (hoverBox ? boxMesh(hoverBox) : null), [hoverBox]);
  useEffect(() => () => { selectedMesh?.geo.dispose(); selectedMesh?.edges.dispose(); }, [selectedMesh]);
  useEffect(() => () => { hoverMesh?.geo.dispose(); hoverMesh?.edges.dispose(); }, [hoverMesh]);
  useEffect(() => { if (!volumePickMode) { setHoverBox(null); lastRef.current = null; } }, [volumePickMode]);

  const candidatesFromEvent = (e: any): CavityBox[] => {
    if (!body || !volumePickMode || !e?.ray) return [];
    const o = e.ray.origin.clone().applyMatrix4(worldToLocal);
    const p = e.ray.origin.clone().add(e.ray.direction).applyMatrix4(worldToLocal);
    const d = p.sub(o).normalize();
    return rayCavityCandidates([o.x, o.y, o.z], [d.x, d.y, d.z], body, obstacles, groupAxisOf(volumePickMode), GROUP_PANEL_THICKNESS * 2);
  };
  const keysOf = (c: CavityBox[]) => c.map(b => fmtBox(b)).join(';');

  const onPointerMove = (e: any) => {
    if (!volumePickMode) return;
    e.stopPropagation();
    const c = candidatesFromEvent(e);
    setHoverBox(c[0] || null);
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
    console.log('[YAGO][HACİM] aday', index + 1, '/', c.length, fmtBox(c[index]),
      'boyut=', [0, 1, 2].map(a => boxSpan(c[index], a).toFixed(0)).join('x'), 'engelN=', obstacles.length);
  };

  if (!volumePickMode || !pickGeo) return null;
  const hoverIsSelected = !!hoverBox && !!selected && fmtBox(hoverBox) === fmtBox(selected);
  return (
    <>
      <mesh geometry={pickGeo} visible={false} onPointerMove={onPointerMove} onPointerOut={() => setHoverBox(null)}
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
          <lineSegments geometry={selectedMesh.edges} raycast={() => null} renderOrder={7}>
            <lineBasicMaterial color={PICK_COLORS.selectedEdge} depthTest={false} transparent opacity={0.95} />
          </lineSegments>
        </>
      )}
    </>
  );
};
