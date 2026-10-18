/* HIZLI GÖVDE: dört gövde paneli (üst/sol/sağ/alt) + taban (düz / ayaklı / bazalı) + arkalık tek seferde, sanki tek tek
   yerleştirilmiş gibi üretilir. Sonuç sıradan VF-panelleridir (adımlarına girilip değiştirilir); yalnız AYAKLAR gövde
   parametresinde kalıcıdır (`parameters.legs`) ve listede ilk sırada çizilir.

   Köşe birleşimi = VF SIRASI: önce yerleşen panel köşeden geçer (basan), sonra yerleşen arada kalır (basılan).
   Dört köşenin kısıtlarından topolojik sıra çıkarılır; çevrim (fırıldak) kurulamaz → tercih sırası (sol, sağ, üst, alt).
   Bölgeler YEREL olarak, önceki panellerin (gerekirse taşınmış/kısaltılmış) vekil geometrileriyle hesaplanır; her şey
   tek seferde store'a yazılır, arkalık ise paneller gerçekten üretildikten (rebuild boşaldıktan) sonra adaylardan kurulur. */
import * as THREE from 'three';
import {
  type BodyLegs, type CornerKey, type JoinPass, type QuickBodyConfig, type Shape, type VirtualFace,
  childPanelsOf, panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import {
  type CoplanarFaceGroup, type FaceData, type Vec3, convertReplicadToThreeGeometry, createFaceDescriptor, createPanelFromVirtualFace,
  effectiveBodyGeometry, genId, getFacesAndGroups, getShapeMatrix, localBboxOf,
} from './Geometry';
import { computeFaceComponentContour, computeFreeRegionLocal } from './FaceRegion';
import type { ExtrudeStep, MoveTransformStep } from './PanelOps';
import { isDoorPanel } from './DoorService';
import { BACK_AXIS, BACK_SIDE, backCandidatesAt, backPreviewStamp, createBackGroupFromPick, isBackPanel } from './BackService';

export type QuickPanelKey = 'top' | 'left' | 'right' | 'bottom';
export const QUICK_PANEL_NAME: Record<QuickPanelKey, string> = { top: 'Top', left: 'Left', right: 'Right', bottom: 'Bottom' };
/** Köşe → (yatay panel, yan panel). */
const CORNER_PANELS: Record<CornerKey, [QuickPanelKey, QuickPanelKey]> = { tl: ['top', 'left'], tr: ['top', 'right'], bl: ['bottom', 'left'], br: ['bottom', 'right'] };
/** Çevrimde ve eşitlikte tercih: yanlar önce (yanlar geçer). */
const PREFERRED: QuickPanelKey[] = ['left', 'right', 'top', 'bottom'];

/** Etkin köşe birleşimleri: bazalıda alt köşeler her zaman 'side' (alt panel yanların arasında, yanlar yere iner). */
export function effectiveJoins(cfg: QuickBodyConfig): Record<CornerKey, JoinPass> {
  return cfg.base === 'plinth' ? { ...cfg.joins, bl: 'side', br: 'side' } : { ...cfg.joins };
}

/** Köşe kısıtlarından panel sırası (Kahn; eşitlikte PREFERRED). Çevrim → kalanlar tercih sırasıyla eklenir ve `cyclic` işaretlenir. */
export function panelOrderFor(joins: Record<CornerKey, JoinPass>): { order: QuickPanelKey[]; cyclic: boolean } {
  const before = new Map<QuickPanelKey, Set<QuickPanelKey>>(PREFERRED.map(k => [k, new Set<QuickPanelKey>()]));
  for (const c of Object.keys(CORNER_PANELS) as CornerKey[]) {
    const [h, s] = CORNER_PANELS[c];
    const [first, second] = joins[c] === 'side' ? [s, h] : [h, s];
    before.get(second)!.add(first);
  }
  const order: QuickPanelKey[] = []; const done = new Set<QuickPanelKey>(); let cyclic = false;
  while (order.length < PREFERRED.length) {
    const next = PREFERRED.find(k => !done.has(k) && [...before.get(k)!].every(b => done.has(b)));
    if (next) { order.push(next); done.add(next); continue; }
    cyclic = true;
    const k = PREFERRED.find(x => !done.has(x))!; order.push(k); done.add(k);
  }
  return { order, cyclic };
}

/** Tabanın alt panelin altında bıraktığı yükseklik (ayak / baza); düzde 0. */
export const baseLiftOf = (cfg: QuickBodyConfig): number => (cfg.base === 'plinth' ? cfg.plinth.height : cfg.base === 'legs' ? cfg.legs.height : 0);

/* ───────── Ayak yerleşimi (gövde-yerel; ön = +Z) ───────── */
export interface LegSpot { x: number; z: number }
/** 4 = köşeler; 5 = + merkez; 6 = + ön/arka ortası. `side/front/rear` = ayak MERKEZİNİN kenara mesafesi. */
export function legSpots(legs: Pick<BodyLegs, 'count' | 'side' | 'front' | 'rear'>, W: number, D: number): LegSpot[] {
  const xl = legs.side, xr = W - legs.side, zf = D - legs.front, zb = legs.rear;
  const pts: LegSpot[] = [{ x: xl, z: zf }, { x: xr, z: zf }, { x: xl, z: zb }, { x: xr, z: zb }];
  if (legs.count === 5) pts.push({ x: W / 2, z: (zf + zb) / 2 });
  if (legs.count === 6) pts.push({ x: W / 2, z: zf }, { x: W / 2, z: zb });
  return pts;
}
/** Ayak yüksekliği: alt panelin alt yüzü − gövde tabanı (canlı); alt panel yoksa kayıtlı yükseklik. */
export function legHeightOf(body: Shape, legs: BodyLegs, shapes = useAppStore.getState().shapes): number {
  const bb = localBboxOf(effectiveBodyGeometry(body));
  const bottom = legs.bottomVfId ? panelOfVf(legs.bottomVfId, shapes) : undefined;
  const pb = bottom ? localBboxOf(bottom.geometry) : null;
  if (bb && pb) { const h = pb.min.y - bb.min.y; if (h > 0.5) return h; }
  return legs.height;
}
export const bodyLegsOf = (body: Shape | undefined | null): BodyLegs | null => (body?.parameters?.legs as BodyLegs | undefined) ?? null;
export function setBodyLegs(shapeId: string, patch: Partial<BodyLegs> | null): void {
  const st = useAppStore.getState();
  const body = shapeById(shapeId, st.shapes); if (!body) return;
  const next = { ...body.parameters };
  if (patch === null) delete next.legs; else next.legs = { ...(bodyLegsOf(body) ?? { count: 4, diameter: 50, side: 60, front: 60, rear: 60, height: 100 }), ...patch };
  st.updateShape(shapeId, { parameters: next } as Partial<Shape>);
}

/* ───────── Yerel bölge → VF ───────── */
interface FaceCtx { body: Shape; eff: THREE.BufferGeometry; faces: FaceData[]; groups: CoplanarFaceGroup[]; W2L: THREE.Matrix4; box: THREE.Box3 }

function faceGroupFor(ctx: FaceCtx, n: Vec3, seed: THREE.Vector3): CoplanarFaceGroup | null {
  const nv = new THREE.Vector3(...n);
  const cands = ctx.groups.filter(g => g.normal.clone().normalize().dot(nv) > 0.999);
  if (!cands.length) return null;
  // Çentikli gövdede aynı normalli birden çok yüz: tohuma en yakın merkezli ve en büyük alanlı
  return cands.sort((a, b) => a.center.distanceTo(seed) - b.center.distanceTo(seed) || b.totalArea - a.totalArea)[0];
}

/** `buildFacePreview` ile aynı VF kurulumu (önizleme mesh'i olmadan): bölge tek kaynaktan (computeFreeRegionLocal). */
function vfOnFace(ctx: FaceCtx, n: Vec3, seedLocal: THREE.Vector3, siblings: Shape[], name: string): VirtualFace | null {
  const group = faceGroupFor(ctx, n, seedLocal); if (!group) return null;
  const contour = computeFaceComponentContour(ctx.faces, group.faceIndices, seedLocal, group.normal); if (!contour) return null;
  const region = computeFreeRegionLocal(contour.corners, group.normal, seedLocal, siblings, ctx.W2L, ctx.body.id); if (!region) return null;
  const nrm = group.normal.clone().normalize();
  const to3D = (px: number, py: number) => new THREE.Vector3().addScaledVector(region.u, px).addScaledVector(region.v, py).addScaledVector(nrm, region.planeN);
  const anchor = to3D(region.anchor.x, region.anchor.y);
  return {
    id: genId('vf'), shapeId: ctx.body.id,
    normal: [nrm.x, nrm.y, nrm.z], center: [seedLocal.x, seedLocal.y, seedLocal.z],
    vertices: region.polygon.map(p => { const c = to3D(p.x, p.y); return [c.x, c.y, c.z] as Vec3; }),
    description: name, hasPanel: true, parentFaceShape: true, touchingSiblingIds: region.touchingSiblingIds, sideRelations: region.sideRelations,
    faceGroupDescriptor: createFaceDescriptor(ctx.faces[contour.seedFi], ctx.eff),
    doorBound: true, backBound: true,
    ...({ regionAnchor: [anchor.x, anchor.y, anchor.z] } as Record<string, unknown>),
  };
}

async function slabOf(verts: Vec3[], normal: Vec3, t: number): Promise<{ rp: unknown; geo: THREE.BufferGeometry } | null> {
  const rp = await createPanelFromVirtualFace(verts, normal, t);
  if (!rp) return null;
  return { rp, geo: convertReplicadToThreeGeometry(rp) };
}

function panelShape(body: Shape, vf: VirtualFace, vfIndex: number, geo: THREE.BufferGeometry, rp: unknown, t: number, extra: Record<string, unknown>): Shape {
  const bb = localBboxOf(geo)!; const size = new THREE.Vector3(); bb.getSize(size);
  const s = [size.x, size.y, size.z]; const [def, alt] = [0, 1, 2].sort((a, b) => s[a] - s[b]).slice(1).sort((a, b) => a - b);
  return {
    id: genId('panel-vf'), type: 'panel', position: [...body.position] as Vec3, rotation: body.rotation, scale: [...body.scale] as Vec3, color: '#ffffff',
    geometry: geo, replicadShape: rp,
    parameters: { width: s[def], height: s[alt], depth: t, parentShapeId: body.id, faceIndex: -(vfIndex + 1), virtualFaceId: vf.id, arrowRotated: false, panelThickness: t, ...extra },
  } as Shape;
}

const moveStep = (axis: MoveTransformStep['axis'], value: number, ts: number): MoveTransformStep => ({ id: `step-${ts}`, type: 'move', axis, value, timestamp: ts });
/** Panelin kendi geometrisinde `label` yönündeki dış yüzünden `value` (dyn; − = kısalt). */
function extrudeStepFor(geo: THREE.BufferGeometry, n: Vec3, label: string, value: number, ts: number): ExtrudeStep | null {
  const nv = new THREE.Vector3(...n);
  const g = getFacesAndGroups(geo).groups.filter(x => x.normal.clone().normalize().dot(nv) > 0.999).sort((a, b) => b.totalArea - a.totalArea)[0];
  if (!g) return null;
  return { id: genId('ext'), faceNormal: n, faceCenter: [g.center.x, g.center.y, g.center.z], axisLabel: label, value, isFixed: false, timestamp: ts };
}

/* ───────── Ana akış ───────── */
export interface QuickBodyResult { panelCount: number; backCreated: boolean; cyclic: boolean; warnings: string[] }

export async function applyQuickBody(shapeId: string, cfg: QuickBodyConfig): Promise<QuickBodyResult | null> {
  const st = useAppStore.getState();
  const body = shapeById(shapeId, st.shapes); if (!body) return null;
  const eff = effectiveBodyGeometry(body);
  const { faces, groups } = getFacesAndGroups(eff);
  const box = localBboxOf(eff); if (!box) return null;
  const ctx: FaceCtx = { body, eff, faces, groups, W2L: getShapeMatrix(body).clone().invert(), box };
  const H = box.max.y - box.min.y;
  const x0 = box.min.x, y0 = box.min.y, z0 = box.min.z, x1 = box.max.x, y1 = box.max.y, z1 = box.max.z;
  const t = Math.max(1, cfg.thickness);
  const warnings: string[] = [];
  const joins = effectiveJoins(cfg);
  const { order, cyclic } = panelOrderFor(joins);
  if (cyclic) warnings.push('Corner joints form a cycle — resolved as sides first.');
  const lift = Math.min(Math.max(0, baseLiftOf(cfg)), Math.max(0, H - 3 * t));

  // Mevcut kardeşler (kapak/arkalık hariç; arkalık parçaları damga olarak)
  const existing = childPanelsOf(body.id, st.shapes);
  const siblings: Shape[] = [
    ...existing.filter(p => !isDoorPanel(p) && !isBackPanel(p)),
    ...existing.filter(isBackPanel).map(backPreviewStamp).filter((p): p is Shape => !!p),
  ];
  const vfCountBefore = st.virtualFaces.filter(f => f.shapeId === body.id).length;

  const FACE: Record<QuickPanelKey, { n: Vec3; seed: THREE.Vector3 }> = {
    top: { n: [0, 1, 0], seed: new THREE.Vector3((x0 + x1) / 2, y1, (z0 + z1) / 2) },
    bottom: { n: [0, -1, 0], seed: new THREE.Vector3((x0 + x1) / 2, y0, (z0 + z1) / 2) },
    left: { n: [-1, 0, 0], seed: new THREE.Vector3(x0, (y0 + y1) / 2, (z0 + z1) / 2) },
    right: { n: [1, 0, 0], seed: new THREE.Vector3(x1, (y0 + y1) / 2, (z0 + z1) / 2) },
  };
  const newVfs: VirtualFace[] = []; const newShapes: Shape[] = [];
  let ts = Date.now();
  let bottomVfId: string | undefined;

  const push = async (key: QuickPanelKey | 'plinth' | 'rearPlinth', n: Vec3, seed: THREE.Vector3, name: string, opts: {
    move?: [MoveTransformStep['axis'], number]; cuts?: Array<[Vec3, string, number]>; proxyVerts?: (v: Vec3[]) => Vec3[]; bound?: boolean;
  }): Promise<boolean> => {
    const vf = vfOnFace(ctx, n, seed, siblings, name);
    if (!vf) { warnings.push(`${name}: no free region on that face`); return false; }
    if (opts.bound === false) { vf.doorBound = false; vf.backBound = false; }
    const slab = await slabOf(vf.vertices, vf.normal, t);
    if (!slab) { warnings.push(`${name}: panel solid failed`); return false; }
    const extra: Record<string, unknown> = {};
    const steps: MoveTransformStep[] = [];
    // 0 mm taşıma adımı yazılmaz (ön baza varsayılan 0 → listede boş adım olmasın)
    if (opts.move && Math.abs(opts.move[1]) < 0.001) opts.move = undefined;
    if (opts.move) steps.push(moveStep(opts.move[0], opts.move[1], ++ts));
    if (steps.length) extra.transformSteps = steps;
    const exts = (opts.cuts ?? []).map(([cn, label, v]) => extrudeStepFor(slab.geo, cn, label, v, ++ts)).filter((e): e is ExtrudeStep => !!e);
    if (exts.length) extra.extrudeSteps = exts;
    const shape = panelShape(body, vf, vfCountBefore + newVfs.length, slab.geo, slab.rp, t, extra);
    newVfs.push(vf); newShapes.push(shape);
    if (key === 'bottom') bottomVfId = vf.id;
    // Sonraki bölgeler için VEKİL: taşınmış / kısaltılmış hâli (motorun üreteceği sonuç)
    let proxyGeo = slab.geo;
    if (opts.proxyVerts) { const p = await slabOf(opts.proxyVerts(vf.vertices), vf.normal, t); if (p) proxyGeo = p.geo; }
    if (opts.move) { const d = new THREE.Vector3(); d.setComponent(opts.move[0][0] === 'x' ? 0 : opts.move[0][0] === 'y' ? 1 : 2, opts.move[0][1] === '+' ? opts.move[1] : -opts.move[1]); proxyGeo = proxyGeo.clone().translate(d.x, d.y, d.z); }
    siblings.push({ ...shape, geometry: proxyGeo });
    return true;
  };

  for (const key of order) {
    const f = FACE[key];
    if (key === 'bottom' && lift > 0) {
      // Ayaklıda 'side' köşede yan kısaltılır → alt yüz düzleminde damgası kalmaz; alt panel o uçtan kalınlık kadar kesilir.
      const cuts: Array<[Vec3, string, number]> = [];
      if (cfg.base === 'legs' && joins.bl === 'side') cuts.push([[-1, 0, 0], 'X-', -t]);
      if (cfg.base === 'legs' && joins.br === 'side') cuts.push([[1, 0, 0], 'X+', -t]);
      await push(key, f.n, f.seed, QUICK_PANEL_NAME[key], { move: ['y+', lift], cuts });
    } else if ((key === 'left' || key === 'right') && cfg.base === 'legs' && lift > 0 && joins[key === 'left' ? 'bl' : 'br'] === 'side') {
      // Yan köşeden geçiyor ama ayak kadar yukarıda biter: alt kenar extrude ile kısaltılır (vekil de kısaltılmış).
      await push(key, f.n, f.seed, QUICK_PANEL_NAME[key], {
        cuts: [[[0, -1, 0], 'Y-', -lift]],
        proxyVerts: vs => vs.map(v => [v[0], Math.max(v[1], y0 + lift), v[2]] as Vec3),
      });
    } else {
      await push(key, f.n, f.seed, QUICK_PANEL_NAME[key], {});
    }
  }

  if (cfg.base === 'plinth' && lift > 0) {
    // Ön baza: alt panelin altında kalan ön yüz şeridi; sonra setback kadar geri (−Z). Kapak/arkalık sınırı DEĞİL.
    await push('plinth', [0, 0, 1], new THREE.Vector3((x0 + x1) / 2, y0 + lift / 2, z1), 'Plinth', { move: ['z-', Math.max(0, cfg.plinth.front)], bound: false });
    if (cfg.plinth.rearPlinth) await push('rearPlinth', [0, 0, -1], new THREE.Vector3((x0 + x1) / 2, y0 + lift / 2, z0), 'Rear plinth', { move: ['z+', Math.max(0, cfg.plinth.rear)], bound: false });
  }

  if (!newVfs.length) return { panelCount: 0, backCreated: false, cyclic, warnings };

  // Tek seferde yaz: VF'ler sırayla (= basan/basılan), paneller hazır geometriyle (otomatik üretim efekti devreye girmez).
  useAppStore.setState(s => ({ virtualFaces: [...s.virtualFaces, ...newVfs], shapes: [...s.shapes, ...newShapes] }));
  // Ayaklar: ayaklı tabanda zorunlu, bazalıda isteğe bağlı (count 0 = yok)
  const legCount = cfg.base === 'legs' ? (cfg.legs.count || 4) : cfg.base === 'plinth' ? cfg.legs.count : 0;
  if (legCount) setBodyLegs(body.id, { count: legCount as 4 | 5 | 6, diameter: cfg.legs.diameter, side: cfg.legs.side, front: cfg.legs.front, rear: cfg.legs.rear, height: lift, bottomVfId });

  await requestRebuild(body.id);
  const { whenRebuildIdle } = await import('./PanelEngine');
  await whenRebuildIdle(body.id);

  // Arkalık: paneller gerçek geometrisiyle üretildikten sonra adaydan (en büyük, dört panelin arası)
  let backCreated = false;
  if (cfg.back.enabled) {
    const fresh = shapeById(body.id); if (!fresh) return { panelCount: newVfs.length, backCreated, cyclic, warnings };
    const cy = (y0 + lift + t + (y1 - t)) / 2;
    const picks = backCandidatesAt(fresh, BACK_AXIS, BACK_SIDE, [(x0 + x1) / 2, cy, z0]);
    if (picks.length) {
      // Aday = dört yeni panelin ARASI: yükseltilmiş alt panelin dış yüzü gövde kenarında olmadığından gövde kenarı (yere kadar) da
      // adaydır ve alanı daha büyüktür — bu yüzden en çok yeni panele dayanan aday seçilir, eşitlikte büyük alan.
      const ours = new Set(newVfs.filter(v => v.doorBound !== false).map(v => v.id));
      const score = (p: typeof picks[number]) => [p.bounds.uMin, p.bounds.uMax, p.bounds.vMin, p.bounds.vMax].filter(r => r.vfId && ours.has(r.vfId)).length;
      const pick = [...picks].sort((a, b) => score(b) - score(a) || b.area - a.area)[0];
      const b = cfg.back;
      const g = createBackGroupFromPick(fresh.id, pick, b.placement, 'Back', {
        thickness: Math.max(1, b.thickness), setback: Math.max(0, b.setback), inset: Math.max(0, b.inset),
        grooveClear: { front: Math.max(0, b.clear.front), back: Math.max(0, b.clear.back), depth: Math.max(0, b.clear.depth) },
      });
      backCreated = !!g;
      useAppStore.getState().setSelectedBackGroupId(null);
    } else warnings.push('Back: no candidate between the panels.');
  }
  return { panelCount: newVfs.length, backCreated, cyclic, warnings };
}
