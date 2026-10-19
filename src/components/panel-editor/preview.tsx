import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { type CavityBox, type PanelGroup, type Shape } from '../../store';
import { UI_FONT } from '../Ui';
import { axisDirToVec, isFlatNormal, localBboxOf, round1 } from '../Geometry';
import { largestFaceNormal } from '../FaceRegion';
import { boxSpan, gapMode, groupFacing, memberThicknessesOf, panelStarts, passiveGapIndex, traceMaskLoops } from '../PanelGroupService';
import {
  CHIP, DIM_EXT, DIM_LINE, Chip, DimArrows, DimPill, LOCK_OFF, LockBadge, PREVIEW_BG, PREVIEW_FRAME, PREVIEW_HEIGHT, PassivePill, PillEditInput,
  type Pt, SCHEMATIC_CSS, SOFT, SoftDefs, chipFs, parseNum, pillSize, schemFs, schemFsT, stop, svgId, useEditSession, useElementWidth,
} from './kit';

/* PANEL ÖNİZLEMESİ (2B ölçülü görünüş) ve RAF / DİKME ŞEMASI. */

export function geoAxes(geo: THREE.BufferGeometry) {
  const bbox = localBboxOf(geo); if (!bbox) return null;
  const size = new THREE.Vector3(); bbox.getSize(size);
  const axes = [{ i: 0, v: size.x }, { i: 1, v: size.y }, { i: 2, v: size.z }].sort((a, b) => a.v - b.v);
  return { axes, size, bbox };
}

/* PANEL ÇERÇEVESİ: önizleme ve ölçüler gövde-yerel geometriden okunursa dönmüş panelde eğik bbox
   yanlış ölçü ve sahte "kesim" verir. Dönüş adımlarının birleşik dönüşü (PanelEngine.composeSteps ile
   AYNI sıra) tersine uygulanır; adımsız eğik levhada en büyük yüz normali en yakın eksene çevrilir. */
const _frameCache = new WeakMap<THREE.BufferGeometry, { key: string; geo: THREE.BufferGeometry; inv: THREE.Quaternion }>();
const rotDeg = (st: any): number => (typeof st.resolvedValue === 'number' ? st.resolvedValue : st.value);
function stepsFrameQuat(steps: any[] | undefined): THREE.Quaternion {
  const frame = new THREE.Quaternion();
  for (const st of steps || []) {
    if (st?.type !== 'rotate') continue;
    const deg = rotDeg(st) || 0;
    if (Math.abs(deg) < 1e-9) continue;
    const axis = Array.isArray(st.axisVec)
      ? new THREE.Vector3(st.axisVec[0], st.axisVec[1], st.axisVec[2]).normalize()
      : axisDirToVec(String(st.axis || 'y') + '+');
    const worldAxis = axis.applyQuaternion(frame).normalize();
    frame.premultiply(new THREE.Quaternion().setFromAxisAngle(worldAxis, (deg * Math.PI) / 180));
  }
  return frame;
}
/** Panelin kendi çerçevesindeki geometrisi (dönüşsüz panelde geometrinin kendisi) + uygulanan ters dönüş. */
export function panelFrameOf(shape: Shape | undefined | null): { geo: THREE.BufferGeometry; inv: THREE.Quaternion } | null {
  const geo = shape?.geometry as THREE.BufferGeometry | undefined; if (!geo) return null;
  const steps: any[] = shape?.parameters?.transformSteps || [];
  const vecKey = (s: any) => (Array.isArray(s.axisVec) ? s.axisVec.map((v: number) => v.toFixed(3)).join('/') : '');
  const key = steps.filter(s => s?.type === 'rotate').map(s => `${s.axis}${vecKey(s)}:${rotDeg(s)}`).join('|');
  const hit = _frameCache.get(geo); if (hit && hit.key === key) return { geo: hit.geo, inv: hit.inv };
  const inv = stepsFrameQuat(steps).invert();
  let out = geo;
  if (Math.abs(inv.w) < 0.9999999) { out = geo.clone(); out.applyQuaternion(inv); }
  const n = largestFaceNormal(out, 1e-6);
  if (n && !isFlatNormal(n, 0.9999)) {
    const ax = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)]; const i = ax.indexOf(Math.max(...ax));
    const target = new THREE.Vector3().setComponent(i, Math.sign(n.getComponent(i)) || 1);
    const q2 = new THREE.Quaternion().setFromUnitVectors(n.clone().normalize(), target);
    if (out === geo) out = geo.clone();
    out.applyQuaternion(q2); inv.premultiply(q2);
  }
  if (out !== geo) { out.computeBoundingBox(); out.computeBoundingSphere(); }
  _frameCache.set(geo, { key, geo: out, inv });
  return { geo: out, inv };
}

/** Liste satırı ölçüleri: en / boy (ok yönüne göre) + kalınlık (parametreden; dönmüş panelde bbox'ın en küçüğü gerçek kalınlık değildir). */
export const panelDims = (p: Shape | undefined | null) => {
  const geo = panelFrameOf(p)?.geo; if (!geo) return null;
  const r = geoAxes(geo); if (!r) return null;
  const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
  const target = p!.parameters?.arrowRotated ? pa[1] : pa[0], secondary = pa.find(a => a !== target) ?? pa[0], s = [r.size.x, r.size.y, r.size.z];
  const pt = parseFloat(p!.parameters?.panelThickness) || 18;
  return { primary: round1(s[target]), secondary: round1(s[secondary]), thickness: pt > 0 ? round1(pt) : round1(s[r.axes[0].i]) };
};

