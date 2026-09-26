import * as THREE from 'three';
import { useAppStore, type Shape, type VirtualFace, type PanelGroup, type GapSpec, type CavityBox } from '../store';
import { effectiveBodyGeometry } from './VertexEditorService';
import type { Vec3 } from './PanelMath';

// ═══════════════════════════════════════════════════════════════════════════
// RAF / DİKME GRUPLARI (PanelGroupService)
//
// SÖZLEŞME
//  • Grup = seçilen HACİM (cavity) + n panel + n+1 boşluk. Hacim, gövde yerel
//    kutusunda bir ÇIPA (anchorFrac) etrafından, kardeş panellerin kutularıyla
//    sınırlanarak büyütülür (growCavity). Küp boyutlanınca çıpa oransal kayar,
//    hacim güncel panellerden yeniden bulunur.
//  • Boşluk kuralı: ilk dağılım EŞİT. Bir boşluk girilince fark, kilitsiz ve
//    henüz girilmemiş boşluklara eşit dağılır. Küp boyutlanınca KİLİTLİ boşluk
//    sabit kalır; kilitsizler oranları korunarak (proportional) yeni açıklığa
//    ölçeklenir. Boşluklar panel kalınlığı düşüldükten sonra hesaplanır:
//    Σgap + n·t = L (hacmin dizilim eksenindeki açıklığı).
//  • İç paneller (raf/dikme) GÖVDE PANELLERİNİ ASLA BASMAZ: yüz VF bölgesi
//    hesabına ve damgalamaya girmezler. Gövde panelleri her zaman iç grupları
//    sınırlar; bir iç grup yalnız KENDİNDEN ÖNCE oluşturulmuş iç grupların
//    panelleriyle sınırlanır (döngü yok: A içinde B, B A'yı daraltamaz).
//  • Üye paneller sıradan VF-panelleridir: extrude / move / rotate adımları
//    motorda aynı yoldan uygulanır; VF (çözülmüş konum) her rebuild'de yazılır.
// ═══════════════════════════════════════════════════════════════════════════

export const GROUP_PANEL_THICKNESS = 18;
const TOL = 0.5;
const MIN_GAP = 0;

export const isInteriorPanel = (p: any): boolean => !!p?.parameters?.panelGroupId;
export const isInteriorVf = (vf: any): boolean => !!vf?.interior;
export const groupKindLabel = (k: PanelGroup['kind']) => (k === 'shelf' ? 'Shelf' : 'Divider');
export const groupAxisOf = (k: PanelGroup['kind']): 0 | 1 | 2 => (k === 'shelf' ? 1 : 0);

const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
const r1 = (v: number) => Math.round(v * 10) / 10;
const cloneBox = (b: CavityBox): CavityBox => ({ min: [...b.min] as Vec3, max: [...b.max] as Vec3 });
export const boxSpan = (b: CavityBox, a: number) => b.max[a] - b.min[a];
export const fmtBox = (b: CavityBox) => `${b.min.map(n => n.toFixed(0)).join(',')}..${b.max.map(n => n.toFixed(0)).join(',')}`;
const boxKey = (b: CavityBox) => [...b.min, ...b.max].map(n => Math.round(n)).join('|');

// ── KUTULAR ─────────────────────────────────────────────────────────────────

/** Gövdenin (vertex düzenlemeli etkin) yerel sınır kutusu. */
export function bodyLocalBox(parent: Shape): CavityBox | null {
  const geo = effectiveBodyGeometry(parent);
  const pos = geo?.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  const bb = new THREE.Box3().setFromBufferAttribute(pos);
  return { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] };
}

/** Panelin gövde-yerel kutusu (geometri gövde çerçevesindedir; konum farkı eklenir). */
export function panelLocalBox(p: Shape, parent: Shape): CavityBox | null {
  const pos = p.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count === 0) return null;
  const bb = new THREE.Box3().setFromBufferAttribute(pos);
  const d = [0, 1, 2].map(i => (p.position?.[i] ?? 0) - (parent.position?.[i] ?? 0));
  return { min: [bb.min.x + d[0], bb.min.y + d[1], bb.min.z + d[2]], max: [bb.max.x + d[0], bb.max.y + d[1], bb.max.z + d[2]] };
}

