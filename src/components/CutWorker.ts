/* KESİM İŞÇİSİ + PAYLAŞILAN OCC ÇEKİRDEĞİ
   Panel deliklerini (bağlayıcı + ayak delikleri, pocket / line) ana iş parçacığının DIŞINDA keser: OCC boolean'ı eşzamanlıdır, ana
   iş parçacığında 100–200 ms'lik bir kesim o sürece hiçbir kare çizdirmez (panel giriş animasyonu takılır). İşçi ikinci bir OCC örneği
   yükler (ilk kez ~5 sn, arka planda); hazır olana dek kesim ana iş parçacığında yapılır (eski yol).
   Dosya iki yerde çalışır:
   · ANA İŞ PARÇACIĞI — çekirdek işlevleri (Geometry ve PanelEngine kullanır) + işçi istemcisi (`cutInWorker`).
   · İŞÇİ — dosyanın sonundaki önyükleme (yalnız işçi kapsamında çalışır).
   Çekirdek store'a / pencereye dokunmaz; OCC örneği parametre olarak gelir. Katı, iş parçacıkları arasında BinTools ikili biçimiyle taşınır. */
import * as THREE from 'three';
import initOpenCascade from 'opencascade.js';
import { Plane, cast, draw, makeCylinder, setOC } from 'replicad';

export type V3 = [number, number, number];
/** OCC (opencascade.js) örneği ve replicad katısı tipsizdir (paket tipleri bu sürümde kullanılmıyor): tek yerde adlandırılır. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Occ = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OccShape = any;
/** Kesici tarifi — iş parçacıkları arasında taşınabilir düz veri (kapanış yok). `unit` = birim araç (ConnectorService.ConnUnitCut):
 *  kanonik parçalar bir kez birleştirilir (`key` ile saklanır), `m` (3 × 4, satır satır) ile yerleştirilir; kurulamazsa `fallback` tek tek. */
export type ToolSpec =
  | { k: 'box'; min: V3; max: V3 }
  | { k: 'cyl'; start: V3; dir: V3; r: number; len: number }
  | { k: 'prism'; pts: V3[]; nOut: V3; lift: number; len: number }
  | { k: 'ring'; start: V3; dir: V3; rOut: number; rIn: number; len: number }
  | { k: 'unit'; key: string; m: number[]; parts: ToolSpec[]; fallback: ToolSpec[] };
export type CutBox = { min: V3; max: V3 };

/** B-Rep yüz bilgisi: her üçgenin ait olduğu gerçek yüzey (`tri`) ve düz / eğri (`curved`). Mesh açısı sezgisi teğet geçişte
 *  (düz → radüs → düz) üçünü tek yüz sayıyordu. Dikişle bölünmüş silindir parçaları tek kimlik alır (`surfaceKeyOf`). */
export interface BrepTriInfo { tri: Int32Array; curved: Uint8Array; keys: string[]; /** köşe başına GERÇEK yüzey normali (OCC) — eğri yüzde fasetanınki değil */ normals?: Float32Array }

