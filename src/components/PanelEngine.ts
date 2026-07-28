import * as THREE from 'three';
import { useAppStore, type Shape, type VirtualFace } from '../store';
import { vfPlaneBasis, type RotateStep } from './PanelRotateService';
import type { TransformStep } from './PanelTransformService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PANEL MOTORU — Temiz Çekirdek (Refactored)
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Birleşik adım görünümü ────────────────────────────────────────────────
export function getUnifiedSteps(panel: Shape): TransformStep[] {
  const p = panel.parameters || {};
  const t: TransformStep[] = Array.isArray(p.transformSteps) ? [...p.transformSteps] : [];
  const legacy: RotateStep[] = Array.isArray(p.rotateSteps) ? p.rotateSteps : [];

  const have = new Set(t.map(s => s.id));
  for (const r of legacy) {
    if (have.has(r.id)) continue;
    t.push({
      id: r.id,
      type: 'rotate',
      axis: r.axis,
      axisVec: r.axisVec,
      value: r.value,
      pivot: r.pivot,
      pivotFrac: r.pivotFrac,
      pivotVfFrac: r.pivotVfFrac,
      timestamp: r.timestamp,
    } as TransformStep);
  }
  t.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return t;
}

export function setUnifiedSteps(
  panel: Shape,
  steps: TransformStep[],
  updateShape: (id: string, u: Partial<Shape>) => void
): void {
  const rotateMirror = steps.filter(s => s.type === 'rotate') as any[];
  
  // Düzeltme 1: Güvenli ve derinlikli parameters kopyalama
  const currentParams = panel.parameters ? JSON.parse(JSON.stringify(panel.parameters)) : {};
  
  updateShape(panel.id, {
    parameters: {
      ...currentParams,
      transformSteps: steps,
      rotateSteps: rotateMirror,
    },
  } as any);
}

// ── Bağ kaydı ─────────────────────────────────────────────────────────────
export interface PanelAttachment {
  parentShapeId: string;
  vf: VirtualFace;
  normal: [number, number, number];
}

export function getPanelAttachment(
  panel: Shape,
  virtualFaces: VirtualFace[]
): PanelAttachment | null {
  const vfId = (panel.parameters as any)?.virtualFaceId;
  const parentShapeId = (panel.parameters as any)?.parentShapeId;
  if (!vfId || !parentShapeId) return null;
  
  const vf = virtualFaces.find(f => f.id === vfId);
  if (!vf || !vf.vertices || vf.vertices.length < 3) return null;
  return { parentShapeId, vf, normal: vf.normal as [number, number, number] };
}

// ── Adım tekrarı (Çerçeve Matematiği) ────────────────────────────────────
function resolvePivot(step: any, vf: VirtualFace): THREE.Vector3 {
  if (step.pivotVfFrac && vf) {
    const { n, u, v } = vfPlaneBasis(vf.normal as [number, number, number]);
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, nOff = 0;
    
    for (const c of vf.vertices) {
      const w = new THREE.Vector3(c[0], c[1], c[2]);
      const pu = w.dot(u), pv = w.dot(v);
      uMin = Math.min(uMin, pu); uMax = Math.max(uMax, pu);
      vMin = Math.min(vMin, pv); vMax = Math.max(vMax, pv);
      nOff = w.dot(n);
    }
    const [fu, fv, dn] = step.pivotVfFrac as [number, number, number];
    return new THREE.Vector3()
      .addScaledVector(u, uMin + fu * (uMax - uMin))
      .addScaledVector(v, vMin + fv * (vMax - vMin))
      .addScaledVector(n, nOff + dn);
  }
  return new THREE.Vector3(...(step.pivot || [0, 0, 0]));
}

export function composeSteps(
  steps: TransformStep[],
  vf: VirtualFace
): { quat: THREE.Quaternion; ops: Array<{ kind: 'translate'; d: THREE.Vector3 } | { kind: 'rotate'; deg: number; pivot: THREE.Vector3; axis: THREE.Vector3 }> } {
  const ops: any[] = [];
  const frame = new THREE.Quaternion();
  
  for (const s of steps) {
    if (s.type === 'move') {
      const base = axisLetterToVec((s as any).axis);
      const d = base.clone().applyQuaternion(frame).multiplyScalar((s as any).value);
      ops.push({ kind: 'translate', d });
    } else if (s.type === 'rotate') {
      const st: any = s;
      const axis = st.axisVec
        ? new THREE.Vector3(...st.axisVec).normalize()
        : axisLetterToVec(st.axis + '+');
      const worldAxis = axis.clone().applyQuaternion(frame).normalize();
      const pivot = resolvePivot(st, vf);
      ops.push({ kind: 'rotate', deg: st.value, pivot, axis: worldAxis });
      frame.premultiply(new THREE.Quaternion().setFromAxisAngle(worldAxis, (st.value * Math.PI) / 180));
    }
  }
  return { quat: frame, ops };
}