const boxContains = (b: CavityBox, p: Vec3, tol = TOL) =>
  p[0] > b.min[0] + tol && p[0] < b.max[0] - tol && p[1] > b.min[1] + tol && p[1] < b.max[1] - tol && p[2] > b.min[2] + tol && p[2] < b.max[2] - tol;

/**
 * HACİM BÜYÜTME: tohum noktasından başlayan kutu, 6 yönde en yakın engele
 * (kesitiyle örtüşen panel kutusu) ya da gövde sınırına kadar büyütülür.
 * Yön sırası: önce çapraz eksenler, dizilim ekseni son (raf: önce X/Z, sonra Y).
 * Sabitlenene kadar yinelenir (bir eksendeki büyüme diğerinde yeni engel getirebilir).
 */
export function growCavity(seed: Vec3, body: CavityBox, obstacles: CavityBox[], stackAxis: number): CavityBox {
  const box: CavityBox = { min: [seed[0] - 0.1, seed[1] - 0.1, seed[2] - 0.1], max: [seed[0] + 0.1, seed[1] + 0.1, seed[2] + 0.1] };
  const obs = obstacles.filter(o => !boxContains(o, seed, -TOL));
  const axes = [0, 1, 2].filter(a => a !== stackAxis).concat([stackAxis]);
  const overlapsOther = (o: CavityBox, a: number) => {
    for (const b of [0, 1, 2]) {
      if (b === a) continue;
      if (!(o.min[b] < box.max[b] - TOL && o.max[b] > box.min[b] + TOL)) return false;
    }
    return true;
  };
  for (let iter = 0; iter < 8; iter++) {
    let changed = false;
    for (const a of axes) {
      // − yön
      let lo = body.min[a];
      for (const o of obs) if (overlapsOther(o, a) && o.max[a] <= box.min[a] + TOL && o.max[a] > lo) lo = o.max[a];
      // + yön
      let hi = body.max[a];
      for (const o of obs) if (overlapsOther(o, a) && o.min[a] >= box.max[a] - TOL && o.min[a] < hi) hi = o.min[a];
      if (Math.abs(box.min[a] - lo) > 1e-6) { box.min[a] = lo; changed = true; }
      if (Math.abs(box.max[a] - hi) > 1e-6) { box.max[a] = hi; changed = true; }
    }
    if (!changed) break;
  }
  return box;
}

function rayBoxInterval(o: Vec3, d: Vec3, b: CavityBox): [number, number] | null {
  let t0 = -Infinity, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < b.min[a] || o[a] > b.max[a]) return null;
      continue;
    }
    let ta = (b.min[a] - o[a]) / d[a], tb = (b.max[a] - o[a]) / d[a];
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/**
 * IŞIN BOYUNCA SERBEST HACİMLER: gövde aralığından panel aralıkları çıkarılır;
 * kalan her serbest parçadan (3 örnek nokta) hacim büyütülür, tekilleştirilir,
 * ışın derinliğine göre sıralanır. Sol tık bu liste üzerinde döner.
 */