// ───────── B-Rep yüz eşlemesi ─────────
/** Eğri yüzeyin kimliği: silindirde eksen + yarıçap (dikişle / kesimle ikiye bölünen aynı silindir tek yüz sayılır); ötekilerde yüzün kendisi. */
export function surfaceKeyOf(oc: Occ, face: OccShape, type: string, index: number): string {
  if (type !== 'CYLINDRE') return `f${index}`;
  let ad: OccShape = null;
  try {
    ad = new oc.BRepAdaptor_Surface_2(face.wrapped, true);
    const cyl = ad.Cylinder(), ax = cyl.Axis(), loc = ax.Location(), dir = ax.Direction(), r = cyl.Radius();
    let d = new THREE.Vector3(dir.X(), dir.Y(), dir.Z());
    const o = new THREE.Vector3(loc.X(), loc.Y(), loc.Z());
    // Eksen yönü işaretsiz, eksen noktası eksen üzerinde orijine en yakın nokta → aynı silindir aynı anahtarı verir.
    if (d.x < -1e-6 || (Math.abs(d.x) <= 1e-6 && (d.y < -1e-6 || (Math.abs(d.y) <= 1e-6 && d.z < 0)))) d = d.negate();
    o.addScaledVector(d, -o.dot(d));
    const q = (x: number) => (Math.round(x * 100) / 100 || 0).toFixed(2);
    return `c${q(r)}|${q(d.x)},${q(d.y)},${q(d.z)}|${q(o.x)},${q(o.y)},${q(o.z)}`;
  } catch { return `f${index}`; }
  finally { try { ad?.delete(); } catch { /* sarmalayıcı zaten bırakılmış */ } }
}
export function brepTriInfo(oc: Occ, shape: OccShape, mesh: { triangles: ArrayLike<number>; vertices: ArrayLike<number>; normals?: ArrayLike<number>; faceGroups?: Array<{ start: number; count: number; faceId: number }> }): BrepTriInfo | null {
  const fg = mesh.faceGroups;
  if (!fg?.length) return null;
  try {
    const tri = new Int32Array(Math.floor(mesh.triangles.length / 3)).fill(-1);
    const curved: number[] = [], keys: string[] = [], keyId = new Map<string, number>();
    let k = 0, fi = 0;
    for (const face of shape.faces as OccShape[]) {
      fi++;
      if (k >= fg.length) break;
      if (face.hashCode !== fg[k].faceId) continue;   // üçgenlenmemiş yüz mesh'te yok
      const type = String(face.geomType);
      const key = type === 'PLANE' ? `p${fi}` : surfaceKeyOf(oc, face, type, fi);
      let id = keyId.get(key);
      if (id === undefined) { id = curved.length; keyId.set(key, id); curved.push(type === 'PLANE' ? 0 : 1); keys.push(key); }
      const t0 = fg[k].start / 3, t1 = t0 + fg[k].count / 3;
      for (let t = t0; t < t1; t++) tri[t] = id;
      k++;
    }
    if (k !== fg.length || tri.includes(-1)) return null;
    const hasNormals = !!mesh.normals && mesh.normals.length === mesh.vertices.length;
    // Teğet sürekli serbest eğri yüzler (elips / spline dilimleri) ortak köşelerde normaller aynıysa tek yüz olur ("fA+fB");
    // silindirler yalnız aynı eksen + yarıçapla birleşir.
    const free = curved.map((c, id) => !!c && keys[id].startsWith('f'));
    if (hasNormals && free.filter(Boolean).length > 1) {
      const root = curved.map((_, i) => i);
      const find = (x: number): number => { while (root[x] !== x) { root[x] = root[root[x]]; x = root[x]; } return x; };
      const V = mesh.vertices, Nn = mesh.normals!, T = mesh.triangles;
      const at = new Map<string, Array<{ id: number; v: number }>>();
      const seen = new Set<number>();
      for (let t = 0; t < tri.length; t++) {
        const id = tri[t];
        if (!free[id]) continue;
        for (let c = 0; c < 3; c++) {
          const v = T[t * 3 + c];
          if (seen.has(v)) continue;
          seen.add(v);
          const kk = `${Math.round(V[v * 3] * 100)},${Math.round(V[v * 3 + 1] * 100)},${Math.round(V[v * 3 + 2] * 100)}`;
          const l = at.get(kk);
          if (l) l.push({ id, v }); else at.set(kk, [{ id, v }]);
        }
      }
      const smooth = new Map<string, number>();
      for (const l of at.values()) for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
        const a = l[i], b = l[j];
        if (a.id === b.id) continue;
        const dot = Nn[a.v * 3] * Nn[b.v * 3] + Nn[a.v * 3 + 1] * Nn[b.v * 3 + 1] + Nn[a.v * 3 + 2] * Nn[b.v * 3 + 2];
        if (Math.abs(dot) < 0.9995) continue;
        const pk = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        smooth.set(pk, (smooth.get(pk) ?? 0) + 1);
      }
      for (const [pk, cnt] of smooth) {
        if (cnt < 2) continue;
        const [a, b] = pk.split('|').map(Number), ra = find(a), rb = find(b);
        if (ra !== rb) { root[Math.max(ra, rb)] = Math.min(ra, rb); }
      }
      if (root.some((r, i) => r !== i)) {
        const members = new Map<number, number[]>();
        root.forEach((_, i) => { const r = find(i); (members.get(r) ?? members.set(r, []).get(r)!).push(i); });
        for (const [r, list] of members) if (list.length > 1) keys[r] = list.map(i => keys[i]).join('+');
        for (let t = 0; t < tri.length; t++) tri[t] = find(tri[t]);
      }
    }
    const normals = curved.some(Boolean) && hasNormals ? Float32Array.from(mesh.normals!) : undefined;
    return { tri, curved: Uint8Array.from(curved), keys, normals };
  } catch { return null; }
}


