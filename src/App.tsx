import React, { useEffect, useState } from 'react';
import * as THREE from 'three';
import Scene from './components/Scene';
import Toolbar from './components/Toolbar';
import Terminal from './components/Terminal';
import StatusBar from './components/StatusBar';
import CatalogPanel from './components/CatalogPanel';
import { useAppStore } from './store';
import { catalogService, CatalogItem } from './components/Database';

function App() {
  const { opencascadeLoading, addShape } = useAppStore();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);

  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (e.message?.includes('BindingError') || e.message?.includes('OpenCascade')) {
        e.preventDefault();
        console.error('Caught global error (prevented reload):', e.message);
      }
    };
    const onUnhandledRejection = (e: PromiseRejectionEvent) => {
      const msg = String(e.reason?.message || e.reason || '');
      if (msg.includes('BindingError') || msg.includes('OpenCascade') || msg.includes('replicad')) {
        e.preventDefault();
        console.error('Caught unhandled rejection (prevented reload):', msg);
      }
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    loadCatalogItems();
  }, []);

  const loadCatalogItems = async () => {
    try {
      const items = await catalogService.getAll();
      setCatalogItems(items);
      console.log('Loaded catalog items:', items.length);
    } catch (error) {
      console.error('Failed to load catalog items:', error);
    }
  };

  const handleOpenCatalog = async () => {
    await loadCatalogItems();
    setCatalogOpen(true);
  };

  const handleLoadFromCatalog = async (item: CatalogItem) => {
    console.log('Loading item from catalog:', item.code);

    try {
      const { createReplicadBox, convertReplicadToThreeGeometry, performBooleanCut } = await import('./components/ReplicadService');
      const { getReplicadVertices } = await import('./components/VertexEditorService');

      const geometryData = item.geometry_data;
      const shapeParams = item.shape_parameters || {};
      const subtractionGeometries = item.subtraction_geometries || [];
      const fillets = item.fillets || [];
      const faceRoles = item.face_roles || {};

      const width = shapeParams.width || geometryData.parameters?.width || 600;
      const height = shapeParams.height || geometryData.parameters?.height || 600;
      const depth = shapeParams.depth || geometryData.parameters?.depth || 600;

      let replicadShape = await createReplicadBox({ width, height, depth });

      for (const subtraction of subtractionGeometries) {
        if (!subtraction) continue;

        const subWidth = parseFloat(subtraction.parameters?.width) || subtraction.geometrySize?.[0] || 100;
        const subHeight = parseFloat(subtraction.parameters?.height) || subtraction.geometrySize?.[1] || 100;
        const subDepth = parseFloat(subtraction.parameters?.depth) || subtraction.geometrySize?.[2] || 100;

        const subShape = await createReplicadBox({
          width: subWidth,
          height: subHeight,
          depth: subDepth
        });

        replicadShape = await performBooleanCut(
          replicadShape,
          subShape,
          undefined,
          subtraction.relativeOffset || [0, 0, 0],
          undefined,
          subtraction.relativeRotation || [0, 0, 0],
          undefined,
          subtraction.scale || [1, 1, 1]
        );
      }

      if (fillets && fillets.length > 0) {
        const { applyFillets } = await import('./components/ShapeUpdaterService');
        replicadShape = await applyFillets(replicadShape, fillets, { width, height, depth });
      }

      const geometry = convertReplicadToThreeGeometry(replicadShape);
      const baseVertices = await getReplicadVertices(replicadShape);

      const restoredSubtractionGeometries = subtractionGeometries.filter((s: any) => s !== null).map((sub: any) => {
        const subWidth = parseFloat(sub.parameters?.width) || sub.geometrySize?.[0] || 100;
        const subHeight = parseFloat(sub.parameters?.height) || sub.geometrySize?.[1] || 100;
        const subDepth = parseFloat(sub.parameters?.depth) || sub.geometrySize?.[2] || 100;

        const subGeometry = new THREE.BoxGeometry(subWidth, subHeight, subDepth);
        subGeometry.translate(subWidth / 2, subHeight / 2, subDepth / 2);

        return {
          geometry: subGeometry,
          relativeOffset: sub.relativeOffset || [0, 0, 0],
          relativeRotation: sub.relativeRotation || [0, 0, 0],
          scale: sub.scale || [1, 1, 1],
          parameters: sub.parameters
        };
      });

      const newShape = {
        id: `${geometryData.type || 'box'}-${Date.now()}`,
        type: geometryData.type || 'box',
        geometry,
        replicadShape,
        position: [0, 0, 0] as [number, number, number],
        rotation: geometryData.rotation || [0, 0, 0] as [number, number, number],
        scale: geometryData.scale || [1, 1, 1] as [number, number, number],
        color: shapeParams.color || geometryData.color || '#2563eb',
        parameters: {
          width,
          height,
          depth,
          scaledBaseVertices: baseVertices.map(v => [v.x, v.y, v.z])
        },
        vertexModifications: shapeParams.vertexModifications || geometryData.vertexModifications || [],
        subtractionGeometries: restoredSubtractionGeometries,
        fillets: fillets,
        faceRoles: faceRoles
      };

      addShape(newShape);

      console.log('Shape loaded from catalog:', {
        code: item.code,
        dimensions: { width, height, depth },
        subtractions: restoredSubtractionGeometries.length,
        fillets: fillets.length,
        faceRoles: Object.keys(faceRoles).length
      });

      setCatalogOpen(false);
    } catch (error) {
      console.error('Failed to load shape from catalog:', error);
      alert('Failed to load shape from catalog. Please try again.');
    }
  };

  const handleDeleteFromCatalog = async (id: string) => {
    try {
      await catalogService.delete(id);
      await loadCatalogItems();
      console.log('Item deleted from catalog:', id);
    } catch (error) {
      console.error('Failed to delete from catalog:', error);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-stone-100">
      {opencascadeLoading && (
        <div className="fixed inset-0 bg-stone-900 bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 flex flex-col items-center gap-3">
            <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
            <div className="text-sm font-medium text-slate-700">Loading OpenCascade...</div>
            <div className="text-xs text-slate-500">Please wait a moment</div>
          </div>
        </div>
      )}
      <Toolbar onOpenCatalog={handleOpenCatalog} />
      <div className="flex-1 overflow-hidden relative">
        <Scene />
      </div>
      <div className="relative">
        <Terminal />
        <StatusBar />
      </div>

      <CatalogPanel
        isOpen={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onLoad={handleLoadFromCatalog}
        onDelete={handleDeleteFromCatalog}
        items={catalogItems}
      />
    </div>
  );
}

export default App;
