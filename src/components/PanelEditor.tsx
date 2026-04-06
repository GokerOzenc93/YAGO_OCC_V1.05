import React, { useState, useEffect, useRef } from 'react';
import { X, GripVertical, MousePointer, Layers, RotateCw, Plus, Trash2, Eye, EyeOff, RefreshCw, MoveVertical, Check, Pencil } from 'lucide-react';
import { globalSettingsService, faceLabelRoleDefaultsService, GlobalSettingsProfile } from './GlobalSettingsDatabase';
import { useAppStore } from '../store';
import type { FaceRole } from '../store';
import { extractFacesFromGeometry, groupCoplanarFaces, createFaceDescriptor, FaceData, CoplanarFaceGroup } from './FaceEditor';
import type { FaceDescriptor } from '../store';
import { resolveAllPanelJoints, restoreAllPanels, rebuildAllPanels, rebuildAndRecalculatePipeline } from './PanelJointService';
import { findExistingStepForFace } from './FaceExtrudeService';
import type { FilletData } from './Fillet';
import * as THREE from 'three';

interface PanelEditorProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PanelEditor({ isOpen, onClose }: PanelEditorProps) {
  const { selectedShapeId, shapes, updateShape, addShape, showOutlines, setShowOutlines, showRoleNumbers, setShowRoleNumbers, selectedPanelRow, selectedPanelRowParentId, setSelectedPanelRow, panelSelectMode, setPanelSelectMode, raycastMode, setRaycastMode, showVirtualFaces, setShowVirtualFaces, virtualFaces, updateVirtualFace, deleteVirtualFace, pendingPanelCreation, setActivePanelProfileId, setShapeRebuilding, faceExtrudeMode, setFaceExtrudeMode, faceExtrudeTargetPanelId, setFaceExtrudeTargetPanelId, faceExtrudeSelectedFace, setFaceExtrudeSelectedFace, faceExtrudeHoveredFace, setFaceExtrudeHoveredFace, faceExtrudeThickness, setFaceExtrudeThickness, faceExtrudeFixedMode, setFaceExtrudeFixedMode } = useAppStore();
  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [profiles, setProfiles] = useState<GlobalSettingsProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>('none');
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const prevProfileRef = useRef<string>('none');
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const selectedShape = shapes.find((s) => s.id === selectedShapeId);

  useEffect(() => {
    setSelectedPanelRow(null);
  }, [selectedShapeId, setSelectedPanelRow]);

  const activePanelId = React.useMemo(() => {
    if (!selectedShape || selectedPanelRow === null) return null;
    if (typeof selectedPanelRow === 'number') {
      const ps = shapes.find(s =>
        s.type === 'panel' &&
        s.parameters?.parentShapeId === selectedShape.id &&
        s.parameters?.faceIndex === selectedPanelRow &&
        !s.parameters?.extraRowId
      );
      return ps?.id || null;
    }
    if (typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-')) {
      const vfId = selectedPanelRow.replace('vf-', '');
      const vp = shapes.find(s =>
        s.type === 'panel' &&
        s.parameters?.parentShapeId === selectedShape.id &&
        s.parameters?.virtualFaceId === vfId
      );
      return vp?.id || null;
    }
    return null;
  }, [selectedShape, selectedPanelRow, shapes]);

