import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import * as THREE from 'three';
import type { VertexModification } from './components/VertexEditorService';

// ═══════════════════════════════════════════════════════════════════════════
// VERİ YAPILARI
// ═══════════════════════════════════════════════════════════════════════════

export interface SubtractionParameters {
  width: string; height: string; depth: string;
  posX: string; posY: string; posZ: string;
  rotX: string; rotY: string; rotZ: string;
}

export interface FaceDescriptor {
  normal: [number, number, number];
  normalizedCenter: [number, number, number];
  area: number;
  isCurved?: boolean;
  axisDirection?: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-' | null;
  axisPosition?: number;
}

export interface FilletInfo {
  face1Descriptor: FaceDescriptor;
  face2Descriptor: FaceDescriptor;
  face1Data: { normal: [number, number, number]; center: [number, number, number]; planeD?: number };
  face2Data: { normal: [number, number, number]; center: [number, number, number]; planeD?: number };
  radius: number;
  originalSize: { width: number; height: number; depth: number };
}

export interface SubtractedGeometry {
  geometry: THREE.BufferGeometry;
  relativeOffset: [number, number, number];
  relativeRotation: [number, number, number];
  scale: [number, number, number];
  parameters?: SubtractionParameters;
}

export interface VirtualFace {
  id: string; shapeId: string;
  normal: [number, number, number];
  center: [number, number, number];
  vertices: [number, number, number][];
  description: string; hasPanel: boolean;
  /** TAM YÜZ MODELİ: VF = tıklanan yüz bileşeninin konturu; resize'da yüz eşlemesiyle güncellenir. */
  parentFaceShape?: boolean;
  faceGroupDescriptor?: FaceDescriptor;
  /** Yakalama anında bu yüzeye DEĞEN kardeş panellerin id'leri (kimlik; geometri canlı okunur). */
  touchingSiblingIds?: string[];
  /** Bu panelin hangi kardeşin hangi yüzüne temas ettiği. */
  contactRelations?: Array<{ panelId: string; faceNormal: [number, number, number]; axis: string }>;
  /** DEĞİŞMEZ TARAF SÖZLEŞMESİ: kardeş ayak izine göre taraf (±1); stored-wins birleşir. */
  sideRelations?: Record<string, number>;
  /** YÜZEYİN ŞEKLİNİ AL: açıkken panel serbest bölgenin tam (L/U/çentikli) şeklini alır. */
  fitFaceShape?: boolean;
}

export interface Shape {
  id: string; type: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  geometry: THREE.BufferGeometry;
  color?: string;
  parameters: Record<string, any>;
  ocShape?: any; replicadShape?: any;
  isolated?: boolean;
  vertexModifications?: VertexModification[];
  groupId?: string;
  isReferenceBox?: boolean;
  subtractionGeometries?: (SubtractedGeometry | null)[];
  fillets?: FilletInfo[];
  faceDescriptions?: Record<number, string>;
  faceGroupDescriptors?: Record<number, FaceDescriptor>;
}

export enum CameraType { PERSPECTIVE = 'perspective', ORTHOGRAPHIC = 'orthographic' }
export enum Tool {
  SELECT = 'Select', MOVE = 'Move', ROTATE = 'Rotate', SCALE = 'Scale',
  POINT_TO_POINT_MOVE = 'Point to Point Move',
  POLYLINE = 'Polyline', POLYLINE_EDIT = 'Polyline Edit',
  RECTANGLE = 'Rectangle', CIRCLE = 'Circle', DIMENSION = 'Dimension',
}
export enum ViewMode { WIREFRAME = 'wireframe', SOLID = 'solid', XRAY = 'xray' }
export enum SnapType { ENDPOINT = 'endpoint', MIDPOINT = 'midpoint', CENTER = 'center', PERPENDICULAR = 'perpendicular', INTERSECTION = 'intersection', NEAREST = 'nearest' }
export enum OrthoMode { ON = 'on', OFF = 'off' }

type Vec3 = [number, number, number];
type AxisDir = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
type RefFacePick = { panelId: string; faceGroupIndex: number; normalWorld: Vec3; pointWorld: Vec3 };
type FilletFaceData = { normal: Vec3; center: Vec3; planeD?: number };

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

