import * as THREE from 'three';
import { useAppStore } from '../store';
import { applyRotateSteps, type RotateStep } from './PanelRotateService';

const rebuildInFlight = new Set<string>();

function geoAxesSize(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const axes = [{ i: 0, v: size.x }, { i: 1, v: size.y }, { i: 2, v: size.z }].sort((a, b) => a.v - b.v);
  return { axes, size };
}

// Referans küpü, panelin YEREL (döndürülmemiş) çerçevesine taşır: paneli
// döndürmek yerine küpü TERS döndürüp kesişiriz. Böylece panel geometrisi düz
// kalır (önizleme ve ölçü stabil), ama kırpma panelin gerçek açısına göre
// doğru olur. Adımlar TERS sırada ve negatif açıyla, parent-yerel pivotlar
// etrafında uygulanır — bu, ileri rotasyon transform'unun tam tersidir.
// (Matematiksel olarak: clip_local = S ∩ R⁻¹·C, her parentPos için geçerli.)
function inverseRotateReplicadByLocalSteps(
  shape: any,
  steps: RotateStep[],
  parentPos: [number, number, number]
): any {
  let r = shape;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (Math.abs(step.value) < 1e-6) continue;
    const pivotLocal: [number, number, number] = [
      step.pivot[0] - parentPos[0],
      step.pivot[1] - parentPos[1],
      step.pivot[2] - parentPos[2],
    ];
    const axis: [number, number, number] =
      step.axis === 'x' ? [1, 0, 0] : step.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    r = r.rotate(-step.value, pivotLocal, axis);
  }
  return r;
}

// Parent (referans küp) en büyük kenarı — döndürülmüş paneli kübü aşacak kadar
// büyütmek için güvenli marj.
function parentMaxDim(parent: any): number {
  const geo = parent?.geometry;
  if (geo) {
    const s = geoAxesSize(geo);
    if (s) return Math.max(s.size.x, s.size.y, s.size.z);
  }
  const p = parent?.parameters || {};
  const m = Math.max(parseFloat(p.width) || 0, parseFloat(p.height) || 0, parseFloat(p.depth) || 0);
  return m > 0 ? m : 2000;
}


