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

/* ══════════════════════════════════════════════════════════
   VIEW-CUBE GIZMO
   • Single bold letter on each face (F B R L T U)
   • Compass ring clearly outside the cube
   • Large N/S/E/W labels
══════════════════════════════════════════════════════════ */

const C_FACE_BG  = 'rgba(240,238,234,0.96)';
const C_FACE_HOV = 'rgba(232,98,42,0.93)';
const C_EDGE_BG  = 'rgba(210,207,202,0.90)';
const C_EDGE_HOV = 'rgba(232,98,42,0.88)';
const C_BODY     = '#dbd8d2';
const C_OUTLINE  = 'rgba(140,135,128,0.65)';
const C_ACCENT   = '#e8622a';

/* Face texture — single large letter, fills the tile */
function makeFaceTex(letter: string, hovered: boolean, flipH = false): THREE.CanvasTexture {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;

  ctx.fillStyle = hovered ? C_FACE_HOV : C_FACE_BG;
  ctx.fillRect(0, 0, S, S);

  ctx.strokeStyle = hovered ? 'rgba(255,255,255,0.4)' : 'rgba(150,145,138,0.6)';
  ctx.lineWidth = 5;
  ctx.strokeRect(3, 3, S - 6, S - 6);

  if (flipH) { ctx.save(); ctx.translate(S, 0); ctx.scale(-1, 1); }

  /* Auto-fit: start at 180px, shrink until it fits with padding */
  const PAD = 18;
  let fs = 180;
  ctx.font = `900 ${fs}px "Syne","DM Sans",system-ui,sans-serif`;
  while (ctx.measureText(letter).width > S - PAD * 2 && fs > 40) {
    fs -= 4;
    ctx.font = `900 ${fs}px "Syne","DM Sans",system-ui,sans-serif`;
  }

  ctx.fillStyle = hovered ? '#ffffff' : '#2a2826';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, S / 2, S / 2);

  if (flipH) ctx.restore();

  const t = new THREE.CanvasTexture(cv);
  t.needsUpdate = true;
  return t;
}

function makeEdgeTex(hovered: boolean): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = hovered ? C_EDGE_HOV : C_EDGE_BG;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.needsUpdate = true;
  return t;
}

function norm(x: number, y: number, z: number): [number, number, number] {
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
}

/* Hoverable face plane */
const FacePlane: React.FC<{
  geo: THREE.BufferGeometry;
  pos: [number,number,number];
  rot: [number,number,number];
  letter?: string;
  isEdge?: boolean;
  flipH?: boolean;
  onSnap: () => void;
}> = ({ geo, pos, rot, letter = '', isEdge = false, flipH = false, onSnap }) => {
  const [hov, setHov] = useState(false);
  const tex = useMemo(
    () => isEdge ? makeEdgeTex(hov) : makeFaceTex(letter, hov, flipH),
    [hov, letter, isEdge, flipH]
  );
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <mesh geometry={geo} position={pos} rotation={new THREE.Euler(...rot)} renderOrder={3}
      onPointerEnter={e => { e.stopPropagation(); setHov(true);  document.body.style.cursor = 'pointer'; }}
      onPointerLeave={e => { e.stopPropagation(); setHov(false); document.body.style.cursor = 'default'; }}
      onClick={e      => { e.stopPropagation(); onSnap(); }}>
      <meshBasicMaterial map={tex} transparent depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
};

/* Corner hit zone — shows orange on hover, invisible otherwise */
const CornerZone: React.FC<{ pos: [number,number,number]; onSnap: () => void }> = ({ pos, onSnap }) => {
  const [hov, setHov] = useState(false);
  const geo = useMemo(() => new THREE.BoxGeometry(0.20, 0.20, 0.20), []);
  return (
    <mesh geometry={geo} position={pos} renderOrder={6}
      onPointerEnter={e => { e.stopPropagation(); setHov(true);  document.body.style.cursor = 'pointer'; }}
      onPointerLeave={e => { e.stopPropagation(); setHov(false); document.body.style.cursor = 'default'; }}
      onClick={e      => { e.stopPropagation(); onSnap(); }}>
      <meshBasicMaterial color={C_ACCENT} transparent opacity={hov ? 0.85 : 0} depthTest={false} depthWrite={false} />
    </mesh>
  );
};

