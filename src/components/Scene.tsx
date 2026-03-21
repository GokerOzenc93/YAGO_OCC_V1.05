import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, PerspectiveCamera, OrthographicCamera } from '@react-three/drei';
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
   CUBE GIZMO  – pure Three.js, no Html/CSS
   • 6 faces with canvas-drawn labels
   • Hover highlights face orange
   • Click snaps orbit camera to that view
───────────────────────────────────────────── */

/** Build a CanvasTexture for a face label */
function makeFaceTexture(label: string, hovered: boolean): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = hovered ? 'rgba(232,98,42,0.92)' : 'rgba(20,20,24,0.88)';
  ctx.fillRect(0, 0, size, size);

  // Border
  ctx.strokeStyle = hovered ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, size - 3, size - 3);

  // Label text
  ctx.fillStyle = hovered ? '#ffffff' : 'rgba(220,220,225,0.88)';
  ctx.font = `bold ${label.length > 4 ? 18 : 22}px "Syne", "DM Sans", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, size / 2, size / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// Face definitions: label, position offset, euler rotation
const FACES: { label: string; pos: [number,number,number]; rot: [number,number,number] }[] = [
  { label: 'FRONT',  pos: [0,  0,  0.501], rot: [0, 0, 0] },
  { label: 'BACK',   pos: [0,  0, -0.501], rot: [0, Math.PI, 0] },
  { label: 'RIGHT',  pos: [0.501, 0, 0],   rot: [0, -Math.PI/2, 0] },
  { label: 'LEFT',   pos: [-0.501, 0, 0],  rot: [0,  Math.PI/2, 0] },
  { label: 'TOP',    pos: [0,  0.501, 0],  rot: [-Math.PI/2, 0, 0] },
  { label: 'BOTTOM', pos: [0, -0.501, 0],  rot: [ Math.PI/2, 0, 0] },
];

// Snap targets for each face (world-space camera direction from target)
const FACE_SNAP_DIRS: [number,number,number][] = [
  [0, 0, 1],   // FRONT
  [0, 0, -1],  // BACK
  [1, 0, 0],   // RIGHT
  [-1, 0, 0],  // LEFT
  [0, 1, 0],   // TOP
  [0, -1, 0],  // BOTTOM
];

interface CubeFaceProps {
  index: number;
  label: string;
  pos: [number,number,number];
  rot: [number,number,number];
  orbitRef: React.RefObject<any>;
}

const CubeFace: React.FC<CubeFaceProps> = ({ index, label, pos, rot, orbitRef }) => {
  const { camera } = useThree();
  const [hovered, setHovered] = useState(false);

  const texture = useMemo(() => makeFaceTexture(label, hovered), [label, hovered]);

  // Cleanup texture on unmount / re-create
  useEffect(() => () => { texture.dispose(); }, [texture]);

  const snapTo = useCallback(() => {
    if (!orbitRef.current) return;
    const dir = new THREE.Vector3(...FACE_SNAP_DIRS[index]);
    const target: THREE.Vector3 = orbitRef.current.target.clone();
    const dist = camera.position.distanceTo(target);
    const endPos = target.clone().add(dir.clone().multiplyScalar(dist));
    const startPos = camera.position.clone();
    const t0 = performance.now();
    const duration = 420;

    // Pick a stable up vector
    const up = (index === 4)
      ? new THREE.Vector3(0, 0, -1)
      : (index === 5)
        ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(0, 1, 0);

    const tick = () => {
      const raw = Math.min((performance.now() - t0) / duration, 1);
      const t = 1 - Math.pow(1 - raw, 3); // ease-out-cubic
      camera.position.lerpVectors(startPos, endPos, t);
      camera.up.copy(up);
      camera.lookAt(orbitRef.current.target);
      orbitRef.current.update();
      if (raw < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [camera, orbitRef, index]);

  return (
    <mesh
      position={pos}
      rotation={new THREE.Euler(...rot)}
      onPointerEnter={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
      onPointerLeave={(e) => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'default'; }}
      onClick={(e) => { e.stopPropagation(); snapTo(); }}
    >
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={texture} transparent depthTest={false} />
    </mesh>
  );
};

const CubeGizmo: React.FC<{ orbitRef: React.RefObject<any> }> = ({ orbitRef }) => {
  const { camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);

  // Sync rotation: invert camera quaternion so cube always shows world orientation
  useFrame(() => {
    if (!groupRef.current) return;
    groupRef.current.quaternion.copy(camera.quaternion).invert();
  });

  // Static edge geometry (built once)
  const edgesGeo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), []);
  const edgesMat = useMemo(() => new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.18 }), []);

  // Axis lines geometry
  const axisLines = useMemo(() => {
    const axes = [
      { dir: [0.65,0,0], color: '#f87171' },
      { dir: [0,0.65,0], color: '#4ade80' },
      { dir: [0,0,0.65], color: '#60a5fa' },
    ] as { dir: [number,number,number]; color: string }[];
    return axes.map(({ dir, color }) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0,0,0), new THREE.Vector3(...dir)
      ]);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
      return { geo, mat };
    });
  }, []);

  return (
    <group ref={groupRef}>
      {/* Faces */}
      {FACES.map((f, i) => (
        <CubeFace key={i} index={i} label={f.label} pos={f.pos} rot={f.rot} orbitRef={orbitRef} />
      ))}

      {/* Edges outline */}
      <lineSegments geometry={edgesGeo} material={edgesMat} />

      {/* Corner spheres */}
      {[
        [ 0.5, 0.5, 0.5],[-0.5, 0.5, 0.5],[ 0.5,-0.5, 0.5],[-0.5,-0.5, 0.5],
        [ 0.5, 0.5,-0.5],[-0.5, 0.5,-0.5],[ 0.5,-0.5,-0.5],[-0.5,-0.5,-0.5],
      ].map((p, i) => (
        <mesh key={`c${i}`} position={p as [number,number,number]}>
          <sphereGeometry args={[0.048, 8, 8]} />
          <meshBasicMaterial color="#e8622a" transparent opacity={0.75} depthTest={false} />
        </mesh>
      ))}

      {/* Axis stubs */}
      {axisLines.map(({ geo, mat }, i) => (
        <lineSegments key={`ax${i}`} geometry={geo} material={mat} />
      ))}
    </group>
  );
};

/* ─────────────────────────────────────────────
   CAMERA CONTROLLER  (unchanged)
───────────────────────────────────────────── */
const CameraController: React.FC<{ controlsRef: React.RefObject<any>; cameraType: CameraType }> = ({ controlsRef, cameraType }) => {
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
    const save = () => {
      if (cameraRef.current && controlsRef.current) {
        savedStateRef.current = {
          position: cameraRef.current.position.clone(),
          target: controlsRef.current.target.clone(),
          zoom: cameraRef.current instanceof THREE.OrthographicCamera ? cameraRef.current.zoom : 1,
          perspectiveFov: cameraRef.current instanceof THREE.PerspectiveCamera ? cameraRef.current.fov : 45,
        };
      }
    };
    const id = setInterval(save, 100);
    return () => clearInterval(id);
  }, [controlsRef]);

  if (cameraType === CameraType.PERSPECTIVE) {
    return <PerspectiveCamera ref={cameraRef as React.RefObject<THREE.PerspectiveCamera>} makeDefault position={savedStateRef.current?.position.toArray() || [2000, 2000, 2000]} fov={45} near={1} far={50000} />;
  }
  return <OrthographicCamera ref={cameraRef as React.RefObject<THREE.OrthographicCamera>} makeDefault position={savedStateRef.current?.position.toArray() || [2000, 2000, 2000]} zoom={0.25} near={-50000} far={50000} />;
};

/* ─────────────────────────────────────────────
   SCENE
───────────────────────────────────────────── */
const Scene: React.FC = () => {
  const controlsRef = useRef<any>(null);

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
    panelSurfaceSelectMode: state.panelSurfaceSelectMode, setSelectedPanelRow: state.setSelectedPanelRow,
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
      const cs = useAppStore.getState();
      const { selectedShapeId: sid, selectedVertexIndex: vi, vertexDirection: vd } = cs;
      if (sid && vi !== null && vd) {
        const shape = cs.shapes.find(s => s.id === sid);
        if (shape && shape.parameters) {
          let baseVertices: number[][] = [];
          if (shape.parameters.scaledBaseVertices?.length > 0) {
            baseVertices = shape.parameters.scaledBaseVertices;
          } else if (shape.replicadShape) {
            const { getReplicadVertices } = await import('./VertexEditorService');
            baseVertices = (await getReplicadVertices(shape.replicadShape)).map(v => [v.x, v.y, v.z]);
          } else if (shape.type === 'box') {
            const { getBoxVertices } = await import('./VertexEditorService');
            baseVertices = (getBoxVertices(shape.parameters.width, shape.parameters.height, shape.parameters.depth)).map(v => [v.x, v.y, v.z]);
          }
          if (vi >= baseVertices.length) return;
          const originalPos = baseVertices[vi];
          const axisIndex = vd.startsWith('x') ? 0 : vd.startsWith('y') ? 1 : 2;
          const newPosition: [number, number, number] = [...originalPos] as [number, number, number];
          newPosition[axisIndex] = newValue;
          const offset: [number, number, number] = [0, 0, 0];
          offset[axisIndex] = newValue - originalPos[axisIndex];
          cs.addVertexModification(sid, { vertexIndex: vi, originalPosition: originalPos as [number, number, number], newPosition, direction: vd, expression: String(newValue), description: `Vertex ${vi} ${vd[0].toUpperCase()}${vd[1] === '+' ? '+' : '-'}`, offset });
        }
        (window as any).pendingVertexEdit = false;
        cs.setSelectedVertexIndex(null);
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
          new THREE.Box3().setFromBufferAttribute(result.geometry.getAttribute('position')).getCenter(newCenter);
          const rotatedOffset = new THREE.Vector3().subVectors(newCenter, oldCenter);
          if (shape.rotation[0] !== 0 || shape.rotation[1] !== 0 || shape.rotation[2] !== 0) {
            rotatedOffset.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ')));
          }
          cs.updateShape(sid, {
            geometry: result.geometry, replicadShape: result.replicadShape,
            position: [shape.position[0] - rotatedOffset.x, shape.position[1] - rotatedOffset.y, shape.position[2] - rotatedOffset.z],
            rotation: shape.rotation, scale: shape.scale,
            parameters: { ...shape.parameters, scaledBaseVertices: newBaseVertices.map(v => [v.x, v.y, v.z]), width: shape.parameters.width || 1, height: shape.parameters.height || 1, depth: shape.parameters.depth || 1 },
            fillets: [...(shape.fillets || []), result.filletData],
          });
          cs.clearFilletFaces();
        } catch (error) {
          console.error('❌ Failed to apply fillet:', error);
          cs.clearFilletFaces();
          alert(`Failed to apply fillet: ${(error as Error).message}`);
        }
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
    return canvas ? canvas.toDataURL('image/png') : '';
  };

  const serializeSubtractionGeometries = (sg: any[] | undefined) => {
    if (!sg || sg.length === 0) return [];
    return sg.filter(s => s !== null).map(sub => {
      const out: any = { relativeOffset: sub.relativeOffset, relativeRotation: sub.relativeRotation, scale: sub.scale, parameters: sub.parameters };
      if (sub.geometry) {
        const pa = sub.geometry.getAttribute('position');
        if (pa) { const sz = new THREE.Vector3(); new THREE.Box3().setFromBufferAttribute(pa).getSize(sz); out.geometrySize = [sz.x, sz.y, sz.z]; }
      }
      return out;
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
        if (shape.fillets) filletsData = shape.fillets.map(f => ({ face1Descriptor: f.face1Descriptor, face2Descriptor: f.face2Descriptor, face1Data: f.face1Data, face2Data: f.face2Data, radius: f.radius, originalSize: f.originalSize }));
        if (shape.faceRoles) faceRolesData = Object.entries(shape.faceRoles).reduce((acc, [k, v]) => { if (v) acc[Number(k)] = v; return acc; }, {} as Record<number, string>);
      }
      await catalogService.save({ code: data.code, description: data.description, tags: data.tags, geometry_data: geometryData, shape_parameters: shapeParameters, subtraction_geometries: subtractionGeometriesData, fillets: filletsData, face_roles: faceRolesData, preview_image: data.previewImage });
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
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('WebGL context lost'); });
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
            if (shape.type === 'panel') return <PanelDrawing key={shape.id} shape={shape} isSelected={isSelected} />;
            return (
              <React.Fragment key={shape.id}>
                <ShapeWithTransform shape={shape} isSelected={isSelected} orbitControlsRef={controlsRef} onContextMenu={handleContextMenu} />
                {isSelected && vertexEditMode && (
                  <VertexEditor shape={shape} isActive={true} onVertexSelect={(i) => setSelectedVertexIndex(i)} onDirectionChange={(d) => setVertexDirection(d)} />
                )}
              </React.Fragment>
            );
          })}

          <mesh position={[0, -1, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[30000, 30000]} />
            <shadowMaterial opacity={0.12} />
          </mesh>

          {/* ── CUBE GIZMO ─────────────────────────────
              GizmoHelper renders into an isolated viewport
              (always visible, fixed bottom-right corner).
              CubeGizmo reads the main camera quaternion
              each frame and updates its own rotation.
          ─────────────────────────────────────────── */}
          <GizmoHelper alignment="bottom-right" margin={[90, 90]}>
            <group scale={55}>
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