export async function rebuildPanelsForParent(parentShapeId: string): Promise<void> {
  if (rebuildInFlight.has(parentShapeId)) return;
  rebuildInFlight.add(parentShapeId);
  try {
    const store = useAppStore.getState();
    const parent = store.shapes.find(s => s.id === parentShapeId);
    if (!parent) return;

    const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
    const { createPanelFromVirtualFace, convertReplicadToThreeGeometry, performBooleanCut, createReplicadBox, performBooleanIntersection } = await import('./ReplicadService');
    const { rebuildFromSteps } = await import('./FaceExtrudeService');

    const vfOrder = new Map<string, number>();
    store.virtualFaces.forEach((vf, idx) => vfOrder.set(vf.id, idx));

    const siblingsOrdered = store.shapes
      .filter(s => s.type === 'panel' &&
        s.parameters?.parentShapeId === parentShapeId &&
        s.parameters?.virtualFaceId)
      .sort((a, b) => {
        const ai = vfOrder.get(a.parameters.virtualFaceId) ?? Infinity;
        const bi = vfOrder.get(b.parameters.virtualFaceId) ?? Infinity;
        return ai - bi;
      });

    let workingShapes: any[] = store.shapes.filter(
      s => !(s.type === 'panel' && s.parameters?.parentShapeId === parentShapeId)
    );
    let workingVirtualFaces = store.virtualFaces;

    const builtVfIds = new Set<string>();

    for (const panel of siblingsOrdered) {
      const currentVfId = panel.parameters.virtualFaceId;
      const otherShapeVfs = workingVirtualFaces.filter(f => f.shapeId !== parentShapeId);
      const activeSiblingVfs = workingVirtualFaces.filter(f =>
        f.shapeId === parentShapeId &&
        (f.id === currentVfId || builtVfIds.has(f.id) || !siblingsOrdered.some(s => s.parameters?.virtualFaceId === f.id))
      );
      const filteredForRecalc = [...otherShapeVfs, ...activeSiblingVfs];

      const freshFaces = recalculateVirtualFacesForShape(parent, filteredForRecalc, workingShapes);
      const freshById = new Map(freshFaces.map(f => [f.id, f]));
      workingVirtualFaces = workingVirtualFaces.map(f => freshById.get(f.id) || f);
      builtVfIds.add(currentVfId);

      const vf = freshFaces.find(f => f.id === currentVfId);
      if (!vf || vf.vertices.length < 3) {
        workingShapes = [...workingShapes, panel];
        continue;
      }

      try {
        const thickness = panel.parameters?.depth || 18;

        // Döndürülmüş panelde slab'ı düzleminde büyüt; aşağıda (ters döndürülmüş)
        // parent kesişimi paneli açıya göre tam duvara kadar büyütüp küçültür.
        // Yalnızca parent kesişimi yapılacaksa uygula, yoksa dev panel oluşurdu.
        const rotateSteps: RotateStep[] = panel.parameters?.rotateSteps || [];
        const isRotated = rotateSteps.length > 0;
        const parentPos: [number, number, number] = [...parent.position] as [number, number, number];
        // Panel döndürülmüşse büyüme/kırpma "Ana yüze eşitle" düğmesine BAĞLI
        // OLMAMALI: dönünce otomatik olarak kübe göre uzayıp kırpılsın. Bu yüzden
        // parent kesişimi, döndürülmüş panelde parentFaceShape bayrağı kapalı olsa
        // da (parent.replicadShape varsa) devreye girer.
        const willIntersectParent = !!(parent.replicadShape && (vf.parentFaceShape || isRotated));
        const planeExpand = (isRotated && willIntersectParent) ? parentMaxDim(parent) : 0;

        let rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, thickness, planeExpand);
        if (!rp) {
          workingShapes = [...workingShapes, panel];
          continue;
        }

        const parentHasFillets = !!(parent.fillets && parent.fillets.length > 0 && parent.replicadShape);

        if (willIntersectParent) {
          try {
            // Küpü panelin yerel (döndürülmemiş) çerçevesine taşı: paneli
            // döndürmek yerine küpü ters döndürüp kesişiriz → geometri düz kalır
            // (önizleme/ölçü stabil), kırpma açıya göre doğru olur.
            const cube = rotateSteps.length > 0
              ? inverseRotateReplicadByLocalSteps(parent.replicadShape, rotateSteps, parentPos)
              : parent.replicadShape;
            rp = await performBooleanIntersection(rp, cube);
          } catch (err) {
            console.error('Failed to intersect panel with parent:', err);
            // GÜVENLİK: büyütülmüş slab kırpılamadıysa dev panel olarak kalmasın —
            // normal (büyütmesiz) sanal yüzeyle yeniden kur.
            if (planeExpand > 0) {
              try {
                rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, thickness, 0);
              } catch (err2) {
                console.error('Fallback panel rebuild (no expand) also failed:', err2);
              }
            }
          }
        }

        if (vf.parentFaceShape) {
          if (!parent.replicadShape) {
            const subs = parent.subtractionGeometries || [];
            for (const sub of subs) {
              if (!sub || !sub.parameters) continue;
              const w = parseFloat(sub.parameters.width);
              const h = parseFloat(sub.parameters.height);
              const d = parseFloat(sub.parameters.depth);
              if (isNaN(w) || isNaN(h) || isNaN(d) || w <= 0 || h <= 0 || d <= 0) continue;
              try {
                const margin = 0.5;
                const cuttingBox = await createReplicadBox({ width: w + margin, height: h + margin, depth: d + margin });
                rp = await performBooleanCut(
                  rp, cuttingBox,
                  undefined, sub.relativeOffset,
                  undefined, sub.relativeRotation || [0, 0, 0],
                  undefined, sub.scale || [1, 1, 1]
                );
              } catch (err) {
                console.error('Failed to apply subtractor cut to parent-face-shape panel:', err);
              }
            }
          }

          const siblingPanelShapes = workingShapes.filter(
            s => s.type === 'panel' &&
              s.parameters?.parentShapeId === parentShapeId &&
              s.id !== panel.id &&
              s.replicadShape
          );
          for (const sib of siblingPanelShapes) {
            try {
              rp = await performBooleanCut(rp, sib.replicadShape);
            } catch (err) {
              console.error('Failed to subtract sibling panel from parent-face-shape panel:', err);
            }
          }
        }

        let geometry = convertReplicadToThreeGeometry(rp);
        const r = geoAxesSize(geometry);
        const paramUpdates: Record<string, any> = { ...panel.parameters, baseReplicadShape: rp };
        if (r) {
          const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
          const [def, alt] = [pa[0], pa[1]];
          const s = [r.size.x, r.size.y, r.size.z];
          paramUpdates.width = s[def];
          paramUpdates.height = s[alt];
        }
        let rebuiltPanel: any = { ...panel, geometry, replicadShape: rp, parameters: paramUpdates };

        // Apply extrude steps immediately so subsequent panels see the correct
        // (shortened) geometry as an obstacle during their VF recalculation.
        const steps = panel.parameters?.extrudeSteps || [];
        if (steps.length > 0) {
          const captured: Partial<typeof rebuiltPanel> = {};
          const captureUpdate = (id: string, updates: any) => {
            if (id === panel.id) Object.assign(captured, updates);
          };
          try {
            await rebuildFromSteps(rebuiltPanel, steps, captureUpdate as any);
            if (captured.geometry || captured.replicadShape || captured.parameters) {
              rebuiltPanel = {
                ...rebuiltPanel,
                ...captured,
                parameters: { ...rebuiltPanel.parameters, ...(captured.parameters || {}) },
              };
            }
          } catch (err) {
            console.error('Failed to apply extrude steps during rebuild for panel', panel.id, err);
          }
        }

        // Rotasyonu transform olarak uygula (geometri düz kalır; kırpma yukarıda
        // küpü ters döndürerek açıya göre yapıldı). Sonraki kardeşler bu paneli
        // engel olarak görür.
        if (rotateSteps.length > 0) {
          const basePos: [number, number, number] = panel.parameters?.baseRotatePosition ?? [...panel.position];
          const baseRot: [number, number, number] = panel.parameters?.baseRotateRotation ?? [...panel.rotation];
          const { position: newPos, rotation: newRot } = applyRotateSteps(basePos, baseRot, rotateSteps);
          rebuiltPanel = {
            ...rebuiltPanel,
            position: newPos,
            rotation: newRot,
            parameters: { ...rebuiltPanel.parameters, baseRotatePosition: basePos, baseRotateRotation: baseRot, rotateSteps },
          };
        }

        workingShapes = [...workingShapes, rebuiltPanel];
      } catch (err) {
        console.error('Failed to rebuild panel', panel.id, err);
        workingShapes = [...workingShapes, panel];
      }
    }

    useAppStore.setState(state => {
      const rebuiltById = new Map<string, any>();
      for (const s of workingShapes) {
        if (s.type === 'panel' && s.parameters?.parentShapeId === parentShapeId) rebuiltById.set(s.id, s);
      }
      return {
        shapes: state.shapes.map(s => rebuiltById.get(s.id) || s),
        virtualFaces: workingVirtualFaces,
      };
    });
  } finally {
    rebuildInFlight.delete(parentShapeId);
  }
}