interface GroundDimWorld { fa: THREE.Vector3; fb: THREE.Vector3; da: THREE.Vector3; db: THREE.Vector3; length: number; along?: number; }
/* Panelin tam enini/boyunu kaplayan "kesim" (pah kenarı, tam boy kanal) dış ölçünün kopyasıdır → atılır. */
const CUT_FULL_SPAN = 0.9;
const KEYS = ['x', 'y', 'z'] as const;
type CutFrame = { p0: number; p1: number; thin: number; topVal: number; lo0: number; hi0: number; lo1: number; hi1: number; gap: number; span0: number; span1: number };
/** Panel yüzü çerçevesi: düzlem eksenleri, üst yüz değeri, kenarlar ve ölçü aralığı. */
function cutFrame(thin: number, box: THREE.Box3, size: THREE.Vector3, nDir: THREE.Vector3): CutFrame {
  const [p0, p1] = [0, 1, 2].filter(i => i !== thin), k0 = KEYS[p0], k1 = KEYS[p1], tk = KEYS[thin];
  const span0 = size.getComponent(p0), span1 = size.getComponent(p1);
  return {
    p0, p1, thin, topVal: nDir.getComponent(thin) > 0 ? box.max[tk] : box.min[tk],
    lo0: box.min[k0], hi0: box.max[k0], lo1: box.min[k1], hi1: box.max[k1], gap: Math.min(span0, span1) * 0.045, span0, span1,
  };
}
/** Kesim kutusunun iki ölçüsü (yakın kenar tarafında); tam boy olanlar atılır. */
function cutBoxDims(mn0: number, mx0: number, mn1: number, mx1: number, c: CutFrame): GroundDimWorld[] {
  const mk = (v0: number, v1: number) => new THREE.Vector3().setComponent(c.p0, v0).setComponent(c.p1, v1).setComponent(c.thin, c.topVal);
  const w0 = mx0 - mn0, w1 = mx1 - mn1;
  const dims: GroundDimWorld[] = [];
  // Ölçü kesimin panel kenarına yakın tarafına, kenardan `gap` dışarı çizilir.
  const side = (mn: number, mx: number, lo: number, hi: number) => ((mn - lo) <= (hi - mx) ? [mn, mn - c.gap] : [mx, mx + c.gap]);
  if (w0 > 0.5) {
    const [e, o] = side(mn1, mx1, c.lo1, c.hi1);
    dims.push({ fa: mk(mn0, e), fb: mk(mx0, e), da: mk(mn0, o), db: mk(mx0, o), length: Math.round(w0), along: c.p0 });
  }
  if (w1 > 0.5) {
    const [e, o] = side(mn0, mx0, c.lo0, c.hi0);
    dims.push({ fa: mk(e, mn1), fb: mk(e, mx1), da: mk(o, mn1), db: mk(o, mx1), length: Math.round(w1), along: c.p1 });
  }
  return dims.filter(d => d.length < CUT_FULL_SPAN * (d.along === c.p0 ? c.span0 : c.span1));
}
const subXform = (sg: any) => {
  const rot = sg.relativeRotation || [0, 0, 0];
  return {
    rotM: new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ')),
    off: new THREE.Vector3(...((sg.relativeOffset || [0, 0, 0]) as number[])),
  };
};
/** Çıkarma geometrilerinin (subtraction) panel yüzündeki ölçüleri. */
function cutDimsFromSubGeos(subGeos: any[], box: THREE.Box3, size: THREE.Vector3, thin: number, nDir: THREE.Vector3, frame?: THREE.Matrix4): GroundDimWorld[] {
  const c = cutFrame(thin, box, size, nDir);
  const out: GroundDimWorld[] = [];
  const v = new THREE.Vector3();
  subGeos.forEach(sg => {
    const pos = sg?.geometry?.getAttribute('position'); if (!pos) return;
    const { rotM, off } = subXform(sg);
    let mn0 = Infinity, mx0 = -Infinity, mn1 = Infinity, mx1 = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(rotM).add(off);
      if (frame) v.applyMatrix4(frame);
      const c0 = v.getComponent(c.p0), c1 = v.getComponent(c.p1);
      mn0 = Math.min(mn0, c0); mx0 = Math.max(mx0, c0); mn1 = Math.min(mn1, c1); mx1 = Math.max(mx1, c1);
    }
    out.push(...cutBoxDims(Math.max(mn0, c.lo0), Math.min(mx0, c.hi0), Math.max(mn1, c.lo1), Math.min(mx1, c.hi1), c));
  });
  return out;
}
/** Çıkarma geometrisi yoksa: üst yüzdeki iç kenar kümeleri (cep / kanal) kesim sayılır. */
function computeCutDimsWorld(geometry: THREE.BufferGeometry, thin: number, nDir: THREE.Vector3): GroundDimWorld[] {
  const eg = new THREE.EdgesGeometry(geometry, 15);
  const pos = eg.getAttribute('position');
  if (!pos) { eg.dispose(); return []; }
  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const size = bbox.getSize(new THREE.Vector3());
  const tk = KEYS[thin];
  const c = cutFrame(thin, bbox, size, nDir);
  const { p0, p1, topVal, span0, span1 } = c;
  const minSpan = Math.min(span0, span1);
  const tolT = Math.max((bbox.max[tk] - bbox.min[tk]) * 0.15, 0.6);
  const tolE = Math.max(minSpan * 0.01, 0.4), minLen = Math.max(minSpan * 0.03, 4);
  const onLine = (av: number, bv: number, val: number) => Math.abs(av - val) < tolE && Math.abs(bv - val) < tolE;

  type Seg = { a0: number; a1: number; b0: number; b1: number };
  const segs: Seg[] = [];
  const comp = [0, 0, 0];
  const read = (i: number) => { comp[0] = pos.getX(i); comp[1] = pos.getY(i); comp[2] = pos.getZ(i); return [comp[thin], comp[p0], comp[p1]]; };
  for (let i = 0; i < pos.count; i += 2) {
    const [aThin, a0, a1] = read(i), [bThin, b0, b1] = read(i + 1);
    if (Math.abs(aThin - topVal) > tolT || Math.abs(bThin - topVal) > tolT) continue;
    if (onLine(a0, b0, c.lo0) || onLine(a0, b0, c.hi0) || onLine(a1, b1, c.lo1) || onLine(a1, b1, c.hi1)) continue;
    if (Math.hypot(b0 - a0, b1 - a1) < minLen) continue;
    segs.push({ a0, a1, b0, b1 });
  }
  eg.dispose();
  if (!segs.length) return [];

  // Uç noktası ortak segmentler birleşim-bul ile kümelenir.
  const qstep = Math.max(tolE * 2, 0.8);
  const q = (val: number) => Math.round(val / qstep);
  const parent = segs.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const ptMap = new Map<string, number>();
  segs.forEach((s, i) => {
    [[s.a0, s.a1], [s.b0, s.b1]].forEach(([x, y]) => {
      const kk = q(x) + ',' + q(y);
      if (ptMap.has(kk)) { const ra = find(i), rb = find(ptMap.get(kk)!); if (ra !== rb) parent[ra] = rb; } else ptMap.set(kk, i);
    });
  });
  const clusters = new Map<number, Seg[]>();
  segs.forEach((s, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r)!.push(s); });

  const out: GroundDimWorld[] = [];
  let count = 0;
  clusters.forEach(arr => {
    if (count > 16) return;
    let mn0 = Infinity, mx0 = -Infinity, mn1 = Infinity, mx1 = -Infinity;
    arr.forEach(s => { mn0 = Math.min(mn0, s.a0, s.b0); mx0 = Math.max(mx0, s.a0, s.b0); mn1 = Math.min(mn1, s.a1, s.b1); mx1 = Math.max(mx1, s.a1, s.b1); });
    if ((mx0 - mn0) <= span0 * 0.02 && (mx1 - mn1) <= span1 * 0.02) return;
    // Yüzün tamamını kaplayan kenar kümesi (pah / eğik yüz dış hattı) kesim değildir.
    if ((mx0 - mn0) >= span0 * CUT_FULL_SPAN && (mx1 - mn1) >= span1 * CUT_FULL_SPAN) return;
    const dd = cutBoxDims(mn0, mx0, mn1, mx1, c);
    out.push(...dd); count += dd.length;
  });
  return out;
}
/** Dış ölçüler: en ve boy, zemine (kameraya göre alt) yakın yüzde, kutunun dışında. */
function computeGroundDimWorld(geometry: THREE.BufferGeometry, wIdx: number, hIdx: number, thin: number, up: THREE.Vector3): GroundDimWorld[] {
  const bbox = localBboxOf(geometry); if (!bbox) return [];
  const size = bbox.getSize(new THREE.Vector3()), cen = bbox.getCenter(new THREE.Vector3());
  const wKey = KEYS[wIdx], hKey = KEYS[hIdx], tk = KEYS[thin];
  const cMax = cen.clone().setComponent(thin, bbox.max[tk]);
  const cMin = cen.clone().setComponent(thin, bbox.min[tk]);
  const groundVal = cMin.dot(up) <= cMax.dot(up) ? bbox.min[tk] : bbox.max[tk];
  const wExt = size.getComponent(wIdx), hExt = size.getComponent(hIdx);
  const gOff = Math.max(wExt, hExt) * 0.12;
  const mk = (wv: number, hv: number) => new THREE.Vector3().setComponent(wIdx, wv).setComponent(hIdx, hv).setComponent(thin, groundVal);
  const he = bbox.max[hKey], we = bbox.max[wKey], w0 = bbox.min[wKey], w1 = bbox.max[wKey], h0 = bbox.min[hKey], h1 = bbox.max[hKey];
  return [
    { fa: mk(w0, he), fb: mk(w1, he), da: mk(w0, he + gOff), db: mk(w1, he + gOff), length: Math.round(wExt) },
    { fa: mk(we, h0), fb: mk(we, h1), da: mk(we + gOff, h0), db: mk(we + gOff, h1), length: Math.round(hExt) },
  ];
}

