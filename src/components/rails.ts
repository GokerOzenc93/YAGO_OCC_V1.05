/* KAYIT HARNESS'İ (Node + gerçek replicad/OCC): hızlı gövde kayıtlarının kutu ve L gövdede nereye yerleştiğini ölçer.
   Kullanım: node harness/dist/rails.mjs <senaryo>   (SCEN env ile de)  — senaryolar aşağıda. */
import * as THREE from 'three';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { useAppStore, type Shape, type QuickBodyConfig, DEFAULT_QUICK_BODY, DEFAULT_RAILS, railsOf } from '../src/store';
import { initReplicad, rebuildBodySolid, localBboxOf, type Vec3 } from '../src/components/Geometry';
import { applyQuickBody, quickBodyVfsOf } from '../src/components/PanelGroupService';
import { setBodyFaceRole, bodyFaces, setBodyFrontAxis } from '../src/components/PlinthService';
import { whenRebuildIdle } from '../src/components/PanelEngine';
import { createPanelFromVirtualFace, convertReplicadToThreeGeometry, genId } from '../src/components/Geometry';

/** UI'daki "paneli olmayan VF'ye panel üret" efektinin (Assembly.tsx) harness karşılığı: arkalık üyeleri. */
async function materializePending(bodyId: string) {
  const st = useAppStore.getState();
  const pending = st.virtualFaces.filter(vf => vf.shapeId === bodyId && !vf.hasPanel && !vf.plinthId && !st.shapes.some(s => s.parameters?.virtualFaceId === vf.id));
  for (const vf of pending) {
    const bgrp = vf.backGroupId ? st.backGroups.find(bg => bg.id === vf.backGroupId) : undefined;
    const th = bgrp ? bgrp.thickness : 18;
    const rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, th); if (!rp) continue;
    const g = convertReplicadToThreeGeometry(rp);
    const body = st.shapes.find(x => x.id === bodyId)!;
    useAppStore.getState().addShape({
      id: genId('panel-vf'), type: 'panel', position: [...body.position], rotation: body.rotation, scale: [...body.scale], color: '#fff', geometry: g, replicadShape: rp,
      parameters: { width: 0, height: 0, depth: th, parentShapeId: bodyId, virtualFaceId: vf.id, panelThickness: th, ...(vf.backGroupId ? { backGroupId: vf.backGroupId } : {}) },
    } as unknown as Shape);
    useAppStore.getState().updateVirtualFace(vf.id, { hasPanel: true });
  }
  if (pending.length) { const { requestRebuild } = await import('../src/store'); await requestRebuild(bodyId); await whenRebuildIdle(bodyId); }
  return pending.length;
}

const scen = process.argv[2] || process.env.SCEN || 'box-h';
const r1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (b: THREE.Box3) => `x ${r1(b.min.x)}..${r1(b.max.x)}  y ${r1(b.min.y)}..${r1(b.max.y)}  z ${r1(b.min.z)}..${r1(b.max.z)}`;

async function makeBody(id: string, W: number, H: number, D: number, notch?: { x0: number; z0: number; w: number; d: number }): Promise<Shape> {
  const size = { width: W, height: H, depth: D };
  const subs = notch ? [{ parameters: { width: notch.w, height: H + 2, depth: notch.d }, relativeOffset: [notch.x0, -1, notch.z0] as Vec3 }] : [];
  const r = await rebuildBodySolid({ parameters: size }, subs, size, false);
  return {
    id, type: 'box', geometry: r.geometry, replicadShape: r.replicadShape, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#fff',
    parameters: { ...size, scaledBaseVertices: r.scaledBaseVertices }, vertexModifications: [], subtractionGeometries: [], fillets: [],
  } as unknown as Shape;
}

function cfgOf(mod: (c: QuickBodyConfig) => void): QuickBodyConfig {
  const c: QuickBodyConfig = JSON.parse(JSON.stringify({ ...DEFAULT_QUICK_BODY, top: { ...DEFAULT_RAILS }, bottom: { ...DEFAULT_RAILS } }));
  mod(c);
  return c;
}
const rail = (kind: 'horizontal' | 'vertical', size = 100, setback = 0) => ({ kind, size, setback });

