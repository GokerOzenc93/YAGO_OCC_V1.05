/* AKSESUAR KÜTÜPHANESİ (Goker, Eki 2026 — "Panel editör yanında Aksesuar sekmesi; ilk seçenek ayak. Ayak için dışarıdan model alayım,
   alabildiğimiz tüm uzantıları destekleyelim; ayaklar 3 parça, yalnız orta parça uzasın, uzayacak parçayı eklerden seçip rol vereyim;
   4/5/6 ayak setlerini kaydedip ayak kısmında çağıralım").

   KATMANLAR
   1) Dosya → geometri: Three örnek yükleyicileri (glTF/GLB, OBJ, STL, FBX, DAE, PLY, 3MF, 3DS, AMF, WRL) + STEP (replicad / OpenCascade).
      Sonuç TEK BufferGeometry: birim ölçeği (mm/cm/m/in), yukarı ekseni (Y/Z), XZ'de merkezlenmiş, tabanı y=0'da ("normalize").
      DWG / DXF (Goker, Kas 2026 — "elimdeki aksesuarlar DWG; içeri alırken STL'ye çevirip alalım"): içe aktarırken `public/dwg2stl.wasm`
      ile ikili STL'ye çevrilir ve kütüphaneye STL OLARAK kaydedilir (`convertDwgToStl`; kaynak: dwg2stl/lib.rs). Dönüştürücü yalnız
      içe aktarma anında yüklenir; kayıtlı modeller ona bağlı değildir.
   2) Kalıcılık: IndexedDB `yago-accessories` — `models` (üst bilgi + ham bayt dizisi), `legModels`, `legPresets`. Store'daki kopya canlıdır;
      her yazım IDB'ye de gider. indexedDB yoksa (Node harness) yalnız bellek.
   3) Ayak modeli (LegModel) = 1–3 parça + rol: base (zemin) · stem (UZAR) · top (tabla). `legAssembly(leg, h)` parçaları alt alta dizer;
      stem yüksekliği = h − (diğer parçalar) → set yüksekliği değişince yalnız mil uzar/kısalır (Goker). Stem yoksa hiçbir parça ölçeklenmez.
      Her parça nihai ölçüsünde (`dims`, mm), X/Y/Z taşınır (`offset`); uzayan parçalar (`stretch`; varsayılan orta) boyu paylaşır.
   4) Ayak seti (LegPreset, "kaset"): model + adet + kenar mesafeleri + varsayılan yükseklik. `legsFromPreset` → PlinthLegs (baza seti / hızlı gövde).
   5) KATMANLAR (AccessoryLayer, IDB `layers`): kütüphane geneli liste; her parça bir katmana bağlanır, katman rengi parçayı boyar.
   6) DELİKLER (HoleSpec, LegModel.holes): ayak çerçevesinde silindirik delik tanımı; `legHolesAt` montajdaki yerini, `legHoleCutters`
      gövde-yerel kesici silindirleri (PanelEngine tek boolean ile panelden çıkarır) verir. Delik tanımı GENELDİR — ray / menteşe de
      aynı HoleSpec + HoleCutter yolunu kullanacak (konum: parçaya bağlı, aksesuar sıfırına göre gösterilir).
   Bu dosya PlinthService'i İÇE AKTARMAZ (PlinthService buradan okur). */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  type AccessoryLayer, type AccessoryModel, type AccessoryUnit, type CavityBox, type HoleSpec, type LegModel, type LegModelPart, type LegPartRole,
  type LegPreset, type PanelHole, useAppStore,
} from '../store';
import { type AxisDir, type Vec3, convertReplicadToThreeGeometry, genId, initReplicad, round1 } from './Geometry';
import { type LegRule, standardLegRules, standardOf } from './LegLayout';

/* ───────────────────────────── Biçimler ───────────────────────────── */
/** Desteklenen uzantılar (küçük harf, noktasız) → yükleyici anahtarı. */
export const ACCESSORY_FORMATS: Record<string, { loader: string; label: string }> = {
  glb: { loader: 'gltf', label: 'glTF binary' }, gltf: { loader: 'gltf', label: 'glTF' },
  obj: { loader: 'obj', label: 'Wavefront OBJ' }, stl: { loader: 'stl', label: 'STL' },
  fbx: { loader: 'fbx', label: 'Autodesk FBX' }, dae: { loader: 'dae', label: 'Collada' },
  ply: { loader: 'ply', label: 'PLY' }, '3mf': { loader: '3mf', label: '3MF' }, '3ds': { loader: '3ds', label: '3DS' },
  amf: { loader: 'amf', label: 'AMF' }, wrl: { loader: 'wrl', label: 'VRML' }, vrml: { loader: 'wrl', label: 'VRML' },
  step: { loader: 'step', label: 'STEP' }, stp: { loader: 'step', label: 'STEP' },
};
/** İçe aktarırken STL'ye ÇEVRİLEN çizim biçimleri (ayrıştırıcıları yok: kütüphaneye STL baytları yazılır). */
export const CAD_CONVERT_EXTS = ['dwg', 'dxf'];
export const ACCESSORY_ACCEPT = [...Object.keys(ACCESSORY_FORMATS), ...CAD_CONVERT_EXTS].map(e => `.${e}`).join(',');
/** Biçimin olağan yukarı ekseni: CAD / baskı biçimleri Z-yukarı (AutoCAD STLOUT dahil), diğerleri Y-yukarı. */
export const defaultUpAxis = (fileName: string): 'y' | 'z' => (['stl', 'step', 'stp', '3mf', 'amf', 'ply'].includes(extOf(fileName)) ? 'z' : 'y');
export const UNIT_FACTOR: Record<AccessoryUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };
export const LEG_ROLE_LABEL: Record<LegPartRole, string> = { base: 'Base', stem: 'Stem', top: 'Top plate' };
export const LEG_ROLE_TITLE: Record<LegPartRole, string> = {
  base: 'Base — stands on the floor, keeps its own size',
  stem: 'Stem — the only part that stretches: its height follows the set height',
  top: 'Top plate — screwed under the panel, keeps its own size',
};
const ROLE_ORDER: Record<LegPartRole, number> = { base: 0, stem: 1, top: 2 };
export const extOf = (fileName: string) => (fileName.split('.').pop() || '').toLowerCase();
export const isSupportedAccessoryFile = (fileName: string) => !!ACCESSORY_FORMATS[extOf(fileName)] || CAD_CONVERT_EXTS.includes(extOf(fileName));

/* ───────────────────────────── Dosya → geometri ───────────────────────────── */
const textOf = (buf: ArrayBuffer) => new TextDecoder().decode(buf);

/** Bir sahne / mesh ağacını TEK geometriye indirger (dünya matrisleri uygulanır; yalnız konum + varsa normal). */
function flattenObject(root: THREE.Object3D): THREE.BufferGeometry | null {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    const pos = g.getAttribute('position');
    if (!pos || pos.count === 0) return;
    const only = new THREE.BufferGeometry();
    only.setAttribute('position', pos.clone());
    const nrm = g.getAttribute('normal');
    if (nrm) only.setAttribute('normal', nrm.clone());
    only.applyMatrix4(m.matrixWorld);
    parts.push(only);
  });
  if (!parts.length) return null;
  const allNormals = parts.every(p => !!p.getAttribute('normal'));
  if (!allNormals) for (const p of parts) p.deleteAttribute('normal');
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!merged) return null;
  // Normal yoksa ya da bozuksa (ör. STL'de sıfır yüz normalleri → siyah gölgeleme) yeniden hesaplanır.
  const nrm = merged.getAttribute('normal') as THREE.BufferAttribute | undefined;
  let bad = !nrm;
  if (nrm) for (let i = 0; i < nrm.count; i += Math.max(1, Math.floor(nrm.count / 256))) { if (Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) < 0.5) { bad = true; break; } }
  if (bad) merged.computeVertexNormals();
  return merged;
}