interface GroundRender { fa: Pt; fb: Pt; da: Pt; db: Pt; cx: number; cy: number; value: number; }
const PREVIEW_PANEL_COLOR = 0xeee7dc;
const PREVIEW_EDGE_COLOR = 0xa1988b;
const PREVIEW_LIGHT = { hemi: 1.0, ambient: 0.3, key: 1.9, fill: 0.55 };
const dimFs = (w: number) => Math.max(10.5, Math.min(13.5, w * 0.027));
const arrowSize = (w: number) => Math.max(4, Math.min(6.5, w * 0.014));

/* TEK WebGL BAĞLAMI: tarayıcı ~16 bağlamı aşınca EN ESKİSİNİ (ana sahne Canvas'ı) öldürür. Tüm önizlemeler
   tek ekran-dışı renderer'ı paylaşır; görüntü görünür canvas'a 2D drawImage ile kopyalanır. */
let _sharedPreviewRenderer: THREE.WebGLRenderer | null = null;
function getSharedPreviewRenderer(): THREE.WebGLRenderer | null {
  const cur = _sharedPreviewRenderer;
  if (cur && !cur.getContext().isContextLost()) return cur;
  if (cur) { try { cur.dispose(); } catch { /* yok say */ } _sharedPreviewRenderer = null; }
  try {
    const r = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setClearColor(0x000000, 0);
    _sharedPreviewRenderer = r;
    return r;
  } catch (e) {
    console.error('[YAGO][ÖNİZLEME] önizleme renderer oluşturulamadı:', e);
    return null;
  }
}
function fatLines(geometry: THREE.BufferGeometry, color: number, linewidth: number, w: number, h: number, disposables: Array<{ dispose: () => void }>) {
  const edgesGeo = new THREE.EdgesGeometry(geometry, 18);
  const lineGeo = new LineSegmentsGeometry().fromEdgesGeometry(edgesGeo);
  const mat = new LineMaterial({ color, linewidth, worldUnits: false, alphaToCoverage: true });
  mat.resolution.set(w, h);
  disposables.push(edgesGeo, lineGeo, mat);
  const lines = new LineSegments2(lineGeo, mat);
  lines.computeLineDistances();
  return lines;
}