// ───────── Mesh: OCC → düz veri → three ─────────
/** Görüntü ağı (düz veri): ana iş parçacığında da işçide de aynı tessellation + B-Rep yüz eşlemesi. */
export interface MeshData { vertices: Float32Array; triangles: Uint32Array; brep: BrepTriInfo | null }
export function meshDataOf(oc: Occ, shape: OccShape): MeshData {
  const mesh = shape.mesh({ tolerance: 0.1, angularTolerance: 30 });
  if (!mesh.vertices || !mesh.triangles) throw new Error('Invalid mesh data');
  return { vertices: Float32Array.from(mesh.vertices as ArrayLike<number>), triangles: Uint32Array.from(mesh.triangles as ArrayLike<number>), brep: brepTriInfo(oc, shape, mesh) };
}
export function geometryFromMeshData(d: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(d.vertices, 3));
  // İndeks türü three'nin dizi kuralıyla aynı (en büyük indeks 65535'i aşarsa 32 bit).
  let max = 0;
  for (let i = 0; i < d.triangles.length; i++) if (d.triangles[i] > max) max = d.triangles[i];
  geometry.setIndex(new THREE.BufferAttribute(max >= 65535 ? d.triangles : Uint16Array.from(d.triangles), 1));
  // Üçgen → gerçek (B-Rep) yüzey eşlemesi: yüz gruplaması eğri / düz ayrımını buradan okur (getFacesAndGroups).
  if (d.brep) geometry.userData.brep = d.brep;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// ───────── Katı ↔ bayt (BinTools, emscripten bellek dosyası) ─────────
let _fsSeq = 0;
export function shapeToBytes(oc: Occ, shape: OccShape): Uint8Array {
  const f = `/yago-shape-${++_fsSeq}.bin`, pr = new oc.Message_ProgressRange_1();
  try {
    if (!oc.BinTools.Write_3(shape.wrapped, f, pr)) throw new Error('shape write failed');
    return oc.FS.readFile(f) as Uint8Array;
  } finally { pr.delete(); try { oc.FS.unlink(f); } catch { /* dosya yazılmadı */ } }
}
export function shapeFromBytes(oc: Occ, bytes: Uint8Array): OccShape {
  const f = `/yago-shape-${++_fsSeq}.bin`, pr = new oc.Message_ProgressRange_1(), sh = new oc.TopoDS_Shape();
  try {
    oc.FS.writeFile(f, bytes);
    if (!oc.BinTools.Read_2(sh, f, pr) || sh.IsNull()) throw new Error('shape read failed');
    return cast(sh);
  } finally { pr.delete(); try { oc.FS.unlink(f); } catch { /* dosya yazılmadı */ } }
}

// ───────── Kesiciler ─────────
/** Çokgen prizma kesici: düzlemsel kapalı çokgen (`pts`, gövde-yerel), yüzeyin DIŞ normali `nOut`; çokgen `lift` kadar dışarıdan başlar,
 *  malzemeye doğru `len` kadar iner. Ardışık aynı noktalar atılır; 3'ten az köşe → null. */
export function prismTool(pts: V3[], nOut: V3, lift: number, len: number): OccShape {
  const n = new THREE.Vector3(...nOut).normalize(), P = pts.map(p => new THREE.Vector3(...p));
  const clean = P.filter((p, i) => p.distanceTo(P[(i + P.length - 1) % P.length]) > 1e-4);
  if (clean.length < 3) return null;
  const o = clean[0].clone().addScaledVector(n, lift);
  const u = clean[1].clone().sub(clean[0]).projectOnPlane(n).normalize(), v = new THREE.Vector3().crossVectors(n, u);
  const uv = clean.map(p => { const d = p.clone().sub(clean[0]); return [d.dot(u), d.dot(v)] as [number, number]; });
  let pen = draw(uv[0]);
  for (let i = 1; i < uv.length; i++) pen = pen.lineTo(uv[i]);
  return pen.close().sketchOnPlane(new Plane([o.x, o.y, o.z], [u.x, u.y, u.z], [n.x, n.y, n.z])).extrude(-(len + lift));
}
const boxTool = (min: V3, max: V3): OccShape =>
  draw().movePointerTo([0, 0]).lineTo([max[0] - min[0], 0]).lineTo([max[0] - min[0], max[1] - min[1]]).lineTo([0, max[1] - min[1]]).close()
    .sketchOnPlane().extrude(max[2] - min[2]).translate(min[0], min[1], min[2]);