/** Ham bayt dizisini biçimine göre çözer → ham (birimsiz, normalize edilmemiş) geometri. */
export async function parseAccessoryBytes(bytes: ArrayBuffer, fileName: string): Promise<THREE.BufferGeometry> {
  const ext = extOf(fileName);
  const fmt = ACCESSORY_FORMATS[ext];
  if (!fmt) throw new Error(`Unsupported file type: .${ext}`);
  const path = '';
  switch (fmt.loader) {
    case 'gltf': {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => new GLTFLoader().parse(bytes, path, g => res(g as { scene: THREE.Group }), rej));
      return need(flattenObject(gltf.scene));
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      return need(flattenObject(new OBJLoader().parse(textOf(bytes))));
    }
    case 'stl': {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      return need(flattenObject(new THREE.Mesh(new STLLoader().parse(bytes))));
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      return need(flattenObject(new FBXLoader().parse(bytes, path)));
    }
    case 'dae': {
      const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
      return need(flattenObject(new ColladaLoader().parse(textOf(bytes), path).scene));
    }
    case 'ply': {
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
      return need(flattenObject(new THREE.Mesh(new PLYLoader().parse(bytes))));
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
      return need(flattenObject(new ThreeMFLoader().parse(bytes)));
    }
    case '3ds': {
      const { TDSLoader } = await import('three/examples/jsm/loaders/TDSLoader.js');
      return need(flattenObject(new TDSLoader().parse(bytes, path)));
    }
    case 'amf': {
      const { AMFLoader } = await import('three/examples/jsm/loaders/AMFLoader.js');
      return need(flattenObject(new AMFLoader().parse(bytes)));
    }
    case 'wrl': {
      const { VRMLLoader } = await import('three/examples/jsm/loaders/VRMLLoader.js');
      return need(flattenObject(new VRMLLoader().parse(textOf(bytes), path)));
    }
    case 'step': {
      await initReplicad();
      const { importSTEP } = await import('replicad');
      const shape = await importSTEP(new Blob([bytes]));
      const geo = convertReplicadToThreeGeometry(shape);
      return need(flattenObject(new THREE.Mesh(geo)));
    }
    default: throw new Error(`Unsupported file type: .${ext}`);
  }
}
const need = (g: THREE.BufferGeometry | null): THREE.BufferGeometry => { if (!g) throw new Error('The file has no mesh geometry'); return g; };

/** NORMALİZE: birim ölçeği, yukarı ekseni (Z-yukarı → Y-yukarı), XZ'de merkez, taban y = 0. Döner: geometri + ölçü (mm). */
export function normalizeAccessoryGeometry(raw: THREE.BufferGeometry, unit: AccessoryUnit, upAxis: 'y' | 'z'): { geo: THREE.BufferGeometry; size: Vec3 } {
  const geo = raw.clone();
  const k = UNIT_FACTOR[unit];
  if (k !== 1) geo.scale(k, k, k);
  if (upAxis === 'z') geo.rotateX(-Math.PI / 2);
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
  geo.translate(-cx, -bb.min.y, -cz);
  geo.computeBoundingBox();
  const b2 = geo.boundingBox!;
  return { geo, size: [round1(b2.max.x - b2.min.x), round1(b2.max.y - b2.min.y), round1(b2.max.z - b2.min.z)] };
}

/* ───────────────────────────── DWG / DXF → STL (dwg2stl.wasm) ───────────────────────────── */
/** Dönüştürücü raporu. `units` = çizimin $INSUNITS değeri; `approxFaces` = tam çözülemeyip sınırından düz yama ile kapatılan yüzler. */
export interface DwgReport { units: number; solids: number; faces: number; approxFaces: number; meshes: number; triangles: number; notes: string[]; error: string | null }
/** $INSUNITS → kütüphane birimi (tanımadığı / birimsiz çizimde mm varsayılır). */
const DWG_UNIT: Record<number, AccessoryUnit> = { 1: 'in', 4: 'mm', 5: 'cm', 6: 'm' };
let dwgModule: Promise<WebAssembly.Module> | null = null;
/** Harness / Node: WASM baytlarını elle vermek için (tarayıcıda `public/dwg2stl.wasm` kendiliğinden indirilir). */
export function setDwgConverterWasm(bytes: BufferSource): void { dwgModule = WebAssembly.compile(bytes); }
function loadDwgModule(): Promise<WebAssembly.Module> {
  if (!dwgModule) {
    const url = `${import.meta.env.BASE_URL}dwg2stl.wasm`;
    dwgModule = fetch(url).then(async r => {
      if (!r.ok) throw new Error(`DWG converter could not be loaded (${r.status})`);
      return WebAssembly.compile(await r.arrayBuffer());
    });
    dwgModule.catch(() => { dwgModule = null; });   // ağ hatasından sonra yeniden denenebilsin
  }
  return dwgModule;
}
/** DWG / DXF baytları → ikili STL. Tamamen tarayıcıda çalışır (dosya dışarı gönderilmez). Her çağrı TAZE bir WASM örneği kurar:
 *  dönüştürücü belleği serbest bırakmaz, örnekle birlikte atılır; bozuk dosyada tuzağa düşerse sonraki çağrıyı etkilemez.
 *  Modül WASI hedefiyle derlidir ama dosya / ortam kullanmaz — aşağıdaki küçük vekil yeter (saat, rastgele sayı, yazı çıktısı yutulur). */
export async function convertDwgToStl(bytes: ArrayBuffer): Promise<{ stl: ArrayBuffer; report: DwgReport }> {
  const mod = await loadDwgModule();
  let mem!: WebAssembly.Memory;
  const view = () => new DataView(mem.buffer);
  const wasi: Record<string, (...a: number[]) => number> = {
    random_get: (p, n) => { crypto.getRandomValues(new Uint8Array(mem.buffer, p, n)); return 0; },
    environ_sizes_get: (pc, ps) => { view().setUint32(pc, 0, true); view().setUint32(ps, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (_id, _prec, p) => { view().setBigUint64(p, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    fd_write: (_fd, iovs, n, pw) => { let t = 0; for (let i = 0; i < n; i++) t += view().getUint32(iovs + i * 8 + 4, true); view().setUint32(pw, t, true); return 0; },
    fd_close: () => 0, fd_fdstat_get: () => 8, fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8, path_open: () => 44,
    proc_exit: code => { throw new Error(`DWG converter stopped (${code})`); },
  };
  let res: { ok: number; stl: ArrayBuffer; report: DwgReport };
  try {
    const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi });
    const ex = inst.exports as unknown as { memory: WebAssembly.Memory; d2s_alloc: (n: number) => number; d2s_convert: (p: number, n: number, chord: number) => number };
    mem = ex.memory;
    const p = ex.d2s_alloc(bytes.byteLength);
    new Uint8Array(mem.buffer, p, bytes.byteLength).set(new Uint8Array(bytes));
    const r = ex.d2s_convert(p, bytes.byteLength, 0);   // 0 → varsayılan kiriş sapması (model köşegeninin binde biri)
    const [ok, dp, dl, jp, jl] = new Uint32Array(mem.buffer.slice(r, r + 20));
    res = { ok, stl: mem.buffer.slice(dp, dp + dl), report: JSON.parse(new TextDecoder().decode(new Uint8Array(mem.buffer, jp, jl))) as DwgReport };
  } catch (e) {
    console.error('[YAGO] dwg2stl', e);
    throw new Error('The drawing could not be converted (unsupported or damaged file)');
  }
  if (!res.ok) throw new Error(res.report.error || 'The drawing could not be converted');
  return { stl: res.stl, report: res.report };
}
/** Dönüşüm özeti (kullanıcıya): kaç katı / ağ, hangi birim varsayıldı, yamalanan yüz var mı. */
function dwgNote(rep: DwgReport, unit: AccessoryUnit): string {
  const parts = [rep.solids ? `${rep.solids} solid${rep.solids > 1 ? 's' : ''}` : '', rep.meshes ? `${rep.meshes} mesh${rep.meshes > 1 ? 'es' : ''}` : ''].filter(Boolean).join(' + ');
  const unitNote = DWG_UNIT[rep.units] ? `unit ${unit} (from the drawing)` : `unit ${unit} (drawing has none set)`;
  const approx = rep.approxFaces ? ` · ${rep.approxFaces} of ${rep.faces} faces approximated` : '';
  return `Converted to STL: ${parts} · ${rep.triangles.toLocaleString('en-US')} triangles · ${unitNote}${approx}`;
}

/* ───────────────────────────── Kalıcılık (IndexedDB) ───────────────────────────── */
const DB_NAME = 'yago-accessories', DB_VERSION = 2;   // v2: `layers` deposu
const STORES = ['models', 'legModels', 'legPresets', 'layers'] as const;
type StoreName = typeof STORES[number];
type ModelRecord = AccessoryModel & { bytes: ArrayBuffer };
let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => { const db = req.result; for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { console.warn('[YAGO] accessories: IndexedDB unavailable', req.error); resolve(null); };
    } catch (e) { console.warn('[YAGO] accessories: IndexedDB unavailable', e); resolve(null); }
  });
  return dbPromise;
}
async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb(); if (!db) return [];
  return new Promise(resolve => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]); req.onerror = () => resolve([]);
  });
}
async function idbPut(store: StoreName, value: unknown): Promise<void> {
  const db = await openDb(); if (!db) return;
  await new Promise<void>(resolve => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); });
}
async function idbDelete(store: StoreName, id: string): Promise<void> {
  const db = await openDb(); if (!db) return;
  await new Promise<void>(resolve => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id); tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); });
}