export interface AppState {
  // Şekiller
  shapes: Shape[];
  addShape: (shape: Shape) => void;
  updateShape: (id: string, updates: Partial<Shape>) => void;
  deleteShape: (id: string) => void;
  exitIsolation: () => void;
  checkAndPerformBooleanOperations: () => Promise<void>;
  selectedShapeId: string | null; selectShape: (id: string | null) => void;
  secondarySelectedShapeId: string | null; selectSecondaryShape: (id: string | null) => void;
  createGroup: (primaryId: string, secondaryId: string) => void;

  // Görünüm / araçlar
  activeTool: Tool; setActiveTool: (t: Tool) => void;
  cameraType: CameraType; setCameraType: (t: CameraType) => void;
  viewMode: ViewMode; setViewMode: (m: ViewMode) => void; cycleViewMode: () => void;
  orthoMode: OrthoMode; toggleOrthoMode: () => void;
  snapSettings: Record<SnapType, boolean>; toggleSnapSetting: (t: SnapType) => void;
  opencascadeLoading: boolean; setOpenCascadeLoading: (l: boolean) => void;

  // Vertex düzenleme
  vertexEditMode: boolean; setVertexEditMode: (b: boolean) => void;
  selectedVertexIndex: number | null; setSelectedVertexIndex: (i: number | null) => void;
  vertexDirection: AxisDir | null; setVertexDirection: (d: AxisDir) => void;
  addVertexModification: (shapeId: string, mod: VertexModification) => void;

  // Çıkarma (subtraction)
  subtractionViewMode: boolean; setSubtractionViewMode: (b: boolean) => void;
  selectedSubtractionIndex: number | null; setSelectedSubtractionIndex: (i: number | null) => void;
  hoveredSubtractionIndex: number | null; setHoveredSubtractionIndex: (i: number | null) => void;
  deleteSubtraction: (shapeId: string, idx: number) => Promise<void>;

  // Paneller / editör
  showParametersPanel: boolean; setShowParametersPanel: (b: boolean) => void;
  showOutlines: boolean; setShowOutlines: (b: boolean) => void;
  selectedPanelRow: number | string | null;
  selectedPanelRowExtraId: string | null;
  selectedPanelRowParentId: string | null;
  setSelectedPanelRow: (i: number | string | null, e?: string | null, parentId?: string | null) => void;
  panelSelectMode: boolean; setPanelSelectMode: (b: boolean) => void;
  faceEditMode: boolean; setFaceEditMode: (b: boolean) => void;
  hoveredPanelVfId: string | null; setHoveredPanelVfId: (id: string | null) => void;

  // Fillet
  filletMode: boolean; setFilletMode: (b: boolean) => void;
  selectedFilletFaces: number[]; setSelectedFilletFaces: (f: number[]) => void;
  addFilletFace: (i: number) => void; clearFilletFaces: () => void;
  selectedFilletFaceData: FilletFaceData[];
  addFilletFaceData: (d: FilletFaceData) => void;
  clearFilletFaceData: () => void;

  // Panel yerleştirme (yüz yakalama)
  raycastMode: boolean; setRaycastMode: (b: boolean) => void;

  // Yüz extrude
  faceExtrudeMode: boolean; setFaceExtrudeMode: (b: boolean) => void;
  faceExtrudeTargetPanelId: string | null; setFaceExtrudeTargetPanelId: (id: string | null) => void;
  faceExtrudeSelectedFace: number | null; setFaceExtrudeSelectedFace: (i: number | null) => void;
  /** Yüzü seçen tıklamanın yerel noktası. */
  faceExtrudeClickPoint: Vec3 | null; setFaceExtrudeClickPoint: (p: Vec3 | null) => void;
  faceExtrudeThickness: number; setFaceExtrudeThickness: (v: number) => void;
  faceExtrudeFixedMode: boolean; setFaceExtrudeFixedMode: (b: boolean) => void;
  /** 'fixed' = sabit ölçü, 'dyn' = delta, 'ref' = referans yüze bağlı. */
  faceExtrudeValueMode: 'fixed' | 'dyn' | 'ref'; setFaceExtrudeValueMode: (m: 'fixed' | 'dyn' | 'ref') => void;
  faceExtrudeRefCandidate: RefFacePick | null; setFaceExtrudeRefCandidate: (v: RefFacePick | null) => void;