/** Çok araçlı tek boolean: base − (tüm araçlar) tek BRepAlgoAPI_Cut (SetTools). `simplify` = eş-düzlem yüzleri birleştir. 3B katı değilse fırlatır. */
export function cutShape(oc: Occ, base: OccShape, tools: Array<{ wrapped: unknown }>, simplify = false, fuzzy = 0): OccShape {
  if (!tools.length) return base;
  const args = new oc.TopTools_ListOfShape_1(); args.Append_1(base.wrapped);
  const list = new oc.TopTools_ListOfShape_1(); for (const t of tools) list.Append_1(t.wrapped);
  const op = new oc.BRepAlgoAPI_Cut_1();
  const progress = new oc.Message_ProgressRange_1();
  try {
    op.SetArguments(args); op.SetTools(list);
    op.SetCheckInverted(false);   // girdiler düzgün katılar; ters katı denetimi atlanır (~%10)
    if (fuzzy > 0) op.SetFuzzyValue(fuzzy);
    op.Build(progress);
    if (simplify) op.SimplifyResult(true, true, 1e-3);
    if (op.HasErrors()) throw new Error('boolean cut failed');
    const out = cast(op.Shape());
    if (!(out as OccShape).wrapped || typeof (out as OccShape).cut !== 'function') throw new Error('cut result is not a 3D shape');
    return out;
  } finally { args.delete(); list.delete(); op.delete(); progress.delete(); }
}
/** Araçları TEK katıda birleştirir (tek BRepAlgoAPI_Fuse; birbirine değmeyenler bileşik olarak kalır). Tek araç aynen döner. */
export function fuseShapes(oc: Occ, tools: Array<{ wrapped: unknown }>): { wrapped: unknown } {
  if (tools.length < 2) return tools[0];
  const args = new oc.TopTools_ListOfShape_1(); args.Append_1(tools[0].wrapped);
  const list = new oc.TopTools_ListOfShape_1(); for (const t of tools.slice(1)) list.Append_1(t.wrapped);
  const op = new oc.BRepAlgoAPI_Fuse_1();
  const progress = new oc.Message_ProgressRange_1();
  try {
    op.SetArguments(args); op.SetTools(list);
    op.Build(progress);
    if (op.HasErrors()) throw new Error('tool fuse failed');
    const w = op.Shape();
    if (!w || w.IsNull()) throw new Error('tool fuse is empty');
    return { wrapped: w };
  } finally { args.delete(); list.delete(); op.delete(); progress.delete(); }
}
/** Katının katı dönüşümle (3 × 4, satır satır) yerleştirilmiş DERİN kopyası — saklanan araca boolean dokunmaz (bkz. Geometry.deepCopyShape). */
export function placeShapeBy(oc: Occ, shape: { wrapped: unknown }, m: number[]): { wrapped: unknown } {
  const t = new oc.gp_Trsf_1();
  t.SetValues(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11]);
  const tr = new oc.BRepBuilderAPI_Transform_2(shape.wrapped, t, true);
  try { return { wrapped: tr.Shape() }; }
  finally { tr.delete(); t.delete(); }
}
/** Birim araç önbelleği (anahtar = kanonik geometri): her iş parçacığının kendi önbelleği vardır. null = kurulamadı. */
export type UnitCache = Map<string, { wrapped: unknown } | null>;
/** Tariften OCC aracı. Kurulamazsa null (çağıran atlar ya da birimde yedeğe düşer). */
export function buildTool(oc: Occ, spec: ToolSpec, units: UnitCache): Array<{ wrapped: unknown }> {
  try {
    switch (spec.k) {
      case 'box': return [boxTool(spec.min, spec.max)];
      case 'cyl': return [makeCylinder(spec.r, spec.len, spec.start, spec.dir)];
      case 'prism': { const t = prismTool(spec.pts, spec.nOut, spec.lift, spec.len); return t ? [t] : []; }
      case 'ring': {
        const outer = makeCylinder(spec.rOut, spec.len, spec.start, spec.dir);
        return [spec.rIn > 0.05 ? outer.cut(makeCylinder(spec.rIn, spec.len, spec.start, spec.dir)) : outer];
      }
      case 'unit': {
        let base = units.get(spec.key);
        if (base === undefined) {
          base = null;
          try {
            const parts = spec.parts.flatMap(p => buildTool(oc, p, units));
            if (parts.length) base = fuseShapes(oc, parts);
          } catch (err) { console.warn('[YAGO][BAĞLAYICI] birim araç kurulamadı, parçalar tek tek kesilecek:', (err as Error)?.message ?? err); }
          if (units.size > 96) units.delete(units.keys().next().value as string);
          units.set(spec.key, base);
        }
        if (base) { try { return [placeShapeBy(oc, base, spec.m)]; } catch { /* yedeğe düş */ } }
        return spec.fallback.flatMap(p => buildTool(oc, p, units));
      }
    }
  } catch { /* bozuk kesici atlanır */ }
  return [];
}
/** Katıyı tariflerle keser: tek boolean; sonuç kutusu panelin kutusundan (`pb`) sapıyorsa / hata verirse ardışık kesime düşer. Hiçbiri
 *  kesilemezse null. */