/** Çözülmüş (hazır) geometriler — eşzamanlı okuma için. */
const readyGeo = new Map<string, { geo: THREE.BufferGeometry; size: Vec3 }>();
/** Ham bayt dizileri (IDB'den ya da içe aktarımdan) — geometri çözümü için bellek kopyası. */
const bytesCache = new Map<string, ArrayBuffer>();
/** Normalize geometri + ölçü önbelleği (model id → söz). */
const geoCache = new Map<string, Promise<{ geo: THREE.BufferGeometry; size: Vec3 }>>();
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
/** Geometri önbelleği değişince (yükleme bitti) bileşenler yeniden okusun. */
export function onAccessoryGeometry(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

/** Kütüphaneyi IDB'den store'a yükler (uygulama açılışı). */
export async function loadAccessoryLibrary(): Promise<void> {
  const [models, legModels, legPresets, layersStored] = await Promise.all([
    idbGetAll<ModelRecord>('models'), idbGetAll<LegModel>('legModels'), idbGetAll<LegPreset>('legPresets'), idbGetAll<AccessoryLayer>('layers'),
  ]);
  for (const m of models) bytesCache.set(m.id, m.bytes);
  const meta: AccessoryModel[] = models.map(m => { const rest = { ...m } as Partial<ModelRecord>; delete rest.bytes; return rest as AccessoryModel; });
  const by = (a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt;
  // Katman listesi ilk açılışta örnek katmanlarla gelir (sonradan hepsi silinirse boş kalır — bir daha tohumlanmaz).
  let layers = layersStored;
  if (!layers.length && !seededFlag()) {
    layers = DEFAULT_LAYERS.map((l, i) => ({ id: genId('layer'), name: l.name, color: l.color, createdAt: Date.now() + i }));
    for (const l of layers) await idbPut('layers', l);
    seededFlag(true);
  }
  useAppStore.getState().setAccessoryLibrary({ accessoryModels: meta.sort(by), legModels: legModels.sort(by), legPresets: legPresets.sort(by), accessoryLayers: layers.sort(by) });
}
const SEEDED_KEY = 'yago.accessories.layersSeeded';
function seededFlag(set = false): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    if (set) { localStorage.setItem(SEEDED_KEY, '1'); return true; }
    return localStorage.getItem(SEEDED_KEY) === '1';
  } catch { return false; }
}

/** DOSYA İÇE AKTAR: çöz, normalize et, üst bilgi + baytları kaydet. Hata → fırlatır (UI gösterir).
 *  DWG / DXF: önce STL'ye çevrilir; kayıt STL'dir (`fileName` = ad.stl, `source` = özgün dosya adı, `note` = dönüşüm özeti).
 *  Birim verilmediyse çizimin $INSUNITS değeri kullanılır; yukarı eksen AutoCAD'deki gibi Z. */
export async function importAccessoryFile(file: File, unit?: AccessoryUnit, upAxis?: 'y' | 'z', name?: string): Promise<AccessoryModel> {
  const ext = extOf(file.name);
  if (!isSupportedAccessoryFile(file.name)) throw new Error(`Unsupported file type: .${ext}`);
  const base = file.name.replace(/\.[^.]+$/, '');
  let bytes = await file.arrayBuffer();
  let fileName = file.name;
  let converted: Pick<AccessoryModel, 'source' | 'note'> = {};
  if (CAD_CONVERT_EXTS.includes(ext)) {
    const { stl, report } = await convertDwgToStl(bytes);
    bytes = stl; fileName = `${base}.stl`;
    unit = unit ?? DWG_UNIT[report.units] ?? 'mm';
    converted = { source: file.name, note: dwgNote(report, unit) };
  }
  const u = unit ?? 'mm', up = upAxis ?? defaultUpAxis(fileName);
  const raw = await parseAccessoryBytes(bytes, fileName);
  const { geo, size } = normalizeAccessoryGeometry(raw, u, up);
  raw.dispose();
  const model: AccessoryModel = {
    id: genId('acc'), name: (name || base).trim() || 'Model', fileName, ext: extOf(fileName), unit: u, upAxis: up, size, createdAt: Date.now(), ...converted,
  };
  bytesCache.set(model.id, bytes);
  geoCache.set(model.id, Promise.resolve({ geo, size })); readyGeo.set(model.id, { geo, size });
  useAppStore.getState().upsertAccessoryModel(model);
  await idbPut('models', { ...model, bytes } as ModelRecord);
  notify();
  return model;
}
/** Birim / yukarı ekseni değişince yeniden normalize edilir (baytlar aynı). */
export async function updateAccessoryModel(id: string, patch: Partial<Pick<AccessoryModel, 'name' | 'unit' | 'upAxis'>>): Promise<void> {
  const st = useAppStore.getState();
  const m = st.accessoryModels.find(x => x.id === id); if (!m) return;
  let next: AccessoryModel = { ...m, ...patch };
  if ((patch.unit && patch.unit !== m.unit) || (patch.upAxis && patch.upAxis !== m.upAxis)) {
    const bytes = bytesCache.get(id);
    if (bytes) {
      const raw = await parseAccessoryBytes(bytes, m.fileName);
      const n = normalizeAccessoryGeometry(raw, next.unit, next.upAxis);
      raw.dispose();
      geoCache.set(id, Promise.resolve(n)); readyGeo.set(id, n);
      next = { ...next, size: n.size };
    }
  }
  st.upsertAccessoryModel(next);
  const bytes = bytesCache.get(id);
  if (bytes) await idbPut('models', { ...next, bytes } as ModelRecord);
  notify();
}
export async function deleteAccessoryModel(id: string): Promise<void> {
  const st = useAppStore.getState();
  st.removeAccessoryModel(id);
  // Parçayı kullanan ayak modellerinden düşer.
  for (const lm of st.legModels) if (lm.parts.some(p => p.modelId === id)) await saveLegModel({ ...lm, parts: lm.parts.filter(p => p.modelId !== id) });
  bytesCache.delete(id); dropGeo(id);
  await idbDelete('models', id);
  notify();
}