/* ══════════════════════════════════════════════════════════
   COMPASS RING
   Positioned well below the cube. Labels are large.
   Ring rotates only around Y to track camera azimuth.
══════════════════════════════════════════════════════════ */
const CompassRing: React.FC = () => {
  const ringRef = useRef<THREE.Group>(null);
  const { camera } = useThree();

  useFrame(() => {
    if (!ringRef.current) return;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const azimuth = Math.atan2(dir.x, dir.z);
    ringRef.current.rotation.set(-Math.PI / 2, 0, azimuth);
  });

  /* Ring sits well outside cube (cube half = 0.5, ring inner = 0.90) */
  const ringGeo = useMemo(() => new THREE.RingGeometry(0.90, 1.02, 72), []);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#a09890', side: THREE.DoubleSide, transparent: true, opacity: 0.75, depthTest: false,
  }), []);

  /* Cardinal ticks — long and thick (drawn as fat triangles) */
  const tickGeos = useMemo(() => {
    return [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(angle => {
      const inner = 1.02, outer = 1.22;
      const hw = 0.038; // half-width of tick
      const sa = Math.sin(angle), ca = Math.cos(angle);
      const perp = [-ca, sa]; // perpendicular direction
      const g = new THREE.BufferGeometry();
      const v = new Float32Array([
        sa * inner + perp[0] * hw, ca * inner + perp[1] * hw, 0,
        sa * inner - perp[0] * hw, ca * inner - perp[1] * hw, 0,
        sa * outer,                ca * outer,                0,
      ]);
      g.setAttribute('position', new THREE.BufferAttribute(v, 3));
      g.setIndex([0, 1, 2]);
      return g;
    });
  }, []);

  const tickMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: C_ACCENT, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthTest: false,
  }), []);

  /* N/E/S/W label textures — very large */
  const makeCardTex = (letter: string, isNorth: boolean): THREE.CanvasTexture => {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = isNorth ? C_ACCENT : '#4a4845';
    ctx.font = `900 88px "Syne","DM Sans",system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, S / 2, S / 2);
    const t = new THREE.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  };

  const cardinals = useMemo(() => [
    { letter: 'N', angle: 0 },
    { letter: 'E', angle:  Math.PI / 2 },
    { letter: 'S', angle:  Math.PI },
    { letter: 'W', angle: -Math.PI / 2 },
  ].map(({ letter, angle }) => ({
    letter,
    tex: makeCardTex(letter, letter === 'N'),
    /* push labels further out so they clear the ring */
    pos: new THREE.Vector3(Math.sin(angle) * 1.52, Math.cos(angle) * 1.52, 0),
  })), []);

  const labelGeo = useMemo(() => new THREE.PlaneGeometry(0.38, 0.38), []);

  return (
    /* Lower the ring so it clears the cube bottom (cube bottom = -0.5 in gizmo space) */
    <group position={[0, -0.62, 0]}>
      <group ref={ringRef}>
        <mesh geometry={ringGeo} material={ringMat} renderOrder={2} />

        {/* Tick triangles */}
        {tickGeos.map((g, i) => (
          <mesh key={`tk${i}`} geometry={g} material={tickMat} renderOrder={3} />
        ))}

        {/* Cardinal labels */}
        {cardinals.map(({ letter, pos, tex }) => (
          <mesh key={letter} position={pos} renderOrder={4}>
            <primitive object={labelGeo} attach="geometry" />
            <meshBasicMaterial map={tex} transparent depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        ))}
      </group>
    </group>
  );
};

/* ══════════════════════════════════════════════════════════
   MAIN VIEW CUBE
══════════════════════════════════════════════════════════ */
const ViewCube: React.FC = () => {
  const { tweenCamera } = useGizmoContext();
  const { camera }      = useThree();
  const cubeRef         = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!cubeRef.current) return;
    cubeRef.current.quaternion.copy(camera.quaternion).invert();
  });

  const snap = useCallback((dir: [number,number,number], up: [number,number,number] = [0,1,0]) => {
    tweenCamera(new THREE.Vector3(...dir), new THREE.Vector3(...up), 1);
  }, [tweenCamera]);

  const S = 1, H = 0.5, FW = 0.68, EW = 0.155, D = 0.003;

  const geoFace  = useMemo(() => new THREE.PlaneGeometry(FW, FW), []);
  const geoEdgeH = useMemo(() => new THREE.PlaneGeometry(FW, EW), []);
  const geoEdgeV = useMemo(() => new THREE.PlaneGeometry(EW, FW), []);
  const geoBody  = useMemo(() => new THREE.BoxGeometry(S, S, S),  []);
  const geoEdges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(S, S, S)), []);
  const matBody  = useMemo(() => new THREE.MeshBasicMaterial({ color: C_BODY, depthTest: false, depthWrite: false }), []);
  const matEdges = useMemo(() => new THREE.LineBasicMaterial({ color: C_OUTLINE, transparent: true, opacity: 1, depthTest: false }), []);

  const P = H + D, EC = (FW + EW) / 2;
  type V3 = [number,number,number];

  /* Single letter per face — large and readable */
  const FACES: { letter: string; pos: V3; rot: V3; dir: V3; up: V3; flipH?: boolean }[] = [
    { letter: 'F', pos: [0,0,P],   rot: [0,0,0],           dir: [0,0,1],  up: [0,1,0]  },
    { letter: 'B', pos: [0,0,-P],  rot: [0,Math.PI,0],     dir: [0,0,-1], up: [0,1,0]  },
    { letter: 'R', pos: [P,0,0],   rot: [0,-Math.PI/2,0],  dir: [1,0,0],  up: [0,1,0],  flipH: true },
    { letter: 'L', pos: [-P,0,0],  rot: [0,Math.PI/2,0],   dir: [-1,0,0], up: [0,1,0],  flipH: true },
    { letter: 'T', pos: [0,P,0],   rot: [-Math.PI/2,0,0],  dir: [0,1,0],  up: [0,0,-1] },
    { letter: 'U', pos: [0,-P,0],  rot: [Math.PI/2,0,0],   dir: [0,-1,0], up: [0,0,1]  },
  ];

  const EDGES: { pos: V3; rot: V3; geo: 'h'|'v'; dir: V3; up: V3 }[] = [
    // FRONT
    { pos:[0,EC,P],   rot:[0,0,0],           geo:'h', dir:norm(0,1,1),   up:[0,1,0]  },
    { pos:[0,-EC,P],  rot:[0,0,0],           geo:'h', dir:norm(0,-1,1),  up:[0,1,0]  },
    { pos:[-EC,0,P],  rot:[0,0,0],           geo:'v', dir:norm(-1,0,1),  up:[0,1,0]  },
    { pos:[EC,0,P],   rot:[0,0,0],           geo:'v', dir:norm(1,0,1),   up:[0,1,0]  },
    // BACK
    { pos:[0,EC,-P],  rot:[0,Math.PI,0],     geo:'h', dir:norm(0,1,-1),  up:[0,1,0]  },
    { pos:[0,-EC,-P], rot:[0,Math.PI,0],     geo:'h', dir:norm(0,-1,-1), up:[0,1,0]  },
    { pos:[EC,0,-P],  rot:[0,Math.PI,0],     geo:'v', dir:norm(1,0,-1),  up:[0,1,0]  },
    { pos:[-EC,0,-P], rot:[0,Math.PI,0],     geo:'v', dir:norm(-1,0,-1), up:[0,1,0]  },
    // RIGHT
    { pos:[P,EC,0],   rot:[0,-Math.PI/2,0],  geo:'h', dir:norm(1,1,0),   up:[0,1,0]  },
    { pos:[P,-EC,0],  rot:[0,-Math.PI/2,0],  geo:'h', dir:norm(1,-1,0),  up:[0,1,0]  },
    { pos:[P,0,EC],   rot:[0,-Math.PI/2,0],  geo:'v', dir:norm(1,0,1),   up:[0,1,0]  },
    { pos:[P,0,-EC],  rot:[0,-Math.PI/2,0],  geo:'v', dir:norm(1,0,-1),  up:[0,1,0]  },
    // LEFT
    { pos:[-P,EC,0],  rot:[0,Math.PI/2,0],   geo:'h', dir:norm(-1,1,0),  up:[0,1,0]  },
    { pos:[-P,-EC,0], rot:[0,Math.PI/2,0],   geo:'h', dir:norm(-1,-1,0), up:[0,1,0]  },
    { pos:[-P,0,-EC], rot:[0,Math.PI/2,0],   geo:'v', dir:norm(-1,0,-1), up:[0,1,0]  },
    { pos:[-P,0,EC],  rot:[0,Math.PI/2,0],   geo:'v', dir:norm(-1,0,1),  up:[0,1,0]  },
    // TOP
    { pos:[0,P,EC],   rot:[-Math.PI/2,0,0],  geo:'h', dir:norm(0,1,1),   up:[0,0,-1] },
    { pos:[0,P,-EC],  rot:[-Math.PI/2,0,0],  geo:'h', dir:norm(0,1,-1),  up:[0,0,-1] },
    { pos:[-EC,P,0],  rot:[-Math.PI/2,0,0],  geo:'v', dir:norm(-1,1,0),  up:[0,0,-1] },
    { pos:[EC,P,0],   rot:[-Math.PI/2,0,0],  geo:'v', dir:norm(1,1,0),   up:[0,0,-1] },
    // BOTTOM
    { pos:[0,-P,EC],  rot:[Math.PI/2,0,0],   geo:'h', dir:norm(0,-1,1),  up:[0,0,1]  },
    { pos:[0,-P,-EC], rot:[Math.PI/2,0,0],   geo:'h', dir:norm(0,-1,-1), up:[0,0,1]  },
    { pos:[-EC,-P,0], rot:[Math.PI/2,0,0],   geo:'v', dir:norm(-1,-1,0), up:[0,0,1]  },
    { pos:[EC,-P,0],  rot:[Math.PI/2,0,0],   geo:'v', dir:norm(1,-1,0),  up:[0,0,1]  },
  ];

  const CORNERS: { pos: V3; dir: V3; up: V3 }[] = [
    { pos:[ H, H, H], dir:norm(1,1,1),    up:[0,0,-1] },
    { pos:[-H, H, H], dir:norm(-1,1,1),   up:[0,0,-1] },
    { pos:[ H,-H, H], dir:norm(1,-1,1),   up:[0,0,1]  },
    { pos:[-H,-H, H], dir:norm(-1,-1,1),  up:[0,0,1]  },
    { pos:[ H, H,-H], dir:norm(1,1,-1),   up:[0,0,-1] },
    { pos:[-H, H,-H], dir:norm(-1,1,-1),  up:[0,0,-1] },
    { pos:[ H,-H,-H], dir:norm(1,-1,-1),  up:[0,0,1]  },
    { pos:[-H,-H,-H], dir:norm(-1,-1,-1), up:[0,0,1]  },
  ];

  return (
    <>
      <group ref={cubeRef}>
        <mesh geometry={geoBody} material={matBody} renderOrder={1} />
        <lineSegments geometry={geoEdges} material={matEdges} renderOrder={4} />

        {FACES.map((f, i) => (
          <FacePlane key={`f${i}`} geo={geoFace} pos={f.pos} rot={f.rot}
            letter={f.letter} flipH={f.flipH} onSnap={() => snap(f.dir, f.up)} />
        ))}
        {EDGES.map((e, i) => (
          <FacePlane key={`e${i}`} geo={e.geo === 'h' ? geoEdgeH : geoEdgeV}
            pos={e.pos} rot={e.rot} isEdge onSnap={() => snap(e.dir, e.up)} />
        ))}
        {CORNERS.map((c, i) => (
          <CornerZone key={`c${i}`} pos={c.pos} onSnap={() => snap(c.dir, c.up)} />
        ))}
      </group>

      <CompassRing />
    </>
  );
};

/* ══════════════════════════════════════════════════════════
   CAMERA CONTROLLER
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
          position: cameraRef.current.position.clone(),
          target:   controlsRef.current.target.clone(),
          zoom:     cameraRef.current instanceof THREE.OrthographicCamera ? cameraRef.current.zoom : 1,
          perspectiveFov: cameraRef.current instanceof THREE.PerspectiveCamera ? cameraRef.current.fov : 45,
        };
      }
    }, 100);
    return () => clearInterval(id);
  }, [controlsRef]);

  return cameraType === CameraType.PERSPECTIVE
    ? <PerspectiveCamera  ref={cameraRef as React.RefObject<THREE.PerspectiveCamera>}  makeDefault position={savedRef.current?.position.toArray() || [2000,2000,2000]} fov={45}   near={1}      far={50000} />
    : <OrthographicCamera ref={cameraRef as React.RefObject<THREE.OrthographicCamera>} makeDefault position={savedRef.current?.position.toArray() || [2000,2000,2000]} zoom={0.25} near={-50000} far={50000} />;
};

/* ══════════════════════════════════════════════════════════
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

  const [contextMenu, setContextMenu] = useState<{ x:number; y:number; shapeId:string; shapeType:string }|null>(null);
  const [saveDialog,  setSaveDialog ] = useState<{ isOpen:boolean; shapeId:string|null }>({ isOpen:false, shapeId:null });

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selectedShapeId) deleteShape(selectedShapeId);
      else if (e.key === 'Escape') { selectShape(null); exitIsolation(); setVertexEditMode(false); setFaceEditMode(false); clearFilletFaces(); }
      else if ((e.ctrlKey||e.metaKey) && e.key === 'g') { e.preventDefault(); if (selectedShapeId && secondarySelectedShapeId) useAppStore.getState().createGroup(selectedShapeId, secondarySelectedShapeId); }
      else if ((e.ctrlKey||e.metaKey) && e.key === 'u') { e.preventDefault(); if (selectedShapeId) { const sh = shapes.find(s => s.id === selectedShapeId); if (sh?.groupId) useAppStore.getState().ungroupShapes(sh.groupId); } }
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
          else if (shape.replicadShape) { const { getReplicadVertices: g } = await import('./VertexEditorService'); bv = (await g(shape.replicadShape)).map(v => [v.x,v.y,v.z]); }
          else if (shape.type === 'box') { const { getBoxVertices } = await import('./VertexEditorService'); bv = getBoxVertices(shape.parameters.width, shape.parameters.height, shape.parameters.depth).map(v => [v.x,v.y,v.z]); }
          if (vi >= bv.length) return;
          const op = bv[vi]; const ai = vd.startsWith('x') ? 0 : vd.startsWith('y') ? 1 : 2;
          const np: [number,number,number] = [...op] as [number,number,number]; np[ai] = newValue;
          const off: [number,number,number] = [0,0,0]; off[ai] = newValue - op[ai];
          cs.addVertexModification(sid, { vertexIndex: vi, originalPosition: op as [number,number,number], newPosition: np, direction: vd, expression: String(newValue), description: `Vertex ${vi} ${vd[0].toUpperCase()}${vd[1]==='+'?'+':'-'}`, offset: off });
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
          if (shape.rotation[0]||shape.rotation[1]||shape.rotation[2]) ro.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(shape.rotation[0],shape.rotation[1],shape.rotation[2],'XYZ')));
          cs.updateShape(sid, { geometry: result.geometry, replicadShape: result.replicadShape, position: [shape.position[0]-ro.x,shape.position[1]-ro.y,shape.position[2]-ro.z], rotation: shape.rotation, scale: shape.scale, parameters: { ...shape.parameters, scaledBaseVertices: nbv.map(v=>[v.x,v.y,v.z]), width: shape.parameters.width||1, height: shape.parameters.height||1, depth: shape.parameters.depth||1 }, fillets: [...(shape.fillets||[]),result.filletData] });
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
    e.nativeEvent.preventDefault(); state.selectShape(shapeId);
    setContextMenu({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY, shapeId, shapeType: state.shapes.find(s=>s.id===shapeId)?.type||'unknown' });
  }, []);

  const captureSnapshot = () => { const c = document.querySelector('canvas'); return c ? c.toDataURL('image/png') : ''; };

  const serializeSubs = (sg: any[]|undefined) => {
    if (!sg?.length) return [];
    return sg.filter(Boolean).map(sub => {
      const out: any = { relativeOffset: sub.relativeOffset, relativeRotation: sub.relativeRotation, scale: sub.scale, parameters: sub.parameters };
      if (sub.geometry) { const pa = sub.geometry.getAttribute('position'); if (pa) { const sz = new THREE.Vector3(); new THREE.Box3().setFromBufferAttribute(pa).getSize(sz); out.geometrySize=[sz.x,sz.y,sz.z]; } }
      return out;
    });
  };

  const handleSave = async (data: { code:string; description:string; tags:string[]; previewImage?:string }) => {
    if (!saveDialog.shapeId) return;
    const shape = shapes.find(s => s.id === saveDialog.shapeId); if (!shape) return;
    try {
      let gd: any, sp: any={}, ssd: any[]=[], fd: any[]=[], frd: Record<number,string>={};
      if (shape.groupId) {
        const gs = shapes.filter(s => s.groupId === shape.groupId);
        gd = { type:'group', shapes: gs.map(s=>({ type:s.type, position:s.position, rotation:s.rotation, scale:s.scale, color:s.color, parameters:s.parameters, vertexModifications:s.vertexModifications||[], isReferenceBox:s.isReferenceBox })) };
      } else {
        gd = { type:shape.type, position:shape.position, rotation:shape.rotation, scale:shape.scale, color:shape.color, parameters:shape.parameters, vertexModifications:shape.vertexModifications||[] };
        sp = { width:shape.parameters?.width, height:shape.parameters?.height, depth:shape.parameters?.depth, color:shape.color, position:shape.position, rotation:shape.rotation, scale:shape.scale, vertexModifications:shape.vertexModifications||[] };
        ssd = serializeSubs(shape.subtractionGeometries);
        if (shape.fillets) fd = shape.fillets.map(f=>({ face1Descriptor:f.face1Descriptor, face2Descriptor:f.face2Descriptor, face1Data:f.face1Data, face2Data:f.face2Data, radius:f.radius, originalSize:f.originalSize }));
        if (shape.faceRoles) frd = Object.entries(shape.faceRoles).reduce((a,[k,v])=>{ if(v) a[Number(k)]=v; return a; }, {} as Record<number,string>);
      }
      await catalogService.save({ code:data.code, description:data.description, tags:data.tags, geometry_data:gd, shape_parameters:sp, subtraction_geometries:ssd, fillets:fd, face_roles:frd, preview_image:data.previewImage });
      alert('Geometry saved successfully!'); setSaveDialog({ isOpen:false, shapeId:null });
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
        <Canvas shadows gl={{ antialias:true, alpha:false, preserveDrawingBuffer:true, powerPreference:'high-performance', logarithmicDepthBuffer:true }} dpr={[1,2]} onContextMenu={e=>e.preventDefault()} onCreated={handleCreated}>
          <color attach="background" args={['#f5f5f4']} />
          <CameraController controlsRef={controlsRef} cameraType={cameraType} />

          <ambientLight intensity={0.6} />
          <hemisphereLight intensity={0.4} groundColor="#888888" color="#ffffff" />
          <directionalLight position={[1500,2500,1500]} intensity={1.8} castShadow
            shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-bias={-0.0005}
            shadow-camera-far={15000} shadow-camera-left={-3000} shadow-camera-right={3000}
            shadow-camera-top={3000} shadow-camera-bottom={-3000} />
          <directionalLight position={[-1000,1500,-1000]} intensity={0.4} />
          <directionalLight position={[0,2000,-2000]} intensity={0.3} />
          <directionalLight position={[500,500,3000]} intensity={0.5} />

          <OrbitControls ref={controlsRef} makeDefault target={[0,0,0]} enableDamping dampingFactor={0.05} rotateSpeed={0.8} maxDistance={25000} minDistance={50} />

          {shapes.map(shape => {
            const isSel = selectedShapeId === shape.id;
            if (shape.type === 'panel') return <PanelDrawing key={shape.id} shape={shape} isSelected={isSel} />;
            return (
              <React.Fragment key={shape.id}>
                <ShapeWithTransform shape={shape} isSelected={isSel} orbitControlsRef={controlsRef} onContextMenu={handleContextMenu} />
                {isSel && vertexEditMode && <VertexEditor shape={shape} isActive onVertexSelect={i=>setSelectedVertexIndex(i)} onDirectionChange={d=>setVertexDirection(d)} />}
              </React.Fragment>
            );
          })}

          <mesh position={[0,-1,0]} rotation={[-Math.PI/2,0,0]} receiveShadow>
            <planeGeometry args={[30000,30000]} />
            <shadowMaterial opacity={0.12} />
          </mesh>

          {/*
            scale=42  → cube size unchanged
            margin right=116, margin bottom=140
            Extra bottom margin gives room for the now-larger compass ring + labels
          */}
          <GizmoHelper alignment="bottom-right" margin={[116, 140]}>
            <group scale={42}>
              <ViewCube />
            </group>
          </GizmoHelper>

        </Canvas>
      </ErrorBoundary>

      {contextMenu && (
        <ContextMenu
          position={{ x:contextMenu.x, y:contextMenu.y }}
          shapeId={contextMenu.shapeId} shapeType={contextMenu.shapeType}
          onClose={() => setContextMenu(null)}
          onEdit={() => { isolateShape(contextMenu.shapeId); setContextMenu(null); }}
          onCopy={() => { copyShape(contextMenu.shapeId); setContextMenu(null); }}
          onDelete={() => { deleteShape(contextMenu.shapeId); setContextMenu(null); }}
          onSave={() => { setSaveDialog({ isOpen:true, shapeId:contextMenu.shapeId }); setContextMenu(null); }}
        />
      )}
      <SaveDialog isOpen={saveDialog.isOpen} onClose={() => setSaveDialog({ isOpen:false, shapeId:null })} onSave={handleSave} shapeId={saveDialog.shapeId||''} captureSnapshot={captureSnapshot} />
    </>
  );
};

export default Scene;