export function cutBySpecs(oc: Occ, rp: OccShape, specs: ToolSpec[], pb: CutBox, simplify: boolean, units: UnitCache): OccShape | null {
  const tools = specs.flatMap(s => buildTool(oc, s, units));
  if (!tools.length) return null;
  const sane = (s: OccShape): boolean => {
    try {
      const b = s.boundingBox.bounds as [number[], number[]];
      return [0, 1, 2].every(a => Math.abs(b[0][a] - pb.min[a]) < 1 && Math.abs(b[1][a] - pb.max[a]) < 1);
    } catch { return false; }
  };
  try {
    const cut = cutShape(oc, rp, tools, simplify);
    if (sane(cut)) return cut;
    console.error('[YAGO][MOTOR] çok araçlı kesim kutuyu bozdu, ardışık kesime dönülüyor');
  } catch (err) { console.error('[YAGO][MOTOR] çok araçlı kesim hatası, ardışık kesime dönülüyor:', (err as Error)?.message ?? err); }
  let cut = rp, n = 0;
  for (const t of tools) { try { const c = cut.cut(t); if (sane(c)) { cut = c; n++; } } catch { /* kesilemeyen araç atlanır */ } }
  return n ? cut : null;
}

// ───────── İşçi iletisi ─────────
export interface CutJob { id: number; base: Uint8Array; specs: ToolSpec[]; pb: CutBox; simplify: boolean }
export type CutReply =
  | { type: 'ready'; ms: number }
  | { type: 'failed'; msg: string }
  | { type: 'done'; id: number; ok: true; bytes: Uint8Array; mesh: MeshData; ms: number }
  | { type: 'done'; id: number; ok: false; msg: string; ms: number };