/** Modelin normalize geometrisi (önbellek; gerekirse baytlardan çözer). */
export function accessoryGeometry(modelId: string): Promise<{ geo: THREE.BufferGeometry; size: Vec3 }> | null {
  const hit = geoCache.get(modelId);
  if (hit) return hit;
  const m = useAppStore.getState().accessoryModels.find(x => x.id === modelId);
  const bytes = bytesCache.get(modelId);
  if (!m || !bytes) return null;
  const p = parseAccessoryBytes(bytes, m.fileName).then(raw => { const n = normalizeAccessoryGeometry(raw, m.unit, m.upAxis); raw.dispose(); return n; });
  p.then(notify, e => { console.warn('[YAGO] accessory parse failed', m.fileName, e); dropGeo(modelId); notify(); });
  geoCache.set(modelId, p);
  return p;
}
/** Çözülmüş geometri (hazırsa); hazır değilse yüklemeyi başlatır ve null döner (hazır olunca onAccessoryGeometry tetiklenir). */
export function accessoryGeometryNow(modelId: string): { geo: THREE.BufferGeometry; size: Vec3 } | null {
  const r = readyGeo.get(modelId);
  if (r) return r;
  const p = accessoryGeometry(modelId);
  if (p) void p.then(v => { readyGeo.set(modelId, v); notify(); }, () => {});
  return null;
}
const dropGeo = (id: string) => { geoCache.delete(id); readyGeo.delete(id); };

/* ───────────────────────────── Ayak modelleri / setleri ───────────────────────────── */
export async function saveLegModel(m: LegModel): Promise<void> {
  useAppStore.getState().upsertLegModel(m);
  await idbPut('legModels', m);
}
export async function deleteLegModel(id: string): Promise<void> {
  const st = useAppStore.getState();
  st.removeLegModel(id);
  for (const p of st.legPresets) if (p.legModelId === id) await saveLegPreset({ ...p, legModelId: null });
  await idbDelete('legModels', id);
}
export async function saveLegPreset(p: LegPreset): Promise<void> {
  useAppStore.getState().upsertLegPreset(p);
  await idbPut('legPresets', p);
}
export async function deleteLegPreset(id: string): Promise<void> {
  useAppStore.getState().removeLegPreset(id);
  await idbDelete('legPresets', id);
}
export const newLegModel = (name = 'Leg'): LegModel => ({ id: genId('leg'), name, parts: [], stretch: 'stem', createdAt: Date.now() });
/** Parça uzar mı (Goker: "her parçada stretch özelliği olsun; seçiliyse ayak büyüyüp küçüldüğünde komple sünsün, kapalıysa verilen
 *  değerde sabit kalsın"): parçanın kendi ayarı; eski kayıtta yok → orta parça uzar, üst / alt sabit. */
export const legPartStretches = (p: Pick<LegModelPart, 'stretch' | 'role'>): boolean => p.stretch ?? p.role === 'stem';
/** Eski API: uzayan parçanın varsayılan rolü. */
export const legStretchOf = (_leg?: Pick<LegModel, 'stretch'>): LegPartRole => 'stem';
/** Parçanın taşıması (mm). */
export const legPartOffset = (p: Pick<LegModelPart, 'offset'>): Vec3 => [p.offset?.[0] ?? 0, p.offset?.[1] ?? 0, p.offset?.[2] ?? 0];
/** Parçanın NİHAİ ölçüsü (mm): girilen `dims`, yoksa model ölçüsü (eski kayıt: orta parçanın X/Z çarpanı uygulanır). */
export function legPartDims(p: Pick<LegModelPart, 'dims' | 'scale' | 'role'>, size: Vec3): Vec3 {
  const old = p.role === 'stem' && p.scale ? p.scale : [1, 1];
  const d = (i: number, k: number) => (p.dims && p.dims[i] > 0 ? p.dims[i] : size[i] * k);
  return [d(0, old[0]), d(1, 1), d(2, old[1])];
}
/** Hiçbir ayak modelinde (ve `keep` içinde) kullanılmayan içe aktarılmış dosyaları siler (vazgeçilen / değiştirilen yuvalar). */
export async function pruneUnusedAccessoryModels(keep: string[] = []): Promise<void> {
  const st = useAppStore.getState();
  const used = new Set([...keep, ...st.legModels.flatMap(l => l.parts.map(p => p.modelId))]);
  for (const m of st.accessoryModels) if (!used.has(m.id)) await deleteAccessoryModel(m.id);
}
export const newLegPreset = (name = 'Leg set'): LegPreset =>
  ({ id: genId('legset'), name, legModelId: null, count: 4, side: 60, front: 60, rear: 60, height: 100, rules: standardLegRules(4, 60, 60, 60), createdAt: Date.now() });

/** Parçalar rol sırasına (taban → mil → tabla) dizilir; aynı rolde ekleme sırası korunur. */
export const orderedParts = (parts: LegModelPart[]): LegModelPart[] => parts.map((p, i) => ({ p, i })).sort((a, b) => ROLE_ORDER[a.p.role] - ROLE_ORDER[b.p.role] || a.i - b.i).map(x => x.p);

/** Montajdaki parçanın YERİ: konum (x, y, z — parça yerel orijini: XZ merkezi, tabanı) + ölçek (model ölçüsüne göre çarpan) + katman. */
export interface LegPartPlacement {
  modelId: string; role: LegPartRole; stretch: boolean; x: number; y: number; z: number; scaleX: number; scaleY: number; scaleZ: number;
  size: Vec3; layerId: string | null;
  /** Temas düzleminin üstünde kalan (panele giren) kısım, mm — yalnız en üst parçada > 0. */
  embed: number;
}
/** Montajdaki parça: yer + çözülmüş geometri. */
export interface LegAssemblyPart extends LegPartPlacement { geo: THREE.BufferGeometry }
/** AYAK MONTAJ DÜZENİ (geometri gerekmez — yalnız model ölçüleri): yuvalar alttan üste (taban → orta → üst), her parça NİHAİ ölçüsünde
 *  (`dims`). Ayak boyu h: UZAYAN parçalar (`legPartStretches`) kalan boyu kendi boyları oranında paylaşır → toplam h; uzamayanlar girilen
 *  boyda sabit. Hiç uzayan yoksa ayak doğal boyundadır. X / Z taşıma düz kaydırma; Y taşıma istifte (üstündekiler de kayar).
 *  Ölçüsü bilinmeyen (kütüphanede olmayan) parça varsa null. Delik yerleri de bu düzenden okunur (geometri yüklenmeden). */