  // Panel taşıma
  panelMoveMode: boolean; setPanelMoveMode: (b: boolean) => void;
  panelMoveTargetPanelId: string | null; setPanelMoveTargetPanelId: (id: string | null) => void;
  panelMoveAxis: AxisDir | null; setPanelMoveAxis: (a: AxisDir | null) => void;
  panelMoveValue: number; setPanelMoveValue: (v: number) => void;
  panelMoveValueMode: 'dyn' | 'fixed' | 'ref'; setPanelMoveValueMode: (m: 'dyn' | 'fixed' | 'ref') => void;
  panelMoveRefSourceVertex: Vec3 | null; setPanelMoveRefSourceVertex: (v: Vec3 | null) => void;
  panelMoveRefTargetPanelId: string | null; setPanelMoveRefTargetPanelId: (id: string | null) => void;
  panelMoveRefTargetVertex: Vec3 | null; setPanelMoveRefTargetVertex: (v: Vec3 | null) => void;

  // Panel döndürme
  panelRotateMode: boolean; setPanelRotateMode: (b: boolean) => void;
  panelRotateTargetPanelId: string | null; setPanelRotateTargetPanelId: (id: string | null) => void;
  panelRotatePivot: Vec3 | null; setPanelRotatePivot: (p: Vec3 | null) => void;
  panelRotatePivotType: 'center' | 'vertex' | null; setPanelRotatePivotType: (t: 'center' | 'vertex' | null) => void;
  panelRotateAxis: 'x' | 'y' | 'z' | null; setPanelRotateAxis: (a: 'x' | 'y' | 'z' | null) => void;
  panelRotateValue: number; setPanelRotateValue: (v: number) => void;
  /** null = mod HENÜZ seçilmedi (sahnede nokta/halka yok). 'ref': pivot → nişan → eksen → referans yüz → sağ tık. */
  panelRotateValueMode: 'dyn' | 'ref' | null; setPanelRotateValueMode: (m: 'dyn' | 'ref' | null) => void;
  /** Dönen panelin referansa NİŞAN alan kendi noktası. */
  panelRotateRefArmVertex: Vec3 | null; setPanelRotateRefArmVertex: (v: Vec3 | null) => void;
  panelRotateRefTargetPanelId: string | null; setPanelRotateRefTargetPanelId: (id: string | null) => void;
  /** Referans YÜZ (nokta değil): nişan bu yüzün düzlemine değene kadar döner. */
  panelRotateRefFace: RefFacePick | null; setPanelRotateRefFace: (f: RefFacePick | null) => void;

  // Sanal yüzler (VF)
  showVirtualFaces: boolean; setShowVirtualFaces: (b: boolean) => void;
  virtualFaces: VirtualFace[];
  addVirtualFace: (v: VirtualFace) => void;
  updateVirtualFace: (id: string, u: Partial<VirtualFace>) => void;
  deleteVirtualFace: (id: string) => void;
  /** Sıra = basan/basılan önceliği; değişince paneller yeniden üretilir. */
  reorderVirtualFaceGroup: (shapeId: string, fromIds: string[], toGroupFirstId: string | null) => void;
}

const rebuildParent = (shapeId: string) =>
  import('./components/PanelEngine').then(({ rebuildPanelsForParent }) => rebuildPanelsForParent(shapeId));

const bboxOfGeometry = (g: THREE.BufferGeometry) =>
  new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);