async function main() {
  (globalThis as any).window = globalThis;
  await initReplicad();
  const st = useAppStore.getState();
  const W = 800, H = 720, D = 560;
  const isL = scen.startsWith('L');
  // L: ön-sağ köşede çentik (x 450..800, z 300..560 boş) → ön yüzler: z=560 (x 0..450) ve z=300 (x 450..800); +X yüzler: x=800 (z 0..300) ve x=450 (z 300..560)
  const body = await makeBody('body-1', W, H, D, isL ? { x0: 450, z0: 300, w: 400, d: 300 } : undefined);
  st.addShape(body);
  const faces = bodyFaces(body);
  console.log(`[${scen}] gövde yüzleri:`, faces.map(f => `${f.role}${f.overridden ? '*' : ''}@${f.axis ?? 'tilt'} c=(${f.center.map(r1).join(',')})`).join(' | '));
  if (scen.startsWith('L-corner')) {
    // KÖŞE DOLABI rolleri: çentik yüzleri ÖN (x=450 → front), x=0 → rear, z=560 → left; z=0 rear otomatik, x=800 right otomatik
    const by = (ax: string, pred: (c: Vec3) => boolean) => faces.find(f => f.axis === ax && pred(f.center));
    const notchX = by('x+', c => c[0] < 500), leftX = by('x-', () => true), frontZ = by('z+', c => c[2] > 500);
    if (notchX) setBodyFaceRole(body.id, notchX.gi, 'front');
    if (leftX) setBodyFaceRole(body.id, leftX.gi, 'rear');
    if (frontZ) setBodyFaceRole(body.id, frontZ.gi, 'left');
    const b2 = useAppStore.getState().shapes.find(s => s.id === body.id)!;
    console.log(`[${scen}] roller:`, bodyFaces(b2).map(f => `${f.role}${f.overridden ? '*' : ''}@${f.axis}`).join(' | '));
  }
  if (scen === 'box-xfront-h') setBodyFrontAxis(body.id, 'x+');
  if (scen.startsWith('L-backnotch')) {
    // ARKA ÇENTİKLİ dolap: ön yön −Z; çentik yüzleri ARKA (x=450 duvarı 'rear' üstüne yazılır; z=560 ve z=300 otomatik rear), z=0 ön,
    // x=0 / x=800 yanlar.
    setBodyFrontAxis(body.id, 'z-');
    const b1 = useAppStore.getState().shapes.find(s => s.id === body.id)!;
    const wall = bodyFaces(b1).find(f => f.axis === 'x+' && f.center[0] < 500);
    if (wall) setBodyFaceRole(body.id, wall.gi, 'rear');
    const b2 = useAppStore.getState().shapes.find(s => s.id === body.id)!;
    console.log(`[${scen}] roller:`, bodyFaces(b2).map(f => `${f.role}${f.overridden ? '*' : ''}@${f.axis}`).join(' | '));
  }
  const vertical = scen.endsWith('-v');
  const cfg = cfgOf(c => {
    c.base = 'plinth'; c.plinth = { height: 100, front: 0, rear: 50, rearPlinth: false }; c.legs.count = 0;
    c.back = { ...c.back, enabled: scen.includes('back') };
    const k = vertical ? 'vertical' : 'horizontal';
    const join = scen.includes('passes') ? 'rail' as const : undefined;
    const rails = { panel: scen.includes('panel'), front: { ...rail(k, 100, scen.includes('sb') ? 20 : 0), join }, rear: { ...rail(k, 80, 0), join }, backRel: 'groove' as const };
    const plain = { panel: true, front: rail('none'), rear: rail('none'), backRel: 'groove' as const };
    if (scen.includes('bottom')) { c.bottom = rails; c.top = plain; } else { c.top = rails; c.bottom = plain; }
    if (scen.includes('horiz')) c.joins = { tl: 'horiz', tr: 'horiz', bl: 'horiz', br: 'horiz' };
    if (scen.includes('legs')) { c.base = 'legs'; c.legs = { ...c.legs, count: 4, height: 100 }; }
  });
  console.log(`[${scen}] cfg top:`, JSON.stringify(railsOf(cfg, 'top')));
  const t0 = Date.now();
  const res = await applyQuickBody(body.id, cfg);
  await whenRebuildIdle(body.id);
  const made = await materializePending(body.id);
  console.log(`[${scen}] sonuç:`, JSON.stringify(res), `${Date.now() - t0} ms`, made ? `(+${made} arkalık paneli)` : '');
  const dump = (label: string) => {
    const now = useAppStore.getState();
    if (process.env.DUMPJSON) {
      const rows: any[] = [];
      for (const s of now.shapes.filter(x => x.parameters?.parentShapeId === body.id)) {
        const bb = localBboxOf(s.geometry); if (!bb) continue;
        const vf = now.virtualFaces.find(f => f.id === s.parameters?.virtualFaceId);
        rows.push({ name: vf?.description ?? s.id, key: vf?.quickBody ?? (vf?.backGroupId ? 'back' : '?'), min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z],
          verts: vf?.vertices ?? null });
      }
      require('fs').writeFileSync(process.env.DUMPJSON, JSON.stringify({ scen, W, H, D, notch: isL ? { x0: 450, z0: 300, w: 400, d: 300 } : null, rows }));
    }
    for (const vf of quickBodyVfsOf(body.id, now.virtualFaces)) {
      const p = now.shapes.find(s => s.parameters?.virtualFaceId === vf.id);
      const bb = p ? localBboxOf(p.geometry) : null;
      console.log(`  ${label}${String(vf.quickBody).padEnd(14)} ${vf.description.padEnd(24)} ${bb ? fmt(bb) : '—'}  köşe:${vf.vertices.length}${vf.railStrip ? ' strip' : ''}`);
    }
    for (const g of now.backGroups.filter(g => g.shapeId === body.id)) for (const mid of g.memberVfIds) {
      const p = now.shapes.find(s => s.parameters?.virtualFaceId === mid); const bb = p ? localBboxOf(p.geometry) : null;
      console.log(`  ${label}${'back'.padEnd(14)} ${g.name.padEnd(24)} ${bb ? fmt(bb) : '—'}`);
    }
  };
  dump('');
  if (process.env.REAPPLY) {
    const ids = new Set(useAppStore.getState().shapes.filter(s => s.parameters?.parentShapeId === body.id).map(s => s.id));
    const res2 = await applyQuickBody(body.id, cfg); await whenRebuildIdle(body.id);
    const ids2 = useAppStore.getState().shapes.filter(s => s.parameters?.parentShapeId === body.id).map(s => s.id);
    console.log(`[${scen}] yeniden uygulama:`, JSON.stringify(res2), `id korunan ${ids2.filter(i => ids.has(i)).length}/${ids2.length}`);
    dump('R ');
  }
  if (process.env.RESIZE) {
    // Gövde derinliği +100 (ön yüz ileri gider): şerit kenarı izlemeli, genişlik sabit kalmalı.
    const nb = await makeBody(body.id, W, H, D + 100, isL ? { x0: 450, z0: 400, w: 400, d: 300 } : undefined);
    useAppStore.getState().updateShape(body.id, { geometry: nb.geometry, replicadShape: nb.replicadShape, parameters: { ...body.parameters, depth: D + 100 } } as Partial<Shape>);
    const { requestRebuild: rr } = await import('../src/store');
    await rr(body.id); await whenRebuildIdle(body.id);
    console.log(`[${scen}] RESIZE derinlik ${D} → ${D + 100}:`);
    dump('S ');
  }
  // İkinci tam rebuild: kararlı mı?
  const { requestRebuild } = await import('../src/store');
  const now = useAppStore.getState();
  const before = new Map(now.shapes.filter(s => s.parameters?.parentShapeId === body.id).map(s => [s.id, fmt(localBboxOf(s.geometry)!)]));
  await requestRebuild(body.id); await whenRebuildIdle(body.id);
  const after = useAppStore.getState().shapes.filter(s => s.parameters?.parentShapeId === body.id);
  const drift = after.filter(s => before.get(s.id) !== fmt(localBboxOf(s.geometry)!));
  console.log(`[${scen}] 2. rebuild: ${drift.length ? 'DEĞİŞTİ → ' + drift.map(s => `${s.id}: ${before.get(s.id)} → ${fmt(localBboxOf(s.geometry)!)}`).join('; ') : 'kararlı'}`);
  if (process.env.DUMP2) dump('2 ');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