export function legLayout(leg: LegModel, h: number, sizeOf: (id: string) => Vec3 | null = modelSizeNow): LegPartPlacement[] | null {
  const parts = orderedParts(leg.parts);
  if (!parts.length) return null;
  const resolved = parts.map(p => ({ p, size: sizeOf(p.modelId) }));
  if (resolved.some(r => !r.size)) return null;
  const rows = resolved.map(r => ({ ...r, d: legPartDims(r.p, r.size!), st: legPartStretches(r.p), off: legPartOffset(r.p) }));
  const offY = rows.reduce((a, r) => a + r.off[1], 0);
  // PANELE GİREN KISIM: en üst parçanın tepesinden `embed` kadarı temas düzleminin üstünde → ayak boyu h temas düzlemine kadar,
  // model h + embed'e uzanır (uzayan parçalar embed kadar daha uzar). Uzayan üst parçada okunmaz.
  const top = rows[rows.length - 1];
  const embed = top.st ? 0 : legPartEmbed(top.p, top.d[1]);
  const fixedH = rows.filter(r => !r.st).reduce((a, r) => a + r.d[1], 0) + offY - embed;
  const stretchNatural = rows.filter(r => r.st).reduce((a, r) => a + r.d[1], 0);
  const k = stretchNatural > 1e-6 ? Math.max(1, h - fixedH) / stretchNatural : 1;
  const out: LegPartPlacement[] = [];
  let y = 0;
  const ratio = (v: number, base: number) => (base > 1e-6 ? v / base : 1);
  for (const r of rows) {
    const size = r.size!, hy = r.st ? r.d[1] * k : r.d[1];
    y += r.off[1];
    out.push({
      modelId: r.p.modelId, role: r.p.role, stretch: r.st, x: r.off[0], y, z: r.off[2],
      scaleX: ratio(r.d[0], size[0]), scaleY: ratio(hy, size[1]), scaleZ: ratio(r.d[2], size[2]), size, layerId: r.p.layerId ?? null,
      embed: r === top ? embed : 0,
    });
    y += hy;
  }
  return out;
}
/** Parçanın panele giren kısmı (mm), parça boyundan küçük tutulur. */
export const legPartEmbed = (p: Pick<LegModelPart, 'embed'>, partHeight: number): number => Math.max(0, Math.min(p.embed ?? 0, Math.max(0, partHeight - 0.1)));
/** TEMAS YÜKSEKLİĞİ (panelin altı): en üst parçanın tepesi − panele giren kısım; model tepesi `legTopHeight`. */
export const legContactHeight = (parts: LegPartPlacement[]): number => parts.reduce((a, p) => Math.max(a, p.y + p.size[1] * p.scaleY - p.embed), 0);
export const legTopHeight = (parts: LegPartPlacement[]): number => parts.reduce((a, p) => Math.max(a, p.y + p.size[1] * p.scaleY), 0);
/** PANELE GİREN KISMI MODELDEN BUL: +Y bakan üçgenlerin y'ye göre alan toplamı — en büyük alanlı yatay düzlem = temas düzlemi (tabla
 *  üstü); embed = model tepesi − o düzlem (model uzayında; nihai ölçüye `scaleY` ile). Üstte pim / vida yuvası yoksa 0. */
export function detectPartEmbed(geo: THREE.BufferGeometry, scaleY = 1): number {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined; if (!pos) return 0;
  const index = geo.index; const n = index ? index.count : pos.count;
  const area = new Map<number, number>(); let top = -Infinity;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i + 2 < n; i += 3) {
    const i0 = index ? index.getX(i) : i, i1 = index ? index.getX(i + 1) : i + 1, i2 = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    top = Math.max(top, a.y, b.y, c.y);
    u.subVectors(b, a); v.subVectors(c, a); u.cross(v);
    const l = u.length(); if (l < 1e-9 || u.y / l < 0.95) continue;
    const y = Math.round(((a.y + b.y + c.y) / 3) * 20) / 20;
    area.set(y, (area.get(y) ?? 0) + l / 2);
  }
  if (!area.size || !Number.isFinite(top)) return 0;
  let bestY = top, bestA = -1;
  for (const [y, ar] of area) if (ar > bestA) { bestA = ar; bestY = y; }
  return round1(Math.max(0, top - bestY) * scaleY);
}
const modelSizeNow = (id: string): Vec3 | null => useAppStore.getState().accessoryModels.find(m => m.id === id)?.size ?? null;
/** AYAK MONTAJI (çizim): düzen + çözülmüş geometriler. Hazır olmayan parça varsa null. */
export function legAssembly(leg: LegModel, h: number, geoOf: (id: string) => { geo: THREE.BufferGeometry; size: Vec3 } | null = accessoryGeometryNow): LegAssemblyPart[] | null {
  const geos = new Map<string, { geo: THREE.BufferGeometry; size: Vec3 }>();
  for (const p of leg.parts) { const g = geoOf(p.modelId); if (!g) return null; geos.set(p.modelId, g); }
  const lay = legLayout(leg, h, id => geos.get(id)?.size ?? null);
  return lay ? lay.map(p => ({ ...p, geo: geos.get(p.modelId)!.geo })) : null;
}
/** Montaj parçalarının taban izi çapı: orijinden en uzak XZ noktasının iki katı (ölçü + taşıma dahil). */
export const assemblyFootprint = (parts: Array<Pick<LegAssemblyPart, 'x' | 'z' | 'scaleX' | 'scaleZ' | 'size'>>): number =>
  parts.reduce((d, p) => Math.max(d, p.size[0] * p.scaleX + 2 * Math.abs(p.x), p.size[2] * p.scaleZ + 2 * Math.abs(p.z)), 0);
/** Modelin doğal yüksekliği (nihai ölçüler + Y taşımaları; uzama yok) ve taban izi çapı (ölçü + taşıma dahil). */
export function legModelDims(leg: LegModel | undefined, models = useAppStore.getState().accessoryModels): { height: number; diameter: number } | null {
  if (!leg || !leg.parts.length) return null;
  let h = 0, d = 0;
  const ordered = orderedParts(leg.parts);
  for (const p of ordered) {
    const m = models.find(x => x.id === p.modelId); if (!m) continue;
    const [ox, oy, oz] = legPartOffset(p), [dx, dy, dz] = legPartDims(p, m.size);
    h += dy + oy;
    if (p === ordered[ordered.length - 1] && !legPartStretches(p)) h -= legPartEmbed(p, dy);   // temas yüksekliği: panele giren kısım sayılmaz
    d = Math.max(d, dx + 2 * Math.abs(ox), dz + 2 * Math.abs(oz));
  }
  return { height: round1(h), diameter: round1(d) };
}
/** Ayak boyla değişir mi (en az bir uzayan parça). */
export const legModelHasStem = (leg: LegModel | undefined) => !!leg && leg.parts.some(legPartStretches);

/** Setin KÖŞE DÜZENİ (adet + kenar mesafeleri). Yerleşim her zaman otomatik köşe düzenidir; eski kayıtların ayak ayak kuralları
 *  standart düzene denkse oradan okunur, değilse setin alanları. */
export function presetLayout(p: Pick<LegPreset, 'rules' | 'count' | 'side' | 'front' | 'rear'>): { count: 4 | 5 | 6; side: number; front: number; rear: number } {
  const std = p.rules && p.rules.length ? standardOf(p.rules) : null;
  return std ?? { count: p.count, side: p.side, front: p.front, rear: p.rear };
}
/** Setten PlinthLegs alanları (PlinthService / hızlı gövde): adet, kenar mesafeleri, model, Ø modelden (yoksa 50). */
export function legsFromPreset(preset: LegPreset, st = useAppStore.getState()): {
  count: 4 | 5 | 6; diameter: number; side: number; front: number; rear: number; legModelId: string | null; presetId: string; rules: LegRule[];
} {
  const leg = preset.legModelId ? st.legModels.find(x => x.id === preset.legModelId) : undefined;
  const dims = legModelDims(leg, st.accessoryModels);
  const L = presetLayout(preset);
  return { ...L, diameter: dims?.diameter || 50, legModelId: leg ? leg.id : null, presetId: preset.id, rules: standardLegRules(L.count, L.side, L.front, L.rear) };
}
/** Setin ayak ayak kuralları (eski kayıt: standart düzenden türer). */
export const presetRules = (p: Pick<LegPreset, 'rules' | 'count' | 'side' | 'front' | 'rear'>): LegRule[] =>
  p.rules && p.rules.length ? p.rules : standardLegRules(p.count, p.side, p.front, p.rear);
export const legPresetById = (id: string | null | undefined, st = useAppStore.getState()) => (id ? st.legPresets.find(p => p.id === id) : undefined);
/** KULLANILACAK AYAK SETİ (Goker: "sadece kayıtlı ayaklar gelsin, yerleşik ayak seçeneği hiç gelmesin"): verilen id'nin seti; yoksa
 *  (eski kayıt / hiç seçilmemiş) kütüphanedeki İLK set; kütüphane boşsa undefined (yalnız o zaman yerleşik ayak çizilir). */