function axisLetterToVec(a: string): THREE.Vector3 {
  switch (a) {
    case 'x+': return new THREE.Vector3(1, 0, 0);
    case 'x-': return new THREE.Vector3(-1, 0, 0);
    case 'y+': return new THREE.Vector3(0, 1, 0);
    case 'y-': return new THREE.Vector3(0, -1, 0);
    case 'z+': return new THREE.Vector3(0, 0, 1);
    case 'z-': return new THREE.Vector3(0, 0, -1);
    default: return new THREE.Vector3(0, 0, 0);
  }
}

// ── Rebuild Orkestrasyonu ─────────────────────────────────────────────────
const inFlight = new Set<string>();
const pending = new Set<string>();

export async function rebuildPanelsForParent(parentShapeId: string): Promise<void> {
  if (inFlight.has(parentShapeId)) {
    pending.add(parentShapeId);
    return;
  }
  inFlight.add(parentShapeId);
  try {
    await rebuildOnce(parentShapeId);
  } finally {
    inFlight.delete(parentShapeId);
    if (pending.has(parentShapeId)) {
      pending.delete(parentShapeId);
      await rebuildPanelsForParent(parentShapeId);
    }
  }
}

async function rebuildOnce(parentShapeId: string): Promise<void> {
  const store = useAppStore.getState();
  const parent = store.shapes.find(s => s.id === parentShapeId);
  if (!parent) return;

  const { recalculateVirtualFacesForShape } = await import('./VirtualFaceUpdateService');
  const {
    createPanelFromVirtualFace, convertReplicadToThreeGeometry,
    performBooleanCut, performBooleanIntersection,
  } = await import('./ReplicadService');

  const fresh = useAppStore.getState();
  const shapes = fresh.shapes;
  const parentFresh = shapes.find(s => s.id === parentShapeId) || parent;
  const updateShape = fresh.updateShape;
  const updateVirtualFace = (fresh as any).updateVirtualFace as ((id: string, u: any) => void) | undefined;

  const freshVirtualFaces = useAppStore.getState().virtualFaces;
  const vfOrder = new Map<string, number>();
  freshVirtualFaces.forEach((f, i) => vfOrder.set(f.id, i));

  const orderOf = (s: Shape): number => {
    const vfId = (s.parameters as any)?.virtualFaceId;
    const idx = vfId != null ? vfOrder.get(vfId) : undefined;
    return idx != null ? idx : 1e9 + panelTs(s) / 1e13;
  };

  const children = shapes
    .filter(s => s.type === 'panel' && (s.parameters as any)?.parentShapeId === parentShapeId)
    .sort((a, b) => orderOf(a) - orderOf(b));

  if (children.length === 0) return;

  const parentPos: [number, number, number] = [...(parentFresh.position as any)] as any;
  const parentMax = Math.max(
    parseFloat((parentFresh.parameters as any)?.width) || 0,
    parseFloat((parentFresh.parameters as any)?.height) || 0,
    parseFloat((parentFresh.parameters as any)?.depth) || 0
  ) || 2000;

  const builtSolid = new Map<string, any>();
  const builtGrown = new Map<string, any>();
  const meta = new Map<string, { att: PanelAttachment; thickness: number; isRotated: boolean; steps: TransformStep[] }>();

  const buildSolids = async (vfsIn: VirtualFace[], writeEarly: boolean) => {
    builtSolid.clear(); builtGrown.clear(); meta.clear();
    for (const panel of children) {
      try {
        const att = getPanelAttachment(panel, vfsIn);
        if (!att) continue;

        const thickness = parseFloat((panel.parameters as any)?.panelThickness) || 18;
        const steps = getUnifiedSteps(panel);
        const isRotated = steps.some(s => s.type === 'rotate');
        const { ops } = composeSteps(steps, att.vf);

        const applyOps = (solid: any) => {
          let s = solid;
          for (const op of ops) {
            if (op.kind === 'translate') s = s.translate(op.d.x, op.d.y, op.d.z);
            else s = s.rotate(op.deg, [op.pivot.x, op.pivot.y, op.pivot.z], [op.axis.x, op.axis.y, op.axis.z]);
          }
          return s;
        };

        const expand = isRotated ? parentMax : 0;
        let rp = await createPanelFromVirtualFace(att.vf.vertices, att.vf.normal, thickness, expand);
        if (!rp) continue;
        rp = applyOps(rp);

        let cutterSolid = rp;
        if (isRotated) {
          try {
            const real = await createPanelFromVirtualFace(att.vf.vertices, att.vf.normal, thickness, 0);
            if (real) cutterSolid = applyOps(real);
          } catch (e2) {
            cutterSolid = rp;
          }
        }

        builtSolid.set(panel.id, cutterSolid);
        builtGrown.set(panel.id, rp);
        meta.set(panel.id, { att, thickness, isRotated, steps });

        if (writeEarly) {
          const gPre = convertReplicadToThreeGeometry(cutterSolid);
          updateShape(panel.id, { geometry: gPre, position: parentPos, rotation: [0, 0, 0] } as any);
        }
      } catch (err) {
        console.error('[PanelEngine] Katı üretim hatası:', panel.id, err);
      }
    }
  };

  // AŞAMA 1: Ön-tur ham geometri hesabı
  const vfsPre: VirtualFace[] = recalculateVirtualFacesForShape(
    parentFresh, freshVirtualFaces, shapes, 'all'
  );
  await buildSolids(vfsPre, true);

  // AŞAMA 2: Bölge otoritesi
  const freshShapes = useAppStore.getState().shapes;
  let vfs: VirtualFace[] = recalculateVirtualFacesForShape(
    parentFresh, useAppStore.getState().virtualFaces, freshShapes, 'all'
  );
  if (updateVirtualFace) {
    for (const f of vfs) updateVirtualFace(f.id, f);
  }

  // AŞAMA 3: Yeniden üretim
  await buildSolids(vfs, false);

  // FAZ B: Kesim ve Sınırlama
  for (let pi = 0; pi < children.length; pi++) {
    const panel = children[pi];
    const m = meta.get(panel.id);
    let rp = builtGrown.get(panel.id) ?? builtSolid.get(panel.id);
    if (!m || !rp) continue;

    const { isRotated } = m;
    try {
      for (let si = 0; si < pi; si++) {
        const sib = children[si];
        const sm = meta.get(sib.id);
        if (!sm) continue;

        const cutter = sm.isRotated
          ? (builtGrown.get(sib.id) ?? builtSolid.get(sib.id))
          : builtSolid.get(sib.id);

        if (!cutter) continue;
        
        // Düzeltme 2: AABB çakışma kontrolü daha hassas eşikle yapılır
        if (!aabbTouch(rp, cutter)) continue;

        const before = bb6(rp);
        try {
          // Düzeltme 3: Nesne klonlaması güvenli hale getirildi
          const rpClone = safeClone(rp);
          const cutterClone = safeClone(cutter);
          
          if (rpClone && cutterClone) {
            const cut = await performBooleanCut(rpClone, cutterClone);
            const ab = bb6(cut);
            const alive = ab && (ab[3] - ab[0]) > 1e-2 && (ab[4] - ab[1]) > 1e-2 && (ab[5] - ab[2]) > 1e-2;
            const d = bbDelta(before, ab);
            if (d > 0.001 && alive) rp = cut;
          }
        } catch (e) { 
          console.warn('[PanelEngine] Kesim hatası:', panel.id, '<-', sib.id, e); 
        }
      }

      // K6: Ebeveyn sınırı kesişimi
      if ((parentFresh as any).replicadShape) {
        try {
          const parentShapeClone = safeClone((parentFresh as any).replicadShape);
          if (parentShapeClone) {
            const clipped = await performBooleanIntersection(rp, parentShapeClone);
            const cb = bb6(clipped);
            if (cb && isFinite(cb[0]) && (cb[3] - cb[0]) > 1e-3 && (cb[4] - cb[1]) > 1e-3 && (cb[5] - cb[2]) > 1e-3) {
              rp = clipped;
            }
          }
        } catch (e) { 
          console.warn('[PanelEngine] K6 Kesişim hatası:', e); 
        }
      }

      const geometry = convertReplicadToThreeGeometry(rp);
      updateShape(panel.id, {
        geometry,
        position: parentPos,
        rotation: [0, 0, 0],
        replicadShape: rp,
      } as any);

    } catch (err) {
      console.error('[PanelEngine] Panel rebuild hatası:', panel.id, err);
    }
  }
}