export function rayCavityCandidates(originLocal: Vec3, dirLocal: Vec3, body: CavityBox, obstacles: CavityBox[], stackAxis: number, minSpan: number): CavityBox[] {
  const bodyIv = rayBoxInterval(originLocal, dirLocal, body);
  if (!bodyIv) return [];
  const blocked: Array<[number, number]> = [];
  for (const o of obstacles) {
    const iv = rayBoxInterval(originLocal, dirLocal, o);
    if (iv && iv[1] > bodyIv[0] && iv[0] < bodyIv[1]) blocked.push([Math.max(iv[0], bodyIv[0]), Math.min(iv[1], bodyIv[1])]);
  }
  blocked.sort((p, q) => p[0] - q[0]);
  const free: Array<[number, number]> = [];
  let cur = Math.max(bodyIv[0], 0);
  for (const [a, b] of blocked) {
    if (b <= cur) continue;
    if (a > cur + 1) free.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (bodyIv[1] > cur + 1) free.push([cur, bodyIv[1]]);

  const out: CavityBox[] = [];
  const seen = new Set<string>();
  for (const [a, b] of free) {
    for (const f of [0.5, 0.25, 0.75]) {
      const t = a + (b - a) * f;
      const seed: Vec3 = [originLocal[0] + dirLocal[0] * t, originLocal[1] + dirLocal[1] * t, originLocal[2] + dirLocal[2] * t];
      const box = growCavity(seed, body, obstacles, stackAxis);
      if (boxSpan(box, 0) < minSpan || boxSpan(box, 1) < minSpan || boxSpan(box, 2) < minSpan) continue;
      const k = boxKey(box);
      if (seen.has(k)) continue;
      seen.add(k); out.push(box);
    }
  }
  return out;
}

// ── BOŞLUK ÇÖZÜCÜ ───────────────────────────────────────────────────────────

/** Eşit dağılım: n panel, n+1 boşluk, kilitsiz. */
export function equalGaps(L: number, count: number, t: number): GapSpec[] {
  const n = Math.max(0, count);
  const g = Math.max(MIN_GAP, (L - n * t) / (n + 1));
  return Array.from({ length: n + 1 }, () => ({ value: r1(g), locked: false }));
}

/**
 * YENİDEN DAĞITIM (küp boyutlandı / hacim değişti): kilitli boşluklar aynen
 * kalır; kalan açıklık kilitsizlere ORANLARI korunarak dağılır (hepsi eşitse
 * eşit kalır). Kilitliler sığmıyorsa oransal küçültülür (uyarı). Hepsi
 * kilitliyse artık son boşluğa yazılır.
 */
export function rescaleGaps(gaps: GapSpec[], L: number, count: number, t: number): GapSpec[] {
  if (!Array.isArray(gaps) || gaps.length !== count + 1) return equalGaps(L, count, t);
  const avail = L - count * t;
  const out = gaps.map(g => ({ ...g }));
  const lockedSum = out.filter(g => g.locked).reduce((s, g) => s + g.value, 0);
  let free = avail - lockedSum;
  if (free < -1e-6) {
    const k = lockedSum > 0 ? Math.max(0, avail) / lockedSum : 0;
    console.warn('[YAGO][GRUP-BOŞLUK] kilitli boşluklar açıklığa sığmıyor: kilitliΣ=', lockedSum.toFixed(1), 'açıklık=', avail.toFixed(1), '→ kilitliler oransal küçültüldü');
    for (const g of out) if (g.locked) g.value = r1(g.value * k);
    free = 0;
  }
  const unlocked = out.filter(g => !g.locked);
  if (unlocked.length === 0) {
    const last = out[out.length - 1];
    if (Math.abs(free) > 0.05) { last.value = r1(last.value + free); console.warn('[YAGO][GRUP-BOŞLUK] tüm boşluklar kilitli, artık son boşluğa yazıldı:', free.toFixed(1)); }
    return out;
  }
  const uSum = unlocked.reduce((s, g) => s + g.value, 0);
  if (uSum > 1e-6) for (const g of unlocked) g.value = r1(g.value * free / uSum);
  else for (const g of unlocked) g.value = r1(free / unlocked.length);
  // Yuvarlama artığı son kilitsize.
  const total = out.reduce((s, g) => s + g.value, 0);
  const resid = avail - total;
  if (Math.abs(resid) > 0.05) unlocked[unlocked.length - 1].value = r1(unlocked[unlocked.length - 1].value + resid);
  return out;
}

/**
 * BOŞLUK GİRİŞİ: k. boşluk value olur ve "girildi" sayılır; fark, kilitsiz ve
 * girilmemiş boşluklara EŞİT dağılır. Öyle boşluk kalmadıysa diğer kilitsiz
 * (girilmiş) boşluklara oransal; o da yoksa değer kalan açıklığa kırpılır.
 */
export function applyGapEdit(gaps: GapSpec[], k: number, value: number, L: number, count: number, t: number): GapSpec[] {
  const out = (gaps.length === count + 1 ? gaps : equalGaps(L, count, t)).map(g => ({ ...g }));
  if (k < 0 || k >= out.length) return out;
  const avail = L - count * t;
  const v = Math.max(MIN_GAP, value);
  out[k] = { ...out[k], value: r1(v), edited: true };
  const others = out.filter((_, i) => i !== k);
  const fixedSum = others.filter(g => g.locked || g.edited).reduce((s, g) => s + g.value, 0);
  let free = avail - out[k].value - fixedSum;
  const fresh = others.filter(g => !g.locked && !g.edited);
  if (fresh.length > 0) {
    if (free < 0) { console.warn('[YAGO][GRUP-BOŞLUK] girilen değer açıklığı aşıyor, serbest boşluklar 0:', free.toFixed(1)); free = 0; }
    for (const g of fresh) g.value = r1(free / fresh.length);
    return out;
  }
  const soft = others.filter(g => !g.locked);
  if (soft.length > 0) {
    if (free < 0) free = 0;
    const sSum = soft.reduce((s, g) => s + g.value, 0);
    if (sSum > 1e-6) for (const g of soft) g.value = r1(g.value * free / sSum);
    else for (const g of soft) g.value = r1(free / soft.length);
    return out;
  }
  // Diğerlerinin hepsi kilitli: girilen değer kalan açıklığa kırpılır.
  const lockedSum = others.reduce((s, g) => s + g.value, 0);
  out[k].value = r1(Math.max(MIN_GAP, avail - lockedSum));
  console.warn('[YAGO][GRUP-BOŞLUK] diğer boşluklar kilitli, değer kırpıldı →', out[k].value);
  return out;
}

/** Panel başlangıçları (dizilim ekseni, hacim min'inden): p_i = min + Σgap[0..i] + i·t. */
export function panelStarts(cavityMin: number, gaps: GapSpec[], t: number): number[] {
  const starts: number[] = [];
  let p = cavityMin;
  for (let i = 0; i < gaps.length - 1; i++) {
    p += gaps[i].value;
    starts.push(p);
    p += t;
  }
  return starts;
}

// ── ÜYE VF GEOMETRİSİ ───────────────────────────────────────────────────────

/**
 * Üye VF: dizilim ekseninde start+t düzleminde (normal +eksen), hacmin diğer iki
 * eksenini tam kaplayan dikdörtgen. createPanelFromVirtualFace −normal yönünde
 * t kadar uzar → levha [start, start+t] aralığına oturur.
 */
export function memberVfGeometry(axis: number, cavity: CavityBox, start: number, t: number): { normal: Vec3; vertices: Vec3[]; center: Vec3 } {
  const [b, c] = [0, 1, 2].filter(a => a !== axis);
  const plane = start + t;
  const mk = (vb: number, vc: number): Vec3 => { const p: Vec3 = [0, 0, 0]; p[axis] = plane; p[b] = vb; p[c] = vc; return p; };
  const vertices = [mk(cavity.min[b], cavity.min[c]), mk(cavity.max[b], cavity.min[c]), mk(cavity.max[b], cavity.max[c]), mk(cavity.min[b], cavity.max[c])];
  const normal: Vec3 = [0, 0, 0]; normal[axis] = 1;
  const center = mk((cavity.min[b] + cavity.max[b]) / 2, (cavity.min[c] + cavity.max[c]) / 2);
  return { normal, vertices, center };
}

export interface GroupSolution { cavity: CavityBox; gaps: GapSpec[]; starts: number[] }

/** Grubun engelleri: tüm gövde panelleri + kendinden ÖNCE oluşturulmuş grupların panelleri. */
export function groupObstacles(group: PanelGroup, parent: Shape, panels: Shape[], groups: PanelGroup[]): CavityBox[] {
  const byId = new Map(groups.map(g => [g.id, g] as const));
  const out: CavityBox[] = [];
  for (const p of panels) {
    if ((p.parameters as any)?.parentShapeId !== parent.id) continue;
    const gid = (p.parameters as any)?.panelGroupId as string | undefined;
    if (gid) {
      if (gid === group.id) continue;
      const g = byId.get(gid);
      if (!g || g.createdAt >= group.createdAt) continue;
    }
    const b = panelLocalBox(p, parent);
    if (b) out.push(b);
  }
  return out;
}

/** Grubu güncel gövde + panellerle çözer (saf). Hacim bozuksa önceki hacimle devam eder. */
export function solveGroup(group: PanelGroup, parent: Shape, panels: Shape[], groups: PanelGroup[]): GroupSolution | null {
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const seed: Vec3 = [0, 1, 2].map(i => body.min[i] + group.anchorFrac[i] * (body.max[i] - body.min[i])) as Vec3;
  const obstacles = groupObstacles(group, parent, panels, groups);
  let cavity = growCavity(seed, body, obstacles, group.axis);
  const t = group.thickness;
  const minOk = [0, 1, 2].every(a => boxSpan(cavity, a) >= (a === group.axis ? group.count * t : t));
  if (!minOk) {
    console.warn('[YAGO][GRUP] hacim bozuk/çok küçük, önceki hacim korunuyor:', group.id, fmtBox(cavity));
    cavity = cloneBox(group.cavity);
  }
  const L = boxSpan(cavity, group.axis);
  const gaps = rescaleGaps(group.gaps, L, group.count, t);
  return { cavity, gaps, starts: panelStarts(cavity.min[group.axis], gaps, t) };
}

/** Çözümden üye VF yaması (regen bu alanları yazar; kullanıcı alanları dokunulmaz). */
export function interiorVfPatch(vf: VirtualFace, group: PanelGroup, sol: GroupSolution): Partial<VirtualFace> | null {
  const i = vf.groupIndex ?? group.memberVfIds.indexOf(vf.id);
  if (i < 0 || i >= sol.starts.length) return null;
  const g = memberVfGeometry(group.axis, sol.cavity, sol.starts[i], group.thickness);
  return { normal: g.normal, vertices: g.vertices, center: g.center, regionAnchor: g.center } as any;
}

/**
 * REGEN KANCASI (VirtualFaceUpdateService): bir gövdenin tüm iç VF'lerini grup
 * çözümüyle yeniden yazar. Yüz eşlemesi yapılmaz. Grup yoksa VF olduğu gibi kalır.
 */
export function recalculateInteriorVfs(parent: Shape, vfs: VirtualFace[], panels: Shape[], groups: PanelGroup[]): Map<string, VirtualFace> {
  const out = new Map<string, VirtualFace>();
  const mine = groups.filter(g => g.shapeId === parent.id);
  for (const g of mine) {
    const sol = solveGroup(g, parent, panels, groups);
    if (!sol) continue;
    console.log('[YAGO][GRUP-REGEN]', g.id, g.kind, 'n=', g.count, 'hacim=', fmtBox(sol.cavity),
      'L=', boxSpan(sol.cavity, g.axis).toFixed(1), 'boşluklar=', sol.gaps.map(x => `${x.value}${x.locked ? '🔒' : ''}`).join('/'));
    for (const vf of vfs) {
      if (vf.shapeId !== parent.id || vf.groupId !== g.id) continue;
      const patch = interiorVfPatch(vf, g, sol);
      if (patch) out.set(vf.id, { ...vf, ...patch });
    }
  }
  return out;
}

// ── STORE İŞLEMLERİ ─────────────────────────────────────────────────────────

const rebuild = (shapeId: string) =>
  import('./PanelEngine').then(({ rebuildPanelsForParent }) => rebuildPanelsForParent(shapeId));

function makeMemberVf(group: PanelGroup, i: number, sol: GroupSolution): VirtualFace {
  const g = memberVfGeometry(group.axis, sol.cavity, sol.starts[i], group.thickness);
  return {
    id: genId('vf-int'), shapeId: group.shapeId,
    normal: g.normal, center: g.center, vertices: g.vertices,
    description: '', hasPanel: false,
    parentFaceShape: false, interior: true, groupId: group.id, groupIndex: i,
    ...( { regionAnchor: g.center } as any ),
  };
}

/** Onaylanan hacimden grup + ilk üye VF (1 panel, eşit boşluk) oluşturur; grup seçilir. */
export function createPanelGroupFromCavity(shapeId: string, kind: PanelGroup['kind'], cavity: CavityBox): PanelGroup | null {
  const st = useAppStore.getState();
  const parent = st.shapes.find(s => s.id === shapeId);
  if (!parent) return null;
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const axis = groupAxisOf(kind);
  const t = GROUP_PANEL_THICKNESS;
  const c: Vec3 = [0, 1, 2].map(i => (cavity.min[i] + cavity.max[i]) / 2) as Vec3;
  const anchorFrac: Vec3 = [0, 1, 2].map(i => {
    const s = body.max[i] - body.min[i];
    return s > 1e-6 ? Math.max(0, Math.min(1, (c[i] - body.min[i]) / s)) : 0.5;
  }) as Vec3;
  const count = 1;
  const L = boxSpan(cavity, axis);
  const group: PanelGroup = {
    id: genId(kind === 'shelf' ? 'shelf' : 'divider'), shapeId, kind, axis, anchorFrac,
    cavity: cloneBox(cavity), count, gaps: equalGaps(L, count, t), thickness: t, memberVfIds: [], createdAt: Date.now(),
  };
  const sol: GroupSolution = { cavity: group.cavity, gaps: group.gaps, starts: panelStarts(cavity.min[axis], group.gaps, t) };
  const vfs = Array.from({ length: count }, (_, i) => makeMemberVf(group, i, sol));
  group.memberVfIds = vfs.map(v => v.id);
  st.addPanelGroup(group);
  st.insertVirtualFacesAfter(null, vfs);
  st.setSelectedPanelGroupId(group.id);
  console.log('[YAGO][GRUP] oluşturuldu', group.id, kind, 'hacim=', fmtBox(cavity), 'L=', L.toFixed(1), 'çıpa=', anchorFrac.map(n => n.toFixed(2)).join(','));
  return group;
}

/** Üye sayısı: artınca yeni VF'ler son üyenin arkasına eklenir, azalınca son üyeler (panel+VF) silinir. Boşluklar eşitlenir. */
export async function setGroupCount(groupId: string, count: number): Promise<void> {
  const st = useAppStore.getState();
  const group = st.panelGroups.find(g => g.id === groupId);
  if (!group) return;
  const n = Math.max(0, Math.min(40, Math.round(count)));
  if (n === group.count) return;
  const L = boxSpan(group.cavity, group.axis);
  const gaps = equalGaps(L, n, group.thickness);
  const starts = panelStarts(group.cavity.min[group.axis], gaps, group.thickness);
  const sol: GroupSolution = { cavity: group.cavity, gaps, starts };
  let memberVfIds = group.memberVfIds.slice();
  if (n < group.count) {
    const removed = memberVfIds.slice(n);
    memberVfIds = memberVfIds.slice(0, n);
    for (const vfId of removed) {
      const p = st.shapes.find(s => s.type === 'panel' && (s.parameters as any)?.virtualFaceId === vfId);
      if (p) st.deleteShape(p.id);
      st.deleteVirtualFace(vfId);
      if (st.selectedPanelRow === `vf-${vfId}`) st.setSelectedPanelRow(null);
    }
  }
  const next: PanelGroup = { ...group, count: n, gaps, memberVfIds };
  // Kalan üyelerin VF'leri yeni konuma.
  for (let i = 0; i < Math.min(n, group.count); i++) {
    const vf = st.virtualFaces.find(f => f.id === memberVfIds[i]);
    if (!vf) continue;
    const patch = interiorVfPatch({ ...vf, groupIndex: i }, next, sol);
    if (patch) st.updateVirtualFace(vf.id, { ...patch, groupIndex: i });
  }
  if (n > group.count) {
    const added = Array.from({ length: n - group.count }, (_, k) => makeMemberVf(next, group.count + k, sol));
    next.memberVfIds = [...memberVfIds, ...added.map(v => v.id)];
    st.insertVirtualFacesAfter(memberVfIds[memberVfIds.length - 1] || null, added);
  }
  st.updatePanelGroup(groupId, { count: n, gaps: next.gaps, memberVfIds: next.memberVfIds });
  console.log('[YAGO][GRUP] adet', group.count, '→', n, groupId, '(boşluklar eşitlendi)');
  // Panel ekleme (VF → otomatik panel) / silme rebuild'i App izleyicisi tetikler.
}

function writeGroupGaps(group: PanelGroup, gaps: GapSpec[]): void {
  const st = useAppStore.getState();
  const starts = panelStarts(group.cavity.min[group.axis], gaps, group.thickness);
  const sol: GroupSolution = { cavity: group.cavity, gaps, starts };
  const next = { ...group, gaps };
  for (const vfId of group.memberVfIds) {
    const vf = st.virtualFaces.find(f => f.id === vfId);
    if (!vf) continue;
    const patch = interiorVfPatch(vf, next, sol);
    if (patch) st.updateVirtualFace(vf.id, patch);
  }
  st.updatePanelGroup(group.id, { gaps });
}

/** Boşluk girişi (şema pill'i): kural applyGapEdit; VF'ler güncellenir, tam rebuild. */
export async function editGroupGap(groupId: string, k: number, value: number): Promise<void> {
  const st = useAppStore.getState();
  const group = st.panelGroups.find(g => g.id === groupId);
  if (!group || !Number.isFinite(value)) return;
  const L = boxSpan(group.cavity, group.axis);
  const gaps = applyGapEdit(group.gaps, k, value, L, group.count, group.thickness);
  writeGroupGaps(group, gaps);
  console.log('[YAGO][GRUP-BOŞLUK] girildi', groupId, 'k=', k, 'değer=', value, '→', gaps.map(g => `${g.value}${g.locked ? '🔒' : g.edited ? '*' : ''}`).join('/'));
  await rebuild(group.shapeId);
}

/** Kilit: değer değişmez; küp boyutlanınca bu boşluk sabit kalır. */
export function toggleGroupGapLock(groupId: string, k: number): void {
  const st = useAppStore.getState();
  const group = st.panelGroups.find(g => g.id === groupId);
  if (!group || k < 0 || k >= group.gaps.length) return;
  const gaps = group.gaps.map((g, i) => (i === k ? { ...g, locked: !g.locked } : g));
  st.updatePanelGroup(groupId, { gaps });
  console.log('[YAGO][GRUP-BOŞLUK]', gaps[k].locked ? 'KİLİTLENDİ' : 'kilit açıldı', groupId, 'k=', k, 'değer=', gaps[k].value);
}

/** Tüm boşluklar eşit + kilitsiz. */
export async function equalizeGroupGaps(groupId: string): Promise<void> {
  const st = useAppStore.getState();
  const group = st.panelGroups.find(g => g.id === groupId);
  if (!group) return;
  const L = boxSpan(group.cavity, group.axis);
  writeGroupGaps(group, equalGaps(L, group.count, group.thickness));
  console.log('[YAGO][GRUP-BOŞLUK] eşitlendi', groupId);
  await rebuild(group.shapeId);
}

/** Grup + tüm üye paneller ve VF'ler silinir (rebuild'i panel silme izleyicisi tetikler). */
export function deletePanelGroupWithMembers(groupId: string): void {
  const st = useAppStore.getState();
  const group = st.panelGroups.find(g => g.id === groupId);
  if (!group) return;
  for (const vfId of group.memberVfIds) {
    const p = st.shapes.find(s => s.type === 'panel' && (s.parameters as any)?.virtualFaceId === vfId);
    if (p) st.deleteShape(p.id);
    st.deleteVirtualFace(vfId);
    if (st.selectedPanelRow === `vf-${vfId}`) st.setSelectedPanelRow(null);
  }
  st.deletePanelGroup(groupId);
  console.log('[YAGO][GRUP] silindi', groupId, 'üyeN=', group.memberVfIds.length);
}

/**
 * REBUILD SONRASI SENKRON (PanelEngine): grubun store'daki hacmi/boşlukları
 * güncel çözümle eşitlenir (şema ve kilit değerleri doğru okunsun).
 */
export function syncPanelGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = st.shapes.find(s => s.id === parentShapeId);
  if (!parent) return;
  const mine = st.panelGroups.filter(g => g.shapeId === parentShapeId);
  for (const g of mine) {
    const sol = solveGroup(g, parent, st.shapes, st.panelGroups);
    if (!sol) continue;
    const sameBox = boxKey(sol.cavity) === boxKey(g.cavity);
    const sameGaps = sol.gaps.length === g.gaps.length && sol.gaps.every((x, i) => Math.abs(x.value - g.gaps[i].value) < 0.05 && x.locked === g.gaps[i].locked);
    if (sameBox && sameGaps) continue;
    st.updatePanelGroup(g.id, { cavity: sol.cavity, gaps: sol.gaps });
    console.log('[YAGO][GRUP-SENKRON]', g.id, 'hacim=', fmtBox(sol.cavity), 'boşluklar=', sol.gaps.map(x => x.value).join('/'));
  }
}