export const resolveLegPreset = (id: string | null | undefined, st = useAppStore.getState()): LegPreset | undefined =>
  legPresetById(id, st) ?? st.legPresets[0];
export const legModelById = (id: string | null | undefined, st = useAppStore.getState()) => (id ? st.legModels.find(p => p.id === id) : undefined);

/* ───────────────────────────── Katmanlar ─────────────────────────────
   Kütüphane geneli liste (Goker: "katmanları bir listede tut, tüm aksesuarlarda bu katmanlar ilerde kullanılacak"): ad + renk.
   Parça → katman bağı parçanın kendisinde (`layerId`); katman silinince bağ düşer (parça varsayılan renge döner). */
export const LAYER_PALETTE = ['#8a8f99', '#3f3f46', '#b45309', '#0f766e', '#2563eb', '#be123c', '#4d7c0f', '#7c3aed', '#a16207', '#57534e'];
const DEFAULT_LAYERS: Array<Pick<AccessoryLayer, 'name' | 'color'>> = [{ name: 'Metal', color: '#9aa0a8' }, { name: 'Plastic', color: '#56534f' }];
/** Katmansız parçanın rengi (eski kayıtlar / katman silinmiş). */
export const LAYER_DEFAULT_COLOR = '#4a4542';
export const layerById = (id: string | null | undefined, st = useAppStore.getState()): AccessoryLayer | undefined =>
  id ? st.accessoryLayers.find(l => l.id === id) : undefined;
/** Parçanın çizim rengi: katmanın rengi, katman yoksa `fallback`. */
export const layerColorOf = (layerId: string | null | undefined, fallback = LAYER_DEFAULT_COLOR, st = useAppStore.getState()): string =>
  layerById(layerId, st)?.color ?? fallback;
/** Listede kullanılmayan ilk palet rengi (hepsi kullanıldıysa sıradaki). */
export function nextLayerColor(layers = useAppStore.getState().accessoryLayers): string {
  const used = new Set(layers.map(l => l.color.toLowerCase()));
  return LAYER_PALETTE.find(c => !used.has(c)) ?? LAYER_PALETTE[layers.length % LAYER_PALETTE.length];
}
export const newAccessoryLayer = (name = 'Layer', color?: string): AccessoryLayer =>
  ({ id: genId('layer'), name, color: color ?? nextLayerColor(), createdAt: Date.now() });
export async function saveAccessoryLayer(l: AccessoryLayer): Promise<void> {
  useAppStore.getState().upsertAccessoryLayer(l);
  await idbPut('layers', l);
}
/** Katmanı siler; onu kullanan ayak parçaları katmansız kalır. */
export async function deleteAccessoryLayer(id: string): Promise<void> {
  const st = useAppStore.getState();
  st.removeAccessoryLayer(id);
  for (const lm of st.legModels) if (lm.parts.some(p => p.layerId === id)) await saveLegModel({ ...lm, parts: lm.parts.map(p => (p.layerId === id ? { ...p, layerId: null } : p)) });
  await idbDelete('layers', id);
}
/** Katmanı kullanan parça sayısı (liste rozeti). */
export const layerUseCount = (id: string, legModels = useAppStore.getState().legModels): number =>
  legModels.reduce((n, lm) => n + lm.parts.filter(p => p.layerId === id).length, 0);

/* ───────────────────────────── Delikler ─────────────────────────────
   HoleSpec (store): parçaya bağlı, parçanın ÖLÇEKSİZ model uzayında `pos`; `dir` birim yön. Montajdaki yeri parçanın yerinden
   (`legLayout`) türer: merkez = parça + pos·ölçek. Ayak sıfırına göre X/Y/Z gösterilir / düzenlenir (`holeLegPos` / `holePosFromLeg`).
   Kesici: ağız HOLE_MOUTH kadar geri alınmış silindir (panel yüzeyiyle çakışık kapak olmasın — boolean temiz ve hızlı), boy mouth + depth;
   panelden çıkan = silindir ∩ panel ("panele değdiği yerden"). */
export const HOLE_DEFAULTS = { diameter: 4, depth: 12 } as const;
/** Ağız payı (mm): silindir ağızdan bu kadar geride başlar. */
export const HOLE_MOUTH = 1;
export const HOLE_AXES: Array<{ v: AxisDir; label: string }> = [
  { v: 'y+', label: '+Y' }, { v: 'y-', label: '−Y' }, { v: 'x+', label: '+X' }, { v: 'x-', label: '−X' }, { v: 'z+', label: '+Z' }, { v: 'z-', label: '−Z' },
];
export const axisVecOf = (a: AxisDir): Vec3 => {
  const s = a[1] === '+' ? 1 : -1;
  return a[0] === 'x' ? [s, 0, 0] : a[0] === 'y' ? [0, s, 0] : [0, 0, s];
};
/** Yön eksen-hizalıysa (|c| > 0.95) ekseni, değilse null. */
export const holeAxisOf = (dir: Vec3): AxisDir | null => {
  for (const [i, l] of [[0, 'x'], [1, 'y'], [2, 'z']] as Array<[number, string]>) { if (dir[i] > 0.95) return `${l}+` as AxisDir; if (dir[i] < -0.95) return `${l}-` as AxisDir; }
  return null;
};
/** Yüzey normalini en yakın eksene kıstırır (aksesuar delikleri eksen boyunca delinir). */
export const snapDirToAxis = (n: Vec3): Vec3 => {
  const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])], i = a.indexOf(Math.max(...a));
  const out: Vec3 = [0, 0, 0]; out[i] = n[i] >= 0 ? 1 : -1; return out;
};
export const newHole = (init: Partial<HoleSpec> = {}): HoleSpec =>
  ({ id: genId('hole'), part: null, pos: [0, 0, 0], dir: [0, 1, 0], diameter: HOLE_DEFAULTS.diameter, depth: HOLE_DEFAULTS.depth, ...init });
