import React, { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Check, Layers, Plus, Radius, Spline, Trash2, X } from 'lucide-react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import { createClient } from '@supabase/supabase-js';
import Scene from './components/Scene';
import { Sidebar, StatusBar, Terminal, Toolbar, ToolChip, ToolChipBar, UI_FONT } from './components/Ui';
import { PanelEditor } from './components/PanelEditor';
import { type Shape, childPanelsOf, requestRebuild, shapeById, useAppStore, useStoreFields } from './store';
import { applyShapeChanges, axisIndexOf, evaluateExpression, initReplicad, rebuildBodySolid } from './components/Geometry';
// Rebuild motoru sayfayla birlikte yüklenir ve store'a kaydolur (bkz. store.requestRebuild).
import './components/PanelEngine';

/* ═══════════════════════════════════════════════════════════════════════════
   UYGULAMA KÖKÜ — (A) Supabase geometri kataloğu (veri + panel); (B) App:
   yerleşim, OpenCascade ön-yükleme, global hata yakalama, panel-kümesi izleyicisi;
   (C) Parametre paneli (ölçü/dönüş/fillet/özel parametre/çıkarma/vertex, Apply).
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Veritabanı ──────────────────────────────────────────────────────────────
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

export interface CatalogItem {
  id: string; code: string; description: string; tags: string[];
  geometry_data: any; shape_parameters?: any; subtraction_geometries?: any[]; fillets?: any[];
  preview_image?: string; created_at: string; updated_at: string;
}
export const catalogService = {
  async getAll(): Promise<CatalogItem[]> {
    if (!supabase) { console.warn('Supabase not configured - running in local mode'); return []; }
    const { data, error } = await supabase.from('geometry_catalog').select('*').order('created_at', { ascending: false });
    if (error) { console.error('Error fetching catalog items:', error); return []; }
    return data || [];
  },
  async delete(id: string): Promise<boolean> {
    if (!supabase) { console.warn('Supabase not configured - cannot delete from catalog'); return false; }
    const { error } = await supabase.from('geometry_catalog').delete().eq('id', id);
    if (error) { console.error('Error deleting catalog item:', error); return false; }
    return true;
  },
};

// ── Katalog kartı önizlemesi (basit üç.js sahnesi) ──────────────────────────
const createGeometryFromType = (type: string, p: any = {}): THREE.BufferGeometry => {
  switch (type) {
    case 'cylinder': return new THREE.CylinderGeometry(p.radius || 50, p.radius || 50, p.height || 100, p.segments || 32);
    case 'sphere': return new THREE.SphereGeometry(p.radius || 50, p.widthSegments || 32, p.heightSegments || 32);
    default: return new THREE.BoxGeometry(p.width || 100, p.height || 100, p.depth || 100);
  }
};
const GeometryPreview: React.FC<{ geometryData: any }> = ({ geometryData }) => {
  const geometry = useMemo(() => createGeometryFromType(geometryData.type, geometryData.parameters), [geometryData]);
  const cameraDistance = useMemo(() => {
    const size = new THREE.Box3().setFromObject(new THREE.Mesh(geometry)).getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z) * 2.2;
  }, [geometry]);
  return (
    <div className="w-full aspect-square rounded-lg overflow-hidden bg-gradient-to-br from-slate-100 to-slate-200">
      <Canvas dpr={[1, 2]} gl={{ alpha: false, antialias: true }}>
        <color attach="background" args={['#f8fafc']} />
        <PerspectiveCamera makeDefault position={[cameraDistance, cameraDistance * 0.7, cameraDistance * 0.8]} fov={40} />
        <OrbitControls enableZoom enablePan={false} target={[0, 0, 0]} />
        <ambientLight intensity={1.2} />
        <directionalLight position={[5, 10, 5]} intensity={1.4} />
        <directionalLight position={[-5, -5, -5]} intensity={0.5} />
        <mesh geometry={geometry}><meshStandardMaterial color={geometryData.color || '#2563eb'} metalness={0.3} roughness={0.4} /></mesh>
      </Canvas>
    </div>
  );
};

// ── Katalog paneli (sürüklenebilir pencere) ─────────────────────────────────
const CatalogPanel: React.FC<{ isOpen: boolean; onClose: () => void; onLoad: (item: CatalogItem) => void | Promise<void>; onDelete: (id: string) => void; items: CatalogItem[] }> =
  ({ isOpen, onClose, onLoad, onDelete, items }) => {
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
    const allTags = Array.from(new Set(items.flatMap(item => item.tags)));
    const filteredItems = items.filter(item => !selectedTag || item.tags.includes(selectedTag));

    useEffect(() => { if (isOpen) setPosition({ x: window.innerWidth / 2 - 400, y: window.innerHeight / 2 - 350 }); }, [isOpen]);
    useEffect(() => {
      if (!drag) return;
      const onMove = (e: MouseEvent) => setPosition({ x: e.clientX - drag.x, y: e.clientY - drag.y });
      const onUp = () => setDrag(null);
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
      return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    }, [drag]);
    if (!isOpen) return null;

    const actionBtn = (enabled: boolean, cls: string, onClick: () => void, icon: React.ReactNode, label: string) => (
      <button onClick={onClick} disabled={!enabled}
        className={`px-3 py-1.5 text-xs font-medium rounded transition-all flex items-center gap-1 ${enabled ? cls : 'bg-stone-300 text-stone-500 cursor-not-allowed'}`}>
        {icon}{label}
      </button>
    );
    const tagBtn = (tag: string | null, label: string, count: number) => (
      <button key={tag ?? '__all'} onClick={() => setSelectedTag(tag)}
        className={`w-full text-left px-3 py-2 text-xs font-medium rounded transition-colors flex items-center justify-between ${tag ? 'uppercase' : ''} ${selectedTag === tag ? 'bg-orange-600 text-white' : 'bg-white text-slate-700 hover:bg-stone-200'}`}>
        <span>{label}</span><span className="text-xs">{count}</span>
      </button>
    );
    return (
      <div className="fixed inset-0 z-50 pointer-events-none">
        <div className="absolute bg-stone-50 rounded-2xl shadow-2xl w-full max-w-3xl h-[700px] border border-stone-300 flex flex-col pointer-events-auto"
          style={{ left: `${position.x}px`, top: `${position.y}px`, cursor: drag ? 'grabbing' : 'default' }}
          onMouseDown={e => { if ((e.target as HTMLElement).closest('.drag-handle')) setDrag({ x: e.clientX - position.x, y: e.clientY - position.y }); }}>
          <div className="drag-handle flex items-center justify-between px-5 py-4 cursor-grab active:cursor-grabbing">
            <h1 className="text-xl font-bold text-slate-900">Geometry Catalog</h1>
            <div className="flex items-center gap-2">
              {actionBtn(!!selectedItem, 'bg-orange-600 text-white hover:bg-orange-700', () => { if (selectedItem) { onLoad(selectedItem); setSelectedItem(null); } }, <Plus size={14} strokeWidth={2} />, 'Insert')}
              {actionBtn(!!selectedItem, 'bg-orange-400 text-white hover:bg-orange-500', () => { if (selectedItem && confirm(`Delete "${selectedItem.code}"?`)) { onDelete(selectedItem.id); setSelectedItem(null); } }, <Trash2 size={14} strokeWidth={2} />, 'Delete')}
              <button onClick={onClose} className="p-1.5 rounded hover:bg-stone-200 transition-colors ml-1"><X size={16} className="text-slate-700" /></button>
            </div>
          </div>
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-x-auto px-5 pb-5">
              <div className="flex gap-3">
                {filteredItems.map(item => (
                  <div key={item.id} onClick={() => setSelectedItem(item)}
                    className={`flex-shrink-0 w-44 rounded-lg p-3 transition-all cursor-pointer border-2 ${selectedItem?.id === item.id ? 'border-orange-500 bg-white shadow-lg' : 'border-orange-300 bg-orange-50 hover:border-orange-400 hover:shadow-md'}`}>
                    {item.preview_image
                      ? <div className="w-full aspect-square rounded-lg overflow-hidden bg-gradient-to-br from-slate-100 to-slate-200"><img src={item.preview_image} alt={item.code} className="w-full h-full object-contain" /></div>
                      : <GeometryPreview geometryData={item.geometry_data} />}
                    <div className="mt-2"><h3 className="font-semibold text-slate-900 text-xs leading-tight">{item.code} / {item.description || 'No description'}</h3></div>
                  </div>
                ))}
              </div>
            </div>
            <div className="w-48 bg-stone-100 flex flex-col">
              <div className="p-4">
                <h3 className="text-[10px] font-semibold text-slate-600 mb-3 uppercase tracking-wide">Categories</h3>
                <div className="space-y-1.5">
                  {tagBtn(null, 'All Items', items.length)}
                  {allTags.map(tag => tagBtn(tag, tag, items.filter(item => item.tags.includes(tag)).length))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

// ── Uygulama ────────────────────────────────────────────────────────────────
/** Gövde başına çocuk panel id kümesi (panel-kümesi izleyicisi). */
const panelSetsByParent = (shapes: Shape[]) => {
  const m = new Map<string, Set<string>>();
  for (const s of shapes) {
    const pid = s.type === 'panel' ? s.parameters?.parentShapeId : undefined;
    if (pid) { if (!m.has(pid)) m.set(pid, new Set()); m.get(pid)!.add(s.id); }
  }
  return m;
};

