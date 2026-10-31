/* AKSESUAR KÜTÜPHANESİ (Goker, Eki 2026 — "Panel editör yanında Aksesuar sekmesi; ilk seçenek ayak. Ayak için dışarıdan model alayım,
   alabildiğimiz tüm uzantıları destekleyelim; ayaklar 3 parça, yalnız orta parça uzasın, uzayacak parçayı eklerden seçip rol vereyim;
   4/5/6 ayak setlerini kaydedip ayak kısmında çağıralım").

   KATMANLAR
   1) Dosya → geometri: Three örnek yükleyicileri (glTF/GLB, OBJ, STL, FBX, DAE, PLY, 3MF, 3DS, AMF, WRL) + STEP (replicad / OpenCascade).
      Sonuç TEK BufferGeometry: birim ölçeği (mm/cm/m/in), yukarı ekseni (Y/Z), XZ'de merkezlenmiş, tabanı y=0'da ("normalize").
   2) Kalıcılık: IndexedDB `yago-accessories` — `models` (üst bilgi + ham bayt dizisi), `legModels`, `legPresets`. Store'daki kopya canlıdır;
      her yazım IDB'ye de gider. indexedDB yoksa (Node harness) yalnız bellek.
   3) Ayak modeli (LegModel) = 1–3 parça + rol: base (zemin) · stem (UZAR) · top (tabla). `legAssembly(leg, h)` parçaları alt alta dizer;
      stem yüksekliği = h − (diğer parçalar) → set yüksekliği değişince yalnız mil uzar/kısalır (Goker). Stem yoksa hiçbir parça ölçeklenmez.
   4) Ayak seti (LegPreset, "kaset"): model + adet + kenar mesafeleri + varsayılan yükseklik. `legsFromPreset` → PlinthLegs (baza seti / hızlı gövde).
   Bu dosya PlinthService'i İÇE AKTARMAZ (PlinthService buradan okur). */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  type AccessoryModel, type AccessoryUnit, type LegModel, type LegModelPart, type LegPartRole, type LegPreset, useAppStore,
} from '../store';
import { type Vec3, convertReplicadToThreeGeometry, genId, initReplicad, round1 } from './Geometry';

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
export const ACCESSORY_ACCEPT = Object.keys(ACCESSORY_FORMATS).map(e => `.${e}`).join(',');
export const UNIT_FACTOR: Record<AccessoryUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };
export const LEG_ROLE_LABEL: Record<LegPartRole, string> = { base: 'Base', stem: 'Stem', top: 'Top plate' };
export const LEG_ROLE_TITLE: Record<LegPartRole, string> = {
  base: 'Base — stands on the floor, keeps its own size',
  stem: 'Stem — the only part that stretches: its height follows the set height',
  top: 'Top plate — screwed under the panel, keeps its own size',
};
const ROLE_ORDER: Record<LegPartRole, number> = { base: 0, stem: 1, top: 2 };
export const extOf = (fileName: string) => (fileName.split('.').pop() || '').toLowerCase();
export const isSupportedAccessoryFile = (fileName: string) => !!ACCESSORY_FORMATS[extOf(fileName)];

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
  if (!merged.getAttribute('normal')) merged.computeVertexNormals();
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

/* ───────────────────────────── Kalıcılık (IndexedDB) ───────────────────────────── */
const DB_NAME = 'yago-accessories', DB_VERSION = 1;
const STORES = ['models', 'legModels', 'legPresets'] as const;
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
  const [models, legModels, legPresets] = await Promise.all([idbGetAll<ModelRecord>('models'), idbGetAll<LegModel>('legModels'), idbGetAll<LegPreset>('legPresets')]);
  for (const m of models) bytesCache.set(m.id, m.bytes);
  const meta: AccessoryModel[] = models.map(m => { const rest = { ...m } as Partial<ModelRecord>; delete rest.bytes; return rest as AccessoryModel; });
  const by = (a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt;
  useAppStore.getState().setAccessoryLibrary({ accessoryModels: meta.sort(by), legModels: legModels.sort(by), legPresets: legPresets.sort(by) });
}