const partByRole = (parts: LegPartPlacement[] | null, role: LegPartRole | null | undefined) => (role && parts ? parts.find(p => p.role === role) ?? null : null);
/** Deliğin AYAK uzayındaki ağız merkezi (parça yer + ölçek uygulanmış); parçası yoksa / bulunamazsa pos olduğu gibi. */
export function holeLegPos(hole: HoleSpec, parts: LegPartPlacement[] | null): Vec3 {
  const p = partByRole(parts, hole.part);
  if (!p) return [...hole.pos] as Vec3;
  return [p.x + hole.pos[0] * p.scaleX, p.y + hole.pos[1] * p.scaleY, p.z + hole.pos[2] * p.scaleZ];
}
/** Ayak uzayındaki nokta → o parçanın ölçeksiz model uzayı (deliği parçaya bağlarken / X Y Z düzenlerken). */
export function holePosFromLeg(point: Vec3, part: LegPartRole | null | undefined, parts: LegPartPlacement[] | null): Vec3 {
  const p = partByRole(parts, part);
  if (!p) return [...point] as Vec3;
  const d = (v: number, s: number) => (Math.abs(s) > 1e-9 ? v / s : v);
  return [d(point[0] - p.x, p.scaleX), d(point[1] - p.y, p.scaleY), d(point[2] - p.z, p.scaleZ)];
}
export interface LegHoleAt { hole: HoleSpec; center: Vec3; dir: Vec3; radius: number; depth: number }
/** Ayağın delikleri montaj (ayak) uzayında — önizleme ve kesici üretimi. */
export function legHolesAt(leg: Pick<LegModel, 'holes'>, parts: LegPartPlacement[] | null): LegHoleAt[] {
  return (leg.holes ?? []).map(h => ({ hole: h, center: holeLegPos(h, parts), dir: unit(h.dir), radius: Math.max(0.1, h.diameter / 2), depth: Math.max(0.1, h.depth) }));
}
const unit = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
/** KESİCİ SİLİNDİR (gövde-yerel; PanelEngine): `start` = ağız − dir·mouth, `length` = mouth + depth. `key` önbellek imzası. */
export interface HoleCutter { id: string; key: string; start: Vec3; dir: Vec3; radius: number; length: number; mouth: number; source: PanelHole['source'] }
export function holeCutterOf(at: LegHoleAt, origin: Vec3, id: string, source: PanelHole['source'], mouth = HOLE_MOUTH): HoleCutter {
  const start: Vec3 = [origin[0] + at.center[0] - at.dir[0] * mouth, origin[1] + at.center[1] - at.dir[1] * mouth, origin[2] + at.center[2] - at.dir[2] * mouth];
  const length = mouth + at.depth;
  const key = `${start.map(round1).join(',')}|${at.dir.map(v => v.toFixed(3)).join(',')}|${round1(at.radius)}|${round1(length)}`;
  return { id, key, start, dir: at.dir, radius: at.radius, length, mouth, source };
}
/** Ayağın (origin'e yerleşmiş, h boyunda) kesici silindirleri; model ölçüleri bilinmiyorsa boş. */
export function legHoleCutters(leg: LegModel, h: number, origin: Vec3, source: (holeId: string) => PanelHole['source'], sizeOf?: (id: string) => Vec3 | null): HoleCutter[] {
  if (!leg.holes?.length) return [];
  const parts = legLayout(leg, h, sizeOf);
  if (!parts && leg.holes.some(x => x.part)) return [];
  return legHolesAt(leg, parts).map(at => holeCutterOf(at, origin, `${at.hole.id}@${origin.map(round1).join(',')}`, source(at.hole.id)));
}
/** Kesicinin eksen-hizalı kutusu (panel kutusuyla hızlı eleme). */
export function holeCutterBox(c: HoleCutter): CavityBox {
  const end: Vec3 = [c.start[0] + c.dir[0] * c.length, c.start[1] + c.dir[1] * c.length, c.start[2] + c.dir[2] * c.length];
  const r = c.radius;
  return { min: [Math.min(c.start[0], end[0]) - r, Math.min(c.start[1], end[1]) - r, Math.min(c.start[2], end[2]) - r], max: [Math.max(c.start[0], end[0]) + r, Math.max(c.start[1], end[1]) + r, Math.max(c.start[2], end[2]) + r] };
}
/* ───────────────────────────── Yakalama noktaları (snap) ─────────────────────────────
   Goker (Kas 2026): "delikleri stl modeli üzerindeki belli noktalara yerleştirebileyim". Üçgen ağından CAD yakalama noktaları:
   KÖŞE (keskin kenarların kırıldığı / buluştuğu tepe), ORTA (düz keskin kenar parçasının ortası), MERKEZ (kapalı keskin kenar
   çevriminin çember merkezi — modeldeki delik ağzı, disk / mil kenarı). Keskin kenar = iki yüz normali arası > 25° ya da sınır kenarı.
   Geometri başına bir kez hesaplanır (WeakMap); 150k üçgenden büyük ağlar atlanır. Noktalar parçanın ölçeksiz model uzayında. */