function App() {
  const { opencascadeLoading, setOpenCascadeLoading, addShape } = useStoreFields('opencascadeLoading', 'setOpenCascadeLoading', 'addShape');
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);

  // PANEL-KÜMESİ İZLEYİCİSİ: bir gövdenin çocuk panel kümesi değişince (ekleme /
  // silme) o gövdenin panelleri yeniden üretilir — tek rebuild giriş noktası.
  useEffect(() => {
    let prev = panelSetsByParent(useAppStore.getState().shapes);
    return useAppStore.subscribe((state, prevState) => {
      if (state.shapes === prevState.shapes) return;
      const next = panelSetsByParent(state.shapes);
      const dirty = new Set<string>();
      for (const [pid, set] of prev) { const cur = next.get(pid); if (![...set].every(id => cur?.has(id))) dirty.add(pid); }
      for (const [pid, set] of next) { const old = prev.get(pid); if (![...set].every(id => old?.has(id))) dirty.add(pid); }
      prev = next;
      for (const pid of dirty) if (state.shapes.some(s => s.id === pid)) void requestRebuild(pid);
    });
  }, []);

  // OpenCascade / vaat hataları sayfayı yeniden yüklemesin.
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (e.message?.includes('BindingError') || e.message?.includes('OpenCascade')) { e.preventDefault(); console.error('Caught global error (prevented reload):', e.message); }
    };
    const onUnhandledRejection = (e: PromiseRejectionEvent) => { e.preventDefault(); console.warn('Caught unhandled rejection (prevented reload):', String(e.reason?.message || e.reason || '')); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onUnhandledRejection); };
  }, []);

  const loadCatalogItems = async () => {
    try { const items = await catalogService.getAll(); setCatalogItems(items); console.log('Loaded catalog items:', items.length); }
    catch (error) { console.error('Failed to load catalog items:', error); }
  };
  useEffect(() => { void loadCatalogItems(); }, []);
  useEffect(() => {
    setOpenCascadeLoading(true);
    initReplicad().catch(err => console.error('Failed to preload OpenCascade:', err)).finally(() => setOpenCascadeLoading(false));
  }, []);

  const handleOpenCatalog = async () => { await loadCatalogItems(); setCatalogOpen(true); };

  // KATALOGDAN YÜKLE: kutu − çıkarmalar (+ kayıtlı filletler, merkezler olduğu gibi).
  const handleLoadFromCatalog = async (item: CatalogItem) => {
    console.log('Loading item from catalog:', item.code);
    try {
      const geometryData = item.geometry_data, shapeParams = item.shape_parameters || {};
      const subtractions = (item.subtraction_geometries || []).filter((s: any) => s !== null);
      const fillets = item.fillets || [];
      const size = {
        width: shapeParams.width || geometryData.parameters?.width || 600,
        height: shapeParams.height || geometryData.parameters?.height || 600,
        depth: shapeParams.depth || geometryData.parameters?.depth || 600,
      };
      const r = await rebuildBodySolid({ parameters: size, fillets }, subtractions, size, false);
      const restoredSubtractionGeometries = subtractions.map((sub: any) => {
        const w = parseFloat(sub.parameters?.width) || sub.geometrySize?.[0] || 100;
        const h = parseFloat(sub.parameters?.height) || sub.geometrySize?.[1] || 100;
        const d = parseFloat(sub.parameters?.depth) || sub.geometrySize?.[2] || 100;
        const geometry = new THREE.BoxGeometry(w, h, d); geometry.translate(w / 2, h / 2, d / 2);
        return { geometry, relativeOffset: sub.relativeOffset || [0, 0, 0], relativeRotation: sub.relativeRotation || [0, 0, 0], scale: sub.scale || [1, 1, 1], parameters: sub.parameters };
      });
      addShape({
        id: `${geometryData.type || 'box'}-${Date.now()}`, type: geometryData.type || 'box',
        geometry: r.geometry, replicadShape: r.replicadShape,
        position: [0, 0, 0], rotation: geometryData.rotation || [0, 0, 0], scale: geometryData.scale || [1, 1, 1],
        color: shapeParams.color || geometryData.color || '#2563eb',
        parameters: { ...size, scaledBaseVertices: r.scaledBaseVertices },
        vertexModifications: shapeParams.vertexModifications || geometryData.vertexModifications || [],
        subtractionGeometries: restoredSubtractionGeometries, fillets: r.fillets,
      });
      console.log('Shape loaded from catalog:', { code: item.code, dimensions: size, subtractions: restoredSubtractionGeometries.length, fillets: fillets.length });
      setCatalogOpen(false);
    } catch (error) {
      console.error('Failed to load shape from catalog:', error);
      alert('Failed to load shape from catalog. Please try again.');
    }
  };
  const handleDeleteFromCatalog = async (id: string) => {
    try { await catalogService.delete(id); await loadCatalogItems(); console.log('Item deleted from catalog:', id); }
    catch (error) { console.error('Failed to delete from catalog:', error); }
  };

  return (
    <div className="flex flex-col h-screen bg-stone-100">
      {opencascadeLoading && (
        <div className="fixed inset-0 bg-stone-900 bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 flex flex-col items-center gap-3">
            <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
            <div className="text-sm font-medium text-slate-700">Loading OpenCascade...</div>
            <div className="text-xs text-slate-500">Please wait a moment</div>
          </div>
        </div>
      )}
      <Toolbar onOpenCatalog={handleOpenCatalog} />
      <div className="flex-1 overflow-hidden relative">
        <Scene />
        <Sidebar parametersContent={<ParametersPanel />} panelEditorContent={<PanelEditor />} />
      </div>
      <div className="relative">
        <Terminal />
        <StatusBar />
      </div>
      <CatalogPanel isOpen={catalogOpen} onClose={() => setCatalogOpen(false)} onLoad={handleLoadFromCatalog} onDelete={handleDeleteFromCatalog} items={catalogItems} />
    </div>
  );
}

