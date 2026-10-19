import { type BackEdgeRel, type BackGroup } from '../../store';
import { UI_FONT } from '../Ui';
import {
  type BackCut, type BackEdgeKey, type BackNearPanel, type BackNodeSolved, type BackSolution, BACK_TYPE_LABEL, backCutBands, backCutOutline,
  backPieceOf, backSizeMode, canSplitBackAtPanel, findBackNode, findSolvedBackNode, passiveBackSizeIndex, backSizeBoundByJoint, BACK_REL_LABEL,
  backGrooveClearOf, backGrooveClearOverridden, backJointRelOf, backLeaves, edgeRelOf,
} from '../BackService';
import { CHIP, CHIP_SHADOW, Chip, chipFs, fmt1, pillSize, schemFs, schemFsT, stop, svgId, useElementWidth } from './kit';
import {
  BandFill, BandHit, ChainEditInput, type ChainItem, ChainPills, type ChipAxis, type EditTarget, FocusStrips, HiddenParts, MemberCell, SchemFrame, SelOutline,
  bandAxis, bandGeom, chainKit, chipPlacer, cutAxis, cutBandGeom, cutMinMm, edgeLabel, layoutPills, leafIds, longestEdgeAlong, memberTip, nodePath,
  regionChains, schemView, slopePill, slopeSegsOf, useSchemEdit,
} from './schematicCore';

// Arkalık şemasının kenar payı: en dış sınır levhaları (yan / üst / alt) iç dikdörtgenin DIŞINDA, bu payda çizilir; ilişki ve değer
// rozetleri levhanın üzerinde durur → pay levha + rozet kalınlığını almalı (kapak payı 12 px ile rozetler SVG dışına taşıp kırpılıyordu).
const PAD = 22;
const T0 = 0.05;
type SplitS = Extract<BackNodeSolved, { kind: 'split' }>;
/** Kenar rozeti: değer rozeti (In / On, yerinde düzenlenir) ya da ilişki rozeti (`toggle`: Groove ↔ Nail / ± kanal payı). */
type BandChip = EditTarget & { key: string; vfId: string; label: string; rot: number; warm: boolean; title: string; toggle?: () => void;
  /** Turuncu çerçeve (kenarın kendi kanal payı var). */
  accent?: boolean };
/** Değerler hep aynıysa o değer, yoksa null. */
const same = (vs: number[]) => (vs.length && vs.every(x => Math.abs(x - vs[0]) < T0) ? vs[0] : null);

/** ARKALIK ŞEMASI: ön görünüş (arkadan bakış aynalı), parçalar + sınır levhası bantları (çakma parçada bini, kanallı parçada kanal girişi),
 *  açılı levha şeritleri, derz rozetleri ve seçili bölgenin ölçü zincirleri. Değerler PARÇA BAŞINA: kenar rozeti / pill'i seçili
 *  parçalara (seçim yoksa o kenara değen tüm parçalara) yazar; karışık değer "…" / "Mixed" gösterir. */
