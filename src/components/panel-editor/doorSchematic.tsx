import { useMemo } from 'react';
import { type DoorAlign, type DoorGroup } from '../../store';
import {
  type DoorCut, type DoorEdgeKey, type DoorJoint, type DoorNearPanel, type DoorNodeSolved, JOINT_NEAR, jointOverlayState, DOOR_TYPE_LABEL,
  applyDoorCuts, doorCutBands, doorCutOutline, doorJointParts, doorJoints, doorLeafAxis, doorMemberRects, edgeGapsOf, findSolvedNode, doorSizeMode,
  passiveSizeIndex, solveDoorTree, type EdgeOverlayMode, canSplitDoorAtPanel,
} from '../DoorService';
import { CHIP, Chip, PREVIEW_HEIGHT, chipFs, fmt1, pillSize, schemFs, schemFsT, stop, svgId, useElementWidth } from './kit';
import { type Hinge, leafHinges, swingPath, swingPathPoly } from './cardBlocks';
import {
  BandFill, BandHit, type Box4, ChainEditInput, type ChainItem, type ChainParts, ChainPills, FocusStrips, HiddenParts, MemberCell, SchemFrame, SelOutline,
  bandAxis, bandGeom, chainKit, chipPlacer, crossOf, cutAxis, cutBandGeom, cutMinMm, edgeLabel, isAdditive, layoutPills, leafIds, longestEdgeAlong,
  memberTip, nodePath, regionChains, schemView, sideLabel, slopePill, slopeSegsOf, useSchemEdit, widen,
} from './schematicCore';

/* KAPAK ŞEMASI: temsili ön görünüş (eksenler ayrı ölçeklenir). Ölçü zinciri yalnız seçili bölgenin üzerinde ve
   oksuz (oklar 3 mm boşluklara giriyordu). Sınır levhaları yalnız DIŞ kapakta çizilir. */
const PAD = 12;                   // dört kenar
const DOOR_MIN_ASPECT = 0.6;      // çok geniş kapakta ölçüler sıkışmasın
type SplitS = Extract<DoorNodeSolved, { kind: 'split' }>;
// DERZ BİNİSİ: 'min'/'max' = o taraftaki (düşük/yüksek u·v) kapak levhayı tamamen örter (Full), 'center' = ikisi yarı (Half).
// KAPAK BİNİSİ (kapak seçili): Full = seçili kapak levhayı tamamen örter · Half = iki kapak levha ortasına · None = seçili kapak
// levhanın kenarında biter, komşu kapak levhayı örter. Levha yerinde kalır; yalnız iki komşu kapak uzar/kısalır.
type OverlayOpt = 'Full' | 'Half' | 'None';
const alignForOpt = (side: DoorAlign, o: OverlayOpt): DoorAlign => (o === 'Full' ? side : o === 'Half' ? 'center' : side === 'min' ? 'max' : 'min');
const optOf = (side: DoorAlign, st: DoorAlign | null): OverlayOpt | null => (st === 'center' ? 'Half' : st === side ? 'Full' : st ? 'None' : null);