export default App;

/* ═══════════════════════════════════════════════════════════════════════════
   PARAMETRE PANELİ — tasarım dili Panel Editör ile birebir: satırlar aynı soft
   kart, bölüm başlıkları aynı "eyebrow", değer alanı kutusuz (yago-param-input).
   ═══════════════════════════════════════════════════════════════════════════ */
interface CustomParameter { id: string; name: string; expression: string; result: number; description: string }
type ExprResult = { expression: string; result: number };
type SubKey = 'width' | 'height' | 'depth' | 'posX' | 'posY' | 'posZ' | 'rotX' | 'rotY' | 'rotZ';
const SUB_KEYS: SubKey[] = ['width', 'height', 'depth', 'posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ'];
const SUB_ROWS: Array<[SubKey, string, string]> = [
  ['width', 'W', 'Width'], ['height', 'H', 'Height'], ['depth', 'D', 'Depth'],
  ['posX', 'X', 'Position X'], ['posY', 'Y', 'Position Y'], ['posZ', 'Z', 'Position Z'],
  ['rotX', 'RX', 'Rotation X'], ['rotY', 'RY', 'Rotation Y'], ['rotZ', 'RZ', 'Rotation Z'],
];
const RAD2DEG = 180 / Math.PI;

const P_ROW = 'group/prow flex items-center gap-1.5 h-[30px] pl-1 pr-1 rounded-[9px] bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] focus-within:!bg-white focus-within:!ring-[#f0d6ba] transition-colors duration-150';
const P_LABEL = 'shrink-0 w-[30px] text-center text-[11px] font-semibold tracking-wide tabular-nums select-none';
const P_INPUT = 'yago-param-input shrink-0 w-[84px] h-[22px] px-1.5 text-[12px] font-mono tabular-nums text-stone-800 bg-transparent border border-transparent rounded-[6px] outline-none placeholder:text-stone-300 hover:border-[#ebe5dc] focus:bg-white focus:border-orange-400/50 transition-colors';
const P_RESULT = 'shrink-0 w-[56px] text-right text-[11px] tabular-nums text-stone-400 select-none';
const P_DESC = 'flex-1 min-w-0 truncate pl-1 text-[11px] text-stone-400 select-none';
const P_NOTE = 'yago-row-note flex-1 min-w-0 h-[22px] px-[5px] text-[11.5px] text-stone-600 bg-transparent border border-transparent rounded-[5px] outline-none placeholder:text-stone-300 hover:border-[#ebe5dc] focus:bg-white focus:border-orange-400/50 transition-colors';
const P_ICON_BTN = 'shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700 transition-colors duration-150';
const P_DEL_BTN = `${P_ICON_BTN} opacity-0 group-hover/prow:opacity-100 focus-visible:opacity-100 hover:!bg-red-50 hover:!text-red-500`;