export function BackSchematic({
  group, solution, selectedIndex, selectedNodes, memberLabels, cuts, nearPanels, refPick, onEditSize, onToggleLock, onEditSplitGap, onEditInset, onEditJointIn,
  onPathClick, onRefPick, onSplitAtPanel, onEditCover, onToggleEdgeRel, onToggleJointRel, clearVfId, onPickClearEdge, grooveHint, onEditBegin, onEditCancel,
}: {
  group: BackGroup; selectedIndex: number; memberLabels: string[];
  /** Çözüm (solveBackGroup / backFallbackSolution): iç dikdörtgen, hücreler, parça dikdörtgenleri (kendi tip/inset/bini uzantılarıyla). */
  solution: BackSolution;
  selectedNodes: string[];
  cuts: BackCut[];
  nearPanels: BackNearPanel[];
  /** preview=true → canlı önizleme (yalnız store dağılımı, rebuild yok); yoksa onay (yazım + rebuild). */
  onEditSize: (splitId: string, k: number, v: number, preview?: boolean) => void; onToggleLock: (splitId: string, k: number) => void;
  onEditSplitGap: (splitId: string, k: number, v: number, preview?: boolean) => void;
  /** Kanallı parça(lar)ın kenar girişi (mm ≥ 0), leafIds = yazılacak parçalar. */
  onEditInset: (edge: BackEdgeKey, mm: number, leafIds: string[], preview?: boolean) => void;
  /** Levhaya bağlı derzde parça(lar)ın dikme/rafın üzerine binme payı (mm), leafIds = yazılacak parçalar (o kenarı derzde olanlar). */
  onEditJointIn: (edge: BackEdgeKey, mm: number, leafIds: string[], preview?: boolean) => void;
  onEditBegin?: () => unknown; onEditCancel?: (snap: unknown) => void;
  /** Tıklanan noktanın kök → yaprak düğüm yolu (yalnız seçim); additive = Shift/Ctrl/⌘. */
  onPathClick: (path: string[], additive: boolean) => void;
  refPick?: boolean;
  onRefPick?: (vfId: string) => void;
  /** Arkalık-sınırı dikme/raf bandı: tık arkalığı levhanın ortasından böler (Panel ref modunda da aynı). */
  onSplitAtPanel?: (vfId: string) => void;
  /** Çakma parça(lar)ın kenar panelinin üzerine binmesi (mm), leafIds = yazılacak parçalar. */
  onEditCover: (edge: BackEdgeKey, mm: number, leafIds: string[], preview?: boolean) => void;
  /** Kenar ilişkisi (grup başına): Groove ↔ Nail. */
  onToggleEdgeRel: (edge: BackEdgeKey) => void;
  /** Levhaya bağlı derzin ilişkisi: Groove (iki yandan kanal) ↔ Nail (dikme/raf kısalır). */
  onToggleJointRel: (splitId: string, k: number) => void;
  /** Kanal payı kapsamı: seçili kenarın (sınır / derz paneli) VF'si — kartta yalnız onun F/R/D değerleri düzenlenir. */
  clearVfId?: string;
  /** Kenarın "±" rozeti: o kenarın kanal payını kart satırına getirir (tekrar tık → grup). */
  onPickClearEdge: (vfId: string) => void;
  /** Görsel ipucu: kartta kanal payı (ön / arka / dip) değerinin üzerindeyken kanal kutuları vurgulanır (kapsamdaki kenarlar). */
  grooveHint?: 'gf' | 'gb' | 'gd' | null;
}) {
  const [wrapRef, width] = useElementWidth();
  const ed = useSchemEdit(onEditBegin, onEditCancel, group.id, selectedIndex >= 0, selectedNodes.join('|'));
  const { axis, side } = group;
  // rect = İÇ dikdörtgen (sınır panellerinin iç yüzleri); parçalar kendi uzantılarıyla dışına taşar.
  const { rect, solved, members, sides } = solution;
  // TEMSİLİ KARE (Goker, Eki 2026 — "preview tam kare olsun, arkalık o alanı maksimum göstersin, ölçüye göre dinamik değil temsili"):
  // şema kare (yükseklik = genişlik), arkalık dikdörtgeni her zaman aynı temsili alana GERİLİR (oran korunmaz) — kenar bantları
  // ve rozetler dar kenar payında kalır.
  const SW = Math.max(40, width - 2 * PAD), SH = SW, height = SH + 2 * PAD;
  // Görünüş: arkalık ÖNDEN çizilir (gövdenin içine bakar gibi) — 3B ön görünüşle aynı sol/sağ (Goker: arkadan aynalı görünüş
  // ters geliyordu, soldaki parçayı düzeltirken sağdaki değişiyordu). Sağ yan (X+) aynalı; üst (Y+) → Z aşağı.
  const view = schemView(rect, PAD, PAD, SW, SH, axis === 0 && side > 0, axis === 1 && side > 0, width - 2, height - 2);
  const { sx, sy } = view;
  const fs = schemFs(width), fsT = schemFsT(fs), cfs = chipFs(fsT);
  const gid = svgId('bs', group.id);

  // PARÇA BAŞINA değerler: üye dikdörtgeni kendi `piece`'ini taşır (tip / setback / inset / bini).
  const allLeafIds = members.map(m => m.leafId);
  const pieceOfLeaf = (id: string) => {
    const m = members.find(x => x.leafId === id);
    if (m) return m.piece;
    const n = findBackNode(group.tree, id);
    return backPieceOf(group, n && n.kind === 'leaf' ? n : null);
  };
  const groovedOf = (ids: string[]) => ids.filter(id => pieceOfLeaf(id).placement === 'inner');
  const nailedOf = (ids: string[]) => ids.filter(id => pieceOfLeaf(id).placement === 'outer');
  const anyGrooved = groovedOf(allLeafIds).length > 0;
  const cellTouches = (n: BackNodeSolved, k: BackEdgeKey) =>
    Math.abs(k === 'uMin' ? n.u0 - rect.u0 : k === 'uMax' ? n.u1 - rect.u1 : k === 'vMin' ? n.v0 - rect.v0 : n.v1 - rect.v1) < T0;
  /** Kenara değen yapraklar (hücresi iç dikdörtgenin o kenarında), isteğe bağlı bir alt küme içinde. */
  const touchingLeaves = (k: BackEdgeKey, within: string[] = allLeafIds) =>
    backLeaves(solved).filter(n => within.includes(n.id) && cellTouches(n, k)).map(n => n.id);
  /** Çakma parçaların kenar panelinin üzerine ETKİN binmesi (mm; girilmemişse t = tamamen örter); farklıysa null. */
  const coverOf = (k: BackEdgeKey, id: string, t: number) => {
    const c = pieceOfLeaf(id).cover[k];
    return Number.isFinite(c) ? Math.max(0, Math.min(t, c as number)) : t;
  };
  const commonCover = (k: BackEdgeKey, ids: string[], t: number) => same(ids.map(id => coverOf(k, id, t)));
  const selRegions = selectedNodes.map(id => findSolvedBackNode(solved, id)).filter((n): n is BackNodeSolved => !!n);
  const selLeafIds = new Set(selRegions.flatMap(leafIds));
  /** Kenar rozetinin / pill'inin yazacağı parçalar: seçili bölgelerin (ya da seçili üye satırının) o kenara değen yaprakları;
   *  seçim yoksa kenara değen tüm yapraklar. */
  const scopeLeaves = (k: BackEdgeKey): string[] => {
    const sel = selLeafIds.size ? [...selLeafIds] : selectedIndex >= 0 && members[selectedIndex] ? [members[selectedIndex].leafId] : allLeafIds;
    const t = touchingLeaves(k, sel);
    return t.length ? t : touchingLeaves(k);
  };
  const scopeTxt = (ids: string[]) => (ids.length === 1 ? `piece ${memberLabels[allLeafIds.indexOf(ids[0])] ?? ''}`.trim() : `${ids.length} pieces`);

  // Kenar şeritleri: kanallı parçada KANAL GİRİŞİ (pill), çakma parçada bini Full/Half/None (rozet) — ikisi de parça başına.
  /** Kenar bandı: `na` = bini rozeti yazılacak parçalar (dış çakma parçalar + ÇAKMA kenardaki iç parçalar), `gr` = kanallı
   *  kenardaki iç parçalar (giriş pill'i), `nl` = çakma kenardaki iç parçalar (panel kısaltılır), `rel` = kenar ilişkisi (grup başına). */
  const bands = nearPanels.map(np => {
    const scope = np.edge ? scopeLeaves(np.edge) : [];
    const rel: BackEdgeRel | null = np.edge ? edgeRelOf(group, np.edge) : null;
    const inner = np.edge ? groovedOf(scope) : [];
    const gr = rel === 'groove' ? inner : [], nl = rel === 'nail' ? inner : [];
    const na = [...(np.edge && np.behind ? nailedOf(scope) : []), ...nl];
    const t = Math.max(0, np.a1 - np.a0);   // kenar levhasının kalınlığı (bant ekseninde)
    const cov = np.edge && na.length ? commonCover(np.edge, na, t) : null;
    const ins = np.edge && gr.length ? same(gr.map(id => pieceOfLeaf(id).inset[np.edge!])) : null;
    const half = nl.length > 0 || (na.length > 0 && (cov == null || cov < t - T0));   // kısaltılan panel / kısmi binme → sıcak ton
    return { np, ...bandGeom(np, view), half, na, gr, nl, rel, cov, t, ins };
  });
  type Band = typeof bands[number];
  const cutBands = backCutBands(group, rect, cuts, view.areaMm, cutMinMm(view)).map(cb => {
    const na = cb.edge && cb.covered ? nailedOf(scopeLeaves(cb.edge)) : [];
    const t = Math.max(0, cb.cut.dMax - cb.cut.dMin);
    const cov = na.length ? commonCover(cb.edge!, na, t) : null;
    return { ...cb, ...cutBandGeom(cb, view), half: na.length > 0 && (cov == null || cov < t - T0), na, t, cov };
  });
  // Eğik kenarın boşluk pill'i eğik kenarın üzerinde durur; düz kenar zincirlerinde o kenar GÖSTERİLMEZ.
  const slopeSegs = slopeSegsOf(cutBands, members);
  const edgeName = (b: Band) => edgeLabel(b.vertical, b.np.edge, view);
  // İÇ LEVHA (arkalık-sınırı dikme/raf) tek eylemlidir: BÖL. Bini / Left-Right rozeti yok (Goker, Eki 2026): bütün kanallı arkalık
  // levhayı kısaltır; bölününce parçalar levhanın ortasına kadar girer (iki yandan kanallı) ve derz levhayı izler.
  const splittable = (np: BackNearPanel) => !!onSplitAtPanel && !np.edge && !np.joint && canSplitBackAtPanel(group, np);
  /** Levhaya bağlı derz bandı: iki yanın binme değerleri (ekranda sol/üst → sağ/alt), karışıksa "…". */
  const refJoint = (np: BackNearPanel) => {
    if (!np.ref) return null;
    const all = Object.values(sides).flatMap(r => (Object.entries(r) as Array<[BackEdgeKey, NonNullable<typeof r[BackEdgeKey]>]>).map(([key, x]) => ({ key, x })))
      .filter(e => e.x.splitId === np.ref!.splitId && e.x.k === np.ref!.k);
    if (!all.length) return null;
    const val = (keys: BackEdgeKey[]) => {
      const vs = all.filter(e => keys.includes(e.key)).map(e => e.x.in), c = same(vs);
      return !vs.length ? '–' : c == null ? '…' : fmt1(c);
    };
    const lo = val(['uMax', 'vMin']), hi = val(['uMin', 'vMax']);   // lo = derzden önceki (sol / üst) parça(lar), hi = sonraki
    return { txt: (np.kind === 'u' ? view.mirrorU : view.mirrorV) ? `${hi} · ${lo}` : `${lo} · ${hi}` };
  };
  const bandTip = (b: Band) => {
    const np = b.np;
    if (np.edge) {
      const parts: string[] = [];
      if (b.gr.length || b.nl.length) parts.push(b.rel === 'nail'
        ? 'NAIL — this panel is shortened to the back panel\'s front face and the piece covers its end '
          + '(click "Nail" to switch to a groove: the panel keeps its full depth).'
        : 'GROOVE — this panel keeps its full depth and the piece enters its groove '
          + '(click "Groove" to nail instead: the panel is shortened to the back panel\'s front face automatically).');
      if (b.gr.length) {
        parts.push(`GROOVE DEPTH ${b.ins == null ? 'mixed' : `${fmt1(b.ins)} mm`} (${scopeTxt(b.gr)}) — how far the grooved piece enters this panel; `
          + 'click the value to edit (0 = ends at the panel\'s inner face).');
      }
      if (b.na.length) {
        parts.push(`OVERLAP ${b.cov == null ? 'mixed' : `${fmt1(b.cov)} mm`} of ${fmt1(b.t)} (${scopeTxt(b.na)}) — `
          + `how far the piece runs onto this panel's end: 0 = ends at its inner face, ${fmt1(b.t)} = covers it fully. Click the value to edit.`);
      }
      if (!parts.length) {
        parts.push(np.behind ? 'no piece touches this edge.' : 'stands outside the back panel plane; nailed pieces end beside it (no overlay possible).');
      }
      return `${edgeName(b)} — ${np.name}: ${parts.join(' ')} Select a piece to change only that piece.`;
    }
    const what = b.vertical ? 'divider' : 'shelf';
    const whole = anyGrooved ? `While the back panel is whole and grooved, this ${what} is shortened to the back panel's front face.`
      : `While the back panel is whole, it passes behind this ${what}.`;
    if (np.ref) {
      const rel = backJointRelOf(group.tree, np.ref.splitId, np.ref.k) === 'nail' ? `NAIL: the ${what} is shortened to the back panel's front face`
        : `GROOVE: both sides grooved, the ${what} keeps its full depth`;
      return `${np.name} (${what}) — the back panel is split at this ${what} (${rel} — switch with the Groove / Nail chip); `
        + `each piece runs onto it by its own overlap (${refJoint(np)?.txt ?? '–'} mm, default: to its middle) and follows it when it moves. `
        + `Click to select the split region and edit the overlap pills (0 = ends at the ${what}'s face, its thickness = covers it fully). `
        + `Sizes next to this joint come from the ${what}.`;
    }
    if (np.joint) {
      return `${np.name} (${what}) — a joint of the back panel already lies at this ${what} (from a count split); `
        + `it is not bound to it, so the pieces stay when the ${what} moves.`;
    }
    if (refPick || splittable(np)) {
      return `${np.name} (${what}) — back reference: click to split the back panel through its middle `
        + `(both pieces reach the middle${anyGrooved ? ', grooved pieces on both sides' : ''}; the ${what} keeps its full depth). ${whole}`;
    }
    return `${np.name} (${what}) — back reference, cannot be split here (no room for two pieces). ${whole}`;
  };
  const editChip = (c: BandChip | undefined) => { if (c) ed.begin({ key: c.key, v: c.item.txt }); return !!c; };
  const onBandClick = (b: Band) => {
    const np = b.np;
    if (refPick) { if (!np.edge && onRefPick) onRefPick(np.vfId); return; }
    // Kenar bandı: değer rozeti (çakma "On", yoksa kanallı "In") düzenlemeye açılır (ilişki rozeti kendi tıkıyla çevrilir).
    if (np.edge) { editChip(bandChips.find(x => x.vfId === np.vfId && !x.toggle)); return; }
    // Bağlı derz: bölme bölgesi seçilir (binme pill'leri görünür); zaten görünüyorsa ilki düzenlenir.
    if (np.ref) {
      const pre = `bc-jin-${np.vfId}-${np.ref.splitId}-${np.ref.k}-`;
      if (!editChip(bandChips.find(x => x.key.startsWith(pre)))) onPathClick(nodePath(solved, np.ref.splitId), false);
      return;
    }
    if (splittable(np)) onSplitAtPanel!(np.vfId);
  };

  // KENAR / DERZ BİNME DEĞERLERİ ölçü zincirinde GÖSTERİLMEZ (Goker, Eki 2026 — "arkalığa tıklayınca In / On yanında bir de kanal
  // derinlik kutucukları geliyor, iki tane binme değeri görünüyor"): bunlar yalnız bandın In / On rozetlerinde; zincir = parça ölçüleri + aralar.
  const kit = chainKit(view, r => backCutOutline(group, rect, r, cuts));
  const sizeItem = (P: SplitS, i: number, a: number, b: number, horiz: boolean): ChainItem => {
    const base = { key: `size-${P.id}-${i}`, kind: 'size' as const, a, b, txt: fmt1(P.sizes[i]?.value ?? 0), min: 1 };
    const what = horiz ? 'Piece width' : 'Piece height';
    // Levhaya bağlı derze bitişik ölçü levhadan gelir (derz levhayı izler) — girilemez.
    if (backSizeBoundByJoint(P, i)) {
      return { ...base, passive: true, title: `${what} — set by the divider / shelf the joint is bound to (move that panel to change it)`, commit: () => {} };
    }
    // Bölmede tek AÇIK ölçü kaldıysa PASİF (pin de kilit sayılır): girilemez, rozetsiz — değeri kalandan gelir.
    if (passiveBackSizeIndex(P.sizes, P.children.length) === i) {
      return { ...base, passive: true, title: `${what} — remainder (all other pieces pinned or locked); open one to edit`, commit: () => {} };
    }
    const mode = backSizeMode(P.sizes[i]);
    const lockTitle = mode === 'locked' ? 'Locked — fixed on resize and when other pieces are edited. Click: open'
      : mode === 'hold' ? 'Hold — keeps its value when other pieces are edited, still scales with the back panel on resize. Click: lock'
      : 'Open — takes up changes from other pieces and scales with the back panel on resize. Click: hold';
    return { ...base, title: `${what} — click to edit (open pieces take up the difference)`, locked: mode === 'locked', edited: mode === 'hold', lockTitle,
      onLock: () => onToggleLock(P.id, i), commit: x => onEditSize(P.id, i, x), preview: x => onEditSize(P.id, i, x, true) };
  };
  const fullItems = (ax: 'u' | 'v'): ChainItem[] => {
    const horiz = ax === 'u', lo = horiz ? rect.u0 : rect.v1, span = horiz ? rect.u1 - rect.u0 : rect.v1 - rect.v0;
    return [{ key: `full-${ax}`, kind: 'size', a: lo, b: lo + (horiz ? 1 : -1) * span, txt: fmt1(span), commit: () => {}, min: 1,
      title: `Back area ${horiz ? 'width' : 'height'} (between the reference panels' inner faces)` }];
  };
  // LEVHAYA BAĞLI DERZ: zincirde ara yok (binme değerleri derz bandındaki On / In rozetlerinde).
  const isBoundJoint = (P: SplitS, k: number) =>
    !!P.refs?.[k] && Object.values(sides).some(r => Object.values(r).some(x => !!x && x.splitId === P.id && x.k === k));
  const parts = { size: sizeItem, full: fullItems, gapTitle: 'Gap between pieces — click to edit', onGap: onEditSplitGap, hideGap: isBoundJoint };
  for (const n of selRegions) regionChains(kit, solved, n, parts);

  // Eğik kenar giriş pill'i: yalnız SEÇİLİ KANALLI parçaların en uzun eğik kenarının ortasında, kenar yönünde döndürülmüş
  // (çakmada rozet var).
  const slopePills = slopeSegs.flatMap(sg => {
    const best = longestEdgeAlong(members, sg.cb.dir, m => selLeafIds.has(m.leafId) && m.piece.placement === 'inner');
    if (!best) return [];
    const { m } = best, ins = m.piece.inset[sg.edge];
    const item: ChainItem = { key: `slope-${sg.cb.cut.vfId}-${m.leafId}`, kind: 'gap', a: 0, b: 0, txt: fmt1(ins),
      title: `Groove inset into the angled panel ${sg.cb.cut.name} (${scopeTxt([m.leafId])}) — `
        + 'click to edit (the piece enters the panel by this much along the slope)',
      commit: x => onEditInset(sg.edge, x, [m.leafId]), preview: x => onEditInset(sg.edge, x, [m.leafId], true), min: 0 };
    return [slopePill(best, view, fs, item, (ins * view.SH / view.dvR) / 2)];
  });
  const pills = layoutPills(kit.chains, view, fs, slopePills, width, height);
  const chips = chipPlacer(pills, members, view, fsT);

  // KENAR DEĞER ROZETLERİ (bant üzerinde, tıklayınca yerinde düzenlenir): çakma parça → "On <mm>" = panelin üzerine binme,
  // kanallı parça → "In <mm>" = kanal derinliği. Değer seçili parçalara (yoksa kenara değen tüm parçalara) yazılır.
  const bandChips: BandChip[] = [];
  const placeChip = (c: Omit<BandChip, 'cx' | 'cy' | 'pw' | 'ph' | 'f' | 'item'> & { item?: ChainItem }, ax: ChipAxis) => {
    const { pw, ph } = pillSize(c.label, cfs);
    const sp0 = chips.spot(ax, pw);
    // Rozet SVG'nin içinde kalır (döndürülmüşse kapladığı kutu yer değiştirir): kenarda kırpılmasın.
    const rad = (c.rot || 0) * Math.PI / 180, cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const hx = (cos * pw + sin * ph) / 2 + 2, hy = (sin * pw + cos * ph) / 2 + 2;
    const sp = { x: Math.max(hx, Math.min(width - hx, sp0.x)), y: Math.max(hy, Math.min(height - hy, sp0.y)) };
    bandChips.push({ ...c, item: c.item ?? valItem(c.key, null), cx: sp.x, cy: sp.y, pw, ph, f: cfs });
    chips.obstacles.push({ x: sp.x, y: sp.y, r: Math.max(pw, ph) / 2 });
  };
  const valItem = (key: string, v: number | null, edit?: (x: number, preview?: boolean) => void): ChainItem =>
    ({ key, kind: 'gap', a: 0, b: 0, txt: v == null ? '' : fmt1(v), title: '', commit: x => edit?.(x), preview: x => edit?.(x, true), min: 0 });
  const rot = (b: Band) => (b.vertical ? -90 : 0);
  // KANAL PAYI rozeti ("±"): kanallı kenarın / derzin kanal bollaştırmasını kart satırına getirir. Seçili → koyu; kendi değeri var → turuncu.
  const clearChip = (b: Band) => {
    const vfId = b.np.vfId, on = clearVfId === vfId, own = backGrooveClearOverridden(group, vfId), c = backGrooveClearOf(group, vfId);
    placeChip({ key: `bc-clr-${vfId}`, vfId, label: '±', rot: 0, warm: on, accent: own && !on, toggle: () => onPickClearEdge(vfId),
      title: `${b.np.name} — groove clearance ${own ? '(own values)' : '(group values)'}: F ${fmt1(c.front)} · R ${fmt1(c.back)} · D ${fmt1(c.depth)} mm. `
        + `Click to edit only this panel's groove clearance in the card row${on ? ' (click again: back to the whole group)' : ''}.` },
      bandAxis(b));
  };
  if (!refPick) {
    for (const b of bands) {
      const k = b.np.edge, vfId = b.np.vfId, ax = bandAxis(b);
      // BAĞLI DERZ (dikme/rafta bölünmüş): ilişki rozeti Groove ↔ Nail; binme değerleri derz pill'lerinde / rozetinde.
      if (!k && b.np.ref && refJoint(b.np)) {
        const { splitId, k: jk } = b.np.ref;
        const rel = backJointRelOf(group.tree, splitId, jk), nail = rel === 'nail';
        const what = b.vertical ? 'divider' : 'shelf';
        placeChip({ key: `bc-jrel-${vfId}-${splitId}-${jk}`, vfId, label: BACK_REL_LABEL[rel], rot: rot(b), warm: nail,
          toggle: () => onToggleJointRel(splitId, jk), title: `${b.np.name} (${what}) — the back panel is split here. ` + (nail
            ? `NAILED — the ${what} is shortened to the back panel's front face and both pieces cover its end by their overlap. `
              + `Click to switch to Groove (the ${what} keeps its full depth, both pieces enter it from both sides).`
            : `GROOVED on both sides — the ${what} keeps its full depth and both pieces enter it by their overlap. `
              + `Click to switch to Nail (the ${what} is shortened to the back panel's front face automatically; the pieces cover its end).`) }, ax);
        // BİNME rozetleri (her yan ayrı, doğrudan düzenlenir): Nail → "On" = parçanın levha ucunun üzerine binmesi,
        // Groove → "In" = levhaya giriş. Rozet o yanın parçasına doğru kaydırılır (hangi yan olduğu görünsün).
        for (const which of ['before', 'after'] as const) {
          const ek: BackEdgeKey = b.vertical ? (which === 'before' ? 'uMax' : 'uMin') : (which === 'before' ? 'vMin' : 'vMax');
          const ids = allLeafIds.filter(id => { const x = sides[id]?.[ek]; return !!x && x.splitId === splitId && x.k === jk; });
          if (!ids.length) continue;
          const ss = ids.map(id => sides[id]![ek]!), common = same(ss.map(x => x.in)), t = ss[0].t;
          const m0 = members.find(mm => mm.leafId === ids[0]);
          const pcx = m0 ? (sx(m0.u0) + sx(m0.u1)) / 2 : b.x, pcy = m0 ? (sy(m0.v0) + sy(m0.v1)) / 2 : b.y;
          const dir = b.vertical ? Math.sign(pcx - ax.cx) || 1 : Math.sign(pcy - ax.cy) || 1;
          const label = `${nail ? 'On' : 'In'} ${common == null ? '…' : fmt1(common)}`;
          const off = (b.vertical ? b.w : b.h) / 2 + pillSize(label, cfs).ph / 2 + 2;
          const key = `bc-jin-${vfId}-${splitId}-${jk}-${which}`;
          placeChip({ key, vfId, label, rot: rot(b), warm: nail, item: valItem(key, common, (x, pv) => onEditJointIn(ek, x, ids, pv)),
            title: `${b.np.name} (${what}) — ${nail ? `how far the piece runs onto the ${what}'s end` : `how far the piece enters the ${what}`} on this side `
              + `(${scopeTxt(ids)}): ${common == null ? 'pieces differ' : `${fmt1(common)} mm`} of ${fmt1(t)} `
              + `(0 = ends at its face, ${fmt1(t)} = covers it fully; default: to its middle). Click to type.` },
            { ...ax, cx: ax.cx + (b.vertical ? dir * off : 0), cy: ax.cy + (b.vertical ? 0 : dir * off) });
        }
        if (!nail) clearChip(b);
      }
      if (!k) continue;
      // KENAR İLİŞKİSİ rozeti (grup başına): kenarda iç (kanallı tip) parça varsa Groove ↔ Nail.
      if (b.rel && (b.gr.length || b.nl.length) && b.t > 0) {
        placeChip({ key: `bc-rel-${vfId}`, vfId, label: BACK_REL_LABEL[b.rel], rot: rot(b), warm: b.rel === 'nail', toggle: () => onToggleEdgeRel(k),
          title: `${edgeName(b)} — ${b.np.name}: ${b.rel === 'nail'
            ? 'NAILED edge — the panel is shortened to the back panel\'s front face and the piece covers its end by the overlap. '
              + 'Click to switch to Groove (the panel keeps its full depth, the piece enters its groove).'
            : 'GROOVED edge — the panel keeps its full depth and the piece enters its groove by the groove depth. '
              + 'Click to switch to Nail (the panel is shortened to the back panel\'s front face automatically; the piece covers its end).'}` }, ax);
      }
      if (b.na.length) {
        const ids = b.na, key = `bc-on-${vfId}`;
        placeChip({ key, vfId, label: `On ${b.cov == null ? '…' : fmt1(b.cov)}`, rot: rot(b), warm: b.half,
          item: valItem(key, b.cov, (x, pv) => onEditCover(k, x, ids, pv)),
          title: `${edgeName(b)} — ${b.np.name}: nailed piece overlap ${b.cov == null ? '(pieces differ)' : `${fmt1(b.cov)} mm`} of ${fmt1(b.t)} `
            + `(${scopeTxt(ids)}). `
            + `Click to type the overlap (0 = ends at the panel's inner face, ${fmt1(b.t)} = covers it fully).` }, ax);
      }
      if (b.gr.length) {
        const ids = b.gr, key = `bc-in-${vfId}`;
        placeChip({ key, vfId, label: `In ${b.ins == null ? '…' : fmt1(b.ins)}`, rot: rot(b), warm: false,
          item: valItem(key, b.ins, (x, pv) => onEditInset(k, x, ids, pv)),
          title: `${edgeName(b)} — ${b.np.name}: groove depth ${b.ins == null ? '(pieces differ)' : `${fmt1(b.ins)} mm`} (${scopeTxt(ids)}). `
            + 'Click to type how far the grooved piece enters the panel (0 = ends at its inner face).' }, ax);
        clearChip(b);
      }
    }
    for (const cb of cutBands) {
      if (!cb.edge || !cb.na.length) continue;
      const k = cb.edge, ids = cb.na, key = `bc-on-${cb.cut.vfId}`;
      placeChip({ key, vfId: cb.cut.vfId, label: `On ${cb.cov == null ? '…' : fmt1(cb.cov)}`, rot: cb.deg, warm: cb.half,
        item: valItem(key, cb.cov, (x, pv) => onEditCover(k, x, ids, pv)),
        title: `${cb.cut.name} — angled panel: nailed piece overlap ${cb.cov == null ? '(pieces differ)' : `${fmt1(cb.cov)} mm`} of ${fmt1(cb.t)} `
          + `(${scopeTxt(ids)}), measured across the panel. Click to type the overlap.` }, cutAxis(cb));
    }
  }
  const editables = new Map<string, EditTarget>([...pills.map(p => [p.key, p] as const), ...bandChips.filter(c => !c.toggle).map(c => [c.key, c] as const)]);

  // GİRİŞ BÖLGELERİ (Goker, Eki 2026 — "arkalığın panelin içine girdiğini daha belirgin göster"): parça ∩ sınır levhası şeridi.
  // groove = parça panelin kanalına giriyor (turuncu, kanal dibi koyu çizgi); nail = parça panelin ucunu örtüyor (taş rengi).
  // Her zaman çizilir (seçim gerekmez); çok ince bölge en az 3 px gösterilir (panelin iç yüzünden dışa doğru).
  type Zone = { key: string; x: number; y: number; w: number; h: number; kind: 'groove' | 'nail'; vertical: boolean; deepX: number; deepY: number;
    /** Kanal (bollaştırılmış) kutusu: parça bölgesi + kanal dibi payı (D), panelin iç yüzü sabit. */
    groove?: { x: number; y: number; w: number; h: number };
    /** Kanal payı bu kenar için düzenleniyor (kart satırı): belirgin çerçeve. */
    active?: boolean; vfId: string };
  const zones: Zone[] = [];
  const pxU = SW / view.duR, pxV = SH / view.dvR;   // mm → px
  for (const np of nearPanels) {
    if (np.poly || (!np.edge && !np.ref)) continue;
    const rel: BackEdgeRel = np.edge ? edgeRelOf(group, np.edge) : backJointRelOf(group.tree, np.ref!.splitId, np.ref!.k);
    for (const m of members) {
      const isU = np.kind === 'u';
      const ma0 = isU ? m.u0 : m.v0, ma1 = isU ? m.u1 : m.v1, mc0 = isU ? m.v0 : m.u0, mc1 = isU ? m.v1 : m.u1;
      const a0 = Math.max(ma0, np.a0), a1 = Math.min(ma1, np.a1), c0 = Math.max(mc0, np.c0), c1 = Math.min(mc1, np.c1);
      if (a1 - a0 < 0.05 || c1 - c0 < 1) continue;
      const kind: 'groove' | 'nail' = m.piece.placement === 'outer' || rel === 'nail' ? 'nail' : 'groove';
      // Kanal dibi = parçanın panel içindeki ucu (panelin iç yüzünden uzak taraf).
      const deepAtMax = (ma0 + ma1) / 2 < (np.a0 + np.a1) / 2;   // parça panelin min tarafında → kanal dibi bölgenin max ucu
      const deep = deepAtMax ? a1 : a0;
      let x0 = isU ? Math.min(sx(a0), sx(a1)) : Math.min(sx(c0), sx(c1)), x1 = isU ? Math.max(sx(a0), sx(a1)) : Math.max(sx(c0), sx(c1));
      let y0 = isU ? Math.min(sy(c0), sy(c1)) : Math.min(sy(a0), sy(a1)), y1 = isU ? Math.max(sy(c0), sy(c1)) : Math.max(sy(a0), sy(a1));
      const MINZ = 3;
      // Çok ince bölge: kanal dibi yönüne doğru en az MINZ px (panelin iç yüzü sabit kalır).
      if (isU && x1 - x0 < MINZ) { if (Math.abs(sx(deep) - x0) < Math.abs(sx(deep) - x1)) x0 = x1 - MINZ; else x1 = x0 + MINZ; }
      if (!isU && y1 - y0 < MINZ) { if (Math.abs(sy(deep) - y0) < Math.abs(sy(deep) - y1)) y0 = y1 - MINZ; else y1 = y0 + MINZ; }
      const deepX = isU ? (Math.abs(sx(deep) - x0) < Math.abs(sx(deep) - x1) ? x0 : x1) : 0;
      const deepY = isU ? 0 : (Math.abs(sy(deep) - y0) < Math.abs(sy(deep) - y1) ? y0 : y1);
      // Kanal kutusu: dip payı (D) kanal dibi yönünde eklenir; kanal genişliği (F/B) derinlik ekseninde olduğundan ön görünüşte yok.
      let grooveBox: Zone['groove'];
      if (kind === 'groove') {
        const dpx = backGrooveClearOf(group, np.vfId).depth * (isU ? pxU : pxV);
        grooveBox = isU
          ? (deepX === x0 ? { x: x0 - dpx, y: y0, w: x1 - x0 + dpx, h: y1 - y0 } : { x: x0, y: y0, w: x1 - x0 + dpx, h: y1 - y0 })
          : (deepY === y0 ? { x: x0, y: y0 - dpx, w: x1 - x0, h: y1 - y0 + dpx } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 + dpx });
      }
      zones.push({ key: `z-${np.vfId}-${m.leafId}`, x: x0, y: y0, w: x1 - x0, h: y1 - y0, kind, vertical: isU, deepX, deepY, groove: grooveBox,
        active: clearVfId === np.vfId, vfId: np.vfId });
    }
  }
  const stripClip = cuts.length ? backCutOutline(group, rect, rect, cuts).map(view.toPx) : null;

  return (
    <SchemFrame wrapRef={wrapRef} width={width} height={height} gid={gid} view={view} overlay={<ChainEditInput ed={ed} find={k => editables.get(k)} />}>
      {bands.map(b => <BandFill key={`band-${b.np.vfId}`} gid={gid} pts={b.pts} warm={b.half || b.aligned} />)}
      {cutBands.map(cb => <BandFill key={`cut-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} />)}
      {members.map((m, i) => {
        const lbl = memberLabels[i] ?? String(i + 1), path = nodePath(solved, m.leafId), caption = BACK_TYPE_LABEL[m.piece.placement];
        return (
          // Seçili parça (satır ya da şema) belirgin vurgulanır.
          <MemberCell key={`part-${i}`} m={m} view={view} gid={gid} on={i === selectedIndex || selectedNodes.includes(m.leafId)} inSel={selLeafIds.has(m.leafId)}
            lbl={lbl} fsT={fsT} pills={pills} caption={caption} onPick={add => onPathClick(path, add)}
            tip={memberTip(`Back ${lbl} · ${caption}${m.piece.placement === 'inner' ? ` · setback ${fmt1(m.piece.setback)}` : ''}`, m, path.length,
              'with a piece selected, Type / Setback / edge values apply to that piece only')} />
        );
      })}
      {cutBands.map(cb => <HiddenParts key={`cuthid-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} members={members} view={view} />)}
      {bands.map(b => <HiddenParts key={`hid-${b.np.vfId}`} gid={gid} pts={b.pts} warm={b.half || b.aligned} members={members} view={view} />)}
      {zones.map(z => {
        const groove = z.kind === 'groove';
        const fill = groove ? '#fb923c' : '#78716c', line = groove ? '#c2410c' : '#44403c';
        const gb = z.groove;
        // Kanal dibi çizgisi: kanal kutusunun (parça + D payı) dip kenarı.
        const bx = gb ? (z.vertical ? (z.deepX === z.x ? gb.x : gb.x + gb.w) : 0) : z.deepX;
        const by = gb ? (z.vertical ? 0 : (z.deepY === z.y ? gb.y : gb.y + gb.h)) : z.deepY;
        return (
          <g key={z.key} style={{ pointerEvents: 'none' }}>
            {gb && <rect x={gb.x} y={gb.y} width={Math.max(0.5, gb.w)} height={Math.max(0.5, gb.h)} fill="#fff7ed" fillOpacity={0.95} stroke={line}
              strokeOpacity={0.5} strokeWidth={0.6} strokeDasharray="2 1.5" />}
            {z.active && gb && <rect x={gb.x - 2} y={gb.y - 2} width={gb.w + 4} height={gb.h + 4} rx={2} fill="none" stroke="#ea580c" strokeWidth={1.4} />}
            {/* Görsel ipucu: kartta kanal payının üzerindeyken kapsamdaki kanallar yanıp söner gibi belirginleşir. */}
            {grooveHint && gb && (!clearVfId || clearVfId === z.vfId) && (
              <rect x={gb.x - 3} y={gb.y - 3} width={gb.w + 6} height={gb.h + 6} rx={3} fill="#f97316" fillOpacity={0.18} stroke="#ea580c" strokeWidth={1.6}
                className="yago-hint-pulse" />
            )}
            <rect x={z.x} y={z.y} width={Math.max(0.5, z.w)} height={Math.max(0.5, z.h)} fill={fill} fillOpacity={groove ? 0.62 : 0.42} />
            <rect x={z.x} y={z.y} width={Math.max(0.5, z.w)} height={Math.max(0.5, z.h)} fill="none" stroke={line} strokeOpacity={0.55} strokeWidth={0.6} />
            {/* Kanal dibi / örtme ucu: kalın net çizgi */}
            {z.vertical
              ? <line x1={bx} y1={gb ? gb.y : z.y} x2={bx} y2={(gb ? gb.y + gb.h : z.y + z.h)} stroke={line} strokeWidth={1.6} strokeLinecap="round" />
              : <line x1={gb ? gb.x : z.x} y1={by} x2={(gb ? gb.x + gb.w : z.x + z.w)} y2={by} stroke={line} strokeWidth={1.6} strokeLinecap="round" />}
          </g>
        );
      })}
      <FocusStrips strips={kit.strips} clip={stripClip} />
      {selRegions.map(n => <SelOutline key={`sel-${n.id}`} n={n} view={view} shape={cuts.length ? backCutOutline(group, rect, n, cuts) : null} />)}
      {/* Bant tık alanları bilinçli olarak seçim çerçevesi/şeritlerin ÜSTÜNDE, pill'lerin ALTINDA çizilir. Kenar bandının değer rozetleri
          ayrı çizilir (bandChips); burada yalnız bölme rozeti. */}
      {bands.map(b => {
        const np = b.np;
        const pickable = !!refPick && !np.edge, splitOn = !pickable && splittable(np);
        const interactive = pickable || splitOn || (!pickable && !np.edge && !!refJoint(np)) || (!!np.edge && (b.na.length > 0 || b.gr.length > 0));
        const at = pickable || splitOn ? chips.spot(bandAxis(b), pillSize('Split here', cfs).pw) : null;
        return (
          <BandHit key={`hit-${np.vfId}`} gid={gid} pts={b.pts} rect={np.poly ? undefined : b} warm={b.half || b.aligned} title={bandTip(b)}
            onClick={interactive ? () => onBandClick(b) : undefined}
            chip={at && <Chip className="chip" cx={at.x} cy={at.y} txt="Split here" fs={cfs} tone={CHIP.accent} rot={rot(b)} />} />
        );
      })}
      {/* Açılı levhanın rozeti: kesilen kenara değen ÇAKMA parçaların binisi (kanallı parçada eğik kenar pill'i var). */}
      {cutBands.map(cb => {
        const chip = bandChips.find(c => c.vfId === cb.cut.vfId);
        const tip = `${cb.cut.name} — angled back-reference panel: the back panel is cut along it (it keeps the side you clicked when placing).` +
          (chip ? ` Nailed overlap ${cb.cov == null ? '(pieces differ)' : `${fmt1(cb.cov)} mm`} of ${fmt1(cb.t)} (${scopeTxt(cb.na)}) — click to edit.`
            : cb.covered ? ' Grooved pieces: edit the inset pill on the slanted edge of a selected piece.'
            : ' It stands outside the back panel plane, so there is no overlay to set.');
        return <BandHit key={`cuthit-${cb.cut.vfId}`} gid={gid} pts={cb.pts} warm={cb.half} title={tip} onClick={chip ? () => editChip(chip) : undefined} />;
      })}
      {/* Kenar değer rozetleri: "On <mm>" (çakma binme) / "In <mm>" (kanal derinliği) — tık yerinde düzenler. İlişki rozeti (Groove / Nail):
          dolu koyu taş = Nail (panel kısaltılır), açık = Groove; tık çevirir. */}
      {bandChips.map(c => {
        const tone = c.toggle && c.warm ? CHIP.on : c.warm || c.accent ? CHIP.accent : CHIP.base;
        return (
          <g key={c.key} className="yago-band pnl on" style={{ cursor: 'pointer' }} onClick={e => { stop(e); if (c.toggle) c.toggle(); else editChip(c); }}>
            <g className="chip" transform={c.rot ? `rotate(${c.rot.toFixed(1)} ${c.cx} ${c.cy})` : undefined}>
              <rect x={c.cx - c.pw / 2} y={c.cy - c.ph / 2} width={c.pw} height={c.ph} rx={c.ph / 2} fill={tone.fill} stroke={tone.stroke} strokeWidth={0.9}
                style={{ filter: CHIP_SHADOW }} />
              {ed.editing?.key !== c.key && (
                <text x={c.cx} y={c.cy + c.f * 0.36} textAnchor="middle" fontSize={c.f} fontWeight={700} letterSpacing="0.02em" fill={tone.text}
                  fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums' }}>{c.label}</text>
              )}
            </g>
            <title>{c.title}</title>
          </g>
        );
      })}
      <ChainPills pills={pills} ed={ed} bounds="back panel" />
    </SchemFrame>
  );
}
