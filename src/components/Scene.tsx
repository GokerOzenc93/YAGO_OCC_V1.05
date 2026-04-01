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

/* Corner hit zone */
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
══════════════════════════════════════════════════════════ */
const CompassRing: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const { camera } = useThree();

  useFrame(() => {
    if (!groupRef.current) return;
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    groupRef.current.rotation.y = -euler.y;
  });

  const ringGeo = useMemo(() => new THREE.RingGeometry(0.82, 0.88, 64), []);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: C_OUTLINE, side: THREE.DoubleSide, transparent: true, opacity: 0.6,
    depthTest: false, depthWrite: false
  }), []);

  const labels = [
    { letter: 'N', rot: [0,0,0],              pos: [0, 0.99, 0] as [number,number,number] },
    { letter: 'S', rot: [0,Math.PI,0],         pos: [0,-0.99, 0] as [number,number,number] },
    { letter: 'E', rot: [0,-Math.PI/2,0],      pos: [ 0.99,0, 0] as [number,number,number] },
    { letter: 'W', rot: [0, Math.PI/2,0],      pos: [-0.99,0, 0] as [number,number,number] },
  ];

  return (
    <group ref={groupRef} position={[0,-0.82,0]} rotation={[Math.PI/2,0,0]}>
      <mesh geometry={ringGeo} material={ringMat} renderOrder={2} />
      {labels.map(({ letter, rot, pos }) => {
        const tex = useMemo(() => makeFaceTex(letter, false), [letter]);
        useEffect(() => () => tex.dispose(), [tex]);
        return (
          <mesh key={letter} position={pos} rotation={new THREE.Euler(...rot as [number,number,number])} renderOrder={3}>
            <planeGeometry args={[0.22, 0.22]} />
            <meshBasicMaterial map={tex} transparent depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
    </group>
  );
};

/* ══════════════════════════════════════════════════════════
   VIEW CUBE
══════════════════════════════════════════════════════════ */
type V3 = [number, number, number];

const ViewCube: React.FC = () => {
  const { tweenCamera } = useGizmoContext();
  const cubeRef = useRef<THREE.Group>(null);

  const snap = useCallback((dir: V3, up: V3) => {
    tweenCamera(new THREE.Vector3(...dir), new THREE.Vector3(...up));
  }, [tweenCamera]);

  const geoBody = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const geoFace = useMemo(() => new THREE.PlaneGeometry(0.62, 0.62), []);
  const geoEdgeH = useMemo(() => new THREE.PlaneGeometry(0.62, 0.18), []);
  const geoEdgeV = useMemo(() => new THREE.PlaneGeometry(0.18, 0.62), []);

  const matBody = useMemo(() => new THREE.MeshBasicMaterial({ color: C_BODY, depthTest: false }), []);
  const matEdges = useMemo(() => new THREE.LineBasicMaterial({ color: C_OUTLINE, depthTest: false }), []);
  const geoEdges = useMemo(() => new THREE.EdgesGeometry(geoBody), [geoBody]);

  const P = 0.501, EC = 0.22, H = 0.60;

  const FACES = [
    { pos:[ 0, 0, P] as V3, rot:[ 0, 0, 0]               as V3, letter:'F', flipH:false },
    { pos:[ 0, 0,-P] as V3, rot:[ 0, Math.PI, 0]          as V3, letter:'B', flipH:true  },
    { pos:[ P, 0, 0] as V3, rot:[ 0,-Math.PI/2, 0]        as V3, letter:'R', flipH:false },
    { pos:[-P, 0, 0] as V3, rot:[ 0, Math.PI/2, 0]        as V3, letter:'L', flipH:true  },
    { pos:[ 0, P, 0] as V3, rot:[-Math.PI/2, 0, 0]        as V3, letter:'T', flipH:false },
    { pos:[ 0,-P, 0] as V3, rot:[ Math.PI/2, 0, 0]        as V3, letter:'U', flipH:false },
  ];

  const EDGES: { pos:V3; rot:V3; geo:'h'|'v'; dir:V3; up:V3 }[] = [
    // FRONT
    { pos:[ 0, EC, P], rot:[0,0,0],          geo:'h', dir:norm(0,1,1),   up:[0,1,0]  },
    { pos:[ 0,-EC, P], rot:[0,0,0],          geo:'h', dir:norm(0,-1,1),  up:[0,1,0]  },
    { pos:[ EC, 0, P], rot:[0,0,0],          geo:'v', dir:norm(1,0,1),   up:[0,1,0]  },
    { pos:[-EC, 0, P], rot:[0,0,0],          geo:'v', dir:norm(-1,0,1),  up:[0,1,0]  },
    // BACK
    { pos:[ 0, EC,-P], rot:[0,Math.PI,0],    geo:'h', dir:norm(0,1,-1),  up:[0,1,0]  },
    { pos:[ 0,-EC,-P], rot:[0,Math.PI,0],    geo:'h', dir:norm(0,-1,-1), up:[0,1,0]  },
    { pos:[ EC, 0,-P], rot:[0,Math.PI,0],    geo:'v', dir:norm(1,0,-1),  up:[0,1,0]  },
    { pos:[-EC, 0,-P], rot:[0,Math.PI,0],    geo:'v', dir:norm(-1,0,-1), up:[0,1,0]  },
    // RIGHT
    { pos:[P, EC, 0],  rot:[0,-Math.PI/2,0], geo:'h', dir:norm(1,1,0),   up:[0,1,0]  },
    { pos:[P,-EC, 0],  rot:[0,-Math.PI/2,0], geo:'h', dir:norm(1,-1,0),  up:[0,1,0]  },
    { pos:[P, 0, EC],  rot:[0,-Math.PI/2,0], geo:'v', dir:norm(1,0,1),   up:[0,1,0]  },
    { pos:[P, 0,-EC],  rot:[0,-Math.PI/2,0], geo:'v', dir:norm(1,0,-1),  up:[0,1,0]  },
    // LEFT
    { pos:[-P, EC, 0], rot:[0,Math.PI/2,0],  geo:'h', dir:norm(-1,1,0),  up:[0,1,0]  },
    { pos:[-P,-EC, 0], rot:[0,Math.PI/2,0],  geo:'h', dir:norm(-1,-1,0), up:[0,1,0]  },
    { pos:[-P, 0,-EC], rot:[0,Math.PI/2,0],  geo:'v', dir:norm(-1,0,-1), up:[0,1,0]  },
    { pos:[-P, 0, EC], rot:[0,Math.PI/2,0],  geo:'v', dir:norm(-1,0,1),  up:[0,1,0]  },
    // TOP
    { pos:[ 0, P, EC], rot:[-Math.PI/2,0,0], geo:'h', dir:norm(0,1,1),   up:[0,0,-1] },
    { pos:[ 0, P,-EC], rot:[-Math.PI/2,0,0], geo:'h', dir:norm(0,1,-1),  up:[0,0,-1] },
    { pos:[-EC, P, 0], rot:[-Math.PI/2,0,0], geo:'v', dir:norm(-1,1,0),  up:[0,0,-1] },
    { pos:[ EC, P, 0], rot:[-Math.PI/2,0,0], geo:'v', dir:norm(1,1,0),   up:[0,0,-1] },
    // BOTTOM
    { pos:[ 0,-P, EC], rot:[Math.PI/2,0,0],  geo:'h', dir:norm(0,-1,1),  up:[0,0,1]  },
    { pos:[ 0,-P,-EC], rot:[Math.PI/2,0,0],  geo:'h', dir:norm(0,-1,-1), up:[0,0,1]  },
    { pos:[-EC,-P, 0], rot:[Math.PI/2,0,0],  geo:'v', dir:norm(-1,-1,0), up:[0,0,1]  },
    { pos:[ EC,-P, 0], rot:[Math.PI/2,0,0],  geo:'v', dir:norm(1,-1,0),  up:[0,0,1]  },
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
    addVertexModification: state.addVertexModification,
    subtractionViewMode: state.subtractionViewMode, faceEditMode: state.faceEditMode,
    setFaceEditMode: state.setFaceEditMode,
    filletMode: state.filletMode, selectedFilletFaces: state.selectedFilletFaces,
    clearFilletFaces: state.clearFilletFaces, selectedFilletFaceData: state.selectedFilletFaceData,
    updateShape: state.updateShape, panelSelectMode: state.panelSelectMode,
    panelSurfaceSelectMode: state.panelSurfaceSelectMode,
    setSelectedPanelRow: state.setSelectedPanelRow,
  })));

  const [contextMenu, setContextMenu] = useState<{ x:number; y:number; shapeId:string; shapeType:string } | null>(null);
  const [saveDialog, setSaveDialog] = useState<{ isOpen:boolean; shapeId:string|null }>({ isOpen:false, shapeId:null });

  const handleContextMenu = useCallback((e: any, shapeId: string) => {
    e.stopPropagation();
    const shape = shapes.find(s => s.id === shapeId);
    setContextMenu({ x: e.clientX, y: e.clientY, shapeId, shapeType: shape?.type || 'unknown' });
  }, [shapes]);

  const captureSnapshot = useCallback(async (): Promise<string> => {
    return new Promise(resolve => {
      const canvas = document.querySelector('canvas');
      if (canvas) resolve(canvas.toDataURL('image/png'));
      else resolve('');
    });
  }, []);

  const handleSave = async (name: string, tags: string[]) => {
    const shape = shapes.find(s => s.id === saveDialog.shapeId);
    if (!shape) return;
    try {
      const snapshot = await captureSnapshot();
      await catalogService.saveGeometry({ name, tags, shapeData: shape, snapshot });
      setSaveDialog({ isOpen:false, shapeId:null });
    } catch (err) { console.error('save failed:', err); alert('Failed to save geometry. Please try again.'); }
  };

  // ✅ YENİ: Renderer ayarları — düşük exposure ile ışık patlaması önlendi
  const handleCreated = useCallback(({ gl }: { gl: THREE.WebGLRenderer }) => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 0.82;          // ✅ 1.0 → 0.82 : overexposure / patlama önlendi
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); console.warn('WebGL context lost'); });
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
            powerPreference: 'high-performance',
            logarithmicDepthBuffer: true,
          }}
          dpr={[1, 2]}
          onContextMenu={e => e.preventDefault()}
          onCreated={handleCreated}
        >
          <color attach="background" args={['#f0ede8']} />
          {/* ✅ Arka plan rengi: hafif sıcak gri (#f5f5f4 → #f0ede8) — daha doğal stüdyo tonu */}

          <CameraController controlsRef={controlsRef} cameraType={cameraType} />

          {/* ══ IŞIKLANDIRMA — Dengeli, patlamasız stüdyo kurulumu ══
              Eski kurulumda ana directional 1.8 + exposure 1.0 → speküler patlama.
              Yeni kurulumda:
              - Ambient artırıldı (fill light görevi) → gölgeler çok sert olmaz
              - HemisphereLight azaltıldı ve ground rengi ısıtıldı
              - Ana shadow light: 1.8 → 1.05 (tek yönlü sert gölge yumuşatıldı)
              - Fill ışıkları düşürüldü / yeniden konumlandırıldı
              - Shadow map 4096 → daha keskin gölge kenarları
          */}
          <ambientLight intensity={0.75} />
          {/* ✅ Ambient 0.6 → 0.75: paneller üzerindeki karanlık alanları doldurur */}

          <hemisphereLight
            intensity={0.22}
            groundColor="#b5a882"
            color="#f0f0f8"
          />
          {/* ✅ Intensity 0.4 → 0.22, ground rengi ısıtıldı → doğal zemin yansıması */}

          {/* Ana gölge ışığı — sağ üstten, daha dengeli */}
          <directionalLight
            position={[1500, 2500, 1500]}
            intensity={1.05}
            castShadow
            shadow-mapSize-width={4096}
            shadow-mapSize-height={4096}
            shadow-bias={-0.0003}
            shadow-camera-far={15000}
            shadow-camera-left={-3000}
            shadow-camera-right={3000}
            shadow-camera-top={3000}
            shadow-camera-bottom={-3000}
          />
          {/* ✅ Intensity 1.8 → 1.05, shadow map 2048 → 4096 (daha keskin kenarlar) */}

          {/* Sol arka dolgu ışığı */}
          <directionalLight position={[-1200, 1200, -800]} intensity={0.28} />
          {/* ✅ Intensity 0.4 → 0.28 */}

          {/* Üst arka dolgu */}
          <directionalLight position={[0, 2000, -2000]} intensity={0.18} />
          {/* ✅ Intensity 0.3 → 0.18 */}

          {/* Ön alt dolgu — zemin yansımasını simüle eder */}
          <directionalLight position={[300, 200, 2500]} intensity={0.22} />
          {/* ✅ Intensity 0.5 → 0.22, pozisyon öne çekildi */}

          <OrbitControls
            ref={controlsRef}
            makeDefault
            target={[0,0,0]}
            enableDamping
            dampingFactor={0.05}
            rotateSpeed={0.8}
            maxDistance={25000}
            minDistance={50}
          />

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

          {/* Zemin gölge düzlemi */}
          <mesh position={[0,-1,0]} rotation={[-Math.PI/2,0,0]} receiveShadow>
            <planeGeometry args={[30000,30000]} />
            <shadowMaterial opacity={0.10} />
            {/* ✅ Gölge opaklığı 0.12 → 0.10: daha soft zemin gölgesi */}
          </mesh>

          {/* ViewCube Gizmo */}
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
      <SaveDialog
        isOpen={saveDialog.isOpen}
        onClose={() => setSaveDialog({ isOpen:false, shapeId:null })}
        onSave={handleSave}
        shapeId={saveDialog.shapeId||''}
        captureSnapshot={captureSnapshot}
      />
    </>
  );
};

export default Scene;