export function DoorSchematic({
  group, selectedIndex, selectedNodes, memberLabels, cuts, nearPanels, refPick, onEditSize, onToggleLock, onEditSplitGap, onEditEdgeGap, onEditLeaf,
  onEditLeafGap, onPathClick, onToggleHalfOverlay, onAlignJoint, onJointOverlay, onRefPick, onSplitAtPanel, onEdgeOverlay, addPick, onAddPick, onRemovePick,
  addObstacles, onEditBegin, onEditCancel,
}: {
  group: DoorGroup; selectedIndex: number; memberLabels: string[];
  selectedNodes: string[];
  /** Açılı referans: üyeler bu kesicilerle kırpılmış çokgen olarak çizilir (3B ile aynı şekil). */
  cuts: DoorCut[];
  nearPanels: DoorNearPanel[];
  /** preview=true → canlı önizleme (yalnız store dağılımı, rebuild yok); yoksa onay (yazım + rebuild). */
  onEditSize: (splitId: string, k: number, v: number, preview?: boolean) => void; onToggleLock: (splitId: string, k: number) => void;
  onEditSplitGap: (splitId: string, k: number, v: number, preview?: boolean) => void; onEditEdgeGap: (edge: DoorEdgeKey, v: number, preview?: boolean) => void;
  onEditLeaf: (leafId: string, k: number, v: number, preview?: boolean) => void; onEditLeafGap: (leafId: string, v: number, preview?: boolean) => void;
  onEditBegin?: () => unknown; onEditCancel?: (snap: unknown) => void;
  /** Tıklanan noktanın kök → yaprak düğüm yolu (yalnız seçim, üye seçilmez); additive = Shift/Ctrl/⌘. */
  onPathClick: (path: string[], additive: boolean) => void;
  onToggleHalfOverlay: (edge: DoorEdgeKey, on: boolean) => void;
  /** Yalnız bağ çözme (null): Shift/Ctrl+tık. */
  onAlignJoint: (splitId: string, k: number, vfId: string, align: DoorAlign | null) => void;
  /** Derz binisi (seçili kapağa göre Full/Half): levha yerinde, kapaklar uzar/kısalır. */
  onJointOverlay: (splitId: string, k: number, vfId: string, align: DoorAlign) => void;
  refPick?: boolean;
  onRefPick?: (vfId: string) => void;
  /** Kapak bölünmemişken arkasındaki sınır levhası: tık kapağı levhanın ortasından böler (Half) ve bir yanı seçer → Full/Half/None döngüsü. */
  onSplitAtPanel?: (vfId: string) => void;
  /** Kenar levhası binisi: Full → Half → None (tek rozet, tıkladıkça döner). */
  onEdgeOverlay?: (edge: DoorEdgeKey, mode: EdgeOverlayMode) => void;
  /** Araya raf/dikme modu: 'u' = V derzleri (dikme), 'v' = H derzleri (raf). Zaten bağlı derzler gösterilmez. */
  addPick?: 'u' | 'v' | null;
  /** ats = derz boyunca seçilen yer(ler) (mm); Shift/Ctrl+tık → derzin tüm BOŞ parçaları. */
  onAddPick?: (splitId: string, k: number, ats: number[]) => void;
  onRemovePick?: (groupId: string) => void;
  /** Derz parçalama engelleri: kapak sınırı İŞARETSİZ levhalar dahil (işaretsiz dikme de derzi keser). Yoksa `nearPanels`. */
  addObstacles?: DoorNearPanel[];
}) {
  const [wrapRef, width] = useElementWidth();
  const ed = useSchemEdit(onEditBegin, onEditCancel, group.id, selectedIndex >= 0, selectedNodes.join('|'));
  const { rect, axis, side } = group;
  const SW = Math.max(40, width - 2 * PAD);
  const duR = Math.max(1e-6, rect.u1 - rect.u0), dvR = Math.max(1e-6, rect.v1 - rect.v0);
  const SH = Math.round(Math.max(DOOR_MIN_ASPECT * SW, Math.min(PREVIEW_HEIGHT - 2 * PAD, SW * dvR / duR)));
  const height = SH + 2 * PAD;
  // Görünüş: arka (Z−) ve sağ yan (X+) aynalı; üst (Y+) → Z aşağı.
  const view = schemView(rect, PAD, PAD, SW, SH, (axis === 2 && side < 0) || (axis === 0 && side > 0), axis === 1 && side > 0,
    PAD + SW + PAD - 2, PAD + SH + PAD - 2);
  const { sx, sy, mirrorU, mirrorV } = view;
  const eg = edgeGapsOf(group);
  const treeKey = JSON.stringify(group.tree);
  const cutsKey = cuts.map(c => `${c.vfId}:${c.n.map(x => x.toFixed(3)).join(',')}:${c.dMin.toFixed(1)}:${c.dMax.toFixed(1)}`).join('|');
  const solved = useMemo(() => solveDoorTree(group), // eslint-disable-next-line react-hooks/exhaustive-deps
    [rect, treeKey, group.gap, eg.uMin, eg.uMax, eg.vMin, eg.vMax]);
  const members = useMemo(() => applyDoorCuts(group, rect, doorMemberRects(solved), cuts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [solved, cutsKey, group.placement, group.thickness, group.gap]);
  const fs = schemFs(width), fsT = schemFsT(fs), cfs = chipFs(fsT);
  const gid = svgId('ds', group.id);
  const isOuter = group.placement === 'outer';

  // Hiza rozeti tıkı derzi levhaya BAĞLAR ve levhayı taşır (kapak yerinde kalır); Shift/Ctrl+tık bağı çözer.
  const bands = nearPanels.map(np => {
    const none = !!np.edge && np.behind && !!group.noOverlay?.[np.edge];
    const half = !none && !!np.edge && np.behind && !!group.halfOverlay?.[np.edge];
    return { np, ...bandGeom(np, view), half, none };
  });
  type Band = typeof bands[number];
  const cutBands = doorCutBands(group, rect, cuts, view.areaMm, cutMinMm(view))
    .map(cb => ({ ...cb, ...cutBandGeom(cb, view), half: !!cb.edge && cb.covered && !!group.halfOverlay?.[cb.edge] }));
  // Eğik kenarın boşluk pill'i eğik kenarın üzerinde durur; düz kenar zincirlerinde o kenar GÖSTERİLMEZ (yanıltıcı olur).
  const slopeSegs = slopeSegsOf(cutBands, members);
  const slopeEdges = new Set<DoorEdgeKey>(slopeSegs.map(sg => sg.edge));
  const selRegions = selectedNodes.map(id => findSolvedNode(solved, id)).filter((n): n is DoorNodeSolved => !!n);
  const selLeafIds = new Set(selRegions.flatMap(leafIds));
  // Bini bağlamı: şemada bölge seçili değilse listede / 3B'de seçili kapağın yaprağı (kapak satırı açıkken de Full/Half/None çıksın).
  const selMemberLeaf = selectedIndex >= 0 && members[selectedIndex] ? findSolvedNode(solved, members[selectedIndex].leafId) : null;
  const overlayRegions: DoorNodeSolved[] = [...(selMemberLeaf ? [selMemberLeaf] : []), ...selRegions];

  const sideName = (b: Band, a: DoorAlign) => sideLabel(b.vertical, b.vertical ? a === 'min' : a === 'max', view);
  const allJoints = doorJoints(solved);
  // Seçili bölge levhaya bitişikse: o bölgenin derzi + levhanın hangi tarafında olduğu (np.joint öncelikli).
  const overlayCtx = (np: DoorNearPanel): { j: DoorJoint; side: DoorAlign } | null => {
    if (np.edge || !np.joint || !overlayRegions.length) return null;
    const pc = (np.a0 + np.a1) / 2, t = np.a1 - np.a0;
    const own = (j: DoorJoint) => Number(!(j.splitId === np.joint!.splitId && j.k === np.joint!.k));
    const cands = allJoints.filter(j => j.axis === np.kind && Math.min(j.c1, np.c1) - Math.max(j.c0, np.c0) >= 0.5
      && Math.abs((j.p0 + j.p1) / 2 - pc) <= t / 2 + (j.p1 - j.p0) / 2 + JOINT_NEAR).sort((a, b) => own(a) - own(b));
    for (const j of cands) for (const n of overlayRegions) {
      const nc0 = np.kind === 'u' ? n.v0 : n.u0, nc1 = np.kind === 'u' ? n.v1 : n.u1;
      if (Math.min(nc1, j.c1, np.c1) - Math.max(nc0, j.c0, np.c0) < 0.5) continue;
      const na0 = np.kind === 'u' ? n.u0 : n.v0, na1 = np.kind === 'u' ? n.u1 : n.v1;
      if (Math.abs(na1 - j.p0) < 0.6) return { j, side: 'min' };
      if (Math.abs(na0 - j.p1) < 0.6) return { j, side: 'max' };
    }
    return null;
  };
  const overlayState = (np: DoorNearPanel, j: DoorJoint): DoorAlign | null =>
    (np.ref && np.ref.splitId === j.splitId && np.ref.k === j.k ? np.ref.align : jointOverlayState(j, np.a0, np.a1));
  const jointChip = (b: Band): string | null => {
    const np = b.np;
    if (np.edge || !np.joint) return null;
    const ctx = overlayCtx(np);
    if (ctx) return optOf(ctx.side, overlayState(np, ctx.j)) ?? 'Free';
    const s = overlayState(np, np.joint);
    return s === 'center' ? 'Half' : s ? `${sideName(b, s)} full` : 'Free';
  };
  const removable = (np: DoorNearPanel) => !!addPick && !np.edge && np.kind === addPick && np.ref?.master === 'door' && !!np.groupId;
  // Kapak sonradan konan levhada henüz bölünmemiş: levha kapağın arkasında, yakınında derz yok → ilk tık böler (Half).
  const splitChipOn = (np: DoorNearPanel) => !!onSplitAtPanel && !np.edge && !np.joint && np.behind && !refPick && !addPick && canSplitDoorAtPanel(group, np);
  const bandTip = (b: Band) => {
    const np = b.np;
    if (np.edge) {
      const edge = edgeLabel(b.vertical, np.edge, view);
      if (!np.behind) return `${edge} — ${np.name}: stands in front of the door plane; the door ends beside it (no overlay possible).`;
      const now = b.none ? 'NONE — the door ends at this panel\'s inner face (does not cover it)'
        : b.half ? 'HALF overlay — the door covers half of this panel\'s thickness (the other half is left for the neighbouring door)'
        : 'FULL overlay — the door covers this panel\'s whole thickness';
      return `${edge} — ${np.name}: ${now}. Click to step Full → Half → None.`;
    }
    const what = b.vertical ? 'divider' : 'shelf';
    if (removable(np)) return `${np.name} (${what}) — added between the doors. Click ✕ Remove to delete it (its row and panel are removed; the doors stay).`;
    if (refPick) return `${np.name} (${what}) — PANEL REF: click to split the door through this ${what}'s middle (Half overlay: both doors reach its middle).`;
    if (!np.joint) return splitChipOn(np)
      ? `${np.name} (${what}) — behind the door; the door passes over it (Full). Click: Half — the door splits through its middle (both reach it); `
        + `click again for None, then Full. The ${what} stays.`
      : `${np.name} (${what}) — behind the door, no joint nearby. Use Panel ref mode to split the door at it.`;
    const unbind = np.ref ? ' · Shift/Ctrl+click: unbind' : '';
    const ctx = overlayCtx(np);
    if (ctx) {
      return `${np.name} (${what}) — overlay of the selected door (${sideName(b, ctx.side).toLowerCase()} of it): ${jointChip(b)}. `
        + `Click to step Full (covers the whole ${what}) → Half (to its middle) → None (ends at its edge, the other door covers it). `
        + `The ${what} stays; the doors next to it lengthen / shorten.${unbind}`;
    }
    return `${np.name} (${what}) at the door joint — ${jointChip(b)}. `
      + `Click: the ${what} MOVES under the joint (Half → ${b.vertical ? 'left' : 'top'} full → ${b.vertical ? 'right' : 'bottom'} full); the doors stay. `
      + `To change the doors instead, select a door next to it first: then Full / Half lengthens / shortens that door and the ${what} stays.${unbind}`;
  };
  const onBandClick = (b: Band, additive: boolean) => {
    const np = b.np;
    if (removable(np)) { onRemovePick?.(np.groupId!); return; }
    if (refPick) { if (!np.edge && onRefPick) onRefPick(np.vfId); return; }
    if (np.edge) {
      if (np.behind) {
        const next: EdgeOverlayMode = b.none ? 'full' : b.half ? 'none' : 'half';
        if (onEdgeOverlay) onEdgeOverlay(np.edge, next); else onToggleHalfOverlay(np.edge, !b.half);
      }
      return;
    }
    const j = np.joint;
    if (!j) { if (splitChipOn(np)) onSplitAtPanel!(np.vfId); return; }
    if (additive) { if (np.ref) onAlignJoint(np.ref.splitId, np.ref.k, np.vfId, null); return; }
    const ctx = overlayCtx(np);
    // İKİ BİNİ MODU: kapak seçiliyken → KAPAK uzar/kısalır, levha yerinde (setDoorJointOverlay); kapak seçili değilken →
    // LEVHA derzin altına taşınır, kapaklar yerinde (setDoorJointRef). Sıra ekrana göre: Half → sol/üst full → sağ/alt full.
    if (ctx) {
      const cur = optOf(ctx.side, overlayState(np, ctx.j));
      onJointOverlay(ctx.j.splitId, ctx.j.k, np.vfId, alignForOpt(ctx.side, cur === 'Full' ? 'Half' : cur === 'Half' ? 'None' : 'Full'));
      return;
    }
    const s0 = overlayState(np, j);
    const first: DoorAlign = b.vertical ? (mirrorU ? 'max' : 'min') : (mirrorV ? 'min' : 'max');
    const second: DoorAlign = first === 'min' ? 'max' : 'min';
    onAlignJoint(j.splitId, j.k, np.vfId, s0 === 'center' ? first : s0 === first ? second : 'center');
  };

  // Ölçü zincirleri YALNIZ seçili bölgeler için; boşluklar turuncu şeritle işaretlenir.
  const kit = chainKit(view, r => doorCutOutline(group, rect, r, cuts));
  const T0 = 0.05;
  // Eğik kenar (slopeEdges) dokunuş sayılmaz: onun pill'i eğik kenarın üzerinde (slopePills).
  const touches = (n: DoorNodeSolved, k: DoorEdgeKey) => !slopeEdges.has(k) && Math.abs(k === 'uMin' ? n.u0 - (rect.u0 + eg.uMin)
    : k === 'uMax' ? n.u1 - (rect.u1 - eg.uMax) : k === 'vMax' ? n.v1 - (rect.v1 - eg.vMax) : n.v0 - (rect.v0 + eg.vMin)) < T0;
  const edgeItem = (k: DoorEdgeKey, a: number, b: number, R: Box4, on?: Box4): ChainItem => ({
    key: `edge-${k}`, kind: 'gap', a, b, txt: fmt1(eg[k]), title: `${edgeLabel(k === 'uMin' || k === 'uMax', k, view)} edge gap — click to edit`,
    commit: x => onEditEdgeGap(k, x), preview: x => onEditEdgeGap(k, x, true), min: 0, span: kit.edgeSpan(R, k, on),
  });
  const edgeStrip = (n: Box4, k: DoorEdgeKey) => {
    if (k === 'uMin') kit.strip('u', rect.u0, n.u0, crossOf(n, 'u')); else if (k === 'uMax') kit.strip('u', n.u1, rect.u1, crossOf(n, 'u'));
    else if (k === 'vMax') kit.strip('v', n.v1, rect.v1, crossOf(n, 'v')); else kit.strip('v', rect.v0, n.v0, crossOf(n, 'v'));
  };
  // Bölmede tek AÇIK ölçü kaldıysa PASİF (pin de kilit sayılır): girilemez, rozetsiz — değeri kalandan gelir.
  const sizeItem = (P: SplitS, i: number, a: number, b: number, horiz: boolean): ChainItem => {
    const base = { key: `size-${P.id}-${i}`, kind: 'size' as const, a, b, txt: fmt1(P.sizes[i]?.value ?? 0), min: 1 };
    const what = horiz ? 'Door width' : 'Door height';
    if (passiveSizeIndex(P.sizes, P.children.length) === i) {
      return { ...base, passive: true, title: `${what} — remainder (all other doors pinned or locked); open one to edit`, commit: () => {} };
    }
    // 3 mod (açık → tut → kilitli); değer yazmak ölçüyü 'tut'a alır.
    const mode = doorSizeMode(P.sizes[i]);
    const lockTitle = mode === 'locked' ? 'Locked — fixed on resize and when other doors are edited. Click: open'
      : mode === 'hold' ? 'Hold — keeps its value when other doors are edited, still scales with the door on resize. Click: lock'
      : 'Open — takes up changes from other doors and scales with the door on resize. Click: hold';
    return { ...base, title: `${what} — click to edit (open doors take up the difference)`, locked: mode === 'locked', edited: mode === 'hold', lockTitle,
      onLock: () => onToggleLock(P.id, i), commit: x => onEditSize(P.id, i, x), preview: x => onEditSize(P.id, i, x, true) };
  };
  const fullItems = (ax: 'u' | 'v', on: DoorNodeSolved): ChainItem[] => {
    const horiz = ax === 'u', dir = horiz ? 1 : -1;
    const lo = horiz ? rect.u0 : rect.v1, k0: DoorEdgeKey = horiz ? 'uMin' : 'vMax', k1: DoorEdgeKey = horiz ? 'uMax' : 'vMin';
    const span = (horiz ? rect.u1 - rect.u0 : rect.v1 - rect.v0) - eg[k0] - eg[k1];
    if (!slopeEdges.has(k0)) edgeStrip(on, k0);
    if (!slopeEdges.has(k1)) edgeStrip(on, k1);
    return [...(slopeEdges.has(k0) ? [] : [edgeItem(k0, lo, lo + dir * eg[k0], rect, on)]),
      { key: `full-${ax}`, kind: 'size', a: lo + dir * eg[k0], b: lo + dir * (eg[k0] + span), txt: fmt1(span), commit: () => {}, min: 1,
        title: horiz ? 'Door width (whole area)' : 'Door height (whole area)' },
      ...(slopeEdges.has(k1) ? [] : [edgeItem(k1, lo + dir * (eg[k0] + span), lo + dir * (eg[k0] + span + eg[k1]), rect, on)])];
  };
  const parts: ChainParts<DoorNodeSolved> = {
    size: sizeItem, full: fullItems, gapTitle: 'Gap between doors — click to edit', onGap: onEditSplitGap,
    edge: (n, horiz, end, at, on) => {
      const k: DoorEdgeKey = horiz ? (end ? 'uMax' : 'uMin') : (end ? 'vMin' : 'vMax');
      if (!touches(n, k)) return null;
      const d = (horiz ? 1 : -1) * eg[k];
      edgeStrip(on ?? n, k);
      return end ? edgeItem(k, at, at + d, n, on) : edgeItem(k, at - d, at, n, on);
    },
  };
  for (const n of selRegions) {
    regionChains(kit, solved, n, parts);
    const lax = n.kind === 'leaf' ? doorLeafAxis(n.type) : null;
    if (n.kind !== 'leaf' || !lax || n.leafSplit?.leaves.length !== 2) continue;
    // Çift kanat: kanat · ara · kanat.
    const horiz = lax === 'u', dir = horiz ? 1 : -1;
    const [a, b] = n.leafSplit.leaves.map(l => Math.max(0, l.value)), g = n.leafSplit.gap;
    const p0 = horiz ? n.u0 : n.v1, p1 = p0 + dir * a, p2 = p0 + dir * (a + g);
    kit.strip(lax, p1, p2, crossOf(n, lax));
    const leaf = (k: 0 | 1, from: number, to: number, w: number): ChainItem => ({ key: `leaf-${n.id}-${k}`, kind: 'size', a: from, b: to, txt: fmt1(w), min: 1,
      title: 'Leaf size — click to edit (the other leaf takes the rest)', commit: x => onEditLeaf(n.id, k, x), preview: x => onEditLeaf(n.id, k, x, true) });
    kit.pushChain(n, horiz, [
      leaf(0, p0, p1, a),
      { key: `lgap-${n.id}`, kind: 'gap', a: p1, b: p2, txt: fmt1(g), title: 'Gap between the two leaves — click to edit',
        commit: x => onEditLeafGap(n.id, x), preview: x => onEditLeafGap(n.id, x, true), min: 0, span: kit.jointSpan(n, lax, p1, p2) },
      leaf(1, p2, p0 + dir * (a + g + b), b),
    ]);
  }

  // Eğik kenar boşluk pill'i: yalnız SEÇİLİ kapakların en uzun eğik kenarının ortasında, kenar yönünde döndürülmüş.
  const slopePills = slopeSegs.flatMap(sg => {
    const best = longestEdgeAlong(members, sg.cb.dir, m => selLeafIds.has(m.leafId));
    if (!best) return [];
    const item: ChainItem = { key: `slope-${sg.cb.cut.vfId}`, kind: 'gap', a: 0, b: 0, txt: fmt1(eg[sg.edge]),
      title: `Gap to the angled panel ${sg.cb.cut.name} — click to edit (the door keeps this distance along the slope)`,
      commit: x => onEditEdgeGap(sg.edge, x), preview: x => onEditEdgeGap(sg.edge, x, true), min: 0 };
    return [slopePill(best, view, fs, item, -(eg[sg.edge] * view.SH / view.dvR) / 2)];   // kenar çizgisinden dışa yarım boşluk = boşluğun ortası
  });
  const pills = layoutPills(kit.chains, view, fs, slopePills, width, height);
  const pillByKey = new Map(pills.map(p => [p.key, p]));
  const chips = chipPlacer(pills, members, view, fsT);
  const stripClip = cuts.length ? doorCutOutline(group, rect, rect, cuts, false).map(view.toPx) : null;

  return (
    <SchemFrame wrapRef={wrapRef} width={width} height={height} gid={gid} view={view} overlay={<ChainEditInput ed={ed} find={k => pillByKey.get(k)} />}>
      {bands.map(b => <BandFill key={`band-${b.np.vfId}`} gid={gid} pts={b.pts} warm={b.half || b.aligned} />)}
      {cutBands.map(cb => <BandFill key={`cut-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} />)}
      {members.map((m, i) => {
        const on = i === selectedIndex, lbl = memberLabels[i] ?? String(i + 1), path = nodePath(solved, m.leafId);
        const typeTxt = DOOR_TYPE_LABEL[m.type] + (m.leafCount === 2 ? ` · leaf ${m.leaf + 1}/2` : '');
        // Double'da menteşe EKRANA göre: solda duran kanat sol menteşe (aynalı görünüşte de doğru).
        const swing = (b: { x0: number; y0: number; x1: number; y1: number }, pts: Array<{ x: number; y: number }> | null) => {
          let hinge: Hinge | undefined = leafHinges(m.type)[0];
          if (m.leafCount === 2 && doorLeafAxis(m.type) === 'u') {
            const sib = members[m.leaf === 0 ? i + 1 : i - 1];
            hinge = sib && Math.min(sx(sib.u0), sx(sib.u1)) < b.x0 ? 'R' : 'L';
          } else if (m.leafCount === 2) hinge = 'T';
          const ins = 5;
          return hinge && b.x1 - b.x0 > 2 * ins + 6 && b.y1 - b.y0 > 2 * ins + 6 && (
            <path d={(pts && swingPathPoly(pts, hinge, ins)) || swingPath(b.x0 + ins, b.y0 + ins, b.x1 - ins, b.y1 - ins, hinge)} fill="none"
              stroke={on ? '#f3b98e' : '#d6cfc4'} strokeWidth={0.7} strokeDasharray="3 3" strokeLinejoin="round" strokeLinecap="round"
              style={{ pointerEvents: 'none' }} />
          );
        };
        return (
          <MemberCell key={`door-${i}`} m={m} view={view} gid={gid} on={on} inSel={selLeafIds.has(m.leafId)} lbl={lbl} fsT={fsT} pills={pills} extra={swing}
            tip={memberTip(`Door ${lbl} · ${typeTxt}`, m, path.length, 'open the door\'s row below to edit it')}
            caption={m.type === 'drawer' || m.type === 'fixed' ? DOOR_TYPE_LABEL[m.type] : null} onPick={add => onPathClick(path, add)} />
        );
      })}
      {cutBands.map(cb => <HiddenParts key={`cuthid-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} members={members} view={view} />)}
      {bands.map(b => <HiddenParts key={`hid-${b.np.vfId}`} gid={gid} pts={b.pts} warm={b.half || b.aligned} members={members} view={view} />)}
      <FocusStrips strips={kit.strips} clip={stripClip} />
      {addPick && isOuter && doorJointParts(allJoints, addObstacles ?? nearPanels, addPick).flatMap(({ joint: j, all: segs, free }) => {
        // Araya raf/dikme: derz, onu kesen levhalarla parçalara bölünür; yalnız BOŞ parçalar rozet alır, her parça ayrı grup olur.
        const vertical = j.axis === 'u', what = vertical ? 'divider' : 'shelf';
        const along = vertical ? sx : sy, across = vertical ? sy : sx;
        const [a0, a1] = widen(Math.min(along(j.p0), along(j.p1)), Math.max(along(j.p0), along(j.p1)), 14);
        const allMids = free.map(([c0, c1]) => (c0 + c1) / 2);
        return free.map(([c0, c1]) => {
          const q0 = Math.min(across(c0), across(c1)), q1 = Math.max(across(c0), across(c1));
          const x = vertical ? a0 : q0, y = vertical ? q0 : a0, w = vertical ? a1 - a0 : q1 - q0, h = vertical ? q1 - q0 : a1 - a0;
          return (
            <g key={`add-${j.splitId}-${j.k}-${Math.round(c0)}`} className="yago-band on" style={{ cursor: 'pointer' }}
              onClick={e => { stop(e); onAddPick?.(j.splitId, j.k, isAdditive(e) ? allMids : [(c0 + c1) / 2]); }}>
              <rect x={x} y={y} width={w} height={h} rx={3} fill="#fb923c" fillOpacity={0.16} stroke="#f97316" strokeWidth={1} strokeDasharray="4 2.5"
                className="hit" />
              <Chip className="chip" cx={x + w / 2} cy={y + h / 2} txt={vertical ? '+ Divider' : '+ Shelf'} fs={cfs} tone={CHIP.accent}
                rot={vertical ? -90 : 0} />
              <title>{`Add a ${what} between these two doors${segs.length > 1 ? ` (this part of the joint, ${fmt1(c1 - c0)} mm)` : ''}: `
                + `it is created in the free volume behind this spot (listed after the door row) and stays bound to the joint — when the doors change, `
                + `the ${what} follows.${allMids.length > 1 ? ` Shift+click: a ${what} in every free part of this joint (${allMids.length}).` : ''} `
                + 'It starts at Half overlay (both doors reach its middle); select a door next to it to switch that door to Full.'}</title>
            </g>
          );
        });
      })}
      {selRegions.map(n => <SelOutline key={`sel-${n.id}`} n={n} view={view} shape={cuts.length ? doorCutOutline(group, rect, n, cuts) : null} />)}
      {/* Bant tık alanları bilinçli olarak seçim çerçevesi/şeritlerin ÜSTÜNDE, pill'lerin ALTINDA çizilir. */}
      {bands.map(b => {
        const np = b.np;
        const pickable = !!refPick && !np.edge, rem = removable(np), splitOn = splitChipOn(np);
        const jChip = !np.edge ? jointChip(b) : null;
        const ctxOn = (!np.edge && !!overlayCtx(np)) || splitOn;   // bölünmemiş levha da kapak binisi rozetidir (turuncu)
        const interactive = isOuter && (rem || pickable || (!!np.edge && np.behind) || ctxOn || !!np.joint);
        const chipTxt = rem ? '✕ Remove' : pickable ? 'Split here'
          : np.edge ? (np.behind ? (b.none ? 'None' : b.half ? 'Half' : 'Full') : null) : splitOn ? 'Full' : jChip;
        // Rozet dili arkalıkla aynı (CHIP): rozet HER ZAMAN görünür; Half = koyu taş, kapak seçiliyken turuncu çerçeve.
        const tone = rem ? CHIP.danger : (np.edge ? b.half : jChip === 'Half') ? CHIP.on : pickable || ctxOn ? CHIP.accent : CHIP.base;
        const at = chipTxt ? chips.spot(bandAxis(b), pillSize(chipTxt, cfs).pw) : null;
        return (
          <BandHit key={`hit-${np.vfId}`} gid={gid} pts={b.pts} rect={np.poly ? undefined : b} warm={b.half || b.aligned} title={bandTip(b)}
            onClick={interactive ? e => onBandClick(b, isAdditive(e)) : undefined}
            chip={at && <Chip className="chip" cx={at.x} cy={at.y} txt={chipTxt!} fs={cfs} tone={tone} rot={b.vertical ? -90 : 0} />} />
        );
      })}
      {/* Açılı levhanın Full/Half bayrağı, kesilen kenarın halfOverlay bayrağıdır. */}
      {cutBands.map(cb => {
        const interactive = isOuter && cb.covered && !!cb.edge;
        const chipTxt = interactive ? (cb.half ? 'Half' : 'Full') : null;
        const at = chipTxt ? chips.spot(cutAxis(cb), pillSize(chipTxt, cfs).pw) : null;
        const tip = `${cb.cut.name} — angled door reference panel: the door is cut along it (it keeps the side you clicked when placing the door).` +
          (interactive ? ` ${cb.half ? 'HALF overlay — the door reaches the middle of this panel\'s thickness. Click for full overlay.'
            : 'FULL overlay — the door covers this panel\'s whole thickness. Click for half overlay.'}`
            : cb.covered ? '' : ' It stands in front of the door plane, so there is no overlay to set.');
        return (
          <BandHit key={`cuthit-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} title={tip}
            onClick={interactive ? () => onToggleHalfOverlay(cb.edge!, !cb.half) : undefined}
            chip={at && <Chip className="chip" cx={at.x} cy={at.y} txt={chipTxt!} fs={cfs} tone={cb.half ? CHIP.on : CHIP.base} rot={cb.deg.toFixed(1)} />} />
        );
      })}
      <ChainPills pills={pills} ed={ed} bounds="door" />
    </SchemFrame>
  );
}