const ParamSection: React.FC<{ title: string; count?: number; accent?: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, count, accent, right, children }) => (
  <div className="mt-3 first:mt-0">
    <div className="px-1 pb-1.5 flex items-center gap-2">
      <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: accent || '#b5ada3', fontFamily: UI_FONT }}>{title}</span>
      {count !== undefined && <span className="text-[10px] font-medium tabular-nums text-stone-300">{count}</span>}
      <div className="flex-1 h-px bg-[#efeae2]" />
      {right}
    </div>
    <div className="flex flex-col gap-[2px] p-px">{children}</div>
  </div>
);
const DelBtn = ({ title, onClick, className = P_DEL_BTN }: { title: string; onClick: () => void; className?: string }) => (
  <button onClick={onClick} title={title} className={className}><Trash2 size={11.5} strokeWidth={1.9} /></button>
);

/** Sayısal parametre satırı: yerel metin taslağı, geçerli sayı yazıldıkça onChange; blur'da normalize. */
const ParameterRow: React.FC<{ label: string; value: number; onChange: (v: number) => void; unit: string; description: string; trailing?: React.ReactNode }> =
  ({ label, value, onChange, unit, description, trailing }) => {
    const [inputValue, setInputValue] = useState(value.toString());
    const [isFocused, setIsFocused] = useState(false);
    useEffect(() => { if (!isFocused) setInputValue(value.toString()); }, [value, isFocused]);
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setInputValue(v);
      if (v !== '' && v !== '-' && v !== '+' && v !== '.') { const p = parseFloat(v); if (!isNaN(p)) onChange(p); }
    };
    const handleBlur = () => {
      setIsFocused(false);
      const p = parseFloat(inputValue);
      if (isNaN(p)) setInputValue(value.toString()); else { onChange(p); setInputValue(p.toString()); }
    };
    return (
      <div className={P_ROW}>
        <span className={P_LABEL} style={{ color: '#a8a29e' }}>{label}</span>
        <input type="text" value={inputValue} onChange={handleChange} onFocus={() => setIsFocused(true)} onBlur={handleBlur} className={P_INPUT} />
        <span className="shrink-0 w-[56px] -ml-1 text-left text-[11px] text-stone-400 select-none">{unit}</span>
        <span className={P_DESC}>{description}</span>
        {trailing}
      </div>
    );
  };
