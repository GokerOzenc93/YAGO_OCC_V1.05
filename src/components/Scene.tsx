import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, PerspectiveCamera, OrthographicCamera, Html } from '@react-three/drei';
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

/* ─────────────────────────────────────────────
   CUBE GIZMO
   Renders a small orientation cube synced to the scene camera.
   Clicking a face snaps the orbit camera to that view.
───────────────────────────────────────────── */
const FACE_LABELS = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'];
const FACE_COLORS = {
  hover: '#e8622a',
  default: 'rgba(23,23,26,0.92)',
  border: 'rgba(255,255,255,0.10)',
  text: 'rgba(232,232,234,0.9)',
  textHover: '#fff',
};

// normals matching +X -X +Y -Y +Z -Z
const FACE_NORMALS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

const CubeGizmo: React.FC<{ orbitRef: React.RefObject<any> }> = ({ orbitRef }) => {
  const { camera } = useThree();
  const cubeRef = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  // Sync cube rotation to camera every frame (inverted)
  useFrame(() => {
    if (!cubeRef.current) return;
    const quat = camera.quaternion.clone().invert();
    cubeRef.current.quaternion.copy(quat);
  });

  const snapTo = useCallback((faceIndex: number) => {
    if (!orbitRef.current) return;
    const normal = new THREE.Vector3(...FACE_NORMALS[faceIndex]);
    const target: THREE.Vector3 = orbitRef.current.target.clone();
    const distance = camera.position.distanceTo(target);
    const newPos = target.clone().add(normal.clone().multiplyScalar(distance));

    // Animate
    const startPos = camera.position.clone();
    const startTime = performance.now();
    const duration = 400;

    const animate = () => {
      const t = Math.min((performance.now() - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      camera.position.lerpVectors(startPos, newPos, ease);
      // keep up-vector stable
      if (faceIndex === 2) camera.up.set(0, 0, -1);
      else if (faceIndex === 3) camera.up.set(0, 0, 1);
      else camera.up.set(0, 1, 0);
      camera.lookAt(orbitRef.current.target);
      orbitRef.current.update();
      if (t < 1) requestAnimationFrame(animate);
    };
    animate();
  }, [camera, orbitRef]);

  // Box geometry split into 6 face meshes
  const faceMeshes = FACE_NORMALS.map((normal, i) => {
    const [nx, ny, nz] = normal;
    const position: [number, number, number] = [nx * 0.501, ny * 0.501, nz * 0.501];
    // rotation so face points outward
    const euler = new THREE.Euler();
    if (i === 0) euler.set(0, -Math.PI / 2, 0);
    else if (i === 1) euler.set(0, Math.PI / 2, 0);
    else if (i === 2) euler.set(-Math.PI / 2, 0, 0);
    else if (i === 3) euler.set(Math.PI / 2, 0, 0);
    else if (i === 4) euler.set(0, 0, 0);
    else euler.set(0, Math.PI, 0);

    const isHov = hovered === i;
    return (
      <mesh
        key={i}
        position={position}
        rotation={euler}
        onPointerEnter={(e) => { e.stopPropagation(); setHovered(i); document.body.style.cursor = 'pointer'; }}
        onPointerLeave={() => { setHovered(null); document.body.style.cursor = 'auto'; }}
        onClick={(e) => { e.stopPropagation(); snapTo(i); }}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          color={isHov ? FACE_COLORS.hover : '#1a1a1e'}
          transparent
          opacity={isHov ? 0.95 : 0.88}
          side={THREE.FrontSide}
        />
        <Html
          center
          style={{
            pointerEvents: 'none',
            userSelect: 'none',
            fontSize: '7px',
            fontWeight: 700,
            fontFamily: 'Syne, system-ui, sans-serif',
            letterSpacing: '0.06em',
            color: isHov ? FACE_COLORS.textHover : FACE_COLORS.text,
            whiteSpace: 'nowrap',
            textShadow: isHov ? '0 0 8px rgba(232,98,42,0.6)' : 'none',
            transition: 'color 0.15s',
          }}
        >
          {FACE_LABELS[i]}
        </Html>
      </mesh>
    );
  });

  // Edge lines for the cube outline
  const edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));

  return (
    <group ref={cubeRef}>
      {/* Cube faces */}
      {faceMeshes}

      {/* Outline edges */}
      <lineSegments geometry={edgeGeo}>
        <lineBasicMaterial color="rgba(255,255,255,0.15)" transparent opacity={0.18} />
      </lineSegments>

      {/* Corner dots */}
      {[
        [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5],
        [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5],
      ].map((pos, i) => (
        <mesh key={`corner-${i}`} position={pos as [number, number, number]}>
          <sphereGeometry args={[0.045, 8, 8]} />
          <meshBasicMaterial color="#e8622a" transparent opacity={0.7} />
        </mesh>
      ))}

      {/* Axis stub lines (X=red, Y=green, Z=blue) — always shows orientation */}
      {([
        { dir: [0.72, 0, 0], color: '#f87171' },
        { dir: [0, 0.72, 0], color: '#4ade80' },
        { dir: [0, 0, 0.72], color: '#60a5fa' },
      ] as { dir: [number, number, number]; color: string }[]).map(({ dir, color }, i) => {
        const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(...dir)];
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        return (
          <lineSegments key={`axis-${i}`} geometry={geo}>
            <lineBasicMaterial color={color} transparent opacity={0.55} linewidth={2} />
          </lineSegments>
        );
      })}
    </group>
  );
};

