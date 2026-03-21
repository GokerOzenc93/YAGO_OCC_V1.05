import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, useGizmoContext, PerspectiveCamera, OrthographicCamera } from '@react-three/drei';
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

/* ═══════════════════════════════════════════════════════════
   VIEW-CUBE GIZMO
   Design:
   • Light neutral cube — stone/slate tones matching app UI
   • 6 labelled faces  → orthographic snap
   • 12 edge strips    → 45° snap
   • 8 corner regions  → isometric snap (detected via hit-test
     on the cube body itself, NO visible corner decorations)
   • Hover highlights any region in accent orange
   • Uses useGizmoContext().tweenCamera → gizmo never moves
══════════════════════════════════════════════════════════ */

const C_ACCENT   = '#e8622a';
const C_FACE_BG  = 'rgba(240,238,234,0.94)';   // stone-100-ish, matches app bg
const C_FACE_HOV = 'rgba(232,98,42,0.92)';
const C_EDGE_BG  = 'rgba(210,207,202,0.90)';
const C_EDGE_HOV = 'rgba(232,98,42,0.88)';
const C_BODY     = '#dbd8d2';                   // warm stone
const C_OUTLINE  = 'rgba(150,145,138,0.55)';

/* Build a canvas texture for a face */
function makeFaceTex(label: string, hovered: boolean): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  // background
  ctx.fillStyle = hovered ? C_FACE_HOV : C_FACE_BG;
  ctx.fillRect(0, 0, S, S);

  // subtle border
  ctx.strokeStyle = hovered ? 'rgba(255,255,255,0.35)' : 'rgba(170,165,158,0.7)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(1.5, 1.5, S - 3, S - 3);

  // label
  const fs = label.length > 4 ? 15 : 18;
  ctx.fillStyle = hovered ? '#fff' : '#4a4845';
  ctx.font = `700 ${fs}px "Syne","DM Sans",system-ui,sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, S / 2, S / 2);

  const t = new THREE.CanvasTexture(canvas);
  t.needsUpdate = true;
  return t;
}

/* Build a canvas texture for an edge strip */
function makeEdgeTex(hovered: boolean): THREE.CanvasTexture {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = hovered ? C_EDGE_HOV : C_EDGE_BG;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(canvas);
  t.needsUpdate = true;
  return t;
}

/* ── Normalise a 3-vector ── */
function norm(x: number, y: number, z: number): [number, number, number] {
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
}

/* ── Hoverable face plane ── */
interface FacePlaneProps {
  geo: THREE.BufferGeometry;
  pos: [number, number, number];
  rot: [number, number, number];
  label?: string;
  isEdge?: boolean;
  onSnap: () => void;
}
const FacePlane: React.FC<FacePlaneProps> = ({ geo, pos, rot, label = '', isEdge = false, onSnap }) => {
  const [hov, setHov] = useState(false);
  const tex = useMemo(
    () => isEdge ? makeEdgeTex(hov) : makeFaceTex(label, hov),
    [hov, label, isEdge]
  );
  useEffect(() => () => tex.dispose(), [tex]);

  return (
    <mesh
      geometry={geo}
      position={pos}
      rotation={new THREE.Euler(...rot)}
      onPointerEnter={e => { e.stopPropagation(); setHov(true);  document.body.style.cursor = 'pointer'; }}
      onPointerLeave={e => { e.stopPropagation(); setHov(false); document.body.style.cursor = 'default';  }}
      onClick={e      => { e.stopPropagation(); onSnap(); }}
      renderOrder={3}
    >
      <meshBasicMaterial map={tex} transparent depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
};

/* ── Invisible corner hit zone (no visual) ── */
const CornerZone: React.FC<{ pos: [number, number, number]; onSnap: () => void }> = ({ pos, onSnap }) => {
  const [hov, setHov] = useState(false);
  const geo = useMemo(() => new THREE.BoxGeometry(0.22, 0.22, 0.22), []);

  return (
    <mesh
      geometry={geo}
      position={pos}
      onPointerEnter={e => { e.stopPropagation(); setHov(true);  document.body.style.cursor = 'pointer'; }}
      onPointerLeave={e => { e.stopPropagation(); setHov(false); document.body.style.cursor = 'default';  }}
      onClick={e      => { e.stopPropagation(); onSnap(); }}
      renderOrder={5}
    >
      {/* fully transparent — hover glow is handled on body mesh via state lift */}
      <meshBasicMaterial color={hov ? C_ACCENT : C_BODY} transparent opacity={hov ? 0.45 : 0} depthTest={false} />
    </mesh>
  );
};

/* ── Main ViewCube ── */
const ViewCube: React.FC = () => {
  const { tweenCamera } = useGizmoContext();
  const { camera }      = useThree();
  const groupRef        = useRef<THREE.Group>(null);

  /* Sync rotation to scene camera every frame */
  useFrame(() => {
    if (!groupRef.current) return;
    groupRef.current.quaternion.copy(camera.quaternion).invert();
  });

  const snap = useCallback((dir: [number, number, number], up: [number, number, number] = [0, 1, 0]) => {
    tweenCamera(new THREE.Vector3(...dir), new THREE.Vector3(...up), 1);
  }, [tweenCamera]);

  /* ── Geometry (memoised) ── */
  const S  = 1;      // cube side = 1
  const H  = 0.5;    // half side
  const FW = 0.68;   // face label area width
  const EW = 0.155;  // edge strip width
  const D  = 0.003;  // plane offset above face

  const geoFace  = useMemo(() => new THREE.PlaneGeometry(FW, FW), []);
  const geoEdgeH = useMemo(() => new THREE.PlaneGeometry(FW, EW), []);
  const geoEdgeV = useMemo(() => new THREE.PlaneGeometry(EW, FW), []);
  const geoBody  = useMemo(() => new THREE.BoxGeometry(S, S, S),   []);
  const geoEdges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(S, S, S)), []);

  const matBody  = useMemo(() => new THREE.MeshBasicMaterial({ color: C_BODY, transparent: false, depthTest: false, depthWrite: false }), []);
  const matEdges = useMemo(() => new THREE.LineBasicMaterial({ color: C_OUTLINE, transparent: true, opacity: 1, depthTest: false }), []);

  const P = H + D; // plane sits just above face

  /* ── Face definitions ── */
  type V3 = [number, number, number];
  const FACES: { label: string; pos: V3; rot: V3; dir: V3; up: V3 }[] = [
    { label: 'FRONT',  pos: [0,0,P],    rot: [0,0,0],           dir: [0,0,1],  up: [0,1,0]  },
    { label: 'BACK',   pos: [0,0,-P],   rot: [0,Math.PI,0],     dir: [0,0,-1], up: [0,1,0]  },
    { label: 'RIGHT',  pos: [P,0,0],    rot: [0,-Math.PI/2,0],  dir: [1,0,0],  up: [0,1,0]  },
    { label: 'LEFT',   pos: [-P,0,0],   rot: [0,Math.PI/2,0],   dir: [-1,0,0], up: [0,1,0]  },
    { label: 'TOP',    pos: [0,P,0],    rot: [-Math.PI/2,0,0],  dir: [0,1,0],  up: [0,0,-1] },
    { label: 'BOTTOM', pos: [0,-P,0],   rot: [Math.PI/2,0,0],   dir: [0,-1,0], up: [0,0,1]  },
  ];

  /* ── Edge definitions ──
     16 strips total — 4 per face × 4 faces (front/back/left/right);
     top/bottom get their 4 edges too.
     Each strip bisects two adjacent faces.                        */
  const EC = (FW + EW) / 2;   // strip centre offset from face centre

  const EDGES: { pos: V3; rot: V3; geo: 'h' | 'v'; dir: V3; up: V3 }[] = [
    // FRONT face
    { pos:[0,  EC, P], rot:[0,0,0], geo:'h', dir:norm(0,1,1),  up:[0,1,0]  }, // front-top
    { pos:[0, -EC, P], rot:[0,0,0], geo:'h', dir:norm(0,-1,1), up:[0,1,0]  }, // front-bottom
    { pos:[-EC,0,  P], rot:[0,0,0], geo:'v', dir:norm(-1,0,1), up:[0,1,0]  }, // front-left
    { pos:[ EC,0,  P], rot:[0,0,0], geo:'v', dir:norm(1,0,1),  up:[0,1,0]  }, // front-right
    // BACK face
    { pos:[0, EC,-P],  rot:[0,Math.PI,0], geo:'h', dir:norm(0,1,-1),  up:[0,1,0]  },
    { pos:[0,-EC,-P],  rot:[0,Math.PI,0], geo:'h', dir:norm(0,-1,-1), up:[0,1,0]  },
    { pos:[ EC,0,-P],  rot:[0,Math.PI,0], geo:'v', dir:norm(1,0,-1),  up:[0,1,0]  },
    { pos:[-EC,0,-P],  rot:[0,Math.PI,0], geo:'v', dir:norm(-1,0,-1), up:[0,1,0]  },
    // RIGHT face
    { pos:[P, EC, 0],  rot:[0,-Math.PI/2,0], geo:'h', dir:norm(1,1,0),  up:[0,1,0]  },
    { pos:[P,-EC, 0],  rot:[0,-Math.PI/2,0], geo:'h', dir:norm(1,-1,0), up:[0,1,0]  },
    { pos:[P, 0, EC],  rot:[0,-Math.PI/2,0], geo:'v', dir:norm(1,0,1),  up:[0,1,0]  },
    { pos:[P, 0,-EC],  rot:[0,-Math.PI/2,0], geo:'v', dir:norm(1,0,-1), up:[0,1,0]  },
    // LEFT face
    { pos:[-P, EC, 0], rot:[0,Math.PI/2,0], geo:'h', dir:norm(-1,1,0),  up:[0,1,0]  },
    { pos:[-P,-EC, 0], rot:[0,Math.PI/2,0], geo:'h', dir:norm(-1,-1,0), up:[0,1,0]  },
    { pos:[-P, 0,-EC], rot:[0,Math.PI/2,0], geo:'v', dir:norm(-1,0,-1), up:[0,1,0]  },
    { pos:[-P, 0, EC], rot:[0,Math.PI/2,0], geo:'v', dir:norm(-1,0,1),  up:[0,1,0]  },
    // TOP face
    { pos:[0,  P, EC], rot:[-Math.PI/2,0,0], geo:'h', dir:norm(0,1,1),  up:[0,0,-1] },
    { pos:[0,  P,-EC], rot:[-Math.PI/2,0,0], geo:'h', dir:norm(0,1,-1), up:[0,0,-1] },
    { pos:[-EC,P, 0],  rot:[-Math.PI/2,0,0], geo:'v', dir:norm(-1,1,0), up:[0,0,-1] },
    { pos:[ EC,P, 0],  rot:[-Math.PI/2,0,0], geo:'v', dir:norm(1,1,0),  up:[0,0,-1] },
    // BOTTOM face
    { pos:[0, -P, EC], rot:[Math.PI/2,0,0], geo:'h', dir:norm(0,-1,1),  up:[0,0,1]  },
    { pos:[0, -P,-EC], rot:[Math.PI/2,0,0], geo:'h', dir:norm(0,-1,-1), up:[0,0,1]  },
    { pos:[-EC,-P,0],  rot:[Math.PI/2,0,0], geo:'v', dir:norm(-1,-1,0), up:[0,0,1]  },
    { pos:[ EC,-P,0],  rot:[Math.PI/2,0,0], geo:'v', dir:norm(1,-1,0),  up:[0,0,1]  },
  ];

  /* ── Corner definitions (invisible hit zones only) ── */
  const CORNERS: { pos: V3; dir: V3; up: V3 }[] = [
    { pos:[ H, H, H], dir:norm(1,1,1),   up:[0,0,-1] },
    { pos:[-H, H, H], dir:norm(-1,1,1),  up:[0,0,-1] },
    { pos:[ H,-H, H], dir:norm(1,-1,1),  up:[0,0,1]  },
    { pos:[-H,-H, H], dir:norm(-1,-1,1), up:[0,0,1]  },
    { pos:[ H, H,-H], dir:norm(1,1,-1),  up:[0,0,-1] },
    { pos:[-H, H,-H], dir:norm(-1,1,-1), up:[0,0,-1] },
    { pos:[ H,-H,-H], dir:norm(1,-1,-1), up:[0,0,1]  },
    { pos:[-H,-H,-H], dir:norm(-1,-1,-1),up:[0,0,1]  },
  ];

  /* ── Axis stubs ── */
  const axisLines = useMemo(() => [
    { pts: [new THREE.Vector3(0,0,0), new THREE.Vector3(0.72,0,0)],  color: '#ef4444' },
    { pts: [new THREE.Vector3(0,0,0), new THREE.Vector3(0,0.72,0)],  color: '#22c55e' },
    { pts: [new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,0.72)],  color: '#3b82f6' },
  ].map(({ pts, color }) => ({
    geo: new THREE.BufferGeometry().setFromPoints(pts),
    mat: new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.65, depthTest: false }),
  })), []);

  return (
    <group ref={groupRef}>

      {/* ① Opaque cube body — light stone colour */}
      <mesh geometry={geoBody} material={matBody} renderOrder={1} />

      {/* ② Edge outline */}
      <lineSegments geometry={geoEdges} material={matEdges} renderOrder={4} />

      {/* ③ Axis stubs */}
      {axisLines.map(({ geo, mat }, i) => (
        <lineSegments key={`ax${i}`} geometry={geo} material={mat} renderOrder={5} />
      ))}

      {/* ④ 6 face labels */}
      {FACES.map((f, i) => (
        <FacePlane
          key={`f${i}`}
          geo={geoFace}
          pos={f.pos}
          rot={f.rot}
          label={f.label}
          onSnap={() => snap(f.dir, f.up)}
        />
      ))}

      {/* ⑤ 24 edge strips */}
      {EDGES.map((e, i) => (
        <FacePlane
          key={`e${i}`}
          geo={e.geo === 'h' ? geoEdgeH : geoEdgeV}
          pos={e.pos}
          rot={e.rot}
          isEdge
          onSnap={() => snap(e.dir, e.up)}
        />
      ))}

      {/* ⑥ 8 invisible corner hit-zones (no visual) */}
      {CORNERS.map((c, i) => (
        <CornerZone
          key={`c${i}`}
          pos={c.pos}
          onSnap={() => snap(c.dir, c.up)}
        />
      ))}

    </group>
  );
};

/* ═══════════════════════════════════════════════════════════
   CAMERA CONTROLLER  (unchanged)
══════════════════════════════════════════════════════════ */
const CameraController: React.FC<{ controlsRef: React.RefObject<any>; cameraType: CameraType }> = ({ controlsRef, cameraType }) => {
  const cameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera>(null);
  const savedRef  = useRef<{ position: THREE.Vector3; target: THREE.Vector3; zoom: number; perspectiveFov: number } | null>(null);
  const prevType  = useRef<CameraType>(cameraType);

  useEffect(() => {
    if (prevType.current !== cameraType && savedRef.current && cameraRef.current && controlsRef.current) {
      cameraRef.current.position.copy(savedRef.current.position);
      controlsRef.current.target.copy(savedRef.current.target);
      if (cameraType === CameraType.ORTHOGRAPHIC && cameraRef.current instanceof THREE.OrthographicCamera) {
        const dist = savedRef.current.position.distanceTo(savedRef.current.target);
        const fovR = (savedRef.current.perspectiveFov || 45) * Math.PI / 180;
        cameraRef.current.zoom = window.innerHeight / (2 * dist * Math.tan(fovR / 2));
        cameraRef.current.updateProjectionMatrix();
      }
      controlsRef.current.update();
    }
    prevType.current = cameraType;
  }, [cameraType, controlsRef]);

  useEffect(() => {
    const id = setInterval(() => {
      if (cameraRef.current && controlsRef.current) {
        savedRef.current = {
          position:       cameraRef.current.position.clone(),
          target:         controlsRef.current.target.clone(),
          zoom:           cameraRef.current instanceof THREE.OrthographicCamera ? cameraRef.current.zoom : 1,
          perspectiveFov: cameraRef.current instanceof THREE.PerspectiveCamera  ? cameraRef.current.fov  : 45,
        };
      }
    }, 100);
    return () => clearInterval(id);
  }, [controlsRef]);

  return cameraType === CameraType.PERSPECTIVE
    ? <PerspectiveCamera  ref={cameraRef as React.RefObject<THREE.PerspectiveCamera>}  makeDefault position={savedRef.current?.position.toArray() || [2000,2000,2000]} fov={45}   near={1}      far={50000} />
    : <OrthographicCamera ref={cameraRef as React.RefObject<THREE.OrthographicCamera>} makeDefault position={savedRef.current?.position.toArray() || [2000,2000,2000]} zoom={0.25} near={-50000} far={50000} />;
};

/* ═══════════════════════════════════════════════════════════
   SCENE
══════════════════════════════════════════════════════════ */
const Scene: React.FC = () => {
  const controlsRef = useRef<any>(null);

  const {
    shapes, cameraType, selectedShapeId, secondarySelectedShapeId, selectShape,
    deleteShape, copyShape, isolateShape, exitIsolation,
    vertexEditMode, setVertexEditMode, selectedVertexIndex, setSelectedVertexIndex,
    vertexDirection, setVertexDirection, addVertexModification,
    subtractionViewMode, faceEditMode, setFaceEditMode,
    filletMode, selectedFilletFaces, clearFilletFaces, selectedFilletFaceData,
    updateShape, panelSelectMode, panelSurfaceSelectMode, setSelectedPanelRow,
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
  const [saveDialog,  setSaveDialog ] = useState<{ isOpen: boolean; shapeId: string | null }>({ isOpen: false, shapeId: null });

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selectedShapeId) deleteShape(selectedShapeId);
      else if (e.key === 'Escape') { selectShape(null); exitIsolation(); setVertexEditMode(false); setFaceEditMode(false); clearFilletFaces(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'g') { e.preventDefault(); if (selectedShapeId && secondarySelectedShapeId) useAppStore.getState().createGroup(selectedShapeId, secondarySelectedShapeId); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'u') { e.preventDefault(); if (selectedShapeId) { const sh = shapes.find(s => s.id === selectedShapeId); if (sh?.groupId) useAppStore.getState().ungroupShapes(sh.groupId); } }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [selectedShapeId, secondarySelectedShapeId, shapes, deleteShape, selectShape, exitIsolation, setVertexEditMode, setFaceEditMode, clearFilletFaces]);

  useEffect(() => {
    (window as any).handleVertexOffset = async (newValue: number) => {
      const cs = useAppStore.getState();
      const { selectedShapeId: sid, selectedVertexIndex: vi, vertexDirection: vd } = cs;
      if (sid && vi !== null && vd) {
        const shape = cs.shapes.find(s => s.id === sid);
        if (shape?.parameters) {
          let bv: number[][] = [];
          if (shape.parameters.scaledBaseVertices?.length > 0) bv = shape.parameters.scaledBaseVertices;
          else if (shape.replicadShape) { const { getReplicadVertices: g } = await import('./VertexEditorService'); bv = (await g(shape.replicadShape)).map(v => [v.x, v.y, v.z]); }
          else if (shape.type === 'box') { const { getBoxVertices } = await import('./VertexEditorService'); bv = getBoxVertices(shape.parameters.width, shape.parameters.height, shape.parameters.depth).map(v => [v.x, v.y, v.z]); }
          if (vi >= bv.length) return;
          const op = bv[vi];
          const ai = vd.startsWith('x') ? 0 : vd.startsWith('y') ? 1 : 2;
          const np: [number, number, number] = [...op] as [number, number, number]; np[ai] = newValue;
          const off: [number, number, number] = [0, 0, 0]; off[ai] = newValue - op[ai];
          cs.addVertexModification(sid, { vertexIndex: vi, originalPosition: op as [number, number, number], newPosition: np, direction: vd, expression: String(newValue), description: `Vertex ${vi} ${vd[0].toUpperCase()}${vd[1] === '+' ? '+' : '-'}`, offset: off });
        }
        (window as any).pendingVertexEdit = false; cs.setSelectedVertexIndex(null);
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
        const shape = cs.shapes.find(s => s.id === sid); if (!shape?.replicadShape) return;
        try {
          const oc = new THREE.Vector3();
          if (shape.geometry) new THREE.Box3().setFromBufferAttribute(shape.geometry.getAttribute('position')).getCenter(oc);
          const result = await applyFilletToShape(shape, sff, sffd, radius);
          const nbv = await getReplicadVertices(result.replicadShape);
          const nc = new THREE.Vector3(); new THREE.Box3().setFromBufferAttribute(result.geometry.getAttribute('position')).getCenter(nc);
          const ro = new THREE.Vector3().subVectors(nc, oc);
          if (shape.rotation[0] || shape.rotation[1] || shape.rotation[2]) ro.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ')));
          cs.updateShape(sid, { geometry: result.geometry, replicadShape: result.replicadShape, position: [shape.position[0] - ro.x, shape.position[1] - ro.y, shape.position[2] - ro.z], rotation: shape.rotation, scale: shape.scale, parameters: { ...shape.parameters, scaledBaseVertices: nbv.map(v => [v.x, v.y, v.z]), width: shape.parameters.width || 1, height: shape.parameters.height || 1, depth: shape.parameters.depth || 1 }, fillets: [...(shape.fillets || []), result.filletData] });
          cs.clearFilletFaces();
        } catch (err) { console.error('fillet failed:', err); cs.clearFilletFaces(); alert(`Failed to apply fillet: ${(err as Error).message}`); }
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
    setContextMenu({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY, shapeId, shapeType: state.shapes.find(s => s.id === shapeId)?.type || 'unknown' });
  }, []);

  const captureSnapshot = () => { const c = document.querySelector('canvas'); return c ? c.toDataURL('image/png') : ''; };

  const serializeSubs = (sg: any[] | undefined) => {
    if (!sg?.length) return [];
    return sg.filter(Boolean).map(sub => {
      const out: any = { relativeOffset: sub.relativeOffset, relativeRotation: sub.relativeRotation, scale: sub.scale, parameters: sub.parameters };
      if (sub.geometry) { const pa = sub.geometry.getAttribute('position'); if (pa) { const sz = new THREE.Vector3(); new THREE.Box3().setFromBufferAttribute(pa).getSize(sz); out.geometrySize = [sz.x, sz.y, sz.z]; } }
      return out;
    });
  };

  const handleSave = async (data: { code: string; description: string; tags: string[]; previewImage?: string }) => {
    if (!saveDialog.shapeId) return;
    const shape = shapes.find(s => s.id === saveDialog.shapeId); if (!shape) return;
    try {
      let gd: any, sp: any = {}, ssd: any[] = [], fd: any[] = [], frd: Record<number, string> = {};
      if (shape.groupId) {
        const gs = shapes.filter(s => s.groupId === shape.groupId);
        gd = { type: 'group', shapes: gs.map(s => ({ type: s.type, position: s.position, rotation: s.rotation, scale: s.scale, color: s.color, parameters: s.parameters, vertexModifications: s.vertexModifications || [], isReferenceBox: s.isReferenceBox })) };
      } else {
        gd = { type: shape.type, position: shape.position, rotation: shape.rotation, scale: shape.scale, color: shape.color, parameters: shape.parameters, vertexModifications: shape.vertexModifications || [] };
        sp = { width: shape.parameters?.width, height: shape.parameters?.height, depth: shape.parameters?.depth, color: shape.color, position: shape.position, rotation: shape.rotation, scale: shape.scale, vertexModifications: shape.vertexModifications || [] };
        ssd = serializeSubs(shape.subtractionGeometries);
        if (shape.fillets) fd = shape.fillets.map(f => ({ face1Descriptor: f.face1Descriptor, face2Descriptor: f.face2Descriptor, face1Data: f.face1Data, face2Data: f.face2Data, radius: f.radius, originalSize: f.originalSize }));
        if (shape.faceRoles) frd = Object.entries(shape.faceRoles).reduce((a, [k, v]) => { if (v) a[Number(k)] = v; return a; }, {} as Record<number, string>);
      }
      await catalogService.save({ code: data.code, description: data.description, tags: data.tags, geometry_data: gd, shape_parameters: sp, subtraction_geometries: ssd, fillets: fd, face_roles: frd, preview_image: data.previewImage });
      alert('Geometry saved successfully!'); setSaveDialog({ isOpen: false, shapeId: null });
    } catch (err) { console.error('save failed:', err); alert('Failed to save geometry. Please try again.'); }
  };

  const handleCreated = useCallback(({ gl }: { gl: THREE.WebGLRenderer }) => {
    gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.0;
    gl.shadowMap.type = THREE.PCFSoftShadowMap; gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); console.warn('WebGL context lost'); });
  }, []);

  return (
    <>
      <ErrorBoundary>
        <Canvas shadows gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true }} dpr={[1, 2]} onContextMenu={e => e.preventDefault()} onCreated={handleCreated}>
          <color attach="background" args={['#f5f5f4']} />
          <CameraController controlsRef={controlsRef} cameraType={cameraType} />

          <ambientLight intensity={0.6} />
          <hemisphereLight intensity={0.4} groundColor="#888888" color="#ffffff" />
          <directionalLight position={[1500, 2500, 1500]} intensity={1.8} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-bias={-0.0005} shadow-camera-far={15000} shadow-camera-left={-3000} shadow-camera-right={3000} shadow-camera-top={3000} shadow-camera-bottom={-3000} />
          <directionalLight position={[-1000, 1500, -1000]} intensity={0.4} />
          <directionalLight position={[0, 2000, -2000]} intensity={0.3} />
          <directionalLight position={[500, 500, 3000]} intensity={0.5} />

          <OrbitControls ref={controlsRef} makeDefault target={[0, 0, 0]} enableDamping dampingFactor={0.05} rotateSpeed={0.8} maxDistance={25000} minDistance={50} />

          {shapes.map(shape => {
            const isSel = selectedShapeId === shape.id;
            if (shape.type === 'panel') return <PanelDrawing key={shape.id} shape={shape} isSelected={isSel} />;
            return (
              <React.Fragment key={shape.id}>
                <ShapeWithTransform shape={shape} isSelected={isSel} orbitControlsRef={controlsRef} onContextMenu={handleContextMenu} />
                {isSel && vertexEditMode && <VertexEditor shape={shape} isActive onVertexSelect={i => setSelectedVertexIndex(i)} onDirectionChange={d => setVertexDirection(d)} />}
              </React.Fragment>
            );
          })}

          <mesh position={[0, -1, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[30000, 30000]} />
            <shadowMaterial opacity={0.12} />
          </mesh>

          {/* ── VIEW CUBE ─────────────────────────────────────────── */}
          <GizmoHelper alignment="bottom-right" margin={[96, 96]}>
            <group scale={58}>
              <ViewCube />
            </group>
          </GizmoHelper>

        </Canvas>
      </ErrorBoundary>

      {contextMenu && (
        <ContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          shapeId={contextMenu.shapeId} shapeType={contextMenu.shapeType}
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
