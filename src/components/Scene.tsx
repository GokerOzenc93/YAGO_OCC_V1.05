import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, PerspectiveCamera, OrthographicCamera } from '@react-three/drei';
import * as THREE from 'three';
import { useAppStore, CameraType } from '../store';
import { useShallow } from 'zustand/react/shallow';
import ContextMenu from './ContextMenu';
import SaveDialog from './SaveDialog';
import { catalogService } from './Database';
import { VertexEditor } from './VertexEditor';
import { applyFilletToShape } from './Fillet';
import { ShapeWithTransform } from './ShapeWithTransform';
import { getReplicadVertices } from './VertexEditorService';
import { PanelDrawing } from './PanelDrawing';
import { ErrorBoundary } from './ErrorBoundary';

const CameraController: React.FC<{ controlsRef: React.RefObject<any>, cameraType: CameraType }> = ({ controlsRef, cameraType }) => {
  const cameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera>(null);
  const savedStateRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3; zoom: number; perspectiveFov: number } | null>(null);
  const prevCameraTypeRef = useRef<CameraType>(cameraType);

  useEffect(() => {
    if (prevCameraTypeRef.current !== cameraType && savedStateRef.current && cameraRef.current && controlsRef.current) {
      cameraRef.current.position.copy(savedStateRef.current.position);
      controlsRef.current.target.copy(savedStateRef.current.target);

      if (cameraType === CameraType.ORTHOGRAPHIC && cameraRef.current instanceof THREE.OrthographicCamera) {
        const distance = savedStateRef.current.position.distanceTo(savedStateRef.current.target);
        const fovRad = (savedStateRef.current.perspectiveFov || 45) * Math.PI / 180;
        const visibleHeight = 2 * distance * Math.tan(fovRad / 2);
        cameraRef.current.zoom = window.innerHeight / visibleHeight;
        cameraRef.current.updateProjectionMatrix();
      }

      controlsRef.current.update();
    }
    prevCameraTypeRef.current = cameraType;
  }, [cameraType, controlsRef]);

  useEffect(() => {
    const saveState = () => {
      if (cameraRef.current && controlsRef.current) {
        savedStateRef.current = {
          position: cameraRef.current.position.clone(),
          target: controlsRef.current.target.clone(),
          zoom: cameraRef.current instanceof THREE.OrthographicCamera ? cameraRef.current.zoom : 1,
          perspectiveFov: cameraRef.current instanceof THREE.PerspectiveCamera ? cameraRef.current.fov : 45
        };
      }
    };

    const interval = setInterval(saveState, 100);
    return () => clearInterval(interval);
  }, [controlsRef]);

  // Kamera içine eklenen directionalLight "Headlight" görevi görür.
  const Headlight = () => <directionalLight position={[0, 0, 1]} intensity={0.8} />;

  if (cameraType === CameraType.PERSPECTIVE) {
    return (
      <PerspectiveCamera
        ref={cameraRef as React.RefObject<THREE.PerspectiveCamera>}
        makeDefault
        position={savedStateRef.current?.position.toArray() || [2000, 2000, 2000]}
        fov={45}
        near={1}
        far={50000}
      >
        <Headlight />
      </PerspectiveCamera>
    );
  }

  return (
    <OrthographicCamera
      ref={cameraRef as React.RefObject<THREE.OrthographicCamera>}
      makeDefault
      position={savedStateRef.current?.position.toArray() || [2000, 2000, 2000]}
      zoom={0.25}
      near={-50000}
      far={50000}
    >
      <Headlight />
    </OrthographicCamera>
  );
};