// ── Yardımcı Fonksiyonlar ────────────────────────────────────────────────
function panelTs(s: Shape): number {
  const m = /(\d{10,})/.exec(s.id);
  return m ? parseInt(m[1], 10) : 0;
}

function safeClone(s: any): any { 
  try { 
    return s && typeof s.clone === 'function' ? s.clone() : null; 
  } catch { 
    return null; 
  } 
}

function bb6(s: any): number[] | null {
  try { 
    const b = s?.boundingBox?.bounds; 
    return b ? [b[0][0], b[0][1], b[0][2], b[1][0], b[1][1], b[1][2]] : null; 
  } catch { 
    return null; 
  }
}

function bbDelta(a: number[] | null, b: number[] | null): number {
  if (!a || !b) return Infinity;
  let d = 0;
  for (let i = 0; i < 6; i++) d += Math.abs(a[i] - b[i]);
  return d;
}

// Düzeltme 4: Hassas AABB çakışma algoritması (Tolerans 1e-3 mm)
function aabbTouch(a: any, b: any): boolean {
  const ba = bb6(a), bb = bb6(b);
  if (!ba || !bb) return false;
  const eps = 1e-3; // Bitişik ancak çakışmayan paneller için hassas tolerans
  return ba[0] <= bb[3] - eps && ba[3] >= bb[0] + eps &&
         ba[1] <= bb[4] - eps && ba[4] >= bb[1] + eps &&
         ba[2] <= bb[5] - eps && ba[5] >= bb[2] + eps;
}