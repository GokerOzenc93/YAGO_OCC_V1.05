import { create } from 'zustand';
import * as THREE from 'three';
import type { OpenCascadeInstance } from './vite-env';
import { VertexModification } from './components/VertexEditorService';

/** VERİ YAPILARI */
export interface SubtractionParameters {
  width:string;height:string;depth:string;
  posX:string;posY:string;posZ:string;
  rotX:string;rotY:string;rotZ:string;
}

export interface FaceDescriptor {
  normal:[number,number,number];
  normalizedCenter:[number,number,number];
  area:number;
  isCurved?:boolean;
  axisDirection?:'x+'|'x-'|'y+'|'y-'|'z+'|'z-'|null;
}

export interface FilletInfo {
  face1Descriptor:FaceDescriptor;
  face2Descriptor:FaceDescriptor;
  face1Data:{normal:[number,number,number];center:[number,number,number]};
  face2Data:{normal:[number,number,number];center:[number,number,number]};
  radius:number;
  originalSize:{width:number;height:number;depth:number};
}

export interface SubtractedGeometry {
  geometry:THREE.BufferGeometry;
  relativeOffset:[number,number,number];
  relativeRotation:[number,number,number];
  scale:[number,number,number];
  parameters?:SubtractionParameters;
}

export type FaceRole='Left'|'Right'|'Top'|'Bottom'|'Back'|'Door'|null;

export interface EdgeAnchor {
  edgeV1Local:[number,number,number];
  edgeV2Local:[number,number,number];
  t:number;
  direction:'u+'|'u-'|'v+'|'v-';
}

export interface VirtualFaceRaycastRecipe {
  clickLocalPoint:[number,number,number];
  faceGroupNormal:[number,number,number];
  faceGroupDescriptor:FaceDescriptor;
  normalizedClickUV?:[number,number];
  edgeAnchors?:EdgeAnchor[];
}

export interface VirtualFace {
  id:string;shapeId:string;
  normal:[number,number,number];
  center:[number,number,number];
  vertices:[number,number,number][];
  role:FaceRole;description:string;hasPanel:boolean;
  raycastRecipe?:VirtualFaceRaycastRecipe;
}

export interface Shape {
  id:string;type:string;
  position:[number,number,number];
  rotation:[number,number,number];
  scale:[number,number,number];
  geometry:THREE.BufferGeometry;
  color?:string;
  parameters:Record<string,any>;
  ocShape?:any;replicadShape?:any;
  isolated?:boolean;
  vertexModifications?:VertexModification[];
  groupId?:string;
  isReferenceBox?:boolean;
  subtractionGeometries?:SubtractedGeometry[];
  fillets?:FilletInfo[];
  faceRoles?:Record<number,FaceRole>;
  faceDescriptions?:Record<number,string>;
  facePanels?:Record<number,boolean>;
}

export enum CameraType{PERSPECTIVE='perspective',ORTHOGRAPHIC='orthographic'}
export enum Tool{
  SELECT='Select',MOVE='Move',ROTATE='Rotate',SCALE='Scale',
  POINT_TO_POINT_MOVE='Point to Point Move',
  POLYLINE='Polyline',POLYLINE_EDIT='Polyline Edit',
  RECTANGLE='Rectangle',CIRCLE='Circle',DIMENSION='Dimension'
}
export enum ViewMode{WIREFRAME='wireframe',SOLID='solid',XRAY='xray'}
export enum ModificationType{MIRROR='mirror',ARRAY='array',FILLET='fillet',CHAMFER='chamfer'}
export enum SnapType{ENDPOINT='endpoint',MIDPOINT='midpoint',CENTER='center',PERPENDICULAR='perpendicular',INTERSECTION='intersection',NEAREST='nearest'}
export enum OrthoMode{ON='on',OFF='off'}

/** APP STATE */
interface AppState{
  shapes:Shape[];addShape:(shape:Shape)=>void;updateShape:(id:string,updates:Partial<Shape>)=>void;
  deleteShape:(id:string)=>void;copyShape:(id:string)=>void;
  isolateShape:(id:string)=>void;exitIsolation:()=>void;extrudeShape:(id:string,dist:number)=>void;
  checkAndPerformBooleanOperations:()=>Promise<void>;
  selectedShapeId:string|null;selectShape:(id:string|null)=>void;
  secondarySelectedShapeId:string|null;selectSecondaryShape:(id:string|null)=>void;
  createGroup:(p:string,s:string)=>void;ungroupShapes:(gid:string)=>void;

  activeTool:Tool;setActiveTool:(t:Tool)=>void;
  lastTransformTool:Tool;setLastTransformTool:(t:Tool)=>void;
  cameraType:CameraType;setCameraType:(t:CameraType)=>void;
  viewMode:ViewMode;setViewMode:(m:ViewMode)=>void;cycleViewMode:()=>void;
  orthoMode:OrthoMode;toggleOrthoMode:()=>void;

  snapSettings:Record<SnapType,boolean>;
  toggleSnapSetting:(t:SnapType)=>void;

  modifyShape:(id:string,mod:any)=>void;
  pointToPointMoveState:any;setPointToPointMoveState:(s:any)=>void;
  enableAutoSnap:(t:Tool)=>void;

  opencascadeInstance:OpenCascadeInstance|null;
  opencascadeLoading:boolean;
  setOpenCascadeInstance:(i:OpenCascadeInstance|null)=>void;
  setOpenCascadeLoading:(l:boolean)=>void;

  vertexEditMode:boolean;setVertexEditMode:(b:boolean)=>void;
  selectedVertexIndex:number|null;setSelectedVertexIndex:(i:number|null)=>void;
  vertexDirection:'x+'|'x-'|'y+'|'y-'|'z+'|'z-'|null;
  setVertexDirection:(d:'x+'|'x-'|'y+'|'y-'|'z+'|'z-')=>void;
  addVertexModification:(shapeId:string,mod:VertexModification)=>void;

  subtractionViewMode:boolean;setSubtractionViewMode:(b:boolean)=>void;
  selectedSubtractionIndex:number|null;setSelectedSubtractionIndex:(i:number|null)=>void;
  hoveredSubtractionIndex:number|null;setHoveredSubtractionIndex:(i:number|null)=>void;
  deleteSubtraction:(shapeId:string,idx:number)=>Promise<void>;

  showParametersPanel:boolean;setShowParametersPanel:(b:boolean)=>void;
  showOutlines:boolean;setShowOutlines:(b:boolean)=>void;
  showRoleNumbers:boolean;setShowRoleNumbers:(b:boolean)=>void;

  selectedPanelRow:number|string|null;
  selectedPanelRowExtraId:string|null;
  setSelectedPanelRow:(i:number|string|null,e?:string|null)=>void;
  panelSelectMode:boolean;setPanelSelectMode:(b:boolean)=>void;
  panelSurfaceSelectMode:boolean;setPanelSurfaceSelectMode:(b:boolean)=>void;
  waitingForSurfaceSelection:{extraRowId:string;sourceFaceIndex:number}|null;
  setWaitingForSurfaceSelection:(v:{extraRowId:string;sourceFaceIndex:number}|null)=>void;

  pendingPanelCreation:{
    faceIndex:number;timestamp:number;
    sourceGeometryShapeId?:string;
    surfaceConstraint?:{center:[number,number,number];normal:[number,number,number];constraintPanelId:string;};
  }|null;
  triggerPanelCreationForFace:(faceIndex:number,sid?:string,sc?:{center:[number,number,number];normal:[number,number,number];constraintPanelId:string;})=>void;

  showGlobalSettingsPanel:boolean;setShowGlobalSettingsPanel:(b:boolean)=>void;

  faceEditMode:boolean;setFaceEditMode:(b:boolean)=>void;
  selectedFaceIndex:number|null;setSelectedFaceIndex:(i:number|null)=>void;
  hoveredFaceIndex:number|null;setHoveredFaceIndex:(i:number|null)=>void;

  filletMode:boolean;setFilletMode:(b:boolean)=>void;
  selectedFilletFaces:number[];setSelectedFilletFaces:(f:number[])=>void;
  addFilletFace:(i:number)=>void;clearFilletFaces:()=>void;
  selectedFilletFaceData:Array<{normal:[number,number,number];center:[number,number,number]}>;
  addFilletFaceData:(d:{normal:[number,number,number];center:[number,number,number]})=>void;
  clearFilletFaceData:()=>void;

  roleEditMode:boolean;setRoleEditMode:(b:boolean)=>void;
  updateFaceRole:(sid:string,f:number,r:FaceRole)=>void;

  raycastMode:boolean;setRaycastMode:(b:boolean)=>void;
  raycastResults:Array<{origin:[number,number,number];direction:[number,number,number];hitPoint:[number,number,number]}>;
  setRaycastResults:(r:Array<{origin:[number,number,number];direction:[number,number,number];hitPoint:[number,number,number]}>)=>void;

  showVirtualFaces:boolean;setShowVirtualFaces:(b:boolean)=>void;
  virtualFaces:VirtualFace[];
  addVirtualFace:(v:VirtualFace)=>void;
  updateVirtualFace:(id:string,u:Partial<VirtualFace>)=>void;
  deleteVirtualFace:(id:string)=>void;
  getVirtualFacesForShape:(sid:string)=>VirtualFace[];
  recalculateVirtualFacesForShape:(sid:string)=>void;

  bazaHeight:number;setBazaHeight:(n:number)=>void;
  frontBaseDistance:number;setFrontBaseDistance:(n:number)=>void;
  backBaseDistance:number;setBackBaseDistance:(n:number)=>void;

  legHeight:number;setLegHeight:(n:number)=>void;
  legDiameter:number;setLegDiameter:(n:number)=>void;
  legFrontDistance:number;setLegFrontDistance:(n:number)=>void;
  legBackDistance:number;setLegBackDistance:(n:number)=>void;
  legSideDistance:number;setLegSideDistance:(n:number)=>void;

  backPanelLeftExtend:number;setBackPanelLeftExtend:(n:number)=>void;
  showBackPanelLeftExtend:boolean;setShowBackPanelLeftExtend:(b:boolean)=>void;
  backPanelRightExtend:number;setBackPanelRightExtend:(n:number)=>void;
  showBackPanelRightExtend:boolean;setShowBackPanelRightExtend:(b:boolean)=>void;

  backPanelTopExtend:number;setBackPanelTopExtend:(n:number)=>void;
  showBackPanelTopExtend:boolean;setShowBackPanelTopExtend:(b:boolean)=>void;
  backPanelBottomExtend:number;setBackPanelBottomExtend:(n:number)=>void;
  showBackPanelBottomExtend:boolean;setShowBackPanelBottomExtend:(b:boolean)=>void;

  leftPanelBackShorten:number;setLeftPanelBackShorten:(n:number)=>void;
  showLeftPanelBackShorten:boolean;setShowLeftPanelBackShorten:(b:boolean)=>void;
  rightPanelBackShorten:number;setRightPanelBackShorten:(n:number)=>void;
  showRightPanelBackShorten:boolean;setShowRightPanelBackShorten:(b:boolean)=>void;

  isLeftPanelSelected:boolean;setIsLeftPanelSelected:(b:boolean)=>void;
  isRightPanelSelected:boolean;setIsRightPanelSelected:(b:boolean)=>void;

  isTopPanelSelected:boolean;setIsTopPanelSelected:(b:boolean)=>void;
  isBottomPanelSelected:boolean;setIsBottomPanelSelected:(b:boolean)=>void;

  topPanelBackShorten:number;setTopPanelBackShorten:(n:number)=>void;
  showTopPanelBackShorten:boolean;setShowTopPanelBackShorten:(b:boolean)=>void;
  bottomPanelBackShorten:number;setBottomPanelBackShorten:(n:number)=>void;
  showBottomPanelBackShorten:boolean;setShowBottomPanelBackShorten:(b:boolean)=>void;
}

/** STORE */
export const useAppStore=create<AppState>((set,get)=>({
  shapes:[],

  /* KISA UI STATES */
  showParametersPanel:false,setShowParametersPanel:(b)=>set({showParametersPanel:b}),
  showOutlines:true,setShowOutlines:(b)=>set({showOutlines:b}),
  showRoleNumbers:false,setShowRoleNumbers:(b)=>set({showRoleNumbers:b}),

  selectedPanelRow:null,selectedPanelRowExtraId:null,
  setSelectedPanelRow:(i,e)=>set({selectedPanelRow:i,selectedPanelRowExtraId:e||null}),
  panelSelectMode:false,setPanelSelectMode:(b)=>set({panelSelectMode:b,selectedPanelRow:null,selectedPanelRowExtraId:null}),
  panelSurfaceSelectMode:false,setPanelSurfaceSelectMode:(b)=>set({panelSurfaceSelectMode:b}),
  waitingForSurfaceSelection:null,setWaitingForSurfaceSelection:(v)=>set({waitingForSurfaceSelection:v}),
  pendingPanelCreation:null,
  triggerPanelCreationForFace:(i,sid,sc)=>set({pendingPanelCreation:{faceIndex:i,timestamp:Date.now(),sourceGeometryShapeId:sid,surfaceConstraint:sc}}),

  showGlobalSettingsPanel:false,setShowGlobalSettingsPanel:(b)=>set({showGlobalSettingsPanel:b}),

  faceEditMode:false,setFaceEditMode:(b)=>set({faceEditMode:b}),
  selectedFaceIndex:null,setSelectedFaceIndex:(i)=>set({selectedFaceIndex:i}),
  hoveredFaceIndex:null,setHoveredFaceIndex:(i)=>set({hoveredFaceIndex:i}),

  filletMode:false,setFilletMode:(e)=>set({filletMode:e,selectedFilletFaces:e?[]:[],selectedFilletFaceData:e?[]:[]}),
  selectedFilletFaces:[],setSelectedFilletFaces:(f)=>set({selectedFilletFaces:f}),
  addFilletFace:(i)=>set((s)=>s.selectedFilletFaces.includes(i)?s:{selectedFilletFaces:[...s.selectedFilletFaces,i]}),
  clearFilletFaces:()=>set({selectedFilletFaces:[],selectedFilletFaceData:[]}),
  selectedFilletFaceData:[],addFilletFaceData:(d)=>set((s)=>({selectedFilletFaceData:[...s.selectedFilletFaceData,d]})),
  clearFilletFaceData:()=>set({selectedFilletFaceData:[]}),

  roleEditMode:false,setRoleEditMode:(b)=>set({roleEditMode:b}),
  updateFaceRole:(sid,f,r)=>set((s)=>({shapes:s.shapes.map(x=>x.id===sid?{...x,faceRoles:{...(x.faceRoles||{}),[f]:r}}:x)})),

  raycastMode:false,setRaycastMode:(e)=>set({raycastMode:e,raycastResults:e?get().raycastResults:[]}),
  raycastResults:[],setRaycastResults:(r)=>set({raycastResults:r}),

  showVirtualFaces:true,setShowVirtualFaces:(b)=>set({showVirtualFaces:b}),
  virtualFaces:[],
  addVirtualFace:(v)=>set((s)=>({virtualFaces:[...s.virtualFaces,v]})),
  updateVirtualFace:(id,u)=>set((s)=>({virtualFaces:s.virtualFaces.map(f=>f.id===id?{...f,...u}:f)})),
  deleteVirtualFace:(id)=>set((s)=>({virtualFaces:s.virtualFaces.filter(f=>f.id!==id)})),
  getVirtualFacesForShape:(sid)=>get().virtualFaces.filter(f=>f.shapeId===sid),
  recalculateVirtualFacesForShape:(sid)=>{
    const s=get(),sh=s.shapes.find(x=>x.id===sid);
    if(!sh)return;
    const vf=s.virtualFaces.filter(v=>v.shapeId===sid);
    if(vf.length===0)return;
    import('./components/VirtualFaceUpdateService').then(({recalculateVirtualFacesForShape})=>{
      const st=get(),sh2=st.shapes.find(x=>x.id===sid);
      if(!sh2)return;
      const up=recalculateVirtualFacesForShape(sh2,st.virtualFaces,st.shapes);
      set({virtualFaces:up});
    });
  },

  bazaHeight:100,setBazaHeight:(n)=>set({bazaHeight:n}),
  frontBaseDistance:10,setFrontBaseDistance:(n)=>set({frontBaseDistance:n}),
  backBaseDistance:30,setBackBaseDistance:(n)=>set({backBaseDistance:n}),

  legHeight:100,setLegHeight:(n)=>set({legHeight:n}),
  legDiameter:25,setLegDiameter:(n)=>set({legDiameter:n}),
  legFrontDistance:30,setLegFrontDistance:(n)=>set({legFrontDistance:n}),
  legBackDistance:30,setLegBackDistance:(n)=>set({legBackDistance:n}),
  legSideDistance:30,setLegSideDistance:(n)=>set({legSideDistance:n}),

  backPanelLeftExtend:0,setBackPanelLeftExtend:(n)=>set({backPanelLeftExtend:n}),
  showBackPanelLeftExtend:false,setShowBackPanelLeftExtend:(b)=>set({showBackPanelLeftExtend:b}),
  backPanelRightExtend:0,setBackPanelRightExtend:(n)=>set({backPanelRightExtend:n}),
  showBackPanelRightExtend:false,setShowBackPanelRightExtend:(b)=>set({showBackPanelRightExtend:b}),

  backPanelTopExtend:0,setBackPanelTopExtend:(n)=>set({backPanelTopExtend:n}),
  showBackPanelTopExtend:false,setShowBackPanelTopExtend:(b)=>set({showBackPanelTopExtend:b}),
  backPanelBottomExtend:0,setBackPanelBottomExtend:(n)=>set({backPanelBottomExtend:n}),
  showBackPanelBottomExtend:false,setShowBackPanelBottomExtend:(b)=>set({showBackPanelBottomExtend:b}),

  leftPanelBackShorten:0,setLeftPanelBackShorten:(n)=>set({leftPanelBackShorten:n}),
  showLeftPanelBackShorten:false,setShowLeftPanelBackShorten:(b)=>set({showLeftPanelBackShorten:b}),
  rightPanelBackShorten:0,setRightPanelBackShorten:(n)=>set({rightPanelBackShorten:n}),
  showRightPanelBackShorten:false,setShowRightPanelBackShorten:(b)=>set({showRightPanelBackShorten:b}),

  isLeftPanelSelected:false,setIsLeftPanelSelected:(b)=>set({isLeftPanelSelected:b}),
  isRightPanelSelected:false,setIsRightPanelSelected:(b)=>set({isRightPanelSelected:b}),

  isTopPanelSelected:false,setIsTopPanelSelected:(b)=>set({isTopPanelSelected:b}),
  isBottomPanelSelected:false,setIsBottomPanelSelected:(b)=>set({isBottomPanelSelected:b}),

  topPanelBackShorten:0,setTopPanelBackShorten:(n)=>set({topPanelBackShorten:n}),
  showTopPanelBackShorten:false,setShowTopPanelBackShorten:(b)=>set({showTopPanelBackShorten:b}),
  bottomPanelBackShorten:0,setBottomPanelBackShorten:(n)=>set({bottomPanelBackShorten:n}),
  showBottomPanelBackShorten:false,setShowBottomPanelBackShorten:(b)=>set({showBottomPanelBackShorten:b}),

  /** ----------- SHAPE ACTIONS ----------- */

  addShape:(shape)=>set((s)=>({shapes:[...s.shapes,shape]})),

  updateShape:(id,updates)=>set((state)=>{
    const sh=state.shapes.find(s=>s.id===id);if(!sh) return state;
    const up=state.shapes.map(s=>{
      if(s.id===id)return{...s,...updates};
      if(sh.groupId&&s.groupId===sh.groupId&&s.id!==id){
        if('position'in updates||'rotation'in updates||'scale'in updates){
          const pd=updates.position?[updates.position[0]-sh.position[0],updates.position[1]-sh.position[1],updates.position[2]-sh.position[2]]:[0,0,0];
          const rd=updates.rotation?[updates.rotation[0]-sh.rotation[0],updates.rotation[1]-sh.rotation[1],updates.rotation[2]-sh.rotation[2]]:[0,0,0];
          const sd=updates.scale?[updates.scale[0]/sh.scale[0],updates.scale[1]/sh.scale[1],updates.scale[2]/sh.scale[2]]:[1,1,1];
          return{...s,position:[s.position[0]+pd[0],s.position[1]+pd[1],s.position[2]+pd[2]],
                 rotation:[s.rotation[0]+rd[0],s.rotation[1]+rd[1],s.rotation[2]+rd[2]],
                 scale:[s.scale[0]*sd[0],s.scale[1]*sd[1],s.scale[2]*sd[2]]};
        }
      }
      return s;
    });
    return{shapes:up};
  }),

  deleteShape:(id)=>set((state)=>{
    const child=state.shapes.filter(s=>s.type==='panel'&&s.parameters?.parentShapeId===id).map(s=>s.id);
    const all=new Set([id,...child]);
    return{
      shapes:state.shapes.filter(s=>!all.has(s.id)),
      selectedShapeId:all.has(state.selectedShapeId||'')?null:state.selectedShapeId,
      secondarySelectedShapeId:all.has(state.secondarySelectedShapeId||'')?null:state.secondarySelectedShapeId
    };
  }),

  copyShape:(id)=>{
    const sh=get().shapes.find(s=>s.id===id);
    if(sh)set((st)=>({shapes:[...st.shapes,{...sh,id:`${sh.type}-${Date.now()}`,position:[sh.position[0]+100,sh.position[1],sh.position[2]+100]}]}));
  },

  isolateShape:(id)=>set((s)=>({shapes:s.shapes.map(x=>({...x,isolated:x.id!==id?false:undefined}))})),
  exitIsolation:()=>set((s)=>({shapes:s.shapes.map(x=>({...x,isolated:undefined}))})),

  extrudeShape:(id,d)=>set((st)=>{
    const sh=st.shapes.find(s=>s.id===id);if(!sh)return st;
    const{extrudeGeometry}=require('./services/csg');
    const g=extrudeGeometry(sh.geometry,d);
    return{shapes:st.shapes.map(s=>s.id===id?{...s,geometry:g}:s)};
  }),

  selectedShapeId:null,
  selectShape:(id)=>{
    const t=get().activeTool;
    id&&t===Tool.SELECT?set({selectedShapeId:id,activeTool:Tool.MOVE}):set({selectedShapeId:id});
  },
  secondarySelectedShapeId:null,setSecondarySelectedShapeId:null,
  selectSecondaryShape:(id)=>set({secondarySelectedShapeId:id}),

  createGroup:(p,s2)=>{
    const gid=`group-${Date.now()}`;
    set((s)=>({shapes:s.shapes.map(x=>x.id===p?{...x,groupId:gid}:x.id===s2?{...x,groupId:gid,isReferenceBox:true}:x)}));
  },

  ungroupShapes:(gid)=>set((s)=>({
    shapes:s.shapes.map(x=>x.groupId===gid?(({groupId,isReferenceBox,...r})=>r)(x):x),
    selectedShapeId:null,secondarySelectedShapeId:null
  })),

  activeTool:Tool.SELECT,setActiveTool:(t)=>set({activeTool:t}),
  lastTransformTool:Tool.SELECT,setLastTransformTool:(t)=>set({lastTransformTool:t}),

  cameraType:CameraType.PERSPECTIVE,setCameraType:(t)=>set({cameraType:t}),
  viewMode:ViewMode.SOLID,setViewMode:(m)=>set({viewMode:m}),
  cycleViewMode:()=>{
    const s=get(),arr=[ViewMode.SOLID,ViewMode.WIREFRAME,ViewMode.XRAY],i=arr.indexOf(s.viewMode);
    set({viewMode:arr[(i+1)%arr.length]});
  },

  orthoMode:OrthoMode.OFF,toggleOrthoMode:()=>set((s)=>({orthoMode:s.orthoMode===OrthoMode.ON?OrthoMode.OFF:OrthoMode.ON})),

  snapSettings:{endpoint:false,midpoint:false,center:false,perpendicular:false,intersection:false,nearest:false},
  toggleSnapSetting:(t)=>set((s)=>({snapSettings:{...s.snapSettings,[t]:!s.snapSettings[t]}})),

  modifyShape:(id,mod)=>console.log('Modify shape:',id,mod),
  pointToPointMoveState:null,setPointToPointMoveState:(x)=>set({pointToPointMoveState:x}),
  enableAutoSnap:(t)=>console.log('Enable auto snap:',t),

  opencascadeInstance:null,opencascadeLoading:false,
  setOpenCascadeInstance:(i)=>set({opencascadeInstance:i}),
  setOpenCascadeLoading:(l)=>set({opencascadeLoading:l}),

  vertexEditMode:false,setVertexEditMode:(b)=>set({vertexEditMode:b}),
  selectedVertexIndex:null,setSelectedVertexIndex:(i)=>set({selectedVertexIndex:i}),
  vertexDirection:null,setVertexDirection:(d)=>set({vertexDirection:d}),
  addVertexModification:(sid,mod)=>set((s)=>({
    shapes:s.shapes.map(sh=>{
      if(sh.id!==sid)return sh;
      const a=sh.vertexModifications||[];
      const i=a.findIndex(m=>m.vertexIndex===mod.vertexIndex&&m.direction===mod.direction);
      const arr=i>=0?(a[i]=mod,[...a]):[...a,mod];
      return{...sh,vertexModifications:arr,geometry:sh.geometry};
    })
  })),

  subtractionViewMode:false,setSubtractionViewMode:(b)=>set({subtractionViewMode:b}),
  selectedSubtractionIndex:null,setSelectedSubtractionIndex:(i)=>set({selectedSubtractionIndex:i}),
  hoveredSubtractionIndex:null,setHoveredSubtractionIndex:(i)=>set({hoveredSubtractionIndex:i}),

  /** BOOLEAN OPERASYONU */
  checkAndPerformBooleanOperations:async()=>{
    const st=get(),sh=st.shapes;
    if(sh.length<2)return;
    for(let i=0;i<sh.length;i++)
      for(let j=i+1;j<sh.length;j++){
        const a=sh[i],b=sh[j];
        if(!a.geometry||!b.geometry||!a.replicadShape||!b.replicadShape)continue;
        const BA=new THREE.Box3().setFromBufferAttribute(a.geometry.getAttribute('position')).translate(new THREE.Vector3(...a.position));
        const BB=new THREE.Box3().setFromBufferAttribute(b.geometry.getAttribute('position')).translate(new THREE.Vector3(...b.position));
        if(!BA.intersectsBox(BB))continue;
        try{
          const{performBooleanCut,convertReplicadToThreeGeometry,createReplicadBox}=await import('./components/ReplicadService');
          const{getReplicadVertices}=await import('./components/VertexEditorService');
          const blA=new THREE.Box3().setFromBufferAttribute(a.geometry.getAttribute('position'));
          const sA=new THREE.Vector3();blA.getSize(sA);
          const cA=new THREE.Vector3();blA.getCenter(cA);
          const blB=new THREE.Box3().setFromBufferAttribute(b.geometry.getAttribute('position'));
          const sB=new THREE.Vector3();blB.getSize(sB);
          const cB=new THREE.Vector3();blB.getCenter(cB);

          const isAC=Math.abs(cA.x)<0.01&&Math.abs(cA.y)<0.01&&Math.abs(cA.z)<0.01;
          const isBC=Math.abs(cB.x)<0.01&&Math.abs(cB.y)<0.01&&Math.abs(cB.z)<0.01;

          const oA=[isAC?sA.x/2:0,isAC?sA.y/2:0,isAC?sA.z/2:0];
          const oB=[isBC?sB.x/2:0,isBC?sB.y/2:0,isBC?sB.z/2:0];

          const c1=[a.position[0]-oA[0],a.position[1]-oA[1],a.position[2]-oA[2]];
          const c2=[b.position[0]-oB[0],b.position[1]-oB[1],b.position[2]-oB[2]];

          const rel=[c2[0]-c1[0],c2[1]-c1[1],c2[2]-c1[2]];
          const rot=[b.rotation[0]-a.rotation[0],b.rotation[1]-a.rotation[1],b.rotation[2]-a.rotation[2]];

          const RA=await createReplicadBox({width:sA.x,height:sA.y,depth:sA.z});
          const RB=await createReplicadBox({width:sB.x,height:sB.y,depth:sB.z});

          let result=await performBooleanCut(RA,RB,undefined,rel,undefined,rot,undefined,b.scale);
          let geo=convertReplicadToThreeGeometry(result);
          let verts=await getReplicadVertices(result);

          let fillets=a.fillets||[];
          if(fillets.length){
            const{updateFilletCentersForNewGeometry,applyFillets}=await import('./components/ShapeUpdaterService');
            fillets=await updateFilletCentersForNewGeometry(fillets,geo,{width:sA.x,height:sA.y,depth:sA.z});
            result=await applyFillets(result,fillets,{width:sA.x,height:sA.y,depth:sA.z});
            geo=convertReplicadToThreeGeometry(result);
            verts=await getReplicadVertices(result);
          }

          const sub=b.geometry.clone();
          set((S)=>({
            shapes:S.shapes
              .map(x=>x.id===a.id?{
                ...x,
                geometry:geo,
                replicadShape:result,
                fillets,
                subtractionGeometries:[
                  ...(x.subtractionGeometries||[]),
                  {
                    geometry:sub,relativeOffset:rel,relativeRotation:rot,scale:[1,1,1],
                    parameters:{
                      width:String(sB.x),height:String(sB.y),depth:String(sB.z),
                      posX:String(rel[0]),posY:String(rel[1]),posZ:String(rel[2]),
                      rotX:String(rot[0]*180/Math.PI),
                      rotY:String(rot[1]*180/Math.PI),
                      rotZ:String(rot[2]*180/Math.PI)
                    }
                  }
                ],
                parameters:{...x.parameters,scaledBaseVertices:verts.map(v=>[v.x,v.y,v.z])}
              }
              :x.id!==b.id?x:null)
              .filter(Boolean)
          }));

          import('./components/PanelJointService').then(({rebuildAndRecalculatePipeline})=>rebuildAndRecalculatePipeline(a.id,null));
          return;
        }catch(e){console.error('boolean fail:',e);}
      }
  },

  deleteSubtraction:async(shapeId,idx)=>{
    const st=get(),sh=st.shapes.find(s=>s.id===shapeId);
    if(!sh||!sh.subtractionGeometries)return;
    const arr=[...sh.subtractionGeometries];arr[idx]=null;
    try{
      const{performBooleanCut,convertReplicadToThreeGeometry,createReplicadBox}=await import('./components/ReplicadService');
      const{getReplicadVertices}=await import('./components/VertexEditorService');

      const W=sh.parameters?.width||1,H=sh.parameters?.height||1,D=sh.parameters?.depth||1;
      const pos=[...sh.position];
      let base=await createReplicadBox({width:W,height:H,depth:D});

      for(let i=0;i<arr.length;i++){
        const sub=arr[i];if(!sub)continue;
        let w,h,d;
        if(sub.parameters){w=parseFloat(sub.parameters.width);h=parseFloat(sub.parameters.height);d=parseFloat(sub.parameters.depth);}
        else{
          const B=new THREE.Box3().setFromBufferAttribute(sub.geometry.getAttribute('position'));
          const S=new THREE.Vector3();B.getSize(S);
          w=S.x;h=S.y;d=S.z;
        }
        const SB=await createReplicadBox({width:w,height:h,depth:d});
        base=await performBooleanCut(base,SB,undefined,sub.relativeOffset,undefined,sub.relativeRotation||[0,0,0],undefined,sub.scale||[1,1,1]);
      }

      let geo=convertReplicadToThreeGeometry(base);
      let verts=await getReplicadVertices(base);
      let fillets=sh.fillets||[];

      if(fillets.length){
        const{updateFilletCentersForNewGeometry,applyFillets}=await import('./components/ShapeUpdaterService');
        fillets=await updateFilletCentersForNewGeometry(fillets,geo,{width:W,height:H,depth:D});
        base=await applyFillets(base,fillets,{width:W,height:H,depth:D});
        geo=convertReplicadToThreeGeometry(base);
        verts=await getReplicadVertices(base);
      }

      set((S)=>({
        shapes:S.shapes.map(x=>x.id===shapeId?{
          ...x,
          geometry:geo,
          replicadShape:base,
          subtractionGeometries:arr,
          fillets,
          position:pos,
          parameters:{...x.parameters,scaledBaseVertices:verts.map(v=>[v.x,v.y,v.z])}
        }:x),
        selectedSubtractionIndex:null
      }));

      import('./components/PanelJointService').then(({rebuildAndRecalculatePipeline})=>rebuildAndRecalculatePipeline(shapeId,null));

    }catch(e){console.error('deleteSubtraction fail:',e);}
  }
}));