// ───────── İstemci (ana iş parçacığı) ─────────
/* Tek işçi, tek iş: OCC işçide de eşzamanlıdır. Kuyruk ana iş parçacığında tutulur → aynı panelin bekleyen eski işi gönderilmeden düşürülür. */
type Waiter = { job: CutJob; key: string; resolve: (r: CutReply) => void };
let _worker: Worker | null = null, _ready = false, _broken = false, _busy: Waiter | null = null;
const _queue: Waiter[] = [];
let _seq = 0;
/** İşçi kullanılabilir mi (OCC yüklendi, çökmedi). Hazır değilken kesim ana iş parçacığında yapılır. */
export const cutWorkerReady = (): boolean => _ready && !_broken;
/** İşçiyi başlatır (bir kez). Ana OCC yüklendikten sonra boşta çağrılır: iki 50 MB'lık derleme aynı anda yarışmasın. */
export function startCutWorker(): void {
  if (_worker || _broken || typeof Worker === 'undefined') return;
  try {
    _worker = new Worker(new URL('./CutWorker.ts', import.meta.url), { type: 'module' });
  } catch (err) { _broken = true; console.warn('[YAGO][KESİM] işçi başlatılamadı, kesim ana iş parçacığında:', (err as Error)?.message ?? err); return; }
  _worker.onmessage = (e: MessageEvent<CutReply>) => {
    const r = e.data;
    if (r.type === 'ready') { _ready = true; pump(); return; }
    if (r.type === 'failed') { fail(r.msg); return; }
    const w = _busy; _busy = null;
    if (w && w.job.id === r.id) w.resolve(r);
    pump();
  };
  _worker.onerror = e => fail(e.message || 'worker error');
}
function fail(msg: string): void {
  if (_broken) return;
  _broken = true; _ready = false;
  console.warn('[YAGO][KESİM] işçi kullanılamıyor, kesim ana iş parçacığında:', msg);
  try { _worker?.terminate(); } catch { /* zaten kapalı */ }
  const all = [...(_busy ? [_busy] : []), ..._queue.splice(0)];
  _busy = null;
  for (const w of all) w.resolve({ type: 'done', id: w.job.id, ok: false, msg: 'worker unavailable', ms: 0 });
}
function pump(): void {
  if (!_ready || _busy || !_worker) return;
  const w = _queue.shift(); if (!w) return;
  _busy = w;
  _worker.postMessage(w.job, [w.job.base.buffer]);
}
/** Kesim işini işçiye verir. `key` (panel kimliği) aynı olan, henüz gönderilmemiş eski iş düşürülür (yanıtı ok: false, msg 'superseded'). */
export function cutInWorker(key: string, base: Uint8Array, specs: ToolSpec[], pb: CutBox, simplify: boolean): Promise<CutReply> {
  return new Promise(resolve => {
    for (let i = _queue.length - 1; i >= 0; i--) {
      if (_queue[i].key !== key) continue;
      const [old] = _queue.splice(i, 1);
      old.resolve({ type: 'done', id: old.job.id, ok: false, msg: 'superseded', ms: 0 });
    }
    _queue.push({ job: { id: ++_seq, base, specs, pb, simplify }, key, resolve });
    pump();
  });
}
/** İşçide bekleyen + süren iş sayısı. */
export const cutWorkerLoad = (): number => _queue.length + (_busy ? 1 : 0);

// ───────── İşçi önyüklemesi (yalnız işçi kapsamında) ─────────
const workerScope = (globalThis as { WorkerGlobalScope?: abstract new () => unknown }).WorkerGlobalScope;
const IN_WORKER = typeof self !== 'undefined' && !!workerScope && self instanceof workerScope;
if (IN_WORKER) {
  const scope = self as unknown as { postMessage: (m: CutReply, t?: Transferable[]) => void; onmessage: ((e: MessageEvent<CutJob>) => void) | null };
  const units: UnitCache = new Map();
  let oc: Occ = null;
  const t0 = performance.now();
  initOpenCascade()
    .then((o: Occ) => { oc = o; setOC(o); scope.postMessage({ type: 'ready', ms: performance.now() - t0 }); })
    .catch((err: unknown) => scope.postMessage({ type: 'failed', msg: String((err as Error)?.message ?? err) }));
  scope.onmessage = (e: MessageEvent<CutJob>) => {
    const job = e.data, t = performance.now();
    try {
      const base = shapeFromBytes(oc, job.base);
      const cut = cutBySpecs(oc, base, job.specs, job.pb, job.simplify, units);
      if (!cut) throw new Error('nothing was cut');
      const mesh = meshDataOf(oc, cut), bytes = shapeToBytes(oc, cut);
      const transfer: Transferable[] = [bytes.buffer, mesh.vertices.buffer, mesh.triangles.buffer];
      if (mesh.brep) { transfer.push(mesh.brep.tri.buffer, mesh.brep.curved.buffer); if (mesh.brep.normals) transfer.push(mesh.brep.normals.buffer); }
      try { base.delete?.(); cut.delete?.(); } catch { /* bırakılmış */ }
      scope.postMessage({ type: 'done', id: job.id, ok: true, bytes, mesh, ms: performance.now() - t }, transfer);
    } catch (err) {
      scope.postMessage({ type: 'done', id: job.id, ok: false, msg: String((err as Error)?.message ?? err), ms: performance.now() - t });
    }
  };
}