const Scene: React.FC = () => {
  const controlsRef = useRef<any>(null);
  const {
    shapes,
    cameraType,
    selectedShapeId,
    secondarySelectedShapeId,
    selectShape,
    deleteShape,
    copyShape,
    isolateShape,
    exitIsolation,
    vertexEditMode,
    setVertexEditMode,
    selectedVertexIndex,
    setSelectedVertexIndex,
    vertexDirection,
    setVertexDirection,
    clearFilletFaces,
    setFaceEditMode
  } = useAppStore(useShallow(state => ({
    shapes: state.shapes,
    cameraType: state.cameraType,
    selectedShapeId: state.selectedShapeId,
    secondarySelectedShapeId: state.secondarySelectedShapeId,
    selectShape: state.selectShape,
    deleteShape: state.deleteShape,
    copyShape: state.copyShape,
    isolateShape: state.isolateShape,
    exitIsolation: state.exitIsolation,
    vertexEditMode: state.vertexEditMode,
    setVertexEditMode: state.setVertexEditMode,
    selectedVertexIndex: state.selectedVertexIndex,
    setSelectedVertexIndex: state.setSelectedVertexIndex,
    vertexDirection: state.vertexDirection,
    setVertexDirection: state.setVertexDirection,
    clearFilletFaces: state.clearFilletFaces,
    setFaceEditMode: state.setFaceEditMode
  })));

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; shapeId: string; shapeType: string } | null>(null);
  const [saveDialog, setSaveDialog] = useState<{ isOpen: boolean; shapeId: string | null }>({ isOpen: false, shapeId: null });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selectedShapeId) {
        deleteShape(selectedShapeId);
      } else if (e.key === 'Escape') {
        selectShape(null);
        exitIsolation();
        setVertexEditMode(false);
        setFaceEditMode(false);
        clearFilletFaces();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedShapeId, deleteShape, selectShape, exitIsolation, setVertexEditMode, setFaceEditMode, clearFilletFaces]);

  const handleCreated = useCallback(({ gl }: { gl: THREE.WebGLRenderer }) => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.outputColorSpace = THREE.SRGBColorSpace;
  }, []);

  const handleContextMenu = useCallback((e: any, shapeId: string) => {
    const state = useAppStore.getState();
    if (state.vertexEditMode || state.faceEditMode) return;
    e.nativeEvent.preventDefault();
    state.selectShape(shapeId);
    const shape = state.shapes.find(s => s.id === shapeId);
    setContextMenu({
      x: e.nativeEvent.clientX,
      y: e.nativeEvent.clientY,
      shapeId,
      shapeType: shape?.type || 'unknown'
    });
  }, []);

  const captureSnapshot = (): string => {
    const canvas = document.querySelector('canvas');
    return canvas ? canvas.toDataURL('image/png') : '';
  };

  return (
    <>
      <ErrorBoundary>
        <Canvas
          shadows
          gl={{
            antialias: true,
            preserveDrawingBuffer: true,
            powerPreference: 'high-performance',
            logarithmicDepthBuffer: true 
          }}
          dpr={[1, 2]}
          onContextMenu={(e) => e.preventDefault()}
          onCreated={handleCreated}
        >
          <color attach="background" args={['#f5f5f4']} />
          
          <CameraController controlsRef={controlsRef} cameraType={cameraType} />

          {/* Ortam Aydınlatması - Gölgeleri yumuşatır */}
          <ambientLight intensity={0.7} />
          <hemisphereLight intensity={0.4} groundColor="#888888" color="#ffffff" />

          {/* Global Gölge Işığı - Sadece derinlik katar, parlamaya neden olmaz */}
          <directionalLight
            position={[2000, 5000, 2000]}
            intensity={0.4}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-bias={-0.0001}
            shadow-camera-far={15000}
            shadow-camera-left={-5000}
            shadow-camera-right={5000}
            shadow-camera-top={5000}
            shadow-camera-bottom={-5000}
          />

          <OrbitControls
            ref={controlsRef}
            makeDefault
            enableDamping
            dampingFactor={0.05}
            maxDistance={25000}
            minDistance={50}
          />

          {shapes.map((shape) => {
            const isSelected = selectedShapeId === shape.id;
            if (shape.type === 'panel') {
              return <PanelDrawing key={shape.id} shape={shape} isSelected={isSelected} />;
            }
            return (
              <React.Fragment key={shape.id}>
                <ShapeWithTransform
                  shape={shape}
                  isSelected={isSelected}
                  orbitControlsRef={controlsRef}
                  onContextMenu={handleContextMenu}
                />
                {isSelected && vertexEditMode && (
                  <VertexEditor
                    shape={shape}
                    isActive={true}
                    onVertexSelect={(index) => setSelectedVertexIndex(index)}
                    onDirectionChange={(dir) => setVertexDirection(dir)}
                  />
                )}
              </React.Fragment>
            );
          })}

          {/* Yumuşak Yer Gölgesi */}
          <mesh position={[0, -1, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[50000, 50000]} />
            <shadowMaterial opacity={0.1} />
          </mesh>

          <GizmoHelper alignment="bottom-right" margin={[80, 100]}>
            <GizmoViewport axisColors={['#f87171', '#4ade80', '#60a5fa']} labelColor="white" />
          </GizmoHelper>
        </Canvas>
      </ErrorBoundary>

      {contextMenu && (
        <ContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          shapeId={contextMenu.shapeId}
          // ... diğer propslar aynı
          onClose={() => setContextMenu(null)}
        />
      )}

      <SaveDialog
        isOpen={saveDialog.isOpen}
        onClose={() => setSaveDialog({ isOpen: false, shapeId: null })}
        shapeId={saveDialog.shapeId || ''}
        captureSnapshot={captureSnapshot}
        // ... onSave aynı
      />
    </>
  );
};

export default Scene;