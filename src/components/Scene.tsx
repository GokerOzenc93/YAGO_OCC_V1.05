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

  if (cameraType === CameraType.PERSPECTIVE) {
    return (
      <PerspectiveCamera
        ref={cameraRef as React.RefObject<THREE.PerspectiveCamera>}
        makeDefault
        position={savedStateRef.current?.position.toArray() || [2000, 2000, 2000]}
        fov={45}
        near={1}
        far={50000}
      />
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
    />
  );
};

const Scene: React.FC = () => {
  const controlsRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
    addVertexModification,
    subtractionViewMode,
    faceEditMode,
    setFaceEditMode,
    filletMode,
    selectedFilletFaces,
    clearFilletFaces,
    selectedFilletFaceData,
    updateShape,
    panelSelectMode,
    panelSurfaceSelectMode,
    setSelectedPanelRow
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
    addVertexModification: state.addVertexModification,
    subtractionViewMode: state.subtractionViewMode,
    faceEditMode: state.faceEditMode,
    setFaceEditMode: state.setFaceEditMode,
    filletMode: state.filletMode,
    selectedFilletFaces: state.selectedFilletFaces,
    clearFilletFaces: state.clearFilletFaces,
    selectedFilletFaceData: state.selectedFilletFaceData,
    updateShape: state.updateShape,
    panelSelectMode: state.panelSelectMode,
    panelSurfaceSelectMode: state.panelSurfaceSelectMode,
    setSelectedPanelRow: state.setSelectedPanelRow
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
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        if (selectedShapeId && secondarySelectedShapeId) {
          const { createGroup } = useAppStore.getState();
          createGroup(selectedShapeId, secondarySelectedShapeId);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'u') {
        e.preventDefault();
        if (selectedShapeId) {
          const shape = shapes.find(s => s.id === selectedShapeId);
          if (shape?.groupId) {
            const { ungroupShapes } = useAppStore.getState();
            ungroupShapes(shape.groupId);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedShapeId, secondarySelectedShapeId, shapes, deleteShape, selectShape, exitIsolation, setVertexEditMode, setFaceEditMode, clearFilletFaces]);

  useEffect(() => {
    (window as any).handleVertexOffset = async (newValue: number) => {
      const currentState = useAppStore.getState();
      const currentSelectedShapeId = currentState.selectedShapeId;
      const currentSelectedVertexIndex = currentState.selectedVertexIndex;
      const currentVertexDirection = currentState.vertexDirection;

      if (currentSelectedShapeId && currentSelectedVertexIndex !== null && currentVertexDirection) {
        const shape = currentState.shapes.find(s => s.id === currentSelectedShapeId);
        if (shape && shape.parameters) {
          console.log('📝 Processing vertex offset:', { newValue, vertexIndex: currentSelectedVertexIndex, direction: currentVertexDirection });

          let baseVertices: number[][] = [];

          if (shape.parameters.scaledBaseVertices && shape.parameters.scaledBaseVertices.length > 0) {
            console.log('📍 Using pre-computed scaled base vertices for offset calculation...');
            baseVertices = shape.parameters.scaledBaseVertices;
            console.log(`✅ Using ${baseVertices.length} scaled base vertices`);
          } else if (shape.replicadShape) {
            console.log('🔍 Getting vertices from Replicad shape for offset calculation...');
            const { getReplicadVertices } = await import('./VertexEditorService');
            const verts = await getReplicadVertices(shape.replicadShape);
            baseVertices = verts.map(v => [v.x, v.y, v.z]);
            console.log(`✅ Got ${baseVertices.length} vertices from Replicad`);
          } else if (shape.type === 'box') {
            const { getBoxVertices } = await import('./VertexEditorService');
            const verts = getBoxVertices(
              shape.parameters.width,
              shape.parameters.height,
              shape.parameters.depth
            );
            baseVertices = verts.map(v => [v.x, v.y, v.z]);
            console.log(`✅ Got ${baseVertices.length} vertices from box parameters`);
          }

          if (currentSelectedVertexIndex >= baseVertices.length) {
            console.error('❌ Invalid vertex index:', currentSelectedVertexIndex);
            return;
          }

          const originalPos = baseVertices[currentSelectedVertexIndex];

          const axisIndex = currentVertexDirection.startsWith('x') ? 0 : currentVertexDirection.startsWith('y') ? 1 : 2;

          const newPosition: [number, number, number] = [...originalPos];
          newPosition[axisIndex] = newValue;

          const offsetAmount = newValue - originalPos[axisIndex];
          const offset: [number, number, number] = [0, 0, 0];
          offset[axisIndex] = offsetAmount;

          const axisName = currentVertexDirection[0].toUpperCase();
          const directionSymbol = currentVertexDirection[1] === '+' ? '+' : '-';

          console.log(`🎯 Absolute position applied:`, {
            direction: currentVertexDirection,
            userInput: newValue,
            originalPosAxis: originalPos[axisIndex].toFixed(1),
            newPosAxis: newPosition[axisIndex].toFixed(1),
            offsetAmount: offsetAmount.toFixed(1),
            explanation: `${axisName}${directionSymbol} → move to ${newValue} (offset: ${offsetAmount.toFixed(1)})`
          });

          currentState.addVertexModification(currentSelectedShapeId, {
            vertexIndex: currentSelectedVertexIndex,
            originalPosition: originalPos as [number, number, number],
            newPosition,
            direction: currentVertexDirection,
            expression: String(newValue),
            description: `Vertex ${currentSelectedVertexIndex} ${axisName}${directionSymbol}`,
            offset
          });

          console.log(`✅ Vertex ${currentSelectedVertexIndex}:`, {
            base: `[${originalPos[0].toFixed(1)}, ${originalPos[1].toFixed(1)}, ${originalPos[2].toFixed(1)}]`,
            userValue: newValue,
            axis: axisName,
            offset: `[${offset[0].toFixed(1)}, ${offset[1].toFixed(1)}, ${offset[2].toFixed(1)}]`,
            final: `[${newPosition[0].toFixed(1)}, ${newPosition[1].toFixed(1)}, ${newPosition[2].toFixed(1)}]`
          });
        }

        (window as any).pendingVertexEdit = false;
        currentState.setSelectedVertexIndex(null);
      }
    };

    (window as any).pendingVertexEdit = selectedVertexIndex !== null && vertexDirection !== null;

    return () => {
      delete (window as any).handleVertexOffset;
      delete (window as any).pendingVertexEdit;
    };
  }, [selectedVertexIndex, vertexDirection]);

  useEffect(() => {
    (window as any).handleFilletRadius = async (radius: number) => {
      const currentState = useAppStore.getState();
      const currentSelectedShapeId = currentState.selectedShapeId;
      const currentFilletMode = currentState.filletMode;
      const currentSelectedFilletFaces = currentState.selectedFilletFaces;
      const currentSelectedFilletFaceData = currentState.selectedFilletFaceData;

      if (currentSelectedShapeId && currentFilletMode && currentSelectedFilletFaces.length === 2 && currentSelectedFilletFaceData.length === 2) {
        const shape = currentState.shapes.find(s => s.id === currentSelectedShapeId);
        if (!shape || !shape.replicadShape) {
          console.error('❌ Shape or replicadShape not found');
          return;
        }

        try {
          console.log('🎯 BEFORE FILLET - Shape position:', shape.position);

          const oldCenter = new THREE.Vector3();
          if (shape.geometry) {
            const oldBox = new THREE.Box3().setFromBufferAttribute(shape.geometry.getAttribute('position'));
            oldBox.getCenter(oldCenter);
            console.log('📍 Center BEFORE adding fillet:', oldCenter);
          }

          const result = await applyFilletToShape(
            shape,
            currentSelectedFilletFaces,
            currentSelectedFilletFaceData,
            radius
          );

          const newBaseVertices = await getReplicadVertices(result.replicadShape);

          const newCenter = new THREE.Vector3();
          const newBox = new THREE.Box3().setFromBufferAttribute(result.geometry.getAttribute('position'));
          newBox.getCenter(newCenter);
          console.log('📍 Center AFTER adding fillet:', newCenter);

          const centerOffset = new THREE.Vector3().subVectors(newCenter, oldCenter);
          console.log('📍 Center offset (local):', centerOffset);

          const rotatedOffset = centerOffset.clone();
          if (shape.rotation[0] !== 0 || shape.rotation[1] !== 0 || shape.rotation[2] !== 0) {
            const rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(
              new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ')
            );
            rotatedOffset.applyMatrix4(rotationMatrix);
            console.log('📍 Center offset (rotated):', rotatedOffset);
          }

          const finalPosition: [number, number, number] = [
            shape.position[0] - rotatedOffset.x,
            shape.position[1] - rotatedOffset.y,
            shape.position[2] - rotatedOffset.z
          ];

          console.log('🎯 AFTER FILLET - Adjusted position from', shape.position, 'to', finalPosition);

          currentState.updateShape(currentSelectedShapeId, {
            geometry: result.geometry,
            replicadShape: result.replicadShape,
            position: finalPosition,
            rotation: shape.rotation,
            scale: shape.scale,
            parameters: {
              ...shape.parameters,
              scaledBaseVertices: newBaseVertices.map(v => [v.x, v.y, v.z]),
              width: shape.parameters.width || 1,
              height: shape.parameters.height || 1,
              depth: shape.parameters.depth || 1
            },
            fillets: [
              ...(shape.fillets || []),
              result.filletData
            ]
          });

          console.log(`✅ Fillet with radius ${radius} applied successfully and saved to shape.fillets!`);
          const newState = useAppStore.getState();
          const updatedShape = newState.shapes.find(s => s.id === selectedShapeId);
          console.log(`📍 After update, shape.fillets.length: ${updatedShape?.fillets?.length || 0}`);
          newState.clearFilletFaces();
          console.log('✅ Fillet faces cleared. Select 2 new faces for another fillet operation.');
        } catch (error) {
          console.error('❌ Failed to apply fillet:', error);
          alert(`Failed to apply fillet: ${(error as Error).message}`);
        }
      }

      (window as any).pendingFilletOperation = false;
    };

    (window as any).pendingFilletOperation = filletMode && selectedFilletFaces.length === 2;

    return () => {
      delete (window as any).handleFilletRadius;
      delete (window as any).pendingFilletOperation;
    };
  }, [filletMode, selectedFilletFaces.length]);

  const handleContextMenu = useCallback((e: any, shapeId: string) => {
    const state = useAppStore.getState();
    if (state.vertexEditMode || state.faceEditMode) {
      return;
    }
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
    if (!canvas) return '';
    return canvas.toDataURL('image/png');
  };

  const serializeSubtractionGeometries = (subtractionGeometries: any[] | undefined) => {
    if (!subtractionGeometries || subtractionGeometries.length === 0) return [];

    return subtractionGeometries.filter(sub => sub !== null).map(sub => {
      const serialized: any = {
        relativeOffset: sub.relativeOffset,
        relativeRotation: sub.relativeRotation,
        scale: sub.scale,
        parameters: sub.parameters
      };

      if (sub.geometry) {
        const posAttr = sub.geometry.getAttribute('position');
        if (posAttr) {
          const box = new THREE.Box3().setFromBufferAttribute(posAttr);
          const size = new THREE.Vector3();
          box.getSize(size);
          serialized.geometrySize = [size.x, size.y, size.z];
        }
      }

      return serialized;
    });
  };

  const handleSave = async (data: { code: string; description: string; tags: string[]; previewImage?: string }) => {
    if (!saveDialog.shapeId) return;

    const shape = shapes.find(s => s.id === saveDialog.shapeId);
    if (!shape) return;

    try {
      let geometryData: any;
      let shapeParameters: any = {};
      let subtractionGeometriesData: any[] = [];
      let filletsData: any[] = [];
      let faceRolesData: Record<number, string> = {};

      if (shape.groupId) {
        const groupShapes = shapes.filter(s => s.groupId === shape.groupId);
        geometryData = {
          type: 'group',
          shapes: groupShapes.map(s => ({
            type: s.type,
            position: s.position,
            rotation: s.rotation,
            scale: s.scale,
            color: s.color,
            parameters: s.parameters,
            vertexModifications: s.vertexModifications || [],
            isReferenceBox: s.isReferenceBox
          }))
        };

        console.log('Saving group:', {
          code: data.code,
          shapeCount: groupShapes.length,
          groupId: shape.groupId
        });
      } else {
        geometryData = {
          type: shape.type,
          position: shape.position,
          rotation: shape.rotation,
          scale: shape.scale,
          color: shape.color,
          parameters: shape.parameters,
          vertexModifications: shape.vertexModifications || []
        };

        shapeParameters = {
          width: shape.parameters?.width,
          height: shape.parameters?.height,
          depth: shape.parameters?.depth,
          color: shape.color,
          position: shape.position,
          rotation: shape.rotation,
          scale: shape.scale,
          vertexModifications: shape.vertexModifications || []
        };

        subtractionGeometriesData = serializeSubtractionGeometries(shape.subtractionGeometries);

        if (shape.fillets && shape.fillets.length > 0) {
          filletsData = shape.fillets.map(fillet => ({
            face1Descriptor: fillet.face1Descriptor,
            face2Descriptor: fillet.face2Descriptor,
            face1Data: fillet.face1Data,
            face2Data: fillet.face2Data,
            radius: fillet.radius,
            originalSize: fillet.originalSize
          }));
        }

        if (shape.faceRoles) {
          faceRolesData = Object.entries(shape.faceRoles).reduce((acc, [key, value]) => {
            if (value) acc[Number(key)] = value;
            return acc;
          }, {} as Record<number, string>);
        }

        console.log('Saving geometry with full parameters:', {
          code: data.code,
          type: shape.type,
          parameters: shapeParameters,
          subtractionCount: subtractionGeometriesData.length,
          filletsCount: filletsData.length,
          faceRolesCount: Object.keys(faceRolesData).length
        });
      }

      await catalogService.save({
        code: data.code,
        description: data.description,
        tags: data.tags,
        geometry_data: geometryData,
        shape_parameters: shapeParameters,
        subtraction_geometries: subtractionGeometriesData,
        fillets: filletsData,
        face_roles: faceRolesData,
        preview_image: data.previewImage
      });

      console.log('Geometry saved to catalog:', data.code);
      alert('Geometry saved successfully!');
      setSaveDialog({ isOpen: false, shapeId: null });
    } catch (error) {
      console.error('Failed to save geometry:', error);
      alert('Failed to save geometry. Please try again.');
    }
  };

  const handleCreated = useCallback(({ gl }: { gl: THREE.WebGLRenderer }) => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.outputColorSpace = THREE.SRGBColorSpace;

    const canvas = gl.domElement;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('WebGL context lost - preventing page reload');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      console.log('WebGL context restored');
    });
  }, []);

  return (
    <>
      <ErrorBoundary>
      <Canvas
        shadows
        gl={{
          antialias: true,
          alpha: false,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance'
        }}
        dpr={[1, 1.5]}
        onContextMenu={(e) => e.preventDefault()}
        onCreated={handleCreated}
      >
        <color attach="background" args={['#f5f5f4']} />

      <CameraController controlsRef={controlsRef} cameraType={cameraType} />

      <ambientLight intensity={0.7} />
      <hemisphereLight intensity={0.5} groundColor="#888888" color="#ffffff" />
      <directionalLight
        position={[2000, 3000, 2000]}
        intensity={1.6}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-bias={-0.0001}
        shadow-camera-far={20000}
        shadow-camera-left={-5000}
        shadow-camera-right={5000}
        shadow-camera-top={5000}
        shadow-camera-bottom={-5000}
      />
      <directionalLight
        position={[-1000, 1500, -1000]}
        intensity={0.5}
      />
      <directionalLight
        position={[0, 2000, -2000]}
        intensity={0.4}
      />
      <directionalLight
        position={[500, 500, 3000]}
        intensity={0.4}
      />

      <OrbitControls
        ref={controlsRef}
        makeDefault
        target={[0, 0, 0]}
        enableDamping
        dampingFactor={0.05}
        rotateSpeed={0.8}
        maxDistance={25000}
        minDistance={50}
      />


      {shapes.map((shape) => {
        const isSelected = selectedShapeId === shape.id;

        if (shape.type === 'panel') {
          return (
            <PanelDrawing
              key={shape.id}
              shape={shape}
              isSelected={isSelected}
            />
          );
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
                onOffsetConfirm={(vertexIndex, direction, offset) => {
                  console.log('Offset confirmed:', { vertexIndex, direction, offset });
                }}
              />
            )}
          </React.Fragment>
        );
      })}

      <mesh
        position={[0, -2, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[30000, 30000]} />
        <shadowMaterial opacity={0.15} />
      </mesh>

      <GizmoHelper alignment="bottom-right" margin={[80, 100]}>
        <GizmoViewport
          axisColors={['#f87171', '#4ade80', '#60a5fa']}
          labelColor="white"
        />
      </GizmoHelper>
    </Canvas>
    </ErrorBoundary>

    {contextMenu && (
      <ContextMenu
        position={{ x: contextMenu.x, y: contextMenu.y }}
        shapeId={contextMenu.shapeId}
        shapeType={contextMenu.shapeType}
        onClose={() => setContextMenu(null)}
        onEdit={() => {
          isolateShape(contextMenu.shapeId);
          setContextMenu(null);
        }}
        onCopy={() => {
          copyShape(contextMenu.shapeId);
          setContextMenu(null);
        }}
        onMove={() => {
          console.log('Move:', contextMenu.shapeId);
          setContextMenu(null);
        }}
        onRotate={() => {
          console.log('Rotate:', contextMenu.shapeId);
          setContextMenu(null);
        }}
        onDelete={() => {
          deleteShape(contextMenu.shapeId);
          setContextMenu(null);
        }}
        onToggleVisibility={() => {
          console.log('Toggle visibility:', contextMenu.shapeId);
          setContextMenu(null);
        }}
        onSave={() => {
          setSaveDialog({ isOpen: true, shapeId: contextMenu.shapeId });
          setContextMenu(null);
        }}
      />
    )}

    <SaveDialog
      isOpen={saveDialog.isOpen}
      onClose={() => setSaveDialog({ isOpen: false, shapeId: null })}
      onSave={handleSave}
      shapeId={saveDialog.shapeId || ''}
      captureSnapshot={captureSnapshot}
    />
    </>
  );
};

export default Scene;