  useEffect(() => {
    if (faceExtrudeMode && activePanelId && activePanelId !== faceExtrudeTargetPanelId) {
      setFaceExtrudeTargetPanelId(activePanelId);
      setFaceExtrudeSelectedFace(null);
      setFaceExtrudeHoveredFace(null);
    }
  }, [faceExtrudeMode, activePanelId, faceExtrudeTargetPanelId, setFaceExtrudeTargetPanelId, setFaceExtrudeSelectedFace, setFaceExtrudeHoveredFace]);

  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editingStepValue, setEditingStepValue] = useState<number>(0);

  useEffect(() => {
    if (faceExtrudeSelectedFace === null || !activePanelId) return;
    const panelShape = shapes.find(s => s.id === activePanelId);
    if (!panelShape?.geometry) return;
    const steps = panelShape.parameters?.extrudeSteps || [];
    if (steps.length === 0) return;
    const faces = extractFacesFromGeometry(panelShape.geometry);
    const groups = groupCoplanarFaces(faces);
    const group = groups[faceExtrudeSelectedFace];
    if (!group) return;
    const n = group.normal.clone().normalize();
    const center = group.center.clone();
    const existing = findExistingStepForFace(steps, n, center);
    if (existing) {
      setFaceExtrudeThickness(existing.value);
      setFaceExtrudeFixedMode(existing.isFixed);
    }
  }, [faceExtrudeSelectedFace, activePanelId, shapes]);

  const getArrowTargetAxis = (geometry: THREE.BufferGeometry, faceRole?: string, arrowRotated?: boolean): number => {
    if (!geometry) return 0;

    const posAttr = geometry.getAttribute('position');
    if (!posAttr) return 0;

    const bbox = new THREE.Box3().setFromBufferAttribute(posAttr as THREE.BufferAttribute);
    const size = new THREE.Vector3();
    bbox.getSize(size);

    const axes = [
      { index: 0, value: size.x },
      { index: 1, value: size.y },
      { index: 2, value: size.z }
    ];
    axes.sort((a, b) => a.value - b.value);

    const planeAxes = axes.slice(1).map(a => a.index).sort((a, b) => a - b);

    const role = faceRole?.toLowerCase();
    let defaultAxis = planeAxes[0];
    let altAxis = planeAxes[1];

    if (role === 'left' || role === 'right') {
      if (planeAxes.includes(1)) {
        defaultAxis = 1;
        altAxis = planeAxes.find(a => a !== 1) ?? planeAxes[1];
      }
    } else if (role === 'top' || role === 'bottom') {
      if (planeAxes.includes(0)) {
        defaultAxis = 0;
        altAxis = planeAxes.find(a => a !== 0) ?? planeAxes[1];
      }
    }

    return arrowRotated ? altAxis : defaultAxis;
  };

  const getPanelDimensions = (faceIndex: number): { primary: number; secondary: number; thickness: number; w: number; h: number; d: number } | null => {
    if (!selectedShape) return null;
    const panel = shapes.find(
      s => s.type === 'panel' &&
      s.parameters?.parentShapeId === selectedShape.id &&
      s.parameters?.faceIndex === faceIndex &&
      !s.parameters?.extraRowId
    );
    if (!panel || !panel.geometry) return null;
    const box = new THREE.Box3().setFromBufferAttribute(panel.geometry.getAttribute('position'));
    const size = new THREE.Vector3();
    box.getSize(size);

    const dimensions = {
      w: Math.round(size.x * 10) / 10,
      h: Math.round(size.y * 10) / 10,
      d: Math.round(size.z * 10) / 10
    };

    const targetAxis = getArrowTargetAxis(
      panel.geometry,
      panel.parameters?.faceRole,
      panel.parameters?.arrowRotated
    );

    const posAttr = panel.geometry.getAttribute('position');
    const bbox = new THREE.Box3().setFromBufferAttribute(posAttr as THREE.BufferAttribute);
    const sizeVec = new THREE.Vector3();
    bbox.getSize(sizeVec);

    const axes = [
      { index: 0, value: sizeVec.x },
      { index: 1, value: sizeVec.y },
      { index: 2, value: sizeVec.z }
    ];
    axes.sort((a, b) => a.value - b.value);

    const thicknessAxis = axes[0].index;
    const planeAxes = axes.slice(1).map(a => a.index);
    const secondaryAxis = planeAxes.find(a => a !== targetAxis) ?? planeAxes[0];

    let primary: number;
    let secondary: number;
    let thickness: number;

    if (targetAxis === 0) {
      primary = dimensions.w;
    } else if (targetAxis === 1) {
      primary = dimensions.h;
    } else {
      primary = dimensions.d;
    }

    if (secondaryAxis === 0) {
      secondary = dimensions.w;
    } else if (secondaryAxis === 1) {
      secondary = dimensions.h;
    } else {
      secondary = dimensions.d;
    }

    if (thicknessAxis === 0) {
      thickness = dimensions.w;
    } else if (thicknessAxis === 1) {
      thickness = dimensions.h;
    } else {
      thickness = dimensions.d;
    }

    return {
      primary,
      secondary,
      thickness,
      ...dimensions
    };
  };

  useEffect(() => {
    if (isOpen) {
      loadProfiles();
    } else {
      setSelectedPanelRow(null);
      setPanelSelectMode(false);
      if (faceExtrudeMode) setFaceExtrudeMode(false);
    }
  }, [isOpen, setSelectedPanelRow, setPanelSelectMode, faceExtrudeMode, setFaceExtrudeMode]);

  useEffect(() => {
    if (selectedPanelRow !== null) {
      const rowElement = rowRefs.current.get(selectedPanelRow);
      if (rowElement) {
        rowElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [selectedPanelRow]);

  useEffect(() => {
    setActivePanelProfileId(selectedProfile !== 'none' ? selectedProfile : null);
  }, [selectedProfile]);

  useEffect(() => {
    if (prevProfileRef.current === selectedProfile) return;
    prevProfileRef.current = selectedProfile;
    if (!selectedShapeId) return;

    if (selectedProfile !== 'none') {
      setResolving(true);
      setShapeRebuilding(selectedShapeId, true);
      resolveAllPanelJoints(selectedShapeId, selectedProfile).finally(() => {
        setResolving(false);
        setShapeRebuilding(selectedShapeId, false);
      });
    } else {
      restoreAllPanels(selectedShapeId);
    }
  }, [selectedProfile, selectedShapeId]);


  const loadProfiles = async () => {
    try {
      setLoading(true);
      const data = await globalSettingsService.listProfiles();
      setProfiles(data);
    } catch (error) {
      console.error('Failed to load profiles:', error);
    } finally {
      setLoading(false);
    }
  };

  const selectedProfileRef = useRef<string>('none');
  selectedProfileRef.current = selectedProfile;

  useEffect(() => {
    if (!pendingPanelCreation || !isOpen) return;
    const constraint = pendingPanelCreation.surfaceConstraint;
    if (!constraint?.constraintPanelId) return;

    const vf = virtualFaces.find(f => f.id === constraint.constraintPanelId);
    if (!vf || vf.hasPanel) return;

    const currentShape = useAppStore.getState().shapes.find(s => s.id === vf.shapeId);
    if (!currentShape) return;

    const vfIdx = virtualFaces.filter(f => f.shapeId === vf.shapeId).findIndex(f => f.id === vf.id);
    if (vfIdx === -1) return;

    (async () => {
      try {
        const panelThickness = 18;
        const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
        const replicadPanel = await createPanelFromVirtualFace(
          vf.vertices,
          vf.normal,
          panelThickness
        );
        if (!replicadPanel) return;
        const geometry = convertReplicadToThreeGeometry(replicadPanel);
        const newPanel: any = {
          id: `panel-vf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          type: 'panel',
          geometry,
          replicadShape: replicadPanel,
          position: [...currentShape.position] as [number, number, number],
          rotation: currentShape.rotation,
          scale: [...currentShape.scale] as [number, number, number],
          color: '#ffffff',
          parameters: {
            width: 0,
            height: 0,
            depth: panelThickness,
            parentShapeId: currentShape.id,
            faceIndex: -(vfIdx + 1),
            faceRole: vf.role,
            virtualFaceId: vf.id,
          }
        };
        addShape(newPanel);
        updateVirtualFace(vf.id, { hasPanel: true });

        const currentProfile = selectedProfileRef.current;
        if (currentProfile !== 'none') {
          setResolving(true);
          setShapeRebuilding(currentShape.id, true);
          try {
            await resolveAllPanelJoints(currentShape.id, currentProfile);
          } finally {
            setResolving(false);
            setShapeRebuilding(currentShape.id, false);
          }
        }
      } catch (err) {
        console.error('Failed to create panel for virtual face via click:', err);
      }
    })();
  }, [pendingPanelCreation]);

  const createPanelForFace = async (
    faceGroup: CoplanarFaceGroup,
    faces: FaceData[],
    faceIndex: number
  ) => {
    if (!selectedShape || !selectedShape.replicadShape) {
      return;
    }

    try {
      const localVertices: THREE.Vector3[] = [];
      faceGroup.faceIndices.forEach(idx => {
        const face = faces[idx];
        face.vertices.forEach(v => {
          localVertices.push(v.clone());
        });
      });

      const localNormal = faceGroup.normal.clone().normalize();
      const localBox = new THREE.Box3().setFromPoints(localVertices);
      const localCenter = new THREE.Vector3();
      localBox.getCenter(localCenter);

      const panelThickness = 18;

      const { createPanelFromFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');

      let replicadPanel = await createPanelFromFace(
        selectedShape.replicadShape,
        [localNormal.x, localNormal.y, localNormal.z],
        [localCenter.x, localCenter.y, localCenter.z],
        panelThickness,
        null
      );

      if (!replicadPanel) return;

      const geometry = convertReplicadToThreeGeometry(replicadPanel);

      const faceRole = selectedShape.faceRoles?.[faceIndex];

      const newPanel: any = {
        id: `panel-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        type: 'panel',
        geometry,
        replicadShape: replicadPanel,
        position: [...selectedShape.position] as [number, number, number],
        rotation: selectedShape.rotation,
        scale: [...selectedShape.scale] as [number, number, number],
        color: '#ffffff',
        parameters: {
          width: 0,
          height: 0,
          depth: panelThickness,
          parentShapeId: selectedShape.id,
          faceIndex: faceIndex,
          faceRole: faceRole,
        }
      };

      addShape(newPanel);
    } catch (error) {
      console.error('Failed to create panel:', error);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y
    });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        e.preventDefault();
        setPosition({
          x: e.clientX - dragOffset.x,
          y: e.clientY - dragOffset.y
        });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  useEffect(() => {
    if (!selectedShape || !selectedShape.geometry) return;

    const applyLabelDefaults = async () => {
      const labelDefaults = await faceLabelRoleDefaultsService.getAll();

      const AXIS_ORDER: Record<string, number> = { 'x+': 0, 'x-': 1, 'y+': 2, 'y-': 3, 'z+': 4, 'z-': 5 };
      const getAxisDir = (n: THREE.Vector3): string | null => {
        const tol = 0.95;
        if (n.x > tol) return 'x+';
        if (n.x < -tol) return 'x-';
        if (n.y > tol) return 'y+';
        if (n.y < -tol) return 'y-';
        if (n.z > tol) return 'z+';
        if (n.z < -tol) return 'z-';
        return null;
      };

      const geometry = selectedShape.geometry;
      const faces = extractFacesFromGeometry(geometry);
      const faceGroups = groupCoplanarFaces(faces);
      const subtractionGeometries: any[] = selectedShape.subtractionGeometries || [];
      const fillets: any[] = selectedShape.fillets || [];

      const mainBbox = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
      const cuttingPlanes: Array<{ normal: THREE.Vector3; constant: number }> = [];
      subtractionGeometries.forEach((sub: any) => {
        if (!sub) return;
        const subGeo = sub.geometry;
        if (!subGeo) return;
        const subBbox = new THREE.Box3().setFromBufferAttribute(subGeo.getAttribute('position'));
        const offset = new THREE.Vector3(...sub.relativeOffset);
        const rot = sub.relativeRotation;
        const rotMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
        const corners = [
          new THREE.Vector3(subBbox.min.x, subBbox.min.y, subBbox.min.z),
          new THREE.Vector3(subBbox.max.x, subBbox.min.y, subBbox.min.z),
          new THREE.Vector3(subBbox.min.x, subBbox.max.y, subBbox.min.z),
          new THREE.Vector3(subBbox.max.x, subBbox.max.y, subBbox.min.z),
          new THREE.Vector3(subBbox.min.x, subBbox.min.y, subBbox.max.z),
          new THREE.Vector3(subBbox.max.x, subBbox.min.y, subBbox.max.z),
          new THREE.Vector3(subBbox.min.x, subBbox.max.y, subBbox.max.z),
          new THREE.Vector3(subBbox.max.x, subBbox.max.y, subBbox.max.z),
        ].map(c => c.applyMatrix4(rotMatrix).add(offset));
        const worldBbox = new THREE.Box3().setFromPoints(corners);
        const faceNormals = [
          new THREE.Vector3(1,0,0), new THREE.Vector3(-1,0,0),
          new THREE.Vector3(0,1,0), new THREE.Vector3(0,-1,0),
          new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,-1),
        ];
        const faceConstants = [
          -worldBbox.max.x, worldBbox.min.x,
          -worldBbox.max.y, worldBbox.min.y,
          -worldBbox.max.z, worldBbox.min.z,
        ];
        const facePlanePositions = [
          worldBbox.max.x, worldBbox.min.x,
          worldBbox.max.y, worldBbox.min.y,
          worldBbox.max.z, worldBbox.min.z,
        ];
        for (let pi = 0; pi < 6; pi++) {
          const pos = facePlanePositions[pi];
          const axisIdx = Math.floor(pi / 2);
          const minVal = axisIdx === 0 ? mainBbox.min.x : axisIdx === 1 ? mainBbox.min.y : mainBbox.min.z;
          const maxVal = axisIdx === 0 ? mainBbox.max.x : axisIdx === 1 ? mainBbox.max.y : mainBbox.max.z;
          if (pos > minVal + 1.0 && pos < maxVal - 1.0) {
            cuttingPlanes.push({ normal: faceNormals[pi], constant: faceConstants[pi] });
          }
        }
      });

      const axisCandidates = new Map<string, number[]>();

      faceGroups.forEach((group, groupIndex) => {
        const axisDir = getAxisDir(group.normal);
        if (axisDir === null) {
          for (let fi = 0; fi < fillets.length; fi++) {
            const fillet = fillets[fi];
            const radius = fillet.radius;
            const tol = Math.max(radius * 2.0, 10);
            const n1 = new THREE.Vector3(...fillet.face1Data.normal);
            const n2 = new THREE.Vector3(...fillet.face2Data.normal);
            const d1 = fillet.face1Data.planeD ?? n1.dot(new THREE.Vector3(...fillet.face1Data.center));
            const d2 = fillet.face2Data.planeD ?? n2.dot(new THREE.Vector3(...fillet.face2Data.center));
            if (Math.abs(n1.dot(group.center) - d1) < tol && Math.abs(n2.dot(group.center) - d2) < tol) {
              return;
            }
          }
          return;
        }
        if (cuttingPlanes.length > 0) {
          for (const plane of cuttingPlanes) {
            const normalDot = Math.abs(group.normal.dot(plane.normal));
            if (normalDot < 0.95) continue;
            const dist = group.center.dot(plane.normal) + plane.constant;
            if (Math.abs(dist) < 1.0) {
              return;
            }
          }
        }
        if (!axisCandidates.has(axisDir)) axisCandidates.set(axisDir, []);
        axisCandidates.get(axisDir)!.push(groupIndex);
      });

      const axisSorted = Array.from(axisCandidates.entries()).sort(
        ([a], [b]) => (AXIS_ORDER[a] ?? 99) - (AXIS_ORDER[b] ?? 99)
      );

      const labelForGroupIndex = new Map<number, string>();
      axisSorted.forEach(([, groupIndices], roleIdx) => {
        const roleNumber = roleIdx + 1;
        if (groupIndices.length > 1) {
          groupIndices.forEach((gi, subIdx) => {
            labelForGroupIndex.set(gi, `${roleNumber}-${subIdx + 1}`);
          });
        } else {
          labelForGroupIndex.set(groupIndices[0], `${roleNumber}`);
        }
      });

      const newFaceRoles: Record<number, FaceRole> = {};

      labelForGroupIndex.forEach((label, groupIndex) => {
        const defaultRole = labelDefaults[label];
        if (defaultRole) {
          newFaceRoles[groupIndex] = defaultRole as FaceRole;
        }
      });

      updateShape(selectedShape.id, { faceRoles: newFaceRoles });
    };

    applyLabelDefaults();
  }, [selectedShape?.id, selectedShape?.geometry]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed bg-white rounded-lg shadow-2xl border border-stone-300 z-50"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: '410px',
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 bg-stone-100 border-b border-stone-300 rounded-t-lg select-none"
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
          <GripVertical size={14} className="text-stone-400" />
          <span className="text-sm font-semibold text-slate-800">Panel Editor</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowVirtualFaces(!showVirtualFaces)}
            className={`p-0.5 rounded transition-colors text-[10px] font-semibold px-1.5 ${
              showVirtualFaces
                ? 'text-green-700 bg-green-100 ring-1 ring-green-400'
                : 'text-slate-500 hover:bg-stone-200'
            }`}
            title="Raycast Face"
          >
            RF
          </button>
          <button
            onClick={() => setShowOutlines(!showOutlines)}
            className={`p-0.5 rounded transition-colors text-[10px] font-semibold px-1.5 ${
              showOutlines
                ? 'text-blue-700 bg-blue-100 ring-1 ring-blue-400'
                : 'text-slate-500 hover:bg-stone-200'
            }`}
            title="Outline"
          >
            OL
          </button>
          <button
            onClick={() => setShowRoleNumbers(!showRoleNumbers)}
            className={`p-0.5 rounded transition-colors text-[10px] font-semibold px-1.5 ${
              showRoleNumbers
                ? 'text-orange-700 bg-orange-100 ring-1 ring-orange-400'
                : 'text-slate-500 hover:bg-stone-200'
            }`}
            title="Role Numbers"
          >
            RN
          </button>
          <button
            onClick={() => setRaycastMode(!raycastMode)}
            className={`p-0.5 rounded transition-colors ${
              raycastMode
                ? 'text-amber-600 bg-amber-100 ring-1 ring-amber-400'
                : 'text-slate-600 hover:bg-stone-200'
            }`}
            title={raycastMode ? 'Raycast Modu Aktif (kapat)' : 'Raycast Modunu Aç'}
          >
            <Plus size={14} />
          </button>
          <button
            onClick={async () => {
              if (!selectedShape || selectedProfile === 'none' || resolving) return;
              setResolving(true);
              setShapeRebuilding(selectedShape.id, true);
              try {
                await rebuildAllPanels(selectedShape.id);
                await resolveAllPanelJoints(selectedShape.id, selectedProfile);
              } finally {
                setResolving(false);
                setShapeRebuilding(selectedShape.id, false);
              }
            }}
            disabled={!selectedShape || selectedProfile === 'none' || resolving}
            className={`p-0.5 rounded transition-colors ${
              !selectedShape || selectedProfile === 'none' || resolving
                ? 'text-stone-300 cursor-not-allowed'
                : 'text-slate-600 hover:bg-stone-200'
            }`}
            title="Panelleri Yeniden Hesapla"
          >
            <RefreshCw size={14} className={resolving ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setPanelSelectMode(!panelSelectMode)}
            className={`p-0.5 hover:bg-stone-200 rounded transition-colors ${
              panelSelectMode ? 'text-orange-600' : 'text-slate-600'
            }`}
            title={panelSelectMode ? 'Panel Mode' : 'Body Mode'}
          >
            {panelSelectMode ? <MousePointer size={14} /> : <Layers size={14} />}
          </button>
          <button
            onClick={onClose}
            className="p-0.5 hover:bg-stone-200 rounded transition-colors"
          >
            <X size={14} className="text-stone-600" />
          </button>
        </div>
      </div>

      <div className="p-3 max-h-[calc(100vh-200px)] overflow-y-auto">
        {selectedShape ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-slate-800 whitespace-nowrap">
                Select Body Profile
              </label>
              {loading ? (
                <div className="px-2 py-0.5 text-xs text-stone-400 bg-white border border-gray-300 rounded" style={{ width: '30mm' }}>
                  Loading...
                </div>
              ) : (
                <select
                  value={selectedProfile}
                  onChange={(e) => setSelectedProfile(e.target.value)}
                  className="px-2 py-0.5 text-xs bg-white text-gray-800 border border-gray-300 rounded focus:outline-none focus:border-orange-500"
                  style={{ width: '30mm' }}
                >
                  <option value="none">None</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              )}
            </div>


            {(() => {
              const geometry = selectedShape.geometry;
              if (!geometry) return null;

              const faces = extractFacesFromGeometry(geometry);
              const faceGroups = groupCoplanarFaces(faces);
              const faceRoles = selectedShape.faceRoles || {};
              const faceDescriptions = selectedShape.faceDescriptions || {};
              const facePanels = selectedShape.facePanels || {};
              const roleOptions: FaceRole[] = ['Left', 'Right', 'Top', 'Bottom', 'Back', 'Door'];
              const isDisabled = selectedProfile === 'none';

              const buildDescriptors = (): Record<number, FaceDescriptor> => {
                const descriptors: Record<number, FaceDescriptor> = { ...(selectedShape.faceGroupDescriptors || {}) };
                faceGroups.forEach((group, gi) => {
                  const repFaceIdx = group.faceIndices[0];
                  const repFace = faces[repFaceIdx];
                  if (repFace) {
                    descriptors[gi] = createFaceDescriptor(repFace, geometry);
                  }
                });
                return descriptors;
              };

              const handleTogglePanel = async (faceIndex: number) => {
                if (isDisabled) return;
                const newFacePanels = { ...facePanels };
                if (newFacePanels[faceIndex]) {
                  delete newFacePanels[faceIndex];

                  const panelToRemove = shapes.find(s =>
                    s.type === 'panel' &&
                    s.parameters?.parentShapeId === selectedShape.id &&
                    s.parameters?.faceIndex === faceIndex
                  );
                  if (panelToRemove) {
                    const { deleteShape } = useAppStore.getState();
                    deleteShape(panelToRemove.id);
                  }
                } else {
                  newFacePanels[faceIndex] = true;
                  await createPanelForFace(faceGroups[faceIndex], faces, faceIndex);
                }
                updateShape(selectedShape.id, { facePanels: newFacePanels, faceGroupDescriptors: buildDescriptors() });

                if (selectedProfile !== 'none') {
                  setResolving(true);
                  setShapeRebuilding(selectedShape.id, true);
                  try {
                    await resolveAllPanelJoints(selectedShape.id, selectedProfile);
                  } finally {
                    setResolving(false);
                    setShapeRebuilding(selectedShape.id, false);
                  }
                }
              };

              const handleRowClick = (faceIndex: number) => {
                if (!facePanels[faceIndex]) return;
                setSelectedPanelRow(faceIndex, null, selectedShape.id);
              };

              const shapeVirtualFaces = virtualFaces.filter(vf => vf.shapeId === selectedShape.id);

              const createVirtualPanel = async (vfId: string, vfIndex: number) => {
                const vf = shapeVirtualFaces[vfIndex];
                if (!vf) return;
                try {
                  const panelThickness = 18;
                  const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
                  const replicadPanel = await createPanelFromVirtualFace(
                    vf.vertices,
                    vf.normal,
                    panelThickness
                  );
                  if (!replicadPanel) return;
                  const geometry = convertReplicadToThreeGeometry(replicadPanel);

                  const bbox = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
                  const size = new THREE.Vector3();
                  bbox.getSize(size);

                  const axesBySize = [
                    { index: 0, value: size.x },
                    { index: 1, value: size.y },
                    { index: 2, value: size.z }
                  ].sort((a, b) => a.value - b.value);

                  const planeAxes = axesBySize.slice(1).map(a => a.index).sort((a, b) => a - b);
                  const role = vf.role?.toLowerCase();
                  let defaultAxis = planeAxes[0];
                  let altAxis = planeAxes[1];
                  if (role === 'left' || role === 'right') {
                    if (planeAxes.includes(1)) { defaultAxis = 1; altAxis = planeAxes.find(a => a !== 1) ?? planeAxes[1]; }
                  } else if (role === 'top' || role === 'bottom') {
                    if (planeAxes.includes(0)) { defaultAxis = 0; altAxis = planeAxes.find(a => a !== 0) ?? planeAxes[1]; }
                  }
                  const targetAxis = defaultAxis;
                  const secondaryAxis = altAxis;

                  const sizeByIndex = [size.x, size.y, size.z];
                  const width = sizeByIndex[targetAxis];
                  const height = sizeByIndex[secondaryAxis];

                  const newPanel: any = {
                    id: `panel-vf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                    type: 'panel',
                    geometry,
                    replicadShape: replicadPanel,
                    position: [...selectedShape.position] as [number, number, number],
                    rotation: selectedShape.rotation,
                    scale: [...selectedShape.scale] as [number, number, number],
                    color: '#ffffff',
                    parameters: {
                      width,
                      height,
                      depth: panelThickness,
                      parentShapeId: selectedShape.id,
                      faceIndex: -(vfIndex + 1),
                      faceRole: vf.role,
                      virtualFaceId: vf.id,
                      arrowRotated: false
                    }
                  };
                  addShape(newPanel);
                  updateVirtualFace(vf.id, { hasPanel: true });
                } catch (err) {
                  console.error('Failed to create panel for virtual face:', err);
                }
              };

              const removeVirtualPanel = (vfId: string, vfIndex: number) => {
                const panelToRemove = shapes.find(s =>
                  s.type === 'panel' &&
                  s.parameters?.parentShapeId === selectedShape.id &&
                  s.parameters?.virtualFaceId === vfId
                );
                if (panelToRemove) {
                  const { deleteShape } = useAppStore.getState();
                  deleteShape(panelToRemove.id);
                }
                updateVirtualFace(vfId, { hasPanel: false });
              };

              const fillets: FilletData[] = selectedShape.fillets || [];
              const subtractionGeometries: Array<any> = selectedShape.subtractionGeometries || [];

              const AXIS_DIRECTION_ORDER: Record<string, number> = {
                'x+': 0, 'x-': 1, 'y+': 2, 'y-': 3, 'z+': 4, 'z-': 5,
              };
              const getAxisDir = (n: THREE.Vector3): string | null => {
                const tol = 0.95;
                if (n.x > tol) return 'x+';
                if (n.x < -tol) return 'x-';
                if (n.y > tol) return 'y+';
                if (n.y < -tol) return 'y-';
                if (n.z > tol) return 'z+';
                if (n.z < -tol) return 'z-';
                return null;
              };

              const mainBbox = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
              const cuttingPlanes: Array<{ normal: THREE.Vector3; constant: number; subtractorIndex: number }> = [];
              subtractionGeometries.forEach((sub: any, subtractorIndex: number) => {
                if (!sub) return;
                const subGeo = sub.geometry;
                if (!subGeo) return;
                const subBbox = new THREE.Box3().setFromBufferAttribute(subGeo.getAttribute('position'));
                const offset = new THREE.Vector3(...sub.relativeOffset);
                const rot = sub.relativeRotation;
                const rotMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
                const corners = [
                  new THREE.Vector3(subBbox.min.x, subBbox.min.y, subBbox.min.z),
                  new THREE.Vector3(subBbox.max.x, subBbox.min.y, subBbox.min.z),
                  new THREE.Vector3(subBbox.min.x, subBbox.max.y, subBbox.min.z),
                  new THREE.Vector3(subBbox.max.x, subBbox.max.y, subBbox.min.z),
                  new THREE.Vector3(subBbox.min.x, subBbox.min.y, subBbox.max.z),
                  new THREE.Vector3(subBbox.max.x, subBbox.min.y, subBbox.max.z),
                  new THREE.Vector3(subBbox.min.x, subBbox.max.y, subBbox.max.z),
                  new THREE.Vector3(subBbox.max.x, subBbox.max.y, subBbox.max.z),
                ].map(c => c.applyMatrix4(rotMatrix).add(offset));
                const worldBbox = new THREE.Box3().setFromPoints(corners);
                const faceNormals = [
                  new THREE.Vector3(1,0,0), new THREE.Vector3(-1,0,0),
                  new THREE.Vector3(0,1,0), new THREE.Vector3(0,-1,0),
                  new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,-1),
                ];
                const faceConstants = [
                  -worldBbox.max.x, worldBbox.min.x,
                  -worldBbox.max.y, worldBbox.min.y,
                  -worldBbox.max.z, worldBbox.min.z,
                ];
                const facePlanePositions = [
                  worldBbox.max.x, worldBbox.min.x,
                  worldBbox.max.y, worldBbox.min.y,
                  worldBbox.max.z, worldBbox.min.z,
                ];
                for (let pi = 0; pi < 6; pi++) {
                  const pos = facePlanePositions[pi];
                  const axisIdx = Math.floor(pi / 2);
                  const minVal = axisIdx === 0 ? mainBbox.min.x : axisIdx === 1 ? mainBbox.min.y : mainBbox.min.z;
                  const maxVal = axisIdx === 0 ? mainBbox.max.x : axisIdx === 1 ? mainBbox.max.y : mainBbox.max.z;
                  if (pos > minVal + 1.0 && pos < maxVal - 1.0) {
                    cuttingPlanes.push({ normal: faceNormals[pi], constant: faceConstants[pi], subtractorIndex });
                  }
                }
              });

              const axisCandidatesForLabels = new Map<string, Array<number>>();
              const subtractorMapForLabels = new Map<number, Array<number>>();
              const filletMapForLabels = new Map<number, Array<number>>();

              faceGroups.forEach((group, groupIndex) => {
                const axisDir = getAxisDir(group.normal);
                if (axisDir === null) {
                  for (let fi = 0; fi < fillets.length; fi++) {
                    const fillet = fillets[fi];
                    const radius = fillet.radius;
                    const tol = Math.max(radius * 2.0, 10);
                    const n1 = new THREE.Vector3(...fillet.face1Data.normal);
                    const n2 = new THREE.Vector3(...fillet.face2Data.normal);
                    const d1 = fillet.face1Data.planeD ?? n1.dot(new THREE.Vector3(...fillet.face1Data.center));
                    const d2 = fillet.face2Data.planeD ?? n2.dot(new THREE.Vector3(...fillet.face2Data.center));
                    const dist1 = Math.abs(n1.dot(group.center) - d1);
                    const dist2 = Math.abs(n2.dot(group.center) - d2);
                    if (dist1 < tol && dist2 < tol) {
                      if (!filletMapForLabels.has(fi)) filletMapForLabels.set(fi, []);
                      filletMapForLabels.get(fi)!.push(groupIndex);
                      return;
                    }
                  }
                  return;
                }
                if (cuttingPlanes.length > 0) {
                  for (const plane of cuttingPlanes) {
                    const normalDot = Math.abs(group.normal.dot(plane.normal));
                    if (normalDot < 0.95) continue;
                    const dist = group.center.dot(plane.normal) + plane.constant;
                    if (Math.abs(dist) < 1.0) {
                      if (!subtractorMapForLabels.has(plane.subtractorIndex)) subtractorMapForLabels.set(plane.subtractorIndex, []);
                      subtractorMapForLabels.get(plane.subtractorIndex)!.push(groupIndex);
                      return;
                    }
                  }
                }
                if (!axisCandidatesForLabels.has(axisDir)) axisCandidatesForLabels.set(axisDir, []);
                axisCandidatesForLabels.get(axisDir)!.push(groupIndex);
              });

              const axisSortedForLabels = Array.from(axisCandidatesForLabels.entries()).sort(
                ([a], [b]) => (AXIS_DIRECTION_ORDER[a] ?? 99) - (AXIS_DIRECTION_ORDER[b] ?? 99)
              );

              const faceGroupLabels = new Map<number, { label: string; color: string }>();
              const orderedFaceIndices: number[] = [];

              axisSortedForLabels.forEach(([, groupIndices], roleIdx) => {
                const roleNumber = roleIdx + 1;
                if (groupIndices.length > 1) {
                  groupIndices.forEach((gi, subIdx) => {
                    faceGroupLabels.set(gi, { label: `${roleNumber}-${subIdx + 1}`, color: '#1a1a1a' });
                    orderedFaceIndices.push(gi);
                  });
                } else {
                  faceGroupLabels.set(groupIndices[0], { label: `${roleNumber}`, color: '#1a1a1a' });
                  orderedFaceIndices.push(groupIndices[0]);
                }
              });

              subtractorMapForLabels.forEach((groupIndices, subtractorIdx) => {
                groupIndices.forEach((gi, faceIdx) => {
                  faceGroupLabels.set(gi, { label: `S${subtractorIdx + 1}.${faceIdx + 1}`, color: '#b45000' });
                  orderedFaceIndices.push(gi);
                });
              });

              filletMapForLabels.forEach((groupIndices, filletIdx) => {
                groupIndices.forEach((gi) => {
                  faceGroupLabels.set(gi, { label: `F${filletIdx + 1}`, color: '#006eb4' });
                  orderedFaceIndices.push(gi);
                });
              });

              faceGroups.forEach((_, gi) => {
                if (!orderedFaceIndices.includes(gi)) {
                  orderedFaceIndices.push(gi);
                }
              });

              return (
                <div className={`space-y-0.5 pt-2 border-t border-stone-300 ${isDisabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  {resolving && (
                    <div className="text-[10px] font-normal text-orange-500 animate-pulse mb-1">
                      resolving joints...
                    </div>
                  )}
                  {orderedFaceIndices.map((i) => {
                    const dimensions = getPanelDimensions(i);
                    const isRowSelected = selectedPanelRow === i;
                    const faceLabel = faceGroupLabels.get(i);
                    const labelText = faceLabel?.label ?? `${i + 1}`;
                    const labelColor = faceLabel?.color ?? '#1a1a1a';
                    return (
                      <React.Fragment key={`face-${i}`}>
                        <div
                          ref={(el) => {
                            if (el) rowRefs.current.set(i, el);
                            else rowRefs.current.delete(i);
                          }}
                          className={`flex w-fit gap-0.5 items-center rounded transition-colors ${isRowSelected ? 'bg-red-100 ring-1 ring-red-600' : 'hover:bg-gray-50'} ${facePanels[i] ? 'cursor-pointer' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (facePanels[i]) handleRowClick(i);
                          }}
                        >
                          <input
                            type="radio"
                            name="panel-selection"
                            checked={isRowSelected}
                            disabled={isDisabled || !facePanels[i]}
                            onChange={(e) => {
                              e.stopPropagation();
                              handleRowClick(i);
                            }}
                            className={`w-4 h-4 ${isDisabled || !facePanels[i] ? 'text-stone-300 cursor-not-allowed' : 'text-orange-600 focus:ring-orange-500 cursor-pointer'}`}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <input
                            type="text"
                            value={labelText}
                            readOnly
                            tabIndex={-1}
                            disabled={isDisabled}
                            style={isDisabled ? undefined : { color: labelColor }}
                            className={`w-10 px-1 py-0.5 text-xs font-mono font-bold border rounded text-center ${isDisabled ? 'bg-stone-100 text-stone-400 border-stone-200' : 'bg-white border-gray-300'}`}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <select
                            value={faceRoles[i] || ''}
                            disabled={isDisabled}
                            onClick={(e) => e.stopPropagation()}
                            onChange={async (e) => {
                              const newRole = e.target.value === '' ? null : e.target.value as FaceRole;
                              const newFaceRoles = { ...faceRoles, [i]: newRole };
                              if (newRole === null) {
                                delete newFaceRoles[i];
                              }
                              updateShape(selectedShape.id, { faceRoles: newFaceRoles, faceGroupDescriptors: buildDescriptors() });

                              if (newRole !== null && labelText && !labelText.startsWith('S') && !labelText.startsWith('F')) {
                                faceLabelRoleDefaultsService.upsert(labelText, newRole);
                              }

                              const panelShape = shapes.find(s =>
                                s.type === 'panel' &&
                                s.parameters?.parentShapeId === selectedShape.id &&
                                s.parameters?.faceIndex === i &&
                                !s.parameters?.extraRowId
                              );
                              if (panelShape) {
                                updateShape(panelShape.id, {
                                  parameters: {
                                    ...panelShape.parameters,
                                    faceRole: newRole
                                  }
                                });
                                if (selectedProfile !== 'none') {
                                  setResolving(true);
                                  setShapeRebuilding(selectedShape.id, true);
                                  try {
                                    await rebuildAllPanels(selectedShape.id);
                                    await resolveAllPanelJoints(selectedShape.id, selectedProfile);
                                  } finally {
                                    setResolving(false);
                                    setShapeRebuilding(selectedShape.id, false);
                                  }
                                }
                              }
                            }}
                            style={{ width: '32mm' }}
                            className={`px-1 py-0.5 text-xs border rounded ${isDisabled ? 'bg-stone-100 text-stone-400 border-stone-200' : 'bg-white text-gray-800 border-gray-300'}`}
                          >
                            <option value="">none</option>
                            {roleOptions.map(role => (
                              <option key={role} value={role}>{role}</option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={faceDescriptions[i] || ''}
                            disabled={isDisabled}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              const newDescriptions = { ...faceDescriptions, [i]: e.target.value };
                              updateShape(selectedShape.id, { faceDescriptions: newDescriptions, faceGroupDescriptors: buildDescriptors() });
                            }}
                            placeholder="description"
                            style={{ width: '40mm' }}
                            className={`px-2 py-0.5 text-xs border rounded ${isDisabled ? 'bg-stone-100 text-stone-400 border-stone-200 placeholder:text-stone-300' : 'bg-white text-gray-800 border-gray-300'}`}
                          />
                          <div className="ml-3 flex items-center gap-0.5">
                          <input
                            type="checkbox"
                            checked={facePanels[i] || false}
                            disabled={isDisabled}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => handleTogglePanel(i)}
                            className={`w-4 h-4 border-gray-300 rounded ${isDisabled ? 'text-stone-300 cursor-not-allowed' : 'text-green-600 focus:ring-green-500 cursor-pointer'}`}
                            title={`Toggle panel for face ${labelText}`}
                          />
                          <button
                            disabled={isDisabled || !facePanels[i]}
                            onClick={(e) => {
                              e.stopPropagation();
                              const panelShape = shapes.find(s =>
                                s.type === 'panel' &&
                                s.parameters?.parentShapeId === selectedShape.id &&
                                s.parameters?.faceIndex === i &&
                                !s.parameters?.extraRowId
                              );
                              if (panelShape) {
                                const current = panelShape.parameters?.arrowRotated || false;
                                updateShape(panelShape.id, {
                                  parameters: {
                                    ...panelShape.parameters,
                                    arrowRotated: !current
                                  }
                                });
                              }
                            }}
                            className={`p-0.5 rounded transition-colors ${
                              isDisabled || !facePanels[i]
                                ? 'text-stone-300 cursor-not-allowed'
                                : (() => {
                                    const ps = shapes.find(s =>
                                      s.type === 'panel' &&
                                      s.parameters?.parentShapeId === selectedShape.id &&
                                      s.parameters?.faceIndex === i &&
                                      !s.parameters?.extraRowId
                                    );
                                    return ps?.parameters?.arrowRotated
                                      ? 'text-blue-600 bg-blue-50 hover:bg-blue-100'
                                      : 'text-slate-500 hover:bg-stone-100';
                                  })()
                            }`}
                            title="Rotate arrow direction"
                          >
                            <RotateCw size={13} />
                          </button>
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })}

                  {shapeVirtualFaces.map((vf, vfIdx) => {
                    const virtualPanel = shapes.find(s =>
                      s.type === 'panel' &&
                      s.parameters?.parentShapeId === selectedShape.id &&
                      s.parameters?.virtualFaceId === vf.id
                    );
                    const panelWidth = virtualPanel?.parameters?.width || 0;
                    const panelHeight = virtualPanel?.parameters?.height || 0;
                    const panelDepth = virtualPanel?.parameters?.depth || 0;
                    const arrowRotated = virtualPanel?.parameters?.arrowRotated || false;
                    const isRowSelected = selectedPanelRow === `vf-${vf.id}`;

                    const handleVirtualRowClick = () => {
                      if (!vf.hasPanel) return;
                      setSelectedPanelRow(`vf-${vf.id}`, null, selectedShape.id);
                    };

                    return (
                      <div
                        key={vf.id}
                        className={`flex w-fit gap-0.5 items-center rounded transition-colors ${isRowSelected ? 'bg-red-100 ring-1 ring-red-600' : 'hover:bg-gray-50'} ${vf.hasPanel ? 'cursor-pointer' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (vf.hasPanel) handleVirtualRowClick();
                        }}
                      >
                        <input
                          type="radio"
                          name="panel-selection"
                          checked={isRowSelected}
                          disabled={isDisabled || !vf.hasPanel}
                          onChange={(e) => {
                            e.stopPropagation();
                            handleVirtualRowClick();
                          }}
                          className={`w-4 h-4 ${isDisabled || !vf.hasPanel ? 'text-stone-300 cursor-not-allowed' : 'text-orange-600 focus:ring-orange-500 cursor-pointer'}`}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <input
                          type="text"
                          value={`V${vfIdx + 1}`}
                          readOnly
                          tabIndex={-1}
                          className="w-10 px-1 py-0.5 text-xs font-mono border rounded text-center bg-green-100 text-green-800 border-green-300"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <select
                          value={vf.role || ''}
                          disabled={isDisabled}
                          onClick={(e) => e.stopPropagation()}
                          onChange={async (e) => {
                            const newRole = e.target.value === '' ? null : e.target.value as FaceRole;
                            updateVirtualFace(vf.id, { role: newRole });
                            const virtualPanel = shapes.find(s =>
                              s.type === 'panel' &&
                              s.parameters?.parentShapeId === selectedShape.id &&
                              s.parameters?.virtualFaceId === vf.id
                            );
                            if (virtualPanel) {
                              updateShape(virtualPanel.id, {
                                parameters: { ...virtualPanel.parameters, faceRole: newRole }
                              });
                              if (selectedProfile !== 'none') {
                                setResolving(true);
                                setShapeRebuilding(selectedShape.id, true);
                                try {
                                  await rebuildAllPanels(selectedShape.id);
                                  await resolveAllPanelJoints(selectedShape.id, selectedProfile);
                                } finally {
                                  setResolving(false);
                                  setShapeRebuilding(selectedShape.id, false);
                                }
                              }
                            }
                          }}
                          style={{ width: '32mm' }}
                          className={`px-1 py-0.5 text-xs border rounded ${isDisabled ? 'bg-stone-100 text-stone-400 border-stone-200' : 'bg-white text-gray-800 border-green-300'}`}
                        >
                          <option value="">none</option>
                          {roleOptions.map(role => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={vf.description || ''}
                          disabled={isDisabled}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            updateVirtualFace(vf.id, { description: e.target.value });
                          }}
                          placeholder="description"
                          style={{ width: '40mm' }}
                          className={`px-2 py-0.5 text-xs border rounded ${isDisabled ? 'bg-stone-100 text-stone-400 border-stone-200 placeholder:text-stone-300' : 'bg-white text-gray-800 border-green-300'}`}
                        />
                        <div className="ml-3 flex items-center gap-0.5">
                        <input
                          type="checkbox"
                          checked={vf.hasPanel}
                          disabled={isDisabled}
                          onClick={(e) => e.stopPropagation()}
                          onChange={async () => {
                            if (vf.hasPanel) {
                              removeVirtualPanel(vf.id, vfIdx);
                            } else {
                              await createVirtualPanel(vf.id, vfIdx);
                              if (selectedProfile !== 'none') {
                                setResolving(true);
                                setShapeRebuilding(selectedShape.id, true);
                                try {
                                  await resolveAllPanelJoints(selectedShape.id, selectedProfile);
                                } finally {
                                  setResolving(false);
                                  setShapeRebuilding(selectedShape.id, false);
                                }
                              }
                            }
                          }}
                          className={`w-4 h-4 border-gray-300 rounded ${isDisabled ? 'text-stone-300 cursor-not-allowed' : 'text-green-600 focus:ring-green-500 cursor-pointer'}`}
                          title={`Toggle panel for virtual face V${vfIdx + 1}`}
                        />
                        <button
                          disabled={isDisabled || !vf.hasPanel}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (virtualPanel) {
                              const current = virtualPanel.parameters?.arrowRotated || false;
                              updateShape(virtualPanel.id, {
                                parameters: {
                                  ...virtualPanel.parameters,
                                  arrowRotated: !current
                                }
                              });
                            }
                          }}
                          className={`p-0.5 rounded transition-colors ${
                            isDisabled || !vf.hasPanel
                              ? 'text-stone-300 cursor-not-allowed'
                              : arrowRotated
                              ? 'text-blue-600 bg-blue-50 hover:bg-blue-100'
                              : 'text-slate-500 hover:bg-stone-100'
                          }`}
                          title="Rotate arrow direction"
                        >
                          <RotateCw size={13} />
                        </button>
                        <button
                          disabled={isDisabled}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (vf.hasPanel) removeVirtualPanel(vf.id, vfIdx);
                            deleteVirtualFace(vf.id);
                          }}
                          className="p-0.5 hover:bg-red-100 rounded transition-colors"
                          title="Delete virtual face"
                        >
                          <Trash2 size={13} className="text-red-400" />
                        </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="text-center text-stone-500 text-xs py-4">
            No shape selected
          </div>
        )}
      </div>
      {selectedShape && selectedPanelRow !== null && (() => {
        let dims: { primary: number; secondary: number; thickness: number; w: number; h: number; d: number } | null = null;
        let panelLabel = '';
        let currentPanelId: string | null = null;

        if (typeof selectedPanelRow === 'number') {
          dims = getPanelDimensions(selectedPanelRow);
          const panelShape = shapes.find(s =>
            s.type === 'panel' &&
            s.parameters?.parentShapeId === selectedShape.id &&
            s.parameters?.faceIndex === selectedPanelRow &&
            !s.parameters?.extraRowId
          );
          currentPanelId = panelShape?.id || null;
          panelLabel = panelShape?.parameters?.faceRole ? String(panelShape.parameters.faceRole) : `Face ${selectedPanelRow + 1}`;
        } else if (typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-')) {
          const vfId = selectedPanelRow.replace('vf-', '');
          const vp = shapes.find(s =>
            s.type === 'panel' &&
            s.parameters?.parentShapeId === selectedShape.id &&
            s.parameters?.virtualFaceId === vfId
          );
          if (vp && vp.geometry) {
            const box = new THREE.Box3().setFromBufferAttribute(vp.geometry.getAttribute('position'));
            const size = new THREE.Vector3();
            box.getSize(size);
            const axes = [
              { index: 0, value: size.x },
              { index: 1, value: size.y },
              { index: 2, value: size.z }
            ].sort((a, b) => a.value - b.value);
            const thicknessAxis = axes[0].index;
            const planeAxes = axes.slice(1).map(a => a.index);
            const arrowRotated = vp.parameters?.arrowRotated || false;
            const role = vp.parameters?.faceRole?.toLowerCase();
            let defaultAxis = planeAxes[0];
            let altAxis = planeAxes[1];
            if (role === 'left' || role === 'right') {
              if (planeAxes.includes(1)) { defaultAxis = 1; altAxis = planeAxes.find(a => a !== 1) ?? planeAxes[1]; }
            } else if (role === 'top' || role === 'bottom') {
              if (planeAxes.includes(0)) { defaultAxis = 0; altAxis = planeAxes.find(a => a !== 0) ?? planeAxes[1]; }
            }
            const targetAxis = arrowRotated ? altAxis : defaultAxis;
            const secondaryAxis = planeAxes.find(a => a !== targetAxis) ?? planeAxes[0];
            const sizeByIndex = [size.x, size.y, size.z];
            dims = {
              primary: Math.round(sizeByIndex[targetAxis] * 10) / 10,
              secondary: Math.round(sizeByIndex[secondaryAxis] * 10) / 10,
              thickness: Math.round(sizeByIndex[thicknessAxis] * 10) / 10,
              w: Math.round(size.x * 10) / 10,
              h: Math.round(size.y * 10) / 10,
              d: Math.round(size.z * 10) / 10,
            };
          }
          currentPanelId = vp?.id || null;
          panelLabel = vp?.parameters?.faceRole ? String(vp.parameters.faceRole) : 'Virtual Panel';
        }

        if (!dims) return null;
        const isExtrudeActive = faceExtrudeMode && currentPanelId !== null;
        const showExtrudeControls = isExtrudeActive;
        const currentPanel = currentPanelId ? shapes.find(s => s.id === currentPanelId) : null;
        const extrudeSteps = currentPanel?.parameters?.extrudeSteps || [];

        return (
          <div className="border-t border-orange-200 bg-orange-50 px-3 py-2 rounded-b-lg">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-stone-400 font-medium uppercase tracking-wide">W</span>
                <span className="text-xs font-bold text-slate-800 font-mono">{dims.primary}</span>
              </div>
              <div className="w-px h-4 bg-orange-200 shrink-0" />
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-stone-400 font-medium uppercase tracking-wide">H</span>
                <span className="text-xs font-bold text-slate-800 font-mono">{dims.secondary}</span>
              </div>
              <div className="w-px h-4 bg-orange-200 shrink-0" />
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-stone-400 font-medium uppercase tracking-wide">T</span>
                <span className="text-xs font-bold text-slate-800 font-mono">{dims.thickness}</span>
              </div>
              {showExtrudeControls && (
                <>
                  <div className="w-px h-4 bg-orange-200 shrink-0" />
                  <input
                    type="text"
                    inputMode="numeric"
                    value={faceExtrudeThickness}
                    onChange={(e) => setFaceExtrudeThickness(Number(e.target.value) || 0)}
                    disabled={faceExtrudeSelectedFace === null}
                    className={`w-14 h-6 px-1 text-xs font-mono text-center border rounded focus:outline-none focus:border-orange-500 ${faceExtrudeSelectedFace !== null ? 'bg-white border-orange-300' : 'bg-orange-100 border-orange-200 text-orange-300 cursor-not-allowed'}`}
                  />
                  <div className={`flex rounded overflow-hidden border shrink-0 ${faceExtrudeSelectedFace !== null ? 'border-orange-300' : 'border-orange-200 opacity-40'}`}>
                    <button
                      disabled={faceExtrudeSelectedFace === null}
                      onClick={() => setFaceExtrudeFixedMode(true)}
                      className={`px-1.5 h-6 text-[10px] font-semibold transition-colors ${faceExtrudeFixedMode ? 'bg-orange-500 text-white' : 'bg-white text-orange-600 hover:bg-orange-50'}`}
                    >Fix</button>
                    <button
                      disabled={faceExtrudeSelectedFace === null}
                      onClick={() => setFaceExtrudeFixedMode(false)}
                      className={`px-1.5 h-6 text-[10px] font-semibold border-l border-orange-300 transition-colors ${!faceExtrudeFixedMode ? 'bg-orange-500 text-white' : 'bg-white text-orange-600 hover:bg-orange-50'}`}
                    >Din</button>
                  </div>
                </>
              )}
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (faceExtrudeMode) {
                      setFaceExtrudeMode(false);
                    } else if (currentPanelId) {
                      setFaceExtrudeTargetPanelId(currentPanelId);
                      setFaceExtrudeMode(true);
                    }
                  }}
                  className={`flex items-center justify-center w-6 h-6 rounded border transition-colors shrink-0 ${
                    isExtrudeActive
                      ? 'border-orange-500 bg-orange-500 text-white shadow-sm'
                      : 'border-orange-300 bg-white hover:bg-orange-100 text-orange-600'
                  }`}
                  title="Face Extrude"
                >
                  <MoveVertical size={12} />
                </button>
                {showExtrudeControls && (
                  <button
                    disabled={faceExtrudeSelectedFace === null}
                    onClick={async () => {
                      if (faceExtrudeSelectedFace === null || !currentPanelId) return;
                      const panelShape = shapes.find(s => s.id === currentPanelId);
                      if (!panelShape) return;
                      const { executeFaceExtrude } = await import('./FaceExtrudeService');
                      await executeFaceExtrude({
                        panelShape,
                        faceGroupIndex: faceExtrudeSelectedFace,
                        value: faceExtrudeThickness,
                        isFixed: faceExtrudeFixedMode,
                        shapes,
                        updateShape,
                      });
                      setFaceExtrudeSelectedFace(null);
                    }}
                    className={`flex items-center justify-center w-6 h-6 rounded border transition-colors shrink-0 ${faceExtrudeSelectedFace !== null ? 'border-green-400 bg-green-500 text-white hover:bg-green-600' : 'border-orange-200 bg-orange-100 text-orange-300 cursor-not-allowed'}`}
                    title="Onayla"
                  >
                    <Check size={12} />
                  </button>
                )}
              </div>
            </div>
            {extrudeSteps.length > 0 && (
              <div className="mt-1.5 border-t border-orange-200 pt-1.5 space-y-1">
                {extrudeSteps.map((step: any) => (
                  <div
                    key={step.id}
                    className="flex items-center gap-1.5 group"
                  >
                    <span className="text-[9px] font-bold text-orange-600 bg-orange-200 rounded px-1 py-0.5 font-mono min-w-[24px] text-center">{step.axisLabel}</span>
                    {editingStepId === step.id ? (
                      <>
                        <input
                          type="text"
                          inputMode="numeric"
                          autoFocus
                          value={editingStepValue}
                          onChange={(e) => setEditingStepValue(Number(e.target.value) || 0)}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter') {
                              if (!currentPanelId) return;
                              const ps = shapes.find(s => s.id === currentPanelId);
                              if (!ps) return;
                              const { updateExtrudeStep } = await import('./FaceExtrudeService');
                              await updateExtrudeStep(ps, step.id, editingStepValue, updateShape);
                              setEditingStepId(null);
                            } else if (e.key === 'Escape') {
                              setEditingStepId(null);
                            }
                          }}
                          className="w-14 h-5 px-1 text-[10px] font-mono text-center border border-orange-400 rounded bg-white focus:outline-none focus:border-orange-500"
                        />
                        <span className="text-[9px] text-stone-400">{step.isFixed ? 'Fix' : 'Din'}</span>
                        <button
                          onClick={async () => {
                            if (!currentPanelId) return;
                            const ps = shapes.find(s => s.id === currentPanelId);
                            if (!ps) return;
                            const { updateExtrudeStep } = await import('./FaceExtrudeService');
                            await updateExtrudeStep(ps, step.id, editingStepValue, updateShape);
                            setEditingStepId(null);
                          }}
                          className="flex items-center justify-center w-5 h-5 rounded border border-green-400 bg-green-500 text-white hover:bg-green-600 transition-colors"
                          title="Kaydet"
                        >
                          <Check size={10} />
                        </button>
                        <button
                          onClick={() => setEditingStepId(null)}
                          className="flex items-center justify-center w-5 h-5 rounded border border-stone-300 bg-white text-stone-500 hover:bg-stone-100 transition-colors"
                          title="Iptal"
                        >
                          <X size={10} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="text-[10px] font-mono text-slate-700 font-semibold">{step.value}</span>
                        <span className="text-[9px] text-stone-400">{step.isFixed ? 'Fix' : 'Din'}</span>
                        <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => {
                              setEditingStepId(step.id);
                              setEditingStepValue(step.value);
                            }}
                            className="flex items-center justify-center w-5 h-5 rounded border border-orange-300 bg-white text-orange-500 hover:bg-orange-100 transition-colors"
                            title="Duzenle"
                          >
                            <Pencil size={9} />
                          </button>
                          <button
                            onClick={async () => {
                              if (!currentPanelId) return;
                              const ps = shapes.find(s => s.id === currentPanelId);
                              if (!ps) return;
                              const { deleteExtrudeStep } = await import('./FaceExtrudeService');
                              await deleteExtrudeStep(ps, step.id, updateShape);
                            }}
                            className="flex items-center justify-center w-5 h-5 rounded border border-red-300 bg-white text-red-500 hover:bg-red-50 transition-colors"
                            title="Sil"
                          >
                            <Trash2 size={9} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
