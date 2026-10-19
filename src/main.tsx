import { useState, useEffect } from 'react';
import * as THREE from 'three';
import { createRoot } from 'react-dom/client';
import { type Shape, useStoreFields, useAppStore, requestRebuild } from './store';
import { type CatalogItem, catalogService, Toolbar, Sidebar, ParametersPanel, Terminal, StatusBar, CatalogPanel, ErrorBoundary } from './components/Ui';
import { initReplicad, rebuildBodySolid } from './components/Geometry';
import Scene from './components/Scene';
import { PanelEditor } from './components/PanelEditor';
// Yan etki: rebuild motoru store'a kaydolur (bkz. store.requestRebuild).
import './components/PanelEngine';
import './index.css';

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

  // Çocuk panel kümesi değişince (ekle/sil) gövdenin panelleri yeniden üretilir — tek rebuild giriş noktası.
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
      if (!e.message?.includes('BindingError') && !e.message?.includes('OpenCascade')) return;
      e.preventDefault();
      console.error('Caught global error (prevented reload):', e.message);
    };
    const onUnhandledRejection = (e: PromiseRejectionEvent) => e.preventDefault();
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onUnhandledRejection); };
  }, []);

  const loadCatalogItems = async () => {
    try { const items = await catalogService.getAll(); setCatalogItems(items); }
    catch (error) { console.error('Failed to load catalog items:', error); }
  };
  useEffect(() => { void loadCatalogItems(); }, []);
  useEffect(() => {
    setOpenCascadeLoading(true);
    initReplicad().catch(err => console.error('Failed to preload OpenCascade:', err)).finally(() => setOpenCascadeLoading(false));
  }, []);

  const handleOpenCatalog = async () => { await loadCatalogItems(); setCatalogOpen(true); };

  // Katalogdan yükle: kutu − çıkarmalar (+ kayıtlı filletler).
  const handleLoadFromCatalog = async (item: CatalogItem) => {
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
        return {
          geometry, relativeOffset: sub.relativeOffset || [0, 0, 0], relativeRotation: sub.relativeRotation || [0, 0, 0],
          scale: sub.scale || [1, 1, 1], parameters: sub.parameters,
        };
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
      setCatalogOpen(false);
    } catch (error) {
      console.error('Failed to load shape from catalog:', error);
      alert('Failed to load shape from catalog. Please try again.');
    }
  };
  const handleDeleteFromCatalog = async (id: string) => {
    try { await catalogService.delete(id); await loadCatalogItems(); }
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
      <CatalogPanel isOpen={catalogOpen} onClose={() => setCatalogOpen(false)} onLoad={handleLoadFromCatalog}
        onDelete={handleDeleteFromCatalog} items={catalogItems} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