export interface SnapPoint { kind: 'vertex' | 'mid' | 'center'; p: Vec3; normals: Vec3[] }
const _snapCache = new WeakMap<THREE.BufferGeometry, SnapPoint[]>();
const SNAP_SHARP = Math.cos((25 * Math.PI) / 180), SNAP_STRAIGHT = Math.cos((3 * Math.PI) / 180), SNAP_BEND = Math.cos((20 * Math.PI) / 180);
export function meshSnapPoints(geo: THREE.BufferGeometry): SnapPoint[] {
  const hit = _snapCache.get(geo); if (hit) return hit;
  const out = computeSnapPoints(geo);
  _snapCache.set(geo, out);
  return out;
}
function computeSnapPoints(geo: THREE.BufferGeometry): SnapPoint[] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return [];
  const index = geo.index;
  const triCount = index ? index.count / 3 : pos.count / 3;
  if (triCount > 150000 || triCount < 1) return [];
  // Kaynak: 0.01 mm'de aynı köşeler tek köşe
  const vid = new Map<string, number>(); const verts: Vec3[] = [];
  const idOf = (i: number) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
    let id = vid.get(k); if (id == null) { id = verts.length; vid.set(k, id); verts.push([x, y, z]); } return id;
  };
  const tri: number[] = [], fn: Vec3[] = [];
  const vertFaces = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3, i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1, i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const a = idOf(i0), b = idOf(i1), c = idOf(i2);
    if (a === b || b === c || a === c) continue;
    const A = verts[a], B = verts[b], C = verts[c];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(...n); if (l < 1e-9) continue;
    const f = fn.length; fn.push([n[0] / l, n[1] / l, n[2] / l]); tri.push(a, b, c);
    for (const v of [a, b, c]) { const arr = vertFaces.get(v); if (arr) arr.push(f); else vertFaces.set(v, [f]); }
  }
  const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  // Kenarlar → yüzler
  const edges = new Map<string, { a: number; b: number; faces: number[] }>();
  for (let f = 0; f < fn.length; f++) {
    const v = [tri[f * 3], tri[f * 3 + 1], tri[f * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3], lo = Math.min(a, b), hi = Math.max(a, b), key = `${lo}_${hi}`;
      const e = edges.get(key); if (e) e.faces.push(f); else edges.set(key, { a: lo, b: hi, faces: [f] });
    }
  }
  // Keskin kenarlar + köşe derecesi
  const sharp: Array<{ a: number; b: number; faces: number[] }> = [];
  for (const e of edges.values()) {
    if (e.faces.length === 1 || (e.faces.length === 2 && dot(fn[e.faces[0]], fn[e.faces[1]]) < SNAP_SHARP)) sharp.push(e);
  }
  if (!sharp.length) return [];
  const adj = new Map<number, number[]>();
  sharp.forEach((e, i) => { for (const v of [e.a, e.b]) { const arr = adj.get(v); if (arr) arr.push(i); else adj.set(v, [i]); } });
  // Zincirler: derecesi 2 olan köşelerden geçerek yürü
  const visited = new Uint8Array(sharp.length);
  const chains: Array<{ verts: number[]; edges: number[]; closed: boolean }> = [];
  const other = (ei: number, v: number) => (sharp[ei].a === v ? sharp[ei].b : sharp[ei].a);
  /** startV'den firstE üzerinden yürür; derecesi 2 olmayan köşede ya da başa dönünce (kapalı) durur. */
  const walkFrom = (startV: number, firstE: number): { vs: number[]; es: number[]; closed: boolean } => {
    const vs = [startV], es: number[] = []; let e = firstE, v = startV;
    while (true) {
      visited[e] = 1; es.push(e); v = other(e, v); vs.push(v);
      if (v === startV) return { vs, es, closed: true };
      const nb = adj.get(v)!; if (nb.length !== 2) return { vs, es, closed: false };
      const ne = nb[0] === e ? nb[1] : nb[0];
      if (visited[ne]) return { vs, es, closed: false };
      e = ne;
    }
  };
  for (let i = 0; i < sharp.length; i++) {
    if (visited[i]) continue;
    const e = sharp[i];
    const degA = adj.get(e.a)!.length, degB = adj.get(e.b)!.length;
    let r: { vs: number[]; es: number[]; closed: boolean };
    if (degA !== 2) r = walkFrom(e.a, i);
    else if (degB !== 2) r = walkFrom(e.b, i);
    else {
      // İki uç da derece 2: ileri yürü; kapanmadıysa geri yönü de yürüyüp birleştir
      const fwd = walkFrom(e.a, i);
      if (fwd.closed) r = fwd;
      else {
        const nb = adj.get(e.a)!, otherE = nb[0] === i ? nb[1] : nb[0];
        const bwd = visited[otherE] ? { vs: [e.a], es: [] as number[] } : walkFrom(e.a, otherE);
        r = { vs: [...bwd.vs.slice(1).reverse(), ...fwd.vs], es: [...bwd.es.slice().reverse(), ...fwd.es], closed: false };
      }
    }
    chains.push({ verts: r.vs, edges: r.es, closed: r.closed });
  }
  const out: SnapPoint[] = []; const seen = new Set<string>();
  const push = (kind: SnapPoint['kind'], p: Vec3, normals: Vec3[]) => {
    const k = `${kind}:${Math.round(p[0] * 20)},${Math.round(p[1] * 20)},${Math.round(p[2] * 20)}`;
    if (seen.has(k)) return; seen.add(k); out.push({ kind, p, normals });
  };
  const uniqueNormals = (faces: Iterable<number>, max = 4): Vec3[] => {
    const ns: Vec3[] = [];
    for (const f of faces) { const n = fn[f]; if (!ns.some(m => dot(m, n) > 0.98)) ns.push(n); if (ns.length >= max) break; }
    return ns;
  };
  const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const len = (p: Vec3) => Math.hypot(p[0], p[1], p[2]);
  const unitv = (p: Vec3): Vec3 => { const l = len(p) || 1; return [p[0] / l, p[1] / l, p[2] / l]; };
  const corners = new Set<number>();
  for (const ch of chains) {
    const vs = ch.closed ? ch.verts.slice(0, -1) : ch.verts;
    if (vs.length < 2) continue;
    // ÇEMBER: kapalı, ≥ 6 köşe, düzlemsel, merkeze eşit uzaklık
    if (ch.closed && vs.length >= 6) {
      const c: Vec3 = [0, 0, 0]; for (const v of vs) { c[0] += verts[v][0]; c[1] += verts[v][1]; c[2] += verts[v][2]; }
      c[0] /= vs.length; c[1] /= vs.length; c[2] /= vs.length;
      const nn: Vec3 = [0, 0, 0];   // Newell
      for (let i = 0; i < vs.length; i++) { const p = verts[vs[i]], q = verts[vs[(i + 1) % vs.length]]; nn[0] += (p[1] - q[1]) * (p[2] + q[2]); nn[1] += (p[2] - q[2]) * (p[0] + q[0]); nn[2] += (p[0] - q[0]) * (p[1] + q[1]); }
      const n = unitv(nn);
      const radii = vs.map(v => len(sub(verts[v], c))); const rm = radii.reduce((a, b) => a + b, 0) / radii.length;
      const planar = vs.every(v => Math.abs(dot(sub(verts[v], c), n)) <= Math.max(0.05, rm * 0.02));
      const round = radii.every(r => Math.abs(r - rm) <= rm * 0.03 + 0.02);
      if (planar && round && rm > 0.3) {
        // Yön: çevrimin düzlemine paralel komşu yüzün dış normali (tabla yüzü / disk kapağı); yoksa iki yön
        const par = new Set<number>(); for (const ei of ch.edges) for (const f of sharp[ei].faces) if (Math.abs(dot(fn[f], n)) > 0.9) par.add(f);
        push('center', c, par.size ? uniqueNormals(par, 2) : [n, [-n[0], -n[1], -n[2]]]);
        continue;
      }
    }
    // DÜZ PARÇALAR: aynı yönde ardışık kenarlar birleşir; kapalı zincirde ilk kırılmadan başla
    const n = vs.length, m = ch.closed ? n : n - 1;
    const dirs: Vec3[] = []; for (let i = 0; i < m; i++) dirs.push(unitv(sub(verts[vs[(i + 1) % n]], verts[vs[i]])));
    let start = 0;
    if (ch.closed) { for (let i = 0; i < m; i++) if (dot(dirs[(i + m - 1) % m], dirs[i]) < SNAP_STRAIGHT) { start = i; break; } }
    const runs: Array<{ s: number; e: number; d: Vec3; edges: number[] }> = [];
    let cur: { s: number; e: number; d: Vec3; edges: number[] } | null = null;
    for (let k = 0; k < m; k++) {
      const i = (start + k) % m, d = dirs[i], e = ch.edges[i];
      if (cur && dot(cur.d, d) >= SNAP_STRAIGHT) { cur.e = (i + 1) % n; cur.edges.push(e); }
      else { if (cur) runs.push(cur); cur = { s: i, e: (i + 1) % n, d, edges: [e] }; }
    }
    if (cur) runs.push(cur);
    for (const r of runs) {
      const P = verts[vs[r.s]], Q = verts[vs[r.e]], L = len(sub(Q, P));
      if (L >= 1.5) push('mid', [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2, (P[2] + Q[2]) / 2], uniqueNormals(r.edges.flatMap(ei => sharp[ei].faces), 3));
    }
    // KÖŞELER: ardışık düz parçalar arasında kırılma; açık zincirin uçları (derecesi ≠ 2 köşeler)
    const bends = ch.closed ? runs.length : runs.length - 1;
    for (let i = 0; i < bends; i++) {
      const a = runs[i], b = runs[(i + 1) % runs.length];
      const la = len(sub(verts[vs[a.e]], verts[vs[a.s]])), lb = len(sub(verts[vs[b.e]], verts[vs[b.s]]));
      if (dot(a.d, b.d) < SNAP_BEND && la >= 1.5 && lb >= 1.5) corners.add(vs[a.e]);
    }
    if (!ch.closed) { for (const v of [vs[0], vs[n - 1]]) if ((adj.get(v)?.length ?? 0) !== 2) corners.add(v); }
  }
  for (const v of corners) push('vertex', verts[v], uniqueNormals(vertFaces.get(v) ?? [], 4));
  return out;
}

/** PANEL DELİK KAYDI (üretim): kesicinin panel kutusuna giriş noktası, panel içindeki derinlik, giriş yüzü, geçiyor mu.
 *  Eksen-hizalı delikte kutu yüzünden giriş; eğik delikte giriş = silindir başı (yaklaşık). */
export function panelHoleRecord(c: HoleCutter, pb: { min: Vec3; max: Vec3 }): PanelHole {
  const axis = holeAxisOf(c.dir);
  const end: Vec3 = [c.start[0] + c.dir[0] * c.length, c.start[1] + c.dir[1] * c.length, c.start[2] + c.dir[2] * c.length];
  if (!axis) return { id: c.id, entry: c.start, dir: c.dir, diameter: round1(c.radius * 2), depth: round1(c.length - c.mouth), through: false, face: null, source: c.source };
  const a = axis[0] === 'x' ? 0 : axis[0] === 'y' ? 1 : 2, s = axis[1] === '+' ? 1 : -1;
  const faceAt = s > 0 ? pb.min[a] : pb.max[a], farAt = s > 0 ? pb.max[a] : pb.min[a];
  // Giriş: kutu yüzü ya da (silindir panelin içinde başlıyorsa) silindir başı; derinlik uzak yüze kadar kırpılır.
  const entryAt = s > 0 ? Math.max(c.start[a], faceAt) : Math.min(c.start[a], faceAt);
  const endAt = s > 0 ? Math.min(end[a], farAt) : Math.max(end[a], farAt);
  const depth = Math.max(0, (endAt - entryAt) * s);
  const entry: Vec3 = [...c.start] as Vec3; entry[a] = entryAt;
  const face = `${'xyz'[a]}${s > 0 ? '-' : '+'}` as AxisDir;   // giriş yüzünün dış normali delme yönünün tersi
  return { id: c.id, entry: entry.map(round1) as Vec3, dir: c.dir, diameter: round1(c.radius * 2), depth: round1(depth), through: Math.abs((farAt - entryAt) * s - depth) < 0.05, face, source: c.source };
}