export const useAppStore = create<AppState>((set, get) => ({
  // ── Şekiller ──────────────────────────────────────────────────────────────
  shapes: [],
  addShape: (shape) => set((s) => ({ shapes: [...s.shapes, shape] })),

  // Gruplu şekilde konum/dönüş/ölçek değişimi grubun diğer üyelerine aynen uygulanır.
  updateShape: (id, updates) => set((state) => {
    const sh = state.shapes.find(s => s.id === id);
    if (!sh) return {};
    const shapes = state.shapes.map((s): Shape => {
      if (s.id === id) return { ...s, ...updates };
      if (sh.groupId && s.groupId === sh.groupId && ('position' in updates || 'rotation' in updates || 'scale' in updates)) {
        const pd = updates.position ? [0, 1, 2].map(i => updates.position![i] - sh.position[i]) : [0, 0, 0];
        const rd = updates.rotation ? [0, 1, 2].map(i => updates.rotation![i] - sh.rotation[i]) : [0, 0, 0];
        const sd = updates.scale ? [0, 1, 2].map(i => updates.scale![i] / sh.scale[i]) : [1, 1, 1];
        return {
          ...s,
          position: [s.position[0] + pd[0], s.position[1] + pd[1], s.position[2] + pd[2]],
          rotation: [s.rotation[0] + rd[0], s.rotation[1] + rd[1], s.rotation[2] + rd[2]],
          scale: [s.scale[0] * sd[0], s.scale[1] * sd[1], s.scale[2] * sd[2]],
        };
      }
      return s;
    });
    return { shapes };
  }),

  // Şekil silinince çocuk panelleri de silinir.
  deleteShape: (id) => set((state) => {
    const all = new Set([id, ...state.shapes.filter(s => s.type === 'panel' && s.parameters?.parentShapeId === id).map(s => s.id)]);
    return {
      shapes: state.shapes.filter(s => !all.has(s.id)),
      selectedShapeId: all.has(state.selectedShapeId || '') ? null : state.selectedShapeId,
      secondarySelectedShapeId: all.has(state.secondarySelectedShapeId || '') ? null : state.secondarySelectedShapeId,
    };
  }),

  exitIsolation: () => set((s) => ({ shapes: s.shapes.map(x => ({ ...x, isolated: undefined })) })),

  selectedShapeId: null,
  selectShape: (id) => {
    if (id && get().activeTool === Tool.SELECT) set({ selectedShapeId: id, activeTool: Tool.MOVE });
    else set({ selectedShapeId: id });
  },
  secondarySelectedShapeId: null,
  selectSecondaryShape: (id) => set({ secondarySelectedShapeId: id }),

  createGroup: (primaryId, secondaryId) => {
    const gid = `group-${Date.now()}`;
    set((s) => ({
      shapes: s.shapes.map(x => x.id === primaryId ? { ...x, groupId: gid } : x.id === secondaryId ? { ...x, groupId: gid, isReferenceBox: true } : x),
    }));
  },

  // ── Görünüm / araçlar ─────────────────────────────────────────────────────
  activeTool: Tool.SELECT, setActiveTool: (t) => set({ activeTool: t }),
  cameraType: CameraType.PERSPECTIVE, setCameraType: (t) => set({ cameraType: t }),
  viewMode: ViewMode.SOLID, setViewMode: (m) => set({ viewMode: m }),
  cycleViewMode: () => {
    const order = [ViewMode.SOLID, ViewMode.WIREFRAME, ViewMode.XRAY];
    set({ viewMode: order[(order.indexOf(get().viewMode) + 1) % order.length] });
  },
  orthoMode: OrthoMode.OFF,
  toggleOrthoMode: () => set((s) => ({ orthoMode: s.orthoMode === OrthoMode.ON ? OrthoMode.OFF : OrthoMode.ON })),
  snapSettings: { endpoint: false, midpoint: false, center: false, perpendicular: false, intersection: false, nearest: false },
  toggleSnapSetting: (t) => set((s) => ({ snapSettings: { ...s.snapSettings, [t]: !s.snapSettings[t] } })),
  opencascadeLoading: false, setOpenCascadeLoading: (l) => set({ opencascadeLoading: l }),

  // ── Vertex düzenleme ──────────────────────────────────────────────────────
  vertexEditMode: false, setVertexEditMode: (b) => set({ vertexEditMode: b }),
  selectedVertexIndex: null, setSelectedVertexIndex: (i) => set({ selectedVertexIndex: i }),
  vertexDirection: null, setVertexDirection: (d) => set({ vertexDirection: d }),
  // Aynı köşe + yön için düzenleme varsa değiştirilir, yoksa eklenir.
  addVertexModification: (sid, mod) => set((s) => ({
    shapes: s.shapes.map(sh => {
      if (sh.id !== sid) return sh;
      const mods = sh.vertexModifications || [];
      const i = mods.findIndex(m => m.vertexIndex === mod.vertexIndex && m.direction === mod.direction);
      return { ...sh, vertexModifications: i >= 0 ? mods.map((m, k) => (k === i ? mod : m)) : [...mods, mod] };
    }),
  })),

  // ── Çıkarma ───────────────────────────────────────────────────────────────
  subtractionViewMode: false, setSubtractionViewMode: (b) => set({ subtractionViewMode: b }),
  selectedSubtractionIndex: null, setSelectedSubtractionIndex: (i) => set({ selectedSubtractionIndex: i }),
  hoveredSubtractionIndex: null, setHoveredSubtractionIndex: (i) => set({ hoveredSubtractionIndex: i }),

  /** İlk kesişen iki gövde çiftinde B, A'dan çıkarılır (B silinir, A'ya çıkarma kaydı eklenir). */
  checkAndPerformBooleanOperations: async () => {
    const shapes = get().shapes;
    if (shapes.length < 2) return;
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const a = shapes[i], b = shapes[j];
        if (!a.geometry || !b.geometry || !a.replicadShape || !b.replicadShape) continue;
        const BA = bboxOfGeometry(a.geometry).translate(new THREE.Vector3(...a.position));
        const BB = bboxOfGeometry(b.geometry).translate(new THREE.Vector3(...b.position));
        if (!BA.intersectsBox(BB)) continue;
        try {
          const { performBooleanCut, convertReplicadToThreeGeometry, createReplicadBox } = await import('./components/ReplicadService');
          const { getReplicadVertices } = await import('./components/VertexEditorService');
          const blA = bboxOfGeometry(a.geometry), blB = bboxOfGeometry(b.geometry);
          const sA = new THREE.Vector3(), cA = new THREE.Vector3(); blA.getSize(sA); blA.getCenter(cA);
          const sB = new THREE.Vector3(), cB = new THREE.Vector3(); blB.getSize(sB); blB.getCenter(cB);
          // Merkezli (eski) geometri kök köşeye ötelenir.
          const isCentered = (c: THREE.Vector3) => Math.abs(c.x) < 0.01 && Math.abs(c.y) < 0.01 && Math.abs(c.z) < 0.01;
          const oA = isCentered(cA) ? [sA.x / 2, sA.y / 2, sA.z / 2] : [0, 0, 0];
          const oB = isCentered(cB) ? [sB.x / 2, sB.y / 2, sB.z / 2] : [0, 0, 0];
          const rel: Vec3 = [0, 1, 2].map(k => (b.position[k] - oB[k]) - (a.position[k] - oA[k])) as Vec3;
          const rot: Vec3 = [0, 1, 2].map(k => b.rotation[k] - a.rotation[k]) as Vec3;

          const RA = await createReplicadBox({ width: sA.x, height: sA.y, depth: sA.z });
          const RB = await createReplicadBox({ width: sB.x, height: sB.y, depth: sB.z });
          let result = await performBooleanCut(RA, RB, undefined, rel, undefined, rot, undefined, b.scale);
          let geo = convertReplicadToThreeGeometry(result);
          let verts = await getReplicadVertices(result);
          let fillets = a.fillets || [];
          if (fillets.length) {
            const { updateFilletCentersForNewGeometry, applyFillets } = await import('./components/ShapeUpdaterService');
            fillets = await updateFilletCentersForNewGeometry(fillets, geo, { width: sA.x, height: sA.y, depth: sA.z });
            result = await applyFillets(result, fillets, { width: sA.x, height: sA.y, depth: sA.z });
            geo = convertReplicadToThreeGeometry(result);
            verts = await getReplicadVertices(result);
          }
          const sub: SubtractedGeometry = {
            geometry: b.geometry.clone(), relativeOffset: rel, relativeRotation: rot, scale: [1, 1, 1],
            parameters: {
              width: String(sB.x), height: String(sB.y), depth: String(sB.z),
              posX: String(rel[0]), posY: String(rel[1]), posZ: String(rel[2]),
              rotX: String(rot[0] * 180 / Math.PI), rotY: String(rot[1] * 180 / Math.PI), rotZ: String(rot[2] * 180 / Math.PI),
            },
          };
          set((S) => ({
            shapes: S.shapes
              .filter(x => x.id !== b.id)
              .map(x => x.id === a.id ? {
                ...x, geometry: geo, replicadShape: result, fillets,
                subtractionGeometries: [...(x.subtractionGeometries || []), sub],
                parameters: { ...x.parameters, scaledBaseVertices: verts.map(v => [v.x, v.y, v.z]) },
              } : x),
          }));
          try { await rebuildParent(a.id); } catch (err) { console.error('rebuild after subtractor add fail:', err); }
          return;
        } catch (e) { console.error('boolean fail:', e); }
      }
    }
  },

  /** Çıkarmayı siler: kalan çıkarmalar + filletlerle gövde baştan kurulur. */
  deleteSubtraction: async (shapeId, idx) => {
    const sh = get().shapes.find(s => s.id === shapeId);
    if (!sh || !sh.subtractionGeometries) return;
    const arr = [...sh.subtractionGeometries];
    arr[idx] = null;
    try {
      const { performBooleanCut, convertReplicadToThreeGeometry, createReplicadBox } = await import('./components/ReplicadService');
      const { getReplicadVertices } = await import('./components/VertexEditorService');
      const W = sh.parameters?.width || 1, H = sh.parameters?.height || 1, D = sh.parameters?.depth || 1;
      const pos = [...sh.position] as Vec3;
      let base = await createReplicadBox({ width: W, height: H, depth: D });
      for (const sub of arr) {
        if (!sub) continue;
        let w: number, h: number, d: number;
        if (sub.parameters) { w = parseFloat(sub.parameters.width); h = parseFloat(sub.parameters.height); d = parseFloat(sub.parameters.depth); }
        else { const S = new THREE.Vector3(); bboxOfGeometry(sub.geometry).getSize(S); w = S.x; h = S.y; d = S.z; }
        const SB = await createReplicadBox({ width: w, height: h, depth: d });
        base = await performBooleanCut(base, SB, undefined, sub.relativeOffset, undefined, sub.relativeRotation || [0, 0, 0], undefined, sub.scale || [1, 1, 1]);
      }
      let geo = convertReplicadToThreeGeometry(base);
      let verts = await getReplicadVertices(base);
      let fillets = sh.fillets || [];
      if (fillets.length) {
        const { updateFilletCentersForNewGeometry, applyFillets } = await import('./components/ShapeUpdaterService');
        fillets = await updateFilletCentersForNewGeometry(fillets, geo, { width: W, height: H, depth: D });
        base = await applyFillets(base, fillets, { width: W, height: H, depth: D });
        geo = convertReplicadToThreeGeometry(base);
        verts = await getReplicadVertices(base);
      }
      set((S) => ({
        shapes: S.shapes.map(x => x.id === shapeId ? {
          ...x, geometry: geo, replicadShape: base, subtractionGeometries: arr, fillets, position: pos,
          parameters: { ...x.parameters, scaledBaseVertices: verts.map(v => [v.x, v.y, v.z]) },
        } : x),
        selectedSubtractionIndex: null,
      }));
      try { await rebuildParent(shapeId); } catch (err) { console.error('rebuild after subtractor delete fail:', err); }
    } catch (e) { console.error('deleteSubtraction fail:', e); }
  },

  // ── Paneller / editör ─────────────────────────────────────────────────────
  showParametersPanel: false, setShowParametersPanel: (b) => set({ showParametersPanel: b }),
  showOutlines: true, setShowOutlines: (b) => set({ showOutlines: b }),
  selectedPanelRow: null, selectedPanelRowExtraId: null, selectedPanelRowParentId: null,
  setSelectedPanelRow: (i, e, parentId) => set({ selectedPanelRow: i, selectedPanelRowExtraId: e || null, selectedPanelRowParentId: parentId || null }),
  panelSelectMode: false,
  setPanelSelectMode: (b) => set({ panelSelectMode: b, selectedPanelRow: null, selectedPanelRowExtraId: null, selectedPanelRowParentId: null }),
  faceEditMode: false, setFaceEditMode: (b) => set({ faceEditMode: b }),
  hoveredPanelVfId: null, setHoveredPanelVfId: (id) => set({ hoveredPanelVfId: id }),

  // ── Fillet ────────────────────────────────────────────────────────────────
  filletMode: false, setFilletMode: (e) => set({ filletMode: e, selectedFilletFaces: [], selectedFilletFaceData: [] }),
  selectedFilletFaces: [], setSelectedFilletFaces: (f) => set({ selectedFilletFaces: f }),
  addFilletFace: (i) => set((s) => (s.selectedFilletFaces.includes(i) ? {} : { selectedFilletFaces: [...s.selectedFilletFaces, i] })),
  clearFilletFaces: () => set({ selectedFilletFaces: [], selectedFilletFaceData: [] }),
  selectedFilletFaceData: [],
  addFilletFaceData: (d) => set((s) => ({ selectedFilletFaceData: [...s.selectedFilletFaceData, d] })),
  clearFilletFaceData: () => set({ selectedFilletFaceData: [] }),

  raycastMode: false, setRaycastMode: (b) => set({ raycastMode: b }),

  // ── Yüz extrude ───────────────────────────────────────────────────────────
  faceExtrudeMode: false,
  setFaceExtrudeMode: (b) => set({
    faceExtrudeMode: b, faceExtrudeSelectedFace: null, faceExtrudeClickPoint: null,
    ...(!b ? { faceExtrudeTargetPanelId: null, faceExtrudeRefCandidate: null } : {}),
  }),
  faceExtrudeTargetPanelId: null, setFaceExtrudeTargetPanelId: (id) => set({ faceExtrudeTargetPanelId: id }),
  faceExtrudeSelectedFace: null, setFaceExtrudeSelectedFace: (i) => set({ faceExtrudeSelectedFace: i }),
  faceExtrudeClickPoint: null, setFaceExtrudeClickPoint: (p) => set({ faceExtrudeClickPoint: p }),
  faceExtrudeThickness: 18, setFaceExtrudeThickness: (v) => set({ faceExtrudeThickness: v }),
  faceExtrudeFixedMode: true, setFaceExtrudeFixedMode: (b) => set({ faceExtrudeFixedMode: b }),
  faceExtrudeValueMode: 'fixed', setFaceExtrudeValueMode: (m) => set({ faceExtrudeValueMode: m }),
  faceExtrudeRefCandidate: null, setFaceExtrudeRefCandidate: (v) => set({ faceExtrudeRefCandidate: v }),

  // ── Panel taşıma ──────────────────────────────────────────────────────────
  panelMoveMode: false,
  setPanelMoveMode: (b) => set({
    panelMoveMode: b,
    ...(!b ? {
      panelMoveTargetPanelId: null, panelMoveAxis: null, panelMoveValue: 0, panelMoveValueMode: 'dyn' as const,
      panelMoveRefSourceVertex: null, panelMoveRefTargetPanelId: null, panelMoveRefTargetVertex: null,
    } : {}),
  }),
  panelMoveTargetPanelId: null, setPanelMoveTargetPanelId: (id) => set({ panelMoveTargetPanelId: id }),
  panelMoveAxis: null, setPanelMoveAxis: (a) => set({ panelMoveAxis: a }),
  panelMoveValue: 0, setPanelMoveValue: (v) => set({ panelMoveValue: v }),
  panelMoveValueMode: 'dyn',
  setPanelMoveValueMode: (m) => set({ panelMoveValueMode: m, panelMoveRefSourceVertex: null, panelMoveRefTargetPanelId: null, panelMoveRefTargetVertex: null }),
  panelMoveRefSourceVertex: null, setPanelMoveRefSourceVertex: (v) => set({ panelMoveRefSourceVertex: v }),
  panelMoveRefTargetPanelId: null, setPanelMoveRefTargetPanelId: (id) => set({ panelMoveRefTargetPanelId: id }),
  panelMoveRefTargetVertex: null, setPanelMoveRefTargetVertex: (v) => set({ panelMoveRefTargetVertex: v }),

  // ── Panel döndürme ────────────────────────────────────────────────────────
  // Moda girişte/çıkışta alt durum sıfırlanır (her komut mod seçiminden başlar);
  // hedef panel id'si girişte korunur (satır düğmesi onu hemen önce yazar).
  panelRotateMode: false,
  setPanelRotateMode: (b) => set({
    panelRotateMode: b,
    panelRotatePivot: null, panelRotatePivotType: null, panelRotateAxis: null, panelRotateValue: 0,
    panelRotateValueMode: null, panelRotateRefArmVertex: null, panelRotateRefTargetPanelId: null, panelRotateRefFace: null,
    ...(!b ? { panelRotateTargetPanelId: null } : {}),
  }),
  panelRotateTargetPanelId: null, setPanelRotateTargetPanelId: (id) => set({ panelRotateTargetPanelId: id }),
  panelRotatePivot: null, setPanelRotatePivot: (p) => set({ panelRotatePivot: p }),
  panelRotatePivotType: null, setPanelRotatePivotType: (t) => set({ panelRotatePivotType: t }),
  panelRotateAxis: null, setPanelRotateAxis: (a) => set({ panelRotateAxis: a }),
  panelRotateValue: 0, setPanelRotateValue: (v) => set({ panelRotateValue: v }),
  // Mod seçimi/değişimi akışı BAŞA alır (yarım kalmış seçim taşınmaz).
  panelRotateValueMode: null,
  setPanelRotateValueMode: (m) => set({
    panelRotateValueMode: m, panelRotatePivot: null, panelRotatePivotType: null, panelRotateAxis: null, panelRotateValue: 0,
    panelRotateRefArmVertex: null, panelRotateRefTargetPanelId: null, panelRotateRefFace: null,
  }),
  panelRotateRefArmVertex: null, setPanelRotateRefArmVertex: (v) => set({ panelRotateRefArmVertex: v }),
  panelRotateRefTargetPanelId: null, setPanelRotateRefTargetPanelId: (id) => set({ panelRotateRefTargetPanelId: id }),
  // Yüz seçimi hedef paneli de belirler.
  panelRotateRefFace: null, setPanelRotateRefFace: (f) => set({ panelRotateRefFace: f, panelRotateRefTargetPanelId: f ? f.panelId : null }),

  // ── Sanal yüzler ──────────────────────────────────────────────────────────
  showVirtualFaces: true, setShowVirtualFaces: (b) => set({ showVirtualFaces: b }),
  virtualFaces: [],
  addVirtualFace: (v) => set((s) => ({ virtualFaces: [...s.virtualFaces, v] })),
  updateVirtualFace: (id, u) => set((s) => ({ virtualFaces: s.virtualFaces.map(f => (f.id === id ? { ...f, ...u } : f)) })),
  deleteVirtualFace: (id) => set((s) => ({ virtualFaces: s.virtualFaces.filter(f => f.id !== id) })),
  // Sürüklenen grup hedefin ÖNCESİNE (null = sona) taşınır; diğer şekillerin VF'leri yerinde kalır.
  reorderVirtualFaceGroup: (shapeId, fromIds, toGroupFirstId) => {
    set((s) => {
      const shapeFaces = s.virtualFaces.filter(f => f.shapeId === shapeId);
      const fromSet = new Set(fromIds);
      const group = shapeFaces.filter(f => fromSet.has(f.id));
      const rest = shapeFaces.filter(f => !fromSet.has(f.id));
      const insertIdx = toGroupFirstId === null ? rest.length : rest.findIndex(f => f.id === toGroupFirstId);
      if (insertIdx < 0) return {};
      rest.splice(insertIdx, 0, ...group);
      const queue = [...rest];
      return { virtualFaces: s.virtualFaces.map(f => (f.shapeId === shapeId ? queue.shift()! : f)) };
    });
    rebuildParent(shapeId);
  },
}));

/**
 * Store'dan YALNIZ istenen alanlara abone olur (shallow karşılaştırma).
 * `useAppStore()` tüm store'a abone olup her değişiklikte (hover, rebuild'in
 * her panel yazımı…) bileşeni yeniden çizdiriyordu; bu kanca yalnız seçilen
 * alanlar değişince çizdirir.
 */
export function useStoreFields<K extends keyof AppState>(...keys: K[]): Pick<AppState, K> {
  return useAppStore(useShallow((s: AppState) => {
    const o = {} as Pick<AppState, K>;
    for (const k of keys) o[k] = s[k];
    return o;
  }));
}