/** İfade satırı (çıkarma / vertex): ifade + çözülen sonuç + açıklama ya da not. */
const ExprRow = ({ label, labelColor, expression, onExpr, result, children }: { label: string; labelColor: string; expression: string; onExpr: (v: string) => void; result: number; children: React.ReactNode }) => (
  <div className={P_ROW}>
    <span className={P_LABEL} style={{ color: labelColor }}>{label}</span>
    <input type="text" value={expression} onChange={e => onExpr(e.target.value)} className={P_INPUT} placeholder="expr" />
    <span className={P_RESULT}>{result.toFixed(2)}</span>
    {children}
  </div>
);

export function ParametersPanel() {
  const {
    selectedShapeId, shapes, updateShape, vertexEditMode, setVertexEditMode,
    subtractionViewMode, setSubtractionViewMode, selectedSubtractionIndex, setSelectedSubtractionIndex,
    deleteSubtraction, filletMode, setFilletMode, setFaceEditMode, selectedFilletFaces, clearFilletFaces, clearFilletFaceData,
  } = useStoreFields('selectedShapeId', 'shapes', 'updateShape', 'vertexEditMode', 'setVertexEditMode', 'subtractionViewMode', 'setSubtractionViewMode',
    'selectedSubtractionIndex', 'setSelectedSubtractionIndex', 'deleteSubtraction', 'filletMode', 'setFilletMode', 'setFaceEditMode', 'selectedFilletFaces', 'clearFilletFaces', 'clearFilletFaceData');

  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [depth, setDepth] = useState(0);
  const [rot, setRot] = useState<[number, number, number]>([0, 0, 0]);
  const [customParameters, setCustomParameters] = useState<CustomParameter[]>([]);
  const [vertexModifications, setVertexModifications] = useState<any[]>([]);
  const [filletRadii, setFilletRadii] = useState<number[]>([]);
  const initSub = () => Object.fromEntries(SUB_KEYS.map(k => [k, { expression: '0', result: 0 }])) as Record<SubKey, ExprResult>;
  const [subParams, setSubParams] = useState<Record<SubKey, ExprResult>>(initSub);

  const selectedShape = shapeById(selectedShapeId, shapes);
  const getEvalContext = () => ({ W: width, H: height, D: depth, ...customParameters.reduce((acc, p) => ({ ...acc, [p.name]: p.result }), {}) });

  useEffect(() => {
    if (selectedShape?.parameters) {
      setWidth(selectedShape.parameters.width || 0);
      setHeight(selectedShape.parameters.height || 0);
      setDepth(selectedShape.parameters.depth || 0);
      setRot([0, 1, 2].map(i => (selectedShape.rotation?.[i] || 0) * RAD2DEG) as [number, number, number]);
      setCustomParameters(selectedShape.parameters.customParameters || []);
      setVertexModifications(selectedShape.vertexModifications || []);
      setFilletRadii((selectedShape.fillets || []).map((f: any) => f.radius));
    } else {
      setWidth(0); setHeight(0); setDepth(0); setRot([0, 0, 0]);
      setCustomParameters([]); setVertexModifications([]); setFilletRadii([]);
    }
  }, [selectedShape, selectedShapeId, shapes]);

  // Seçili çıkarmanın ifadeleri: kayıtlı parametre varsa o, yoksa geometriden okunan değer.
  useEffect(() => {
    if (!selectedShape || selectedSubtractionIndex === null) return;
    const sub = selectedShape.subtractionGeometries?.[selectedSubtractionIndex];
    const pos = sub?.geometry?.getAttribute('position');
    if (!sub || !pos) return;
    const size = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute).getSize(new THREE.Vector3());
    const p = sub.parameters, off = sub.relativeOffset, rr = sub.relativeRotation;
    const raw: Record<SubKey, string> = {
      width: p?.width ?? String(size.x), height: p?.height ?? String(size.y), depth: p?.depth ?? String(size.z),
      posX: p?.posX ?? String(off?.[0] || 0), posY: p?.posY ?? String(off?.[1] || 0), posZ: p?.posZ ?? String(off?.[2] || 0),
      rotX: p?.rotX ?? String((rr?.[0] || 0) * RAD2DEG), rotY: p?.rotY ?? String((rr?.[1] || 0) * RAD2DEG), rotZ: p?.rotZ ?? String((rr?.[2] || 0) * RAD2DEG),
    };
    const ctx = getEvalContext();
    setSubParams(Object.fromEntries(SUB_KEYS.map(k => [k, { expression: raw[k], result: evaluateExpression(raw[k], ctx) }])) as Record<SubKey, ExprResult>);
  }, [selectedShape?.id, selectedSubtractionIndex, selectedShape?.subtractionGeometries?.length, width, height, depth, customParameters]);

  const handleSubParamChange = (param: SubKey, expression: string) =>
    setSubParams(prev => ({ ...prev, [param]: { expression, result: evaluateExpression(expression, getEvalContext()) } }));

  const persistCustom = (updated: CustomParameter[]) => {
    setCustomParameters(updated);
    if (selectedShape) updateShape(selectedShape.id, { parameters: { ...selectedShape.parameters, customParameters: updated } });
  };
  const addCustomParameter = () => persistCustom([...customParameters, { id: `param-${Date.now()}`, name: `P${customParameters.length + 1}`, expression: '0', result: 0, description: 'Custom Parameter' }]);
  const updateCustomParameter = (id: string, field: keyof CustomParameter, value: string) =>
    setCustomParameters(customParameters.map(param => {
      if (param.id !== id) return param;
      const p = { ...param, [field]: value };
      if (field === 'expression') p.result = evaluateExpression(value, getEvalContext());
      return p;
    }));

  const updateVertexModification = (index: number, field: string, value: any) =>
    setVertexModifications(vertexModifications.map((mod, idx) => {
      if (idx !== index) return mod;
      const u = { ...mod, [field]: value };
      if (field === 'expression') {
        // SÖZLEŞME (terminal girişi ve Uygula ile AYNI): ifade, seçilen eksendeki
        // MUTLAK koordinattır (yönlü ofset değil).
        const result = evaluateExpression(value, getEvalContext());
        const ai = axisIndexOf(mod.direction);
        const np = [...mod.originalPosition] as [number, number, number]; np[ai] = result;
        const off: [number, number, number] = [0, 0, 0]; off[ai] = result - mod.originalPosition[ai];
        u.newPosition = np; u.offset = off;
      }
      return u;
    }));
  // VERTEX DÜZENLEMESİ SİL (Goker: "eklenen vertex satırı silinemiyor"): hem
  // panel durumundan hem şekilden kaldırılır → mesh aynı anda eski hâline döner
  // (gövde geometrisi hep TABAN'dır; düzenlemeler çizimde üstüne uygulanır).
  const deleteVertexModification = (index: number) => {
    const updated = vertexModifications.filter((_, i) => i !== index);
    setVertexModifications(updated);
    if (selectedShape) {
      updateShape(selectedShape.id, { vertexModifications: updated });
      // Paneller gövdenin geri dönen şekline göre yeniden üretilir.
      const sid = selectedShape.id;
      if (childPanelsOf(sid).length) requestRebuild(sid).catch(e => console.error('[YAGO][VERTEX] rebuild hatası:', e));
    }
    console.log('[YAGO][VERTEX] düzenleme silindi, kalanN=', updated.length);
  };

  const handleApplyChanges = async () => {
    const currentShape = shapeById(selectedShapeId);
    if (!currentShape) return;
    const ctx = getEvalContext();
    const evalSub = Object.fromEntries(SUB_KEYS.map(k => [k, { expression: subParams[k].expression, result: evaluateExpression(subParams[k].expression, ctx) }])) as Record<SubKey, ExprResult>;
    await applyShapeChanges({
      selectedShape: { ...currentShape, position: [...currentShape.position] as [number, number, number] }, width, height, depth, rotX: rot[0], rotY: rot[1], rotZ: rot[2],
      customParameters, vertexModifications, filletRadii, selectedSubtractionIndex,
      subWidth: evalSub.width.result, subHeight: evalSub.height.result, subDepth: evalSub.depth.result,
      subPosX: evalSub.posX.result, subPosY: evalSub.posY.result, subPosZ: evalSub.posZ.result,
      subRotX: evalSub.rotX.result, subRotY: evalSub.rotY.result, subRotZ: evalSub.rotZ.result,
      subParams: evalSub, updateShape,
    });
    if (selectedShapeId) await requestRebuild(selectedShapeId);
  };

  // FİLLET SİL: gövde çıkarmalarıyla baştan kurulur, kalan filletler tazelenip uygulanır.
  const handleDeleteFillet = async (filletIndex: number) => {
    const currentShape = shapeById(selectedShapeId);
    if (!currentShape) return;
    const newFillets = (currentShape.fillets || []).filter((_: any, i: number) => i !== filletIndex);
    try {
      const r = await rebuildBodySolid({ parameters: currentShape.parameters, fillets: newFillets }, currentShape.subtractionGeometries, { width, height, depth });
      updateShape(currentShape.id, {
        geometry: r.geometry, replicadShape: r.replicadShape, fillets: r.fillets,
        position: [...currentShape.position] as [number, number, number],
        parameters: { ...currentShape.parameters, scaledBaseVertices: r.scaledBaseVertices },
      });
      setFilletRadii(filletRadii.filter((_, i) => i !== filletIndex));
    } catch (error) { console.error('Failed to delete fillet:', error); }
  };

  const subtractionCount = selectedShape?.subtractionGeometries?.filter(s => s !== null).length ?? 0;
  // ÜST ARAÇ ÇUBUĞU — Panel Editor ile ORTAK bileşen (ToolChip).
  const paramToolbar = (
    <ToolChipBar>
      <ToolChip label="Vertex" icon={Spline} active={vertexEditMode} title="Edit vertices"
        onClick={() => { setVertexEditMode(!vertexEditMode); if (!vertexEditMode) { setFilletMode(false); setFaceEditMode(false); } }} />
      {subtractionCount > 0 && (
        <ToolChip label="Subtract" icon={Layers} active={subtractionViewMode} badge={subtractionCount} title="Show subtractions"
          onClick={() => { setSubtractionViewMode(!subtractionViewMode); if (!subtractionViewMode) { setFilletMode(false); setFaceEditMode(false); } }} />
      )}
      <ToolChip label="Fillet" icon={Radius} active={filletMode} badge={selectedFilletFaces.length > 0 ? `${selectedFilletFaces.length}/2` : undefined} title="Fillet two faces"
        onClick={() => { const n = !filletMode; setFilletMode(n); setFaceEditMode(n); clearFilletFaces(); clearFilletFaceData(); if (n) { setVertexEditMode(false); setSubtractionViewMode(false); } }} />
      <ToolChip label="Parameter" icon={Plus} onClick={addCustomParameter} title="Add a custom parameter" />
    </ToolChipBar>
  );

  const paramContent = selectedShape ? (
    <div>
      {/* ÖLÇÜLER — alt alta (Goker): Genişlik / Yükseklik / Derinlik */}
      <ParamSection title="Dimensions">
        <ParameterRow label="W" value={width} onChange={setWidth} unit="mm" description="Width" />
        <ParameterRow label="H" value={height} onChange={setHeight} unit="mm" description="Height" />
        <ParameterRow label="D" value={depth} onChange={setDepth} unit="mm" description="Depth" />
      </ParamSection>
      <ParamSection title="Rotation">
        {(['X', 'Y', 'Z'] as const).map((ax, i) => (
          <ParameterRow key={ax} label={`R${ax}`} value={rot[i]} unit="°" description={`${ax} axis`}
            onChange={v => setRot(prev => { const n = [...prev] as [number, number, number]; n[i] = v; return n; })} />
        ))}
      </ParamSection>
      {filletRadii.length > 0 && (
        <ParamSection title="Fillet" count={filletRadii.length}>
          {filletRadii.map((radius, idx) => (
            <ParameterRow key={`fillet-${idx}`} label={`F${idx + 1}`} value={radius} unit="mm" description={`Fillet ${idx + 1} radius`}
              onChange={v => { const r = [...filletRadii]; r[idx] = v; setFilletRadii(r); }}
              trailing={<DelBtn title="Delete fillet" onClick={() => { void handleDeleteFillet(idx); }} />} />
          ))}
        </ParamSection>
      )}
      {customParameters.length > 0 && (
        <ParamSection title="Parameters" count={customParameters.length}>
          {customParameters.map(param => (
            <div key={param.id} className={P_ROW}>
              <input type="text" value={param.name} onChange={e => updateCustomParameter(param.id, 'name', e.target.value)} className={`${P_INPUT} !w-[40px] text-center !font-semibold`} />
              <input type="text" value={param.expression} onChange={e => updateCustomParameter(param.id, 'expression', e.target.value)} className={`${P_INPUT} !w-[74px]`} placeholder="expr" />
              <span className={P_RESULT}>{param.result.toFixed(2)}</span>
              <input type="text" value={param.description} onChange={e => updateCustomParameter(param.id, 'description', e.target.value)} className={P_NOTE} placeholder="note…" />
              <DelBtn title="Delete" onClick={() => persistCustom(customParameters.filter(p => p.id !== param.id))} />
            </div>
          ))}
        </ParamSection>
      )}
      {subtractionViewMode && selectedSubtractionIndex !== null && selectedShape.subtractionGeometries?.[selectedSubtractionIndex] && (
        <ParamSection title={`Subtraction #${selectedSubtractionIndex + 1}`} accent="#b45309"
          right={
            <div className="flex items-center gap-px">
              <DelBtn title="Delete subtraction" className={`${P_ICON_BTN} hover:!bg-red-50 hover:!text-red-500`} onClick={() => { void deleteSubtraction(selectedShape.id, selectedSubtractionIndex); }} />
              <button onClick={() => setSelectedSubtractionIndex(null)} className={P_ICON_BTN} title="Close"><X size={12} strokeWidth={2} /></button>
            </div>
          }>
          {SUB_ROWS.map(([key, label, desc]) => (
            <ExprRow key={key} label={label} labelColor="#b45309" expression={subParams[key].expression} onExpr={v => handleSubParamChange(key, v)} result={subParams[key].result}>
              <span className={P_DESC}>{desc}</span>
            </ExprRow>
          ))}
        </ParamSection>
      )}
      {/* Düzenlemeler Vertex modu kapalıyken de görünür → her zaman silinebilir. */}
      {vertexModifications.length > 0 && (
        <ParamSection title="Vertex edits" count={vertexModifications.length}>
          {vertexModifications.map((mod, idx) => (
            <ExprRow key={idx} label={`V${mod.vertexIndex}`} labelColor="#a8a29e" expression={mod.expression} onExpr={v => updateVertexModification(idx, 'expression', v)}
              result={evaluateExpression(mod.expression, getEvalContext())}>
              <input type="text" value={mod.description || ''} onChange={e => updateVertexModification(idx, 'description', e.target.value)} className={P_NOTE} placeholder="note…" />
              <DelBtn title="Delete vertex edit" onClick={() => deleteVertexModification(idx)} />
            </ExprRow>
          ))}
        </ParamSection>
      )}
      {/* Uygula — Panel Editör'ün onay düğmesiyle aynı koyu taş dil. */}
      <button onClick={handleApplyChanges}
        className="w-full mt-3 h-[30px] rounded-[8px] bg-[#44403c] text-white text-[11.5px] font-semibold tracking-[0.01em] shadow-[0_1px_3px_rgba(40,30,20,0.22)] hover:bg-[#57534e] active:bg-[#292524] transition-colors duration-150 flex items-center justify-center gap-1.5">
        <Check size={13} strokeWidth={2.4} /> Apply
      </button>
    </div>
  ) : <div className="text-center text-stone-400 text-[11.5px] py-6">No shape selected</div>;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-stone-100 flex items-center justify-between shrink-0">{paramToolbar}</div>
      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pt-2 pb-2">{paramContent}</div>
    </div>
  );
}