export function PanelPreview2D({ shape, arrowRotated }: { shape: Shape; arrowRotated?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [ground, setGround] = useState<GroundRender[]>([]);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const [az, setAz] = useState(22);
  const shapeRef = useRef(shape); shapeRef.current = shape;
  const arrowRotatedRef = useRef(arrowRotated); arrowRotatedRef.current = arrowRotated;
  const azRef = useRef(az); azRef.current = az;
  const dragRef = useRef<{ x: number; az: number } | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return;
    let raf = 0, tries = 0;
    const apply = (w: number, h: number) => { if (w > 0 && h > 0) { setCanvasSize({ w: Math.round(w), h: Math.round(h) }); return true; } return false; };
    const measure = () => { if (!apply(wrap.clientWidth, wrap.clientHeight) && ++tries < 20) raf = requestAnimationFrame(measure); };
    raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(es => { const { width, height } = es[0].contentRect; apply(width, height); });
    ro.observe(wrap);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const shape = shapeRef.current, arrowRotated = arrowRotatedRef.current;
    const { w, h } = canvasSize;
    if (!canvas || !shape?.geometry || w <= 0 || h <= 0) return;
    const renderer = getSharedPreviewRenderer();
    if (!renderer) return;
    const frame = panelFrameOf(shape)!;
    const frameGeo = frame.geo;
    const frameM = new THREE.Matrix4().makeRotationFromQuaternion(frame.inv);
    const unrotated = Math.abs(frame.inv.w) > 0.9999999;

    const dpr = window.devicePixelRatio;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);

    const disposables: Array<{ dispose: () => void }> = [];
    const scene = new THREE.Scene();
    const material = new THREE.MeshStandardMaterial({ color: PREVIEW_PANEL_COLOR, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide });
    // Klon: paylaşılan renderer GPU tamponlarını tutar; klon çizimden sonra dispose edilir, sahne geometrisine dokunulmaz.
    const previewGeo = frameGeo.clone();
    disposables.push(material, previewGeo);
    scene.add(new THREE.Mesh(previewGeo, material));
    scene.add(fatLines(frameGeo, PREVIEW_EDGE_COLOR, 0.9, w, h, disposables));

    const bbox = new THREE.Box3().setFromObject(scene);
    const sz = bbox.getSize(new THREE.Vector3()), center = bbox.getCenter(new THREE.Vector3());
    const dims3 = [sz.x, sz.y, sz.z];
    const minIdx = dims3.indexOf(Math.min(...dims3));

    // En/yükseklik düzlem EKSENLERİNE bağlı (panelDims ile aynı) → extrude sonrası önizleme kendiliğinden dönmez.
    const planar = [0, 1, 2].filter(i => i !== minIdx).sort((a, b) => a - b);
    const [wIdx, hIdx] = arrowRotated ? [planar[1], planar[0]] : planar;
    const wDir = new THREE.Vector3().setComponent(wIdx, 1);
    const hDir = new THREE.Vector3().setComponent(hIdx, 1);
    const nDir = new THREE.Vector3().crossVectors(wDir, hDir).normalize();

    const elev = THREE.MathUtils.degToRad(15), azim = THREE.MathUtils.degToRad(azRef.current);
    const camOffset = new THREE.Vector3()
      .addScaledVector(nDir, Math.cos(elev) * Math.cos(azim))
      .addScaledVector(wDir, Math.cos(elev) * Math.sin(azim))
      .addScaledVector(hDir, Math.sin(elev)).normalize();

    // three r155+ fiziksel ışık ölçeği: düşük şiddetler paneli kirli griye çeker.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d1c4, PREVIEW_LIGHT.hemi));
    scene.add(new THREE.AmbientLight(0xffffff, PREVIEW_LIGHT.ambient));
    const light = (color: number, k: number, n: number, hh: number, ww: number) => {
      const l = new THREE.DirectionalLight(color, k);
      l.position.copy(nDir).multiplyScalar(n).addScaledVector(hDir, hh).addScaledVector(wDir, ww);
      return l;
    };
    scene.add(light(0xffffff, PREVIEW_LIGHT.key, 3, 2, 1.4), light(0xf4f1ec, PREVIEW_LIGHT.fill, 1, -1.6, -2.2), light(0xffffff, 0.15, -1, 1, 0.6));

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -40000, 40000);
    camera.position.copy(center).addScaledVector(camOffset, 4000);
    camera.up.copy(hDir);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const upW = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);

    const subGeos: any[] = Array.isArray(shape.subtractionGeometries) ? shape.subtractionGeometries : [];
    const allDimsW = [
      ...computeGroundDimWorld(frameGeo, wIdx, hIdx, minIdx, upW),
      ...(subGeos.length ? cutDimsFromSubGeos(subGeos, bbox, sz, minIdx, nDir, unrotated ? undefined : frameM) : computeCutDimsWorld(frameGeo, minIdx, nDir)),
    ];

    // Kamera kutusu: tüm köşeler + ölçü uçları sığsın; altta pill için pay.
    const allW: THREE.Vector3[] = [];
    for (const X of [bbox.min.x, bbox.max.x]) for (const Y of [bbox.min.y, bbox.max.y]) for (const Z of [bbox.min.z, bbox.max.z]) allW.push(new THREE.Vector3(X, Y, Z));
    allDimsW.forEach(d => allW.push(d.fa, d.fb, d.da, d.db));
    let maxU = 0, maxV = 0;
    allW.forEach(p => { const d = p.clone().sub(center); maxU = Math.max(maxU, Math.abs(d.dot(right))); maxV = Math.max(maxV, Math.abs(d.dot(upW))); });
    const halfV = maxV * 1.06;
    const ratioTop = halfV, ratioBot = halfV + halfV * 0.06;
    let vSpan = ratioTop + ratioBot, halfH = (vSpan / 2) * (w / h);
    const needH = maxU * 1.06;
    if (halfH < needH) { vSpan *= needH / halfH; halfH = needH; }
    camera.left = -halfH; camera.right = halfH;
    camera.top = vSpan * ratioTop / (ratioTop + ratioBot); camera.bottom = -vSpan * ratioBot / (ratioTop + ratioBot);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    subGeos.forEach((sg: any) => {
      if (!sg?.geometry) return;
      const { rotM, off } = subXform(sg);
      const sgLines = fatLines(sg.geometry, 0xd97706, 1.2, w, h, disposables);
      sgLines.matrix.copy(rotM); sgLines.matrix.setPosition(off);
      if (!unrotated) sgLines.matrix.premultiply(frameM);
      sgLines.matrixAutoUpdate = false;
      scene.add(sgLines);
    });

    renderer.render(scene, camera);
    // 2D bağlam WebGL bağlam sınırına sayılmaz.
    const ctx2d = canvas.getContext('2d');
    if (ctx2d) { ctx2d.clearRect(0, 0, canvas.width, canvas.height); ctx2d.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height); }
    renderer.renderLists.dispose();

    // Ölçü pill'leri: çakışan pill ölçü yönünde dışa itilir.
    const fsG = dimFs(w);
    const proj = (p: THREE.Vector3): Pt => { const ndc = p.clone().project(camera); return { x: (ndc.x + 1) / 2 * w, y: (1 - ndc.y) / 2 * h }; };
    const items = allDimsW.map(d => {
      const fa = proj(d.fa), fb = proj(d.fb), da = proj(d.da), db = proj(d.db);
      const ox = da.x - fa.x, oy = da.y - fa.y, l = Math.hypot(ox, oy) || 1;
      const { pw, ph } = pillSize(String(d.length), fsG);
      return { fa, fb, da, db, length: d.length, out: { x: ox / l, y: oy / l }, cx: (da.x + db.x) / 2, cy: (da.y + db.y) / 2, hw: pw / 2, hh: ph / 2 };
    });
    const placed: Array<{ cx: number; cy: number; hw: number; hh: number }> = [];
    const hits = (cx: number, cy: number, hw: number, hh: number) => placed.some(pp => Math.abs(pp.cx - cx) < pp.hw + hw + 4 && Math.abs(pp.cy - cy) < pp.hh + hh + 4);
    setGround(items.map(it => {
      let push = 0; const step = Math.max(it.hh * 2, 16); let cx = it.cx, cy = it.cy, guard = 0;
      while (hits(cx, cy, it.hw, it.hh) && guard < 12) { push += step; cx = it.cx + it.out.x * push; cy = it.cy + it.out.y * push; guard++; }
      placed.push({ cx, cy, hw: it.hw, hh: it.hh });
      const shift = (p: Pt) => ({ x: p.x + it.out.x * push, y: p.y + it.out.y * push });
      return { fa: it.fa, fb: it.fb, da: shift(it.da), db: shift(it.db), cx, cy, value: it.length };
    }));
    disposables.forEach(d => d.dispose());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape?.geometry?.uuid, panelFrameOf(shape)?.geo, arrowRotated, az, canvasSize.w, canvasSize.h]);

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, az: azRef.current };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* yok say */ }
  };
  const onPointerMove = (e: React.PointerEvent) => { const d = dragRef.current; if (d) setAz(Math.max(-55, Math.min(55, d.az + (e.clientX - d.x) * 0.35))); };
  const onPointerUp = () => { dragRef.current = null; };
  const fsG = dimFs(canvasSize.w), asz = arrowSize(canvasSize.w);
  const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%' } as const;

  return (
    <div ref={wrapRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}
      style={{ position: 'absolute', inset: 0, userSelect: 'none', cursor: 'ew-resize', touchAction: 'none' }}>
      <canvas ref={canvasRef} style={{ display: 'block', ...fill, filter: 'drop-shadow(0 8px 14px rgba(60,40,20,0.06))' }} />
      <svg style={{ ...fill, pointerEvents: 'none', overflow: 'visible' }} viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`}>
        {ground.map((d, i) => (
          <g key={`gd-${i}`}>
            <line x1={d.fa.x} y1={d.fa.y} x2={d.da.x} y2={d.da.y} stroke={DIM_EXT} strokeWidth="0.7" />
            <line x1={d.fb.x} y1={d.fb.y} x2={d.db.x} y2={d.db.y} stroke={DIM_EXT} strokeWidth="0.7" />
            <DimArrows a={d.da} b={d.db} asz={asz} color={DIM_LINE} />
            <DimPill cx={d.cx} cy={d.cy} txt={String(d.value)} fs={fsG} />
          </g>
        ))}
      </svg>
    </div>
  );
}

/* RAF / DİKME ŞEMASI: kalınlık kutucuğu yalnız değer girişi açar; üye seçimi yalnız LEVHAYA tıklayınca. */
const SCHEMA_PAD = 34;
function regionMask(boxes: CavityBox[], h: number, v: number) {
  const hsSet = new Set<number>(), vsSet = new Set<number>();
  for (const b of boxes) { hsSet.add(b.min[h]); hsSet.add(b.max[h]); vsSet.add(b.min[v]); vsSet.add(b.max[v]); }
  const hs = Array.from(hsSet).sort((a, b) => a - b), vs = Array.from(vsSet).sort((a, b) => a - b);
  const filled = (i: number, j: number) => {
    const ch = (hs[i] + hs[i + 1]) / 2, cv = (vs[j] + vs[j + 1]) / 2;
    return boxes.some(b => ch > b.min[h] && ch < b.max[h] && cv > b.min[v] && cv < b.max[v]);
  };
  return { hs, vs, filled };
}
type SchemaEdit = { kind: 'gap'; k: number; v: string } | { kind: 't'; i: number; v: string };
const widestRun = (runs: Array<[number, number]>) => runs.reduce((b, x) => (x[1] - x[0] > b[1] - b[0] ? x : b));
const BADGE_LABELS = ['Door ref', 'Back ref'] as const;
const GAP_LOCK_TITLE = {
  locked: 'Locked — fixed on resize and when other gaps are edited. Click: open',
  hold: 'Pinned — keeps its value when other gaps are edited, still scales with the volume on resize. Click: lock',
  open: 'Open — takes up changes from other gaps and scales with the volume on resize. Click: pin',
};

export function GroupSchematic({
  group, selectedIndex, memberLabels, doorRefs, backRefs, onEditGap, onToggleLock, onEditThickness, onSelectMember, onToggleDoorRef, onToggleBackRef,
  onEditBegin, onEditCancel,
}: {
  group: PanelGroup; selectedIndex: number;
  memberLabels: string[];
  doorRefs: boolean[]; backRefs: boolean[];
  /** preview=true → canlı önizleme (yalnız store dağılımı, rebuild yok); yoksa onay (yazım + rebuild). */
  onEditGap: (k: number, v: number, preview?: boolean) => void; onToggleLock: (k: number) => void;
  onEditThickness: (i: number, v: number, preview?: boolean) => void; onSelectMember: (i: number) => void;
  onToggleDoorRef: (i: number) => void; onToggleBackRef: (i: number) => void;
  /** Düzenleme başında kayıt alınır; Esc → kayıt geri yüklenir. */
  onEditBegin?: () => unknown; onEditCancel?: (snap: unknown) => void;
}) {
  const [wrapRef, width] = useElementWidth();
  // Canlı önizleme: her tuşta önizleme yazılır; Esc kaydı geri yükler ve blur onayını iptal eder.
  const ed = useEditSession<SchemaEdit>(onEditBegin, onEditCancel);
  const { editing, setEditing } = ed;
  const apply = (e: SchemaEdit, v: number, preview?: boolean) => {
    if (e.kind === 'gap') { if (v >= 0) { onEditGap(e.k, v, preview); return true; } } else if (v > 0) { onEditThickness(e.i, v, preview); return true; }
    return false;
  };
  useEffect(() => { setEditing(null); }, [group.id, group.count, selectedIndex >= 0]);

  const { cavity, gaps, axis } = group;
  const passiveIdx = passiveGapIndex(gaps, gaps.length);   // tek açık boşluk → pasif (kalanı toplar)
  const gsid = svgId('gs', group.id);
  const ts = memberThicknessesOf(group);
  const barsHorizontal = axis === 1;
  const height = PREVIEW_HEIGHT;
  // Sayım yönü: facing>0 → hacmin MİN tarafından, facing<0 → MAX tarafından.
  const facing = groupFacing(group);
  const stackOrigin = facing > 0 ? cavity.min[axis] : cavity.max[axis];
  const starts = panelStarts(cavity, axis, facing, gaps, ts);

  // Bölge silueti: iki aday görünüşten ŞEKLİ gösteren seçilir (ikisi de dikdörtgense ön görünüş); levha/pill maskeye kırpılır.
  const region = group.region && group.region.length ? group.region : [cavity];
  const view = useMemo(() => {
    const views: Array<[number, number]> = barsHorizontal ? [[0, 1], [2, 1]] : [[axis, 1], [axis, axis === 0 ? 2 : 0]];
    const cands = views.map(([h, v]) => {
      const m = regionMask(region, h, v); const loops = traceMaskLoops(m.hs, m.vs, m.filled);
      return { h, v, m, loops, shaped: loops.length > 1 || loops.some(l => l.length > 4) };
    });
    return cands[0].shaped || !cands[1].shaped ? cands[0] : cands[1];
  }, [region, barsHorizontal]);
  const { h: hAxis, v: vAxis, m: mask, loops } = view;
  // Temsili kare çizim: dizilim ekseninde dünya → px parça-doğrusal, böylece L/U siluet de aynı haritayla çizilir.
  const innerW = width - 2 * SCHEMA_PAD, innerH = height - 2 * SCHEMA_PAD;
  const S = Math.max(40, Math.min(innerW, innerH));
  const ox = SCHEMA_PAD + (innerW - S) / 2, oy = SCHEMA_PAD + (innerH - S) / 2;
  const crossAxis = barsHorizontal ? hAxis : vAxis;
  const nBars = starts.length;
  const barPx = Math.max(3, Math.min(7, S / Math.max(1, (nBars + 1) * 4)));
  const tMin = ts.length ? Math.max(1, Math.min(...ts)) : 1;
  const barPxOf = (i: number) => Math.min(barPx * 3, barPx * ((ts[i] ?? tMin) / tMin));
  const barPxSum = starts.reduce((a, _, i) => a + barPxOf(i), 0);
  // Kırılma noktaları stackOrigin'den yürür; facing<0 ise mapStack için dünya-artan sıraya çevrilir.
  const stackMap = useMemo(() => {
    const wb: number[] = [stackOrigin], pb: number[] = [0];
    const gSum = gaps.reduce((a, g) => a + Math.max(0, g.value), 0);
    const avail = Math.max(0, S - barPxSum);
    let w = stackOrigin, p = 0;
    gaps.forEach((g, k) => {
      w += facing * Math.max(0, g.value); p += gSum > 1e-6 ? (Math.max(0, g.value) / gSum) * avail : avail / gaps.length;
      wb.push(w); pb.push(p);
      if (k < nBars) { w += facing * ts[k]; p += barPxOf(k); wb.push(w); pb.push(p); }
    });
    if (facing < 0) { const pEnd = pb[pb.length - 1]; wb.reverse(); pb.reverse(); for (let i = 0; i < pb.length; i++) pb[i] = pEnd - pb[i]; }
    return { wb, pb };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cavity, axis, facing, stackOrigin, gaps, S, nBars, barPx, barPxSum, ts.join('/')]);
  const mapStack = (w: number) => {
    const { wb, pb } = stackMap;
    if (w <= wb[0]) return pb[0];
    for (let i = 1; i < wb.length; i++) {
      if (w <= wb[i]) { const d = wb[i] - wb[i - 1]; return d > 1e-9 ? pb[i - 1] + ((w - wb[i - 1]) / d) * (pb[i] - pb[i - 1]) : pb[i]; }
    }
    return Math.min(S, pb[pb.length - 1]);
  };
  const crossSpan = Math.max(boxSpan(cavity, crossAxis), 1);
  const mapCross = (w: number) => ((w - cavity.min[crossAxis]) / crossSpan) * S;
  const sx = (wh: number) => ox + (hAxis === axis ? mapStack(wh) : mapCross(wh));
  const sy = (wv: number) => oy + S - (vAxis === axis ? mapStack(wv) : mapCross(wv));
  /** Dizilim (stack) ve çapraz (cross) koordinattan ekran noktası. */
  const at = (stack: number, cross: number): Pt => (barsHorizontal ? { x: sx(cross), y: sy(stack) } : { x: sx(stack), y: sy(cross) });
  const silhouettePath = loops.map(l => l.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ') + ' Z').join(' ');
  const runsAt = (a0: number, a1: number): Array<[number, number]> => {
    const stackPl = barsHorizontal ? mask.vs : mask.hs, crossPl = barsHorizontal ? mask.hs : mask.vs;
    const layers: number[] = [];
    for (let j = 0; j < stackPl.length - 1; j++) if (stackPl[j] < a1 - 0.5 && stackPl[j + 1] > a0 + 0.5) layers.push(j);
    const out: Array<[number, number]> = [];
    let run: [number, number] | null = null;
    for (let i = 0; i <= crossPl.length - 1; i++) {
      const on = i < crossPl.length - 1 && layers.length > 0 && layers.every(j => (barsHorizontal ? mask.filled(i, j) : mask.filled(j, i)));
      if (on) { if (!run) run = [crossPl[i], crossPl[i + 1]]; else run[1] = crossPl[i + 1]; }
      else if (run) { out.push(run); run = null; }
    }
    return out;
  };
  /** Levha i'nin ekran kutusu (çapraz aralık r üzerinde). */
  const barBox = (i: number, r: [number, number]) => {
    const st = starts[i], a = at(st, r[0]), b = at(st + ts[i], r[1]);
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  };

  const fs = schemFs(width), fsT = schemFsT(fs), cfsB = chipFs(fsT), asz = arrowSize(width);
  let cursor = stackOrigin;
  const pills = gaps.map((g, k) => {
    const a = cursor, b = cursor + facing * g.value; cursor = b + facing * (ts[k] ?? 0);
    const mid = (a + b) / 2;
    const txt = String(round1(g.value));
    const { pw, ph } = pillSize(txt, fs);
    // L bölgede pill boş kısma düşmesin: en geniş DOLU aralığın ortası.
    const runs = runsAt(mid - 0.5, mid + 0.5);
    const widest = runs.length ? widestRun(runs) : null;
    const crossMid = widest ? (widest[0] + widest[1]) / 2 : (cavity.min[crossAxis] + cavity.max[crossAxis]) / 2;
    let { x: cx, y: cy } = at(mid, crossMid);
    const gapPx = Math.abs(mapStack(b) - mapStack(a));
    if (!barsHorizontal && gapPx < pw + 6) cy += (k % 2 === 0 ? -1 : 1) * (ph * 0.75);
    if (barsHorizontal && gapPx < ph + 6) cx += (k % 2 === 0 ? -1 : 1) * (pw * 0.6);
    return { k, cx, cy, pw, ph, txt, a, b, crossMid };
  });
  // Kalınlık pill'i ve üye numarası levhanın iki ucunda (yatay levhada sağ / sol, düşeyde üst / alt).
  const ends = starts.map((st, i) => {
    const mid = st + ts[i] / 2;
    const txt = String(round1(ts[i])), lbl = memberLabels[i] ?? String(i + 1);
    const t = pillSize(txt, fsT), n = pillSize(lbl, fsT);
    return barsHorizontal
      ? { i, txt, lbl, ...t, cx: Math.min(ox + S + 6 + t.pw / 2, width - t.pw / 2 - 2), cy: sy(mid), nx: Math.max(ox - 6 - n.pw / 2, n.pw / 2 + 2), ny: sy(mid) }
      : { i, txt, lbl, ...t, cx: sx(mid), cy: Math.max(oy - 6 - t.ph / 2, t.ph / 2 + 2), nx: sx(mid), ny: Math.min(oy + S + 6 + n.ph / 2, height - n.ph / 2 - 2) };
  });

  const commit = () => {
    if (!editing || ed.wasCancelled()) return;   // Esc sonrası blur: onay yok
    const v = parseNum(editing.v);
    setEditing(null);
    if (isNaN(v) || !apply(editing, v)) ed.revert();
  };
  const HIT = 5;
  const bar = (key: string, i: number, b: { x0: number; y0: number; x1: number; y1: number }) => {
    const on = i === selectedIndex;
    const tip = `Panel ${memberLabels[i] ?? i + 1} · ${round1(ts[i])} mm — click to select`;
    return (
      <g key={key} style={{ cursor: 'pointer' }} onClick={e => { stop(e); onSelectMember(i); }}>
        <rect x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} rx={1.5} fill={on ? `url(#${gsid}-on)` : `url(#${gsid}-part)`}
          stroke={on ? SOFT.onStroke : SOFT.partStroke} strokeWidth={on ? 1.1 : 0.8} style={{ filter: SOFT.shadow }} />
        <rect x={b.x0 - HIT} y={b.y0 - HIT} width={b.x1 - b.x0 + 2 * HIT} height={b.y1 - b.y0 + 2 * HIT} fill="transparent"><title>{tip}</title></rect>
      </g>
    );
  };
  /* Levha rozetleri (kapak sınırı · arkalık sınırı) — YAZILI rozet (Goker): arkalık/kapak şemasındaki bant rozetleriyle aynı dil
     (beyaz = kapalı, koyu taş = açık). Levhanın UZUNLUĞU boyunca, levha yönünde dizilir → üye sayısı artsa da çakışmaz. */
  const barBadges = (i: number, b: { x0: number; y0: number; x1: number; y1: number }) => {
    const lbl = memberLabels[i] ?? String(i + 1);
    // Rozet uzunluğu (levha yönünde) = pill genişliği; ilki levhanın ucundan 6 px içeride, aralarında 5 px.
    const ws = BADGE_LABELS.map(t => pillSize(t, cfsB).pw);
    const along = (k: number) => 6 + ws.slice(0, k).reduce((a, w) => a + w + 5, 0) + ws[k] / 2;
    const spot = (k: number): [number, number] => (barsHorizontal ? [b.x1 - along(k), (b.y0 + b.y1) / 2] : [(b.x0 + b.x1) / 2, b.y0 + along(k)]);
    const badge = (k: 0 | 1, on: boolean, tip: string, onClick: () => void) => {
      const [cx, cy] = spot(k);
      return (
        <g key={`${k ? 'back' : 'door'}-${i}`} style={{ cursor: 'pointer' }} onClick={e => { stop(e); onClick(); }}>
          <Chip cx={cx} cy={cy} txt={BADGE_LABELS[k]} fs={cfsB} tone={on ? CHIP.on : CHIP.base} rot={barsHorizontal ? 0 : -90} />
          <title>{tip}</title>
        </g>
      );
    };
    return (
      <g key={`badges-${i}`}>
        {badge(0, !!doorRefs[i], doorRefs[i]
          ? `Panel ${lbl}: door reference ON — doors are built from this panel's edges. Click to remove`
          : `Panel ${lbl}: mark as door reference (doors are built from this panel's edges)`, () => onToggleDoorRef(i))}
        {badge(1, !!backRefs[i], backRefs[i]
          ? `Panel ${lbl}: back panel reference ON — click to remove`
          : `Panel ${lbl}: mark as back panel reference (the back panel ends at / splits at this panel)`, () => onToggleBackRef(i))}
      </g>
    );
  };
  // Sayım yönü oku: dizilimin başladığı köşede kırmızı ok.
  const facingArrow = (() => {
    const len = 18, m = 9, horiz = hAxis === axis;
    const x0 = horiz ? (facing > 0 ? ox + m : ox + S - m) : ox + m;
    const y0 = horiz ? oy + m : (facing > 0 ? oy + S - m : oy + m);
    const x1 = horiz ? x0 + facing * len : x0, y1 = horiz ? y0 : y0 - facing * len;
    const ang = Math.atan2(y1 - y0, x1 - x0), arm = 6.5, f = (n: number) => n.toFixed(1);
    const ax = (k: number) => f(x1 - arm * Math.cos(ang + k * Math.PI / 4)), ay = (k: number) => f(y1 - arm * Math.sin(ang + k * Math.PI / 4));
    return `M${f(x0)},${f(y0)} L${f(x1)},${f(y1)} M${ax(1)},${ay(1)} L${f(x1)},${f(y1)} L${ax(-1)},${ay(-1)}`;
  })();
  const editPill = editing ? (editing.kind === 'gap' ? pills[editing.k] : ends[editing.i]) : undefined;

  return (
    <div ref={wrapRef} className={PREVIEW_FRAME} style={{ background: PREVIEW_BG, height }}>
      <style>{SCHEMATIC_CSS}</style>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', fontFamily: UI_FONT }}>
        <SoftDefs id={gsid} />
        <path d={silhouettePath} fill={SOFT.area} stroke={SOFT.areaStroke} strokeWidth={1} strokeLinejoin="round" fillRule="evenodd" />
        <g style={{ pointerEvents: 'none' }} opacity={0.95}>
          <path d={facingArrow} fill="none" stroke="#dc2626" strokeWidth={2.4} strokeLinecap="butt" strokeLinejoin="miter" />
          <title>Gaps and members are counted from this side</title>
        </g>
        {starts.map((st, i) => runsAt(st, st + ts[i]).map((r, ri) => bar(`bar-${i}-${ri}`, i, barBox(i, r))))}
        {starts.map((st, i) => {
          const runs = runsAt(st, st + ts[i]);
          return runs.length ? barBadges(i, barBox(i, widestRun(runs))) : null;
        })}
        {ends.map(p => {
          const on = p.i === selectedIndex;
          return (
            <DimPill key={`t-${p.i}`} cx={p.cx} cy={p.cy} txt={p.txt} fs={fsT} fill={on ? '#fff7ed' : '#f5f2ec'} stroke={on ? '#f97316' : SOFT.pillStroke}
              strokeWidth={on ? 1 : 0.7} color={on ? '#c2410c' : '#57534e'} hideText={editing?.kind === 't' && editing.i === p.i}
              title={`Panel ${memberLabels[p.i] ?? p.i + 1} thickness — click to edit`}
              onClick={e => { stop(e); ed.begin({ kind: 't', i: p.i, v: p.txt }); }} />
          );
        })}
        {ends.map(n => {
          const on = n.i === selectedIndex;
          return (
            <text key={`n-${n.i}`} x={n.nx} y={n.ny + fsT * 0.36} textAnchor="middle" fontSize={fsT} fontWeight={on ? 700 : 600} fill={on ? '#ea580c' : SOFT.label}
              fontFamily={UI_FONT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', userSelect: 'none' }}>{n.lbl}</text>
          );
        })}
        {pills.map(p => {
          const mode = gapMode(gaps[p.k]);
          const a = at(p.a, p.crossMid), b = at(p.b, p.crossMid);
          if (passiveIdx === p.k) return (
            <g key={`gap-${p.k}`} className="yago-gap passive" style={{ cursor: 'not-allowed' }}>
              <DimArrows a={a} b={b} asz={asz} color={DIM_LINE} />
              <PassivePill cx={p.cx} cy={p.cy} txt={p.txt} fs={fs} title="Gap — remainder (all other gaps pinned or locked); open one to edit" />
            </g>
          );
          const locked = mode === 'locked', edited = mode === 'hold';
          return (
            <g key={`gap-${p.k}`} className={`yago-gap${locked ? ' locked' : ''}`}>
              <DimArrows a={a} b={b} asz={asz} color={locked ? '#f59e0b' : DIM_LINE} />
              <DimPill cx={p.cx} cy={p.cy} txt={p.txt} fs={fs} fill={locked || edited ? '#fff7ed' : '#ffffff'}
                stroke={locked ? '#f97316' : edited ? '#fbbf24' : SOFT.pillStroke} strokeWidth={locked || edited ? 1 : 0.7}
                color={locked ? '#c2410c' : edited ? '#9a3412' : '#44403c'} hideText={editing?.kind === 'gap' && editing.k === p.k}
                title={edited ? 'Pinned gap — click to edit (open gaps take up the difference)' : 'Edit gap (open gaps take up the difference)'}
                onClick={e => { stop(e); ed.begin({ kind: 'gap', k: p.k, v: p.txt }); }} />
              <LockBadge cx={p.cx + p.pw / 2 + LOCK_OFF} cy={p.cy} locked={locked} edited={edited} onClick={() => onToggleLock(p.k)}
                title={GAP_LOCK_TITLE[locked ? 'locked' : edited ? 'hold' : 'open']} holdIcon />
            </g>
          );
        })}
      </svg>
      {editing && editPill && (
        <PillEditInput at={editPill} fs={editing.kind === 'gap' ? fs : fsT} value={editing.v} onCommit={commit} onCancel={ed.cancel}
          onChange={raw => {
            const next = { ...editing, v: raw } as SchemaEdit; setEditing(next);
            const v = parseNum(raw); if (!isNaN(v)) apply(next, v, true);
          }} />
      )}
    </div>
  );
}