/** DOSYA İÇE AKTAR: çöz, normalize et, üst bilgi + baytları kaydet. Hata → fırlatır (UI gösterir). */
export async function importAccessoryFile(file: File, unit: AccessoryUnit = 'mm', upAxis: 'y' | 'z' = 'y', name?: string): Promise<AccessoryModel> {
  if (!isSupportedAccessoryFile(file.name)) throw new Error(`Unsupported file type: .${extOf(file.name)}`);
  const bytes = await file.arrayBuffer();
  const raw = await parseAccessoryBytes(bytes, file.name);
  const { geo, size } = normalizeAccessoryGeometry(raw, unit, upAxis);
  raw.dispose();
  const model: AccessoryModel = {
    id: genId('acc'), name: (name || file.name.replace(/\.[^.]+$/, '')).trim() || 'Model', fileName: file.name, ext: extOf(file.name), unit, upAxis, size, createdAt: Date.now(),
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
export const newLegModel = (name = 'Leg'): LegModel => ({ id: genId('leg'), name, parts: [], createdAt: Date.now() });
export const newLegPreset = (name = 'Leg set'): LegPreset =>
  ({ id: genId('legset'), name, legModelId: null, count: 4, side: 60, front: 60, rear: 60, height: 100, createdAt: Date.now() });

/** Parçalar rol sırasına (taban → mil → tabla) dizilir; aynı rolde ekleme sırası korunur. */
export const orderedParts = (parts: LegModelPart[]): LegModelPart[] => parts.map((p, i) => ({ p, i })).sort((a, b) => ROLE_ORDER[a.p.role] - ROLE_ORDER[b.p.role] || a.i - b.i).map(x => x.p);

export interface LegAssemblyPart { modelId: string; role: LegPartRole; y: number; scaleY: number; geo: THREE.BufferGeometry; size: Vec3 }
/** Ayak montajı: parçalar alt alta; `stem` yüksekliği = h − diğer parçalar (en az 1 mm) → yalnız mil uzar. Hazır olmayan parça yoksa null. */
export function legAssembly(leg: LegModel, h: number, geoOf: (id: string) => { geo: THREE.BufferGeometry; size: Vec3 } | null = accessoryGeometryNow): LegAssemblyPart[] | null {
  const parts = orderedParts(leg.parts);
  if (!parts.length) return null;
  const resolved = parts.map(p => ({ p, g: geoOf(p.modelId) }));
  if (resolved.some(r => !r.g)) return null;
  const hasStem = parts.some(p => p.role === 'stem');
  const fixedH = resolved.filter(r => r.p.role !== 'stem').reduce((a, r) => a + r.g!.size[1], 0);
  const stemNatural = resolved.filter(r => r.p.role === 'stem').reduce((a, r) => a + r.g!.size[1], 0);
  const stemTarget = Math.max(1, h - fixedH);
  const stemScale = hasStem && stemNatural > 1e-6 ? stemTarget / stemNatural : 1;
  const out: LegAssemblyPart[] = [];
  let y = 0;
  for (const r of resolved) {
    const scaleY = r.p.role === 'stem' ? stemScale : 1;
    out.push({ modelId: r.p.modelId, role: r.p.role, y, scaleY, geo: r.g!.geo, size: r.g!.size });
    y += r.g!.size[1] * scaleY;
  }
  return out;
}
/** Modelin doğal yüksekliği (parçaların toplamı) ve taban izi çapı (en geniş parçanın XZ ölçüsü). */
export function legModelDims(leg: LegModel | undefined, models = useAppStore.getState().accessoryModels): { height: number; diameter: number } | null {
  if (!leg || !leg.parts.length) return null;
  let h = 0, d = 0;
  for (const p of leg.parts) {
    const m = models.find(x => x.id === p.modelId); if (!m) continue;
    h += m.size[1]; d = Math.max(d, m.size[0], m.size[2]);
  }
  return { height: round1(h), diameter: round1(d) };
}
export const legModelHasStem = (leg: LegModel | undefined) => !!leg && leg.parts.some(p => p.role === 'stem');

/** Setten PlinthLegs alanları (PlinthService / hızlı gövde): adet, kenar mesafeleri, model, Ø modelden (yoksa 50). */
export function legsFromPreset(preset: LegPreset, st = useAppStore.getState()): { count: 4 | 5 | 6; diameter: number; side: number; front: number; rear: number; legModelId: string | null; presetId: string } {
  const leg = preset.legModelId ? st.legModels.find(x => x.id === preset.legModelId) : undefined;
  const dims = legModelDims(leg, st.accessoryModels);
  return { count: preset.count, diameter: dims?.diameter || 50, side: preset.side, front: preset.front, rear: preset.rear, legModelId: leg ? leg.id : null, presetId: preset.id };
}
export const legPresetById = (id: string | null | undefined, st = useAppStore.getState()) => (id ? st.legPresets.find(p => p.id === id) : undefined);
export const legModelById = (id: string | null | undefined, st = useAppStore.getState()) => (id ? st.legModels.find(p => p.id === id) : undefined);