/* ─────────────────────────────────────────────
   CAMERA CONTROLLER (unchanged)
───────────────────────────────────────────── */
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
      <PerspectiveCamera ref={cameraRef as React.RefObject<THREE.PerspectiveCamera>} makeDefault
        position={savedStateRef.current?.position.toArray() || [2000, 2000, 2000]} fov={45} near={1} far={50000} />
    );
  }
  return (
    <OrthographicCamera ref={cameraRef as React.RefObject<THREE.OrthographicCamera>} makeDefault
      position={savedStateRef.current?.position.toArray() || [2000, 2000, 2000]} zoom={0.25} near={-50000} far={50000} />
  );
};

/* ─────────────────────────────────────────────
   SCENE
───────────────────────────────────────────── */
const Scene: React.FC = () => {
  const controlsRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const {
    shapes, cameraType, selectedShapeId, secondarySelectedShapeId, selectShape,
    deleteShape, copyShape, isolateShape, exitIsolation,
    vertexEditMode, setVertexEditMode, selectedVertexIndex, setSelectedVertexIndex,
    vertexDirection, setVertexDirection, addVertexModification,
    subtractionViewMode, faceEditMode, setFaceEditMode,
    filletMode, selectedFilletFaces, clearFilletFaces, selectedFilletFaceData,
    updateShape, panelSelectMode, panelSurfaceSelectMode, setSelectedPanelRow
  } = useAppStore(useShallow(state => ({
    shapes: state.shapes, cameraType: state.cameraType,
    selectedShapeId: state.selectedShapeId, secondarySelectedShapeId: state.secondarySelectedShapeId,
    selectShape: state.selectShape, deleteShape: state.deleteShape, copyShape: state.copyShape,
    isolateShape: state.isolateShape, exitIsolation: state.exitIsolation,
    vertexEditMode: state.vertexEditMode, setVertexEditMode: state.setVertexEditMode,
    selectedVertexIndex: state.selectedVertexIndex, setSelectedVertexIndex: state.setSelectedVertexIndex,
    vertexDirection: state.vertexDirection, setVertexDirection: state.setVertexDirection,
    addVertexModification: state.addVertexModification, subtractionViewMode: state.subtractionViewMode,
    faceEditMode: state.faceEditMode, setFaceEditMode: state.setFaceEditMode,
    filletMode: state.filletMode, selectedFilletFaces: state.selectedFilletFaces,
    clearFilletFaces: state.clearFilletFaces, selectedFilletFaceData: state.selectedFilletFaceData,
    updateShape: state.updateShape, panelSelectMode: state.panelSelectMode,
    panelSurfaceSelectMode: state.panelSurfaceSelectMode, setSelectedPanelRow: state.setSelectedPanelRow
  })));

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; shapeId: string; shapeType: string } | null>(null);
  const [saveDialog, setSaveDialog] = useState<{ isOpen: boolean; shapeId: string | null }>({ isOpen: false, shapeId: null });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selectedShapeId) {
        deleteShape(selectedShapeId);
      } else if (e.key === 'Escape') {
        selectShape(null); exitIsolation(); setVertexEditMode(false); setFaceEditMode(false); clearFilletFaces();
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
          if (shape?.groupId) { const { ungroupShapes } = useAppStore.getState(); ungroupShapes(shape.groupId); }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedShapeId, secondarySelectedShapeId, shapes, deleteShape, selectShape, exitIsolation, setVertexEditMode, setFaceEditMode, clearFilletFaces]);

  useEffect(() => {
    (window as any).handleVertexOffset = async (newValue: number) => {
      const currentState = useAppStore.getState();
      const { selectedShapeId: sid, selectedVertexIndex: vi, vertexDirection: vd } = currentState;
      if (sid && vi !== null && vd) {
        const shape = currentState.shapes.find(s => s.id === sid);
        if (shape && shape.parameters) {
          let baseVertices: number[][] = [];
          if (shape.parameters.scaledBaseVertices?.length > 0) {
            baseVertices = shape.parameters.scaledBaseVertices;
          } else if (shape.replicadShape) {
            const { getReplicadVertices } = await import('./VertexEditorService');
            const verts = await getReplicadVertices(shape.replicadShape);
            baseVertices = verts.map(v => [v.x, v.y, v.z]);
          } else if (shape.type === 'box') {
            const { getBoxVertices } = await import('./VertexEditorService');
            const verts = getBoxVertices(shape.parameters.width, shape.parameters.height, shape.parameters.depth);
            baseVertices = verts.map(v => [v.x, v.y, v.z]);
          }
          if (vi >= baseVertices.length) return;
          const originalPos = baseVertices[vi];
          const axisIndex = vd.startsWith('x') ? 0 : vd.startsWith('y') ? 1 : 2;
          const newPosition: [number, number, number] = [...originalPos] as [number, number, number];
          newPosition[axisIndex] = newValue;
          const offset: [number, number, number] = [0, 0, 0];
          offset[axisIndex] = newValue - originalPos[axisIndex];
          currentState.addVertexModification(sid, {
            vertexIndex: vi, originalPosition: originalPos as [number, number, number], newPosition,
            direction: vd, expression: String(newValue),
            description: `Vertex ${vi} ${vd[0].toUpperCase()}${vd[1] === '+' ? '+' : '-'}`, offset
          });
        }
        (window as any).pendingVertexEdit = false;
        currentState.setSelectedVertexIndex(null);
      }
    };
    (window as any).pendingVertexEdit = selectedVertexIndex !== null && vertexDirection !== null;
    return () => { delete (window as any).handleVertexOffset; delete (window as any).pendingVertexEdit; };
  }, [selectedVertexIndex, vertexDirection]);

  useEffect(() => {
    (window as any).handleFilletRadius = async (radius: number) => {
      const cs = useAppStore.getState();
      const { selectedShapeId: sid, filletMode: fm, selectedFilletFaces: sff, selectedFilletFaceData: sffd } = cs;
      if (sid && fm && sff.length === 2 && sffd.length === 2) {
        const shape = cs.shapes.find(s => s.id === sid);
        if (!shape || !shape.replicadShape) return;
        try {
          const oldCenter = new THREE.Vector3();
          if (shape.geometry) { const ob = new THREE.Box3().setFromBufferAttribute(shape.geometry.getAttribute('position')); ob.getCenter(oldCenter); }
          const result = await applyFilletToShape(shape, sff, sffd, radius);
          const newBaseVertices = await getReplicadVertices(result.replicadShape);
          const newCenter = new THREE.Vector3();
          const nb = new THREE.Box3().setFromBufferAttribute(result.geometry.getAttribute('position')); nb.getCenter(newCenter);
          const centerOffset = new THREE.Vector3().subVectors(newCenter, oldCenter);
          const rotatedOffset = centerOffset.clone();
          if (shape.rotation[0] !== 0 || shape.rotation[1] !== 0 || shape.rotation[2] !== 0) {
            const rm = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ'));
            rotatedOffset.applyMatrix4(rm);
          }
          cs.updateShape(sid, {
            geometry: result.geometry, replicadShape: result.replicadShape,
            position: [shape.position[0] - rotatedOffset.x, shape.position[1] - rotatedOffset.y, shape.position[2] - rotatedOffset.z],
            rotation: shape.rotation, scale: shape.scale,
            parameters: { ...shape.parameters, scaledBaseVertices: newBaseVertices.map(v => [v.x, v.y, v.z]), width: shape.parameters.width || 1, height: shape.parameters.height || 1, depth: shape.parameters.depth || 1 },
            fillets: [...(shape.fillets || []), result.filletData]
          });
          cs.clearFilletFaces();
        } catch (error) { console.error('❌ Failed to apply fillet:', error); cs.clearFilletFaces(); alert(`Failed to apply fillet: ${(error as Error).message}`); }
      }
      (window as any).pendingFilletOperation = false;
    };
    (window as any).pendingFilletOperation = filletMode && selectedFilletFaces.length === 2;
    return () => { delete (window as any).handleFilletRadius; delete (window as any).pendingFilletOperation; };
  }, [filletMode, selectedFilletFaces.length]);

  const handleContextMenu = useCallback((e: any, shapeId: string) => {
    const state = useAppStore.getState();
    if (state.vertexEditMode || state.faceEditMode) return;
    e.nativeEvent.preventDefault();
    state.selectShape(shapeId);
    const shape = state.shapes.find(s => s.id === shapeId);
    setContextMenu({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY, shapeId, shapeType: shape?.type || 'unknown' });
  }, []);

  const captureSnapshot = (): string => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return '';
    return canvas.toDataURL('image/png');
  };

  const serializeSubtractionGeometries = (subtractionGeometries: any[] | undefined) => {
    if (!subtractionGeometries || subtractionGeometries.length === 0) return [];
    return subtractionGeometries.filter(sub => sub !== null).map(sub => {
      const serialized: any = { relativeOffset: sub.relativeOffset, relativeRotation: sub.relativeRotation, scale: sub.scale, parameters: sub.parameters };
      if (sub.geometry) {
        const posAttr = sub.geometry.getAttribute('position');
        if (posAttr) { const box = new THREE.Box3().setFromBufferAttribute(posAttr); const size = new THREE.Vector3(); box.getSize(size); serialized.geometrySize = [size.x, size.y, size.z]; }
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
        geometryData = { type: 'group', shapes: groupShapes.map(s => ({ type: s.type, position: s.position, rotation: s.rotation, scale: s.scale, color: s.color, parameters: s.parameters, vertexModifications: s.vertexModifications || [], isReferenceBox: s.isReferenceBox })) };
      } else {
        geometryData = { type: shape.type, position: shape.position, rotation: shape.rotation, scale: shape.scale, color: shape.color, parameters: shape.parameters, vertexModifications: shape.vertexModifications || [] };
        shapeParameters = { width: shape.parameters?.width, height: shape.parameters?.height, depth: shape.parameters?.depth, color: shape.color, position: shape.position, rotation: shape.rotation, scale: shape.scale, vertexModifications: shape.vertexModifications || [] };
        subtractionGeometriesData = serializeSubtractionGeometries(shape.subtractionGeometries);
        if (shape.fillets) filletsData = shape.fillets.map(fillet => ({ face1Descriptor: fillet.face1Descriptor, face2Descriptor: fillet.face2Descriptor, face1Data: fillet.face1Data, face2Data: fillet.face2Data, radius: fillet.radius, originalSize: fillet.originalSize }));
        if (shape.faceRoles) faceRolesData = Object.entries(shape.faceRoles).reduce((acc, [key, value]) => { if (value) acc[Number(key)] = value; return acc; }, {} as Record<number, string>);
      }
      await catalogService.save({ code: data.code, description: data.description, tags: data.tags, geometry_data: geometryData, shape_parameters: shapeParameters, subtraction_geometries: subtractionGeometriesData, fillets: filletsData, face_roles: faceRolesData, preview_image: data.previewImage });
      alert('Geometry saved successfully!');
      setSaveDialog({ isOpen: false, shapeId: null });
    } catch (error) { console.error('Failed to save geometry:', error); alert('Failed to save geometry. Please try again.'); }
  };

  const handleCreated = useCallback(({ gl }: { gl: THREE.WebGLRenderer }) => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = gl.domElement;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('WebGL context lost'); });
  }, []);

  return (
    <>
      <ErrorBoundary>
        <Canvas
          shadows
          gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true }}
          dpr={[1, 2]}
          onContextMenu={(e) => e.preventDefault()}
          onCreated={handleCreated}
        >
          <color attach="background" args={['#f5f5f4']} />
          <CameraController controlsRef={controlsRef} cameraType={cameraType} />

          <ambientLight intensity={0.6} />
          <hemisphereLight intensity={0.4} groundColor="#888888" color="#ffffff" />
          <directionalLight position={[1500, 2500, 1500]} intensity={1.8} castShadow
            shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-bias={-0.0005}
            shadow-camera-far={15000} shadow-camera-left={-3000} shadow-camera-right={3000}
            shadow-camera-top={3000} shadow-camera-bottom={-3000} />
          <directionalLight position={[-1000, 1500, -1000]} intensity={0.4} />
          <directionalLight position={[0, 2000, -2000]} intensity={0.3} />
          <directionalLight position={[500, 500, 3000]} intensity={0.5} />

          <OrbitControls ref={controlsRef} makeDefault target={[0, 0, 0]} enableDamping dampingFactor={0.05} rotateSpeed={0.8} maxDistance={25000} minDistance={50} />

          {shapes.map((shape) => {
            const isSelected = selectedShapeId === shape.id;
            if (shape.type === 'panel') return <PanelDrawing key={shape.id} shape={shape} isSelected={isSelected} />;
            return (
              <React.Fragment key={shape.id}>
                <ShapeWithTransform shape={shape} isSelected={isSelected} orbitControlsRef={controlsRef} onContextMenu={handleContextMenu} />
                {isSelected && vertexEditMode && (
                  <VertexEditor shape={shape} isActive={true} onVertexSelect={(index) => setSelectedVertexIndex(index)} onDirectionChange={(dir) => setVertexDirection(dir)} />
                )}
              </React.Fragment>
            );
          })}

          <mesh position={[0, -1, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[30000, 30000]} />
            <shadowMaterial opacity={0.12} />
          </mesh>

          {/* ── CUBE GIZMO (replaces GizmoViewport) ── */}
          <GizmoHelper alignment="bottom-right" margin={[88, 88]}>
            {/* GizmoHelper renders its children into an isolated orthographic mini-viewport;
                we drop our CubeGizmo into it and pass the main orbitControls ref. */}
            <group scale={60}>
              <CubeGizmo orbitRef={controlsRef} />
            </group>
          </GizmoHelper>

        </Canvas>
      </ErrorBoundary>

      {contextMenu && (
        <ContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          shapeId={contextMenu.shapeId}
          shapeType={contextMenu.shapeType}
          onClose={() => setContextMenu(null)}
          onEdit={() => { isolateShape(contextMenu.shapeId); setContextMenu(null); }}
          onCopy={() => { copyShape(contextMenu.shapeId); setContextMenu(null); }}
          onDelete={() => { deleteShape(contextMenu.shapeId); setContextMenu(null); }}
          onSave={() => { setSaveDialog({ isOpen: true, shapeId: contextMenu.shapeId }); setContextMenu(null); }}
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
