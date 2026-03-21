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

/* ═══════════════════════════════════════════════════════════════
   VIEW-CUBE GIZMO
   Replicates Autodesk ViewCube behaviour:
     • 6 face regions  → orthographic snap to that face
     • 12 edge regions → 45° snap between two adjacent faces
     • 8 corner regions→ isometric snap through that corner
   All regions highlight on hover and snap camera on click.
   Uses useGizmoContext().tweenCamera so the gizmo stays fixed.
════════════════════════════════════════════════════════════════ */

const ACC  = '#e8622a';          // hover / accent colour
const BASE = 'rgba(18,18,22,0.90)';

/* ── Texture helpers ─────────────────────────────────────── */
function makeTexture(label: string, hovered: boolean, fontSize = 18): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = hovered ? 'rgba(232,98,42,0.97)' : BASE;
  ctx.fillRect(0, 0, S, S);

  if (!hovered) {
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, S - 2, S - 2);
  }

  if (label) {
    ctx.fillStyle = hovered ? '#fff' : 'rgba(210,210,220,0.92)';
    ctx.font = `bold ${fontSize}px "Syne","DM Sans",system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, S / 2, S / 2);
  }

  const t = new THREE.CanvasTexture(canvas);
  t.needsUpdate = true;
  return t;
}

function makeEdgeTex(hovered: boolean): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = hovered ? 'rgba(232,98,42,0.88)' : 'rgba(30,30,36,0.82)';
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(canvas);
  t.needsUpdate = true;
  return t;
}

/* ── HoverMesh — generic hoverable / clickable mesh ─────── */
interface HoverMeshProps {
  geometry: THREE.BufferGeometry;
  position: [number,number,number];
  rotation?: [number,number,number];
  onSnap: () => void;
  label?: string;
  fontSize?: number;
  isEdge?: boolean;
}

const HoverMesh: React.FC<HoverMeshProps> = ({ geometry, position, rotation, onSnap, label='', fontSize=18, isEdge=false }) => {
  const [hov, setHov] = useState(false);
  const tex = useMemo(
    () => isEdge ? makeEdgeTex(hov) : makeTexture(label, hov, fontSize),
    [hov, label, fontSize, isEdge]
  );
  useEffect(() => () => tex.dispose(), [tex]);

  return (
    <mesh
      geometry={geometry}
      position={position}
      rotation={rotation ? new THREE.Euler(...rotation) : undefined}
      onPointerEnter={e => { e.stopPropagation(); setHov(true);  document.body.style.cursor = 'pointer'; }}
      onPointerLeave={e => { e.stopPropagation(); setHov(false); document.body.style.cursor = 'default';  }}
      onClick={e     => { e.stopPropagation(); onSnap(); }}
      renderOrder={2}
    >
      <meshBasicMaterial map={tex} transparent depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
};

/* ── ViewCube component ──────────────────────────────────── */
const ViewCube: React.FC = () => {
  const { tweenCamera } = useGizmoContext();
  const { camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);

  /* Keep cube orientation synced to scene camera */
  useFrame(() => {
    if (!groupRef.current) return;
    groupRef.current.quaternion.copy(camera.quaternion).invert();
  });

  /* Snap helpers */
  const snap = useCallback((dir: [number,number,number], up: [number,number,number] = [0,1,0]) => {
    tweenCamera(new THREE.Vector3(...dir), new THREE.Vector3(...up), 1);
  }, [tweenCamera]);

  /* ── Geometry cache ──────────────────────────────────────── */
  const S = 1;          // cube half-size = 0.5  → full edge = 1
  const F = 0.70;       // face plane size (leaves room for edge strips)
  const EW = 0.155;     // edge strip width
  const CW = 0.155;     // corner size
  const DEPTH = 0.01;   // thin plane depth

  const facePlane   = useMemo(() => new THREE.PlaneGeometry(F, F), []);
  const hEdgePlane  = useMemo(() => new THREE.PlaneGeometry(F, EW), []);   // horizontal edge on face
  const vEdgePlane  = useMemo(() => new THREE.PlaneGeometry(EW, F), []);   // vertical edge on face
  const cornerPlane = useMemo(() => new THREE.PlaneGeometry(CW, CW), []);

  // Solid cube body (opaque, rendered first)
  const bodyGeo  = useMemo(() => new THREE.BoxGeometry(S, S, S), []);
  const edgesGeo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(S, S, S)), []);
  const edgesMat = useMemo(() => new THREE.LineBasicMaterial({ color:'#bbbbbb', transparent:true, opacity:0.22, depthTest:false }), []);

  const H = S / 2;   // 0.5

  /* ─── FACE definitions ───────────────────────────────────
     Each face: label, position, rotation, snap direction, up
  ─────────────────────────────────────────────────────── */
  type FaceDef = { label:string; pos:[number,number,number]; rot:[number,number,number]; dir:[number,number,number]; up:[number,number,number] };
  const FACES: FaceDef[] = [
    { label:'FRONT',  pos:[0,    0,    H+DEPTH], rot:[0,0,0],              dir:[0,0,1],  up:[0,1,0] },
    { label:'BACK',   pos:[0,    0,  -(H+DEPTH)],rot:[0,Math.PI,0],        dir:[0,0,-1], up:[0,1,0] },
    { label:'RIGHT',  pos:[H+DEPTH, 0, 0],       rot:[0,-Math.PI/2,0],     dir:[1,0,0],  up:[0,1,0] },
    { label:'LEFT',   pos:[-(H+DEPTH),0, 0],     rot:[0, Math.PI/2,0],     dir:[-1,0,0], up:[0,1,0] },
    { label:'TOP',    pos:[0, H+DEPTH, 0],       rot:[-Math.PI/2,0,0],     dir:[0,1,0],  up:[0,0,-1] },
    { label:'BOTTOM', pos:[0,-(H+DEPTH), 0],     rot:[ Math.PI/2,0,0],     dir:[0,-1,0], up:[0,0,1]  },
  ];

  /* ─── EDGE definitions ───────────────────────────────────
     12 edges: between every adjacent face pair.
     Each edge strip sits ON a face plane at the face boundary.
     dir = normalised bisector of the two face normals → 45° snap.

     Convention per face: strips at top / bottom / left / right boundary.
     We render them as thin planes slightly in front of the face.
  ─────────────────────────────────────────────────────── */
  type EdgeDef = { pos:[number,number,number]; rot:[number,number,number]; geo:'h'|'v'; dir:[number,number,number]; up:[number,number,number] };

  const E = H + DEPTH * 1.5;        // just in front of face surface
  const EC = (F + EW) / 2;          // centre of the edge strip on the face

  // Helper: normalise a direction
  const N = (x:number,y:number,z:number): [number,number,number] => {
    const l = Math.sqrt(x*x+y*y+z*z);
    return [x/l, y/l, z/l];
  };

  // FRONT face (rot 0) – top/bottom/left/right strips
  const EDGES: EdgeDef[] = [
    // FRONT face edges
    { pos:[0, EC, E], rot:[0,0,0], geo:'h', dir:N(0,1,1), up:[0,1,0] },         // front-top
    { pos:[0,-EC, E], rot:[0,0,0], geo:'h', dir:N(0,-1,1),up:[0,-1,0] },        // front-bottom
    { pos:[-EC,0, E], rot:[0,0,0], geo:'v', dir:N(-1,0,1),up:[0,1,0] },         // front-left
    { pos:[ EC,0, E], rot:[0,0,0], geo:'v', dir:N( 1,0,1),up:[0,1,0] },         // front-right
    // BACK face edges
    { pos:[0, EC,-(E)], rot:[0,Math.PI,0], geo:'h', dir:N(0,1,-1), up:[0,1,0]  },   // back-top
    { pos:[0,-EC,-(E)], rot:[0,Math.PI,0], geo:'h', dir:N(0,-1,-1),up:[0,-1,0] },   // back-bottom
    { pos:[ EC,0,-(E)], rot:[0,Math.PI,0], geo:'v', dir:N(1,0,-1), up:[0,1,0]  },   // back-left  (mirrored)
    { pos:[-EC,0,-(E)], rot:[0,Math.PI,0], geo:'v', dir:N(-1,0,-1),up:[0,1,0]  },   // back-right (mirrored)
    // TOP face edges (connecting top to front/back/left/right)
    { pos:[0, E, EC], rot:[-Math.PI/2,0,0], geo:'h', dir:N(0,1,1),  up:[0,0,-1] },  // top-front
    { pos:[0, E,-EC], rot:[-Math.PI/2,0,0], geo:'h', dir:N(0,1,-1), up:[0,0,-1] },  // top-back
    { pos:[-EC, E,0], rot:[-Math.PI/2,0,0], geo:'v', dir:N(-1,1,0), up:[0,0,-1] },  // top-left
    { pos:[ EC, E,0], rot:[-Math.PI/2,0,0], geo:'v', dir:N( 1,1,0), up:[0,0,-1] },  // top-right
    // BOTTOM face edges
    { pos:[0,-E, EC], rot:[Math.PI/2,0,0], geo:'h', dir:N(0,-1,1),  up:[0,0,1] },   // bottom-front
    { pos:[0,-E,-EC], rot:[Math.PI/2,0,0], geo:'h', dir:N(0,-1,-1), up:[0,0,1] },   // bottom-back
    { pos:[-EC,-E,0], rot:[Math.PI/2,0,0], geo:'v', dir:N(-1,-1,0), up:[0,0,1] },   // bottom-left
    { pos:[ EC,-E,0], rot:[Math.PI/2,0,0], geo:'v', dir:N( 1,-1,0), up:[0,0,1] },   // bottom-right
  ];

  /* ─── CORNER definitions ─────────────────────────────────
     8 corners rendered as small squares at each face corner.
     We place one on each of the 6 faces (4 corners per face = 24 total)
     but deduplicate by position — easier: render 3 planes per corner
     (one on each of the 3 adjacent faces), user clicks whichever is visible.

     Simpler approach: render 8 corner cubes (tiny boxes) at cube corners.
  ─────────────────────────────────────────────────────── */
  type CornerDef = { pos:[number,number,number]; dir:[number,number,number] };
  const CORNERS: CornerDef[] = [
    { pos:[ H, H, H], dir:N( 1, 1, 1) },
    { pos:[-H, H, H], dir:N(-1, 1, 1) },
    { pos:[ H,-H, H], dir:N( 1,-1, 1) },
    { pos:[-H,-H, H], dir:N(-1,-1, 1) },
    { pos:[ H, H,-H], dir:N( 1, 1,-1) },
    { pos:[-H, H,-H], dir:N(-1, 1,-1) },
    { pos:[ H,-H,-H], dir:N( 1,-1,-1) },
    { pos:[-H,-H,-H], dir:N(-1,-1,-1) },
  ];

  const cornerGeo = useMemo(() => new THREE.BoxGeometry(CW, CW, CW), []);

  return (
    <group ref={groupRef}>

      {/* ── Opaque body (rendered first, blocks inner faces) ── */}
      <mesh geometry={bodyGeo} renderOrder={1}>
        <meshBasicMaterial color="#0f0f12" transparent opacity={0.93} depthTest={false} depthWrite={false} />
      </mesh>

      {/* ── Edge outline ── */}
      <lineSegments geometry={edgesGeo} material={edgesMat} renderOrder={3} />

      {/* ── 6 FACES ── */}
      {FACES.map((f, i) => (
        <HoverMesh
          key={`face-${i}`}
          geometry={facePlane}
          position={f.pos}
          rotation={f.rot}
          label={f.label}
          fontSize={f.label.length > 4 ? 16 : 19}
          onSnap={() => snap(f.dir, f.up)}
        />
      ))}

      {/* ── 16 EDGE STRIPS (on front/back/top/bottom) ──
          + 4 more vertical edges on left/right faces ── */}
      {EDGES.map((e, i) => (
        <HoverMesh
          key={`edge-${i}`}
          geometry={e.geo === 'h' ? hEdgePlane : vEdgePlane}
          position={e.pos}
          rotation={e.rot}
          isEdge
          onSnap={() => snap(e.dir, e.up)}
        />
      ))}

      {/* ── Left face edge strips (RIGHT face of cube = +X) ── */}
      {([
        { pos:[ H+DEPTH,  EC, 0] as [number,number,number], rot:[0,-Math.PI/2,0] as [number,number,number], dir:N(1, 1,0),  up:[0,1,0] },
        { pos:[ H+DEPTH, -EC, 0] as [number,number,number], rot:[0,-Math.PI/2,0] as [number,number,number], dir:N(1,-1,0),  up:[0,1,0] },
        { pos:[ H+DEPTH, 0,  EC] as [number,number,number], rot:[0,-Math.PI/2,0] as [number,number,number], dir:N(1, 0,1),  up:[0,1,0] },
        { pos:[ H+DEPTH, 0, -EC] as [number,number,number], rot:[0,-Math.PI/2,0] as [number,number,number], dir:N(1, 0,-1), up:[0,1,0] },
        { pos:[-(H+DEPTH), EC, 0] as [number,number,number],rot:[0,Math.PI/2,0]  as [number,number,number], dir:N(-1, 1,0), up:[0,1,0] },
        { pos:[-(H+DEPTH),-EC, 0] as [number,number,number],rot:[0,Math.PI/2,0]  as [number,number,number], dir:N(-1,-1,0), up:[0,1,0] },
        { pos:[-(H+DEPTH),0,  EC] as [number,number,number],rot:[0,Math.PI/2,0]  as [number,number,number], dir:N(-1,0, 1), up:[0,1,0] },
        { pos:[-(H+DEPTH),0, -EC] as [number,number,number],rot:[0,Math.PI/2,0]  as [number,number,number], dir:N(-1,0,-1), up:[0,1,0] },
      ]).map((e, i) => (
        <HoverMesh
          key={`side-edge-${i}`}
          geometry={i % 2 === 0 || i === 2 || i === 3 || i === 6 || i === 7 ? hEdgePlane : vEdgePlane}
          position={e.pos}
          rotation={e.rot}
          isEdge
          onSnap={() => snap(e.dir as [number,number,number], e.up as [number,number,number])}
        />
      ))}

      {/* ── 8 CORNERS ── */}
      {CORNERS.map((c, i) => {
        const up: [number,number,number] = c.dir[1] > 0 ? [0,0,-1] : [0,0,1];
        return (
          <CornerMesh key={`corner-${i}`} geo={cornerGeo} pos={c.pos} onSnap={() => snap(c.dir, up)} />
        );
      })}

      {/* ── Axis stubs ── */}
      {([
        { v: new THREE.Vector3(0.72,0,0), c:'#f87171' },
        { v: new THREE.Vector3(0,0.72,0), c:'#4ade80' },
        { v: new THREE.Vector3(0,0,0.72), c:'#60a5fa' },
      ]).map(({ v, c }, i) => {
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), v]);
        return (
          <lineSegments key={`axis-${i}`} renderOrder={5}>
            <primitive object={geo} attach="geometry" />
            <lineBasicMaterial color={c} transparent opacity={0.6} depthTest={false} />
          </lineSegments>
        );
      })}

    </group>
  );
};

/* Corner mesh with its own hover state (uses box geo for easy hit) */
const CornerMesh: React.FC<{ geo: THREE.BufferGeometry; pos:[number,number,number]; onSnap:()=>void }> = ({ geo, pos, onSnap }) => {
  const [hov, setHov] = useState(false);
  return (
    <mesh
      geometry={geo}
      position={pos}
      onPointerEnter={e => { e.stopPropagation(); setHov(true);  document.body.style.cursor='pointer'; }}
      onPointerLeave={e => { e.stopPropagation(); setHov(false); document.body.style.cursor='default';  }}
      onClick={e => { e.stopPropagation(); onSnap(); }}
      renderOrder={4}
    >
      <meshBasicMaterial color={hov ? ACC : '#222228'} transparent opacity={hov ? 0.97 : 0.88} depthTest={false} depthWrite={false} />
    </mesh>
  );
};

/* ═══════════════════════════════════════════════════════════════
   CAMERA CONTROLLER  (unchanged)
═══════════════════════════════════════════════════════════════ */
const CameraController: React.FC<{ controlsRef: React.RefObject<any>; cameraType: CameraType }> = ({ controlsRef, cameraType }) => {
  const cameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera>(null);
  const savedRef  = useRef<{ position:THREE.Vector3; target:THREE.Vector3; zoom:number; perspectiveFov:number }|null>(null);
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
    ? <PerspectiveCamera   ref={cameraRef as React.RefObject<THREE.PerspectiveCamera>}   makeDefault position={savedRef.current?.position.toArray()||[2000,2000,2000]} fov={45} near={1}      far={50000}  />
    : <OrthographicCamera  ref={cameraRef as React.RefObject<THREE.OrthographicCamera>}  makeDefault position={savedRef.current?.position.toArray()||[2000,2000,2000]} zoom={0.25} near={-50000} far={50000} />;
};

/* ═══════════════════════════════════════════════════════════════
   SCENE
═══════════════════════════════════════════════════════════════ */
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
    shapes:state.shapes, cameraType:state.cameraType,
    selectedShapeId:state.selectedShapeId, secondarySelectedShapeId:state.secondarySelectedShapeId,
    selectShape:state.selectShape, deleteShape:state.deleteShape, copyShape:state.copyShape,
    isolateShape:state.isolateShape, exitIsolation:state.exitIsolation,
    vertexEditMode:state.vertexEditMode, setVertexEditMode:state.setVertexEditMode,
    selectedVertexIndex:state.selectedVertexIndex, setSelectedVertexIndex:state.setSelectedVertexIndex,
    vertexDirection:state.vertexDirection, setVertexDirection:state.setVertexDirection,
    addVertexModification:state.addVertexModification, subtractionViewMode:state.subtractionViewMode,
    faceEditMode:state.faceEditMode, setFaceEditMode:state.setFaceEditMode,
    filletMode:state.filletMode, selectedFilletFaces:state.selectedFilletFaces,
    clearFilletFaces:state.clearFilletFaces, selectedFilletFaceData:state.selectedFilletFaceData,
    updateShape:state.updateShape, panelSelectMode:state.panelSelectMode,
    panelSurfaceSelectMode:state.panelSurfaceSelectMode, setSelectedPanelRow:state.setSelectedPanelRow,
  })));

  const [contextMenu, setContextMenu] = useState<{x:number;y:number;shapeId:string;shapeType:string}|null>(null);
  const [saveDialog,  setSaveDialog ] = useState<{isOpen:boolean;shapeId:string|null}>({isOpen:false,shapeId:null});

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key==='Delete' && selectedShapeId) deleteShape(selectedShapeId);
      else if (e.key==='Escape') { selectShape(null); exitIsolation(); setVertexEditMode(false); setFaceEditMode(false); clearFilletFaces(); }
      else if ((e.ctrlKey||e.metaKey) && e.key==='g') { e.preventDefault(); if (selectedShapeId && secondarySelectedShapeId) useAppStore.getState().createGroup(selectedShapeId, secondarySelectedShapeId); }
      else if ((e.ctrlKey||e.metaKey) && e.key==='u') { e.preventDefault(); if (selectedShapeId) { const sh=shapes.find(s=>s.id===selectedShapeId); if (sh?.groupId) useAppStore.getState().ungroupShapes(sh.groupId); } }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [selectedShapeId, secondarySelectedShapeId, shapes, deleteShape, selectShape, exitIsolation, setVertexEditMode, setFaceEditMode, clearFilletFaces]);

  useEffect(() => {
    (window as any).handleVertexOffset = async (newValue: number) => {
      const cs = useAppStore.getState();
      const { selectedShapeId:sid, selectedVertexIndex:vi, vertexDirection:vd } = cs;
      if (sid && vi!==null && vd) {
        const shape = cs.shapes.find(s=>s.id===sid);
        if (shape?.parameters) {
          let bv: number[][] = [];
          if (shape.parameters.scaledBaseVertices?.length>0) bv=shape.parameters.scaledBaseVertices;
          else if (shape.replicadShape) { const {getReplicadVertices:g}=await import('./VertexEditorService'); bv=(await g(shape.replicadShape)).map(v=>[v.x,v.y,v.z]); }
          else if (shape.type==='box') { const {getBoxVertices}=await import('./VertexEditorService'); bv=getBoxVertices(shape.parameters.width,shape.parameters.height,shape.parameters.depth).map(v=>[v.x,v.y,v.z]); }
          if (vi>=bv.length) return;
          const op=bv[vi];
          const ai=vd.startsWith('x')?0:vd.startsWith('y')?1:2;
          const np:[number,number,number]=[...op] as [number,number,number]; np[ai]=newValue;
          const off:[number,number,number]=[0,0,0]; off[ai]=newValue-op[ai];
          cs.addVertexModification(sid,{vertexIndex:vi,originalPosition:op as [number,number,number],newPosition:np,direction:vd,expression:String(newValue),description:`Vertex ${vi} ${vd[0].toUpperCase()}${vd[1]==='+'?'+':'-'}`,offset:off});
        }
        (window as any).pendingVertexEdit=false; cs.setSelectedVertexIndex(null);
      }
    };
    (window as any).pendingVertexEdit=selectedVertexIndex!==null&&vertexDirection!==null;
    return ()=>{delete (window as any).handleVertexOffset;delete (window as any).pendingVertexEdit;};
  }, [selectedVertexIndex, vertexDirection]);

  useEffect(() => {
    (window as any).handleFilletRadius = async (radius:number) => {
      const cs=useAppStore.getState();
      const {selectedShapeId:sid,filletMode:fm,selectedFilletFaces:sff,selectedFilletFaceData:sffd}=cs;
      if (sid&&fm&&sff.length===2&&sffd.length===2) {
        const shape=cs.shapes.find(s=>s.id===sid); if(!shape?.replicadShape)return;
        try {
          const oc=new THREE.Vector3();
          if(shape.geometry)new THREE.Box3().setFromBufferAttribute(shape.geometry.getAttribute('position')).getCenter(oc);
          const result=await applyFilletToShape(shape,sff,sffd,radius);
          const nbv=await getReplicadVertices(result.replicadShape);
          const nc=new THREE.Vector3(); new THREE.Box3().setFromBufferAttribute(result.geometry.getAttribute('position')).getCenter(nc);
          const ro=new THREE.Vector3().subVectors(nc,oc);
          if(shape.rotation[0]||shape.rotation[1]||shape.rotation[2])ro.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(shape.rotation[0],shape.rotation[1],shape.rotation[2],'XYZ')));
          cs.updateShape(sid,{geometry:result.geometry,replicadShape:result.replicadShape,position:[shape.position[0]-ro.x,shape.position[1]-ro.y,shape.position[2]-ro.z],rotation:shape.rotation,scale:shape.scale,parameters:{...shape.parameters,scaledBaseVertices:nbv.map(v=>[v.x,v.y,v.z]),width:shape.parameters.width||1,height:shape.parameters.height||1,depth:shape.parameters.depth||1},fillets:[...(shape.fillets||[]),result.filletData]});
          cs.clearFilletFaces();
        } catch(err){console.error('fillet failed:',err);cs.clearFilletFaces();alert(`Failed to apply fillet: ${(err as Error).message}`);}
      }
      (window as any).pendingFilletOperation=false;
    };
    (window as any).pendingFilletOperation=filletMode&&selectedFilletFaces.length===2;
    return ()=>{delete (window as any).handleFilletRadius;delete (window as any).pendingFilletOperation;};
  }, [filletMode, selectedFilletFaces.length]);

  const handleContextMenu = useCallback((e:any, shapeId:string)=>{
    const state=useAppStore.getState();
    if(state.vertexEditMode||state.faceEditMode)return;
    e.nativeEvent.preventDefault();
    state.selectShape(shapeId);
    setContextMenu({x:e.nativeEvent.clientX,y:e.nativeEvent.clientY,shapeId,shapeType:state.shapes.find(s=>s.id===shapeId)?.type||'unknown'});
  },[]);

  const captureSnapshot=()=>{const c=document.querySelector('canvas');return c?c.toDataURL('image/png'):'';};

  const serializeSubs=(sg:any[]|undefined)=>{
    if(!sg?.length)return[];
    return sg.filter(Boolean).map(sub=>{
      const out:any={relativeOffset:sub.relativeOffset,relativeRotation:sub.relativeRotation,scale:sub.scale,parameters:sub.parameters};
      if(sub.geometry){const pa=sub.geometry.getAttribute('position');if(pa){const sz=new THREE.Vector3();new THREE.Box3().setFromBufferAttribute(pa).getSize(sz);out.geometrySize=[sz.x,sz.y,sz.z];}}
      return out;
    });
  };

  const handleSave=async(data:{code:string;description:string;tags:string[];previewImage?:string})=>{
    if(!saveDialog.shapeId)return;
    const shape=shapes.find(s=>s.id===saveDialog.shapeId);if(!shape)return;
    try{
      let gd:any,sp:any={},ssd:any[]=[],fd:any[]=[],frd:Record<number,string>={};
      if(shape.groupId){
        const gs=shapes.filter(s=>s.groupId===shape.groupId);
        gd={type:'group',shapes:gs.map(s=>({type:s.type,position:s.position,rotation:s.rotation,scale:s.scale,color:s.color,parameters:s.parameters,vertexModifications:s.vertexModifications||[],isReferenceBox:s.isReferenceBox}))};
      }else{
        gd={type:shape.type,position:shape.position,rotation:shape.rotation,scale:shape.scale,color:shape.color,parameters:shape.parameters,vertexModifications:shape.vertexModifications||[]};
        sp={width:shape.parameters?.width,height:shape.parameters?.height,depth:shape.parameters?.depth,color:shape.color,position:shape.position,rotation:shape.rotation,scale:shape.scale,vertexModifications:shape.vertexModifications||[]};
        ssd=serializeSubs(shape.subtractionGeometries);
        if(shape.fillets)fd=shape.fillets.map(f=>({face1Descriptor:f.face1Descriptor,face2Descriptor:f.face2Descriptor,face1Data:f.face1Data,face2Data:f.face2Data,radius:f.radius,originalSize:f.originalSize}));
        if(shape.faceRoles)frd=Object.entries(shape.faceRoles).reduce((a,[k,v])=>{if(v)a[Number(k)]=v;return a;},{} as Record<number,string>);
      }
      await catalogService.save({code:data.code,description:data.description,tags:data.tags,geometry_data:gd,shape_parameters:sp,subtraction_geometries:ssd,fillets:fd,face_roles:frd,preview_image:data.previewImage});
      alert('Geometry saved successfully!');setSaveDialog({isOpen:false,shapeId:null});
    }catch(err){console.error('save failed:',err);alert('Failed to save geometry. Please try again.');}
  };

  const handleCreated=useCallback(({gl}:{gl:THREE.WebGLRenderer})=>{
    gl.toneMapping=THREE.ACESFilmicToneMapping;gl.toneMappingExposure=1.0;
    gl.shadowMap.type=THREE.PCFSoftShadowMap;gl.outputColorSpace=THREE.SRGBColorSpace;
    gl.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();console.warn('WebGL context lost');});
  },[]);

  return (
    <>
      <ErrorBoundary>
        <Canvas shadows gl={{antialias:true,alpha:false,preserveDrawingBuffer:true,powerPreference:'high-performance',logarithmicDepthBuffer:true}} dpr={[1,2]} onContextMenu={e=>e.preventDefault()} onCreated={handleCreated}>
          <color attach="background" args={['#f5f5f4']} />
          <CameraController controlsRef={controlsRef} cameraType={cameraType} />

          <ambientLight intensity={0.6}/>
          <hemisphereLight intensity={0.4} groundColor="#888888" color="#ffffff"/>
          <directionalLight position={[1500,2500,1500]} intensity={1.8} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-bias={-0.0005} shadow-camera-far={15000} shadow-camera-left={-3000} shadow-camera-right={3000} shadow-camera-top={3000} shadow-camera-bottom={-3000}/>
          <directionalLight position={[-1000,1500,-1000]} intensity={0.4}/>
          <directionalLight position={[0,2000,-2000]} intensity={0.3}/>
          <directionalLight position={[500,500,3000]} intensity={0.5}/>

          <OrbitControls ref={controlsRef} makeDefault target={[0,0,0]} enableDamping dampingFactor={0.05} rotateSpeed={0.8} maxDistance={25000} minDistance={50}/>

          {shapes.map(shape=>{
            const isSel=selectedShapeId===shape.id;
            if(shape.type==='panel')return<PanelDrawing key={shape.id} shape={shape} isSelected={isSel}/>;
            return(
              <React.Fragment key={shape.id}>
                <ShapeWithTransform shape={shape} isSelected={isSel} orbitControlsRef={controlsRef} onContextMenu={handleContextMenu}/>
                {isSel&&vertexEditMode&&<VertexEditor shape={shape} isActive onVertexSelect={i=>setSelectedVertexIndex(i)} onDirectionChange={d=>setVertexDirection(d)}/>}
              </React.Fragment>
            );
          })}

          <mesh position={[0,-1,0]} rotation={[-Math.PI/2,0,0]} receiveShadow>
            <planeGeometry args={[30000,30000]}/>
            <shadowMaterial opacity={0.12}/>
          </mesh>

          {/* ── VIEW CUBE GIZMO ── */}
          <GizmoHelper alignment="bottom-right" margin={[100,100]}>
            <group scale={60}>
              <ViewCube />
            </group>
          </GizmoHelper>

        </Canvas>
      </ErrorBoundary>

      {contextMenu&&(
        <ContextMenu position={{x:contextMenu.x,y:contextMenu.y}} shapeId={contextMenu.shapeId} shapeType={contextMenu.shapeType} onClose={()=>setContextMenu(null)}
          onEdit={()=>{isolateShape(contextMenu.shapeId);setContextMenu(null);}}
          onCopy={()=>{copyShape(contextMenu.shapeId);setContextMenu(null);}}
          onDelete={()=>{deleteShape(contextMenu.shapeId);setContextMenu(null);}}
          onSave={()=>{setSaveDialog({isOpen:true,shapeId:contextMenu.shapeId});setContextMenu(null);}}
        />
      )}
      <SaveDialog isOpen={saveDialog.isOpen} onClose={()=>setSaveDialog({isOpen:false,shapeId:null})} onSave={handleSave} shapeId={saveDialog.shapeId||''} captureSnapshot={captureSnapshot}/>
    </>
  );
};

export default Scene;
