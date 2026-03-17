import React, { useState, useEffect, useMemo } from 'react';
import { X, GripVertical, Plus, Check, Trash2 } from 'lucide-react';
import { useAppStore } from '../store';
import type { FaceRole } from '../store';
import * as THREE from 'three';
import { evaluateExpression } from './Expression';
import { applyShapeChanges, applySubtractionChanges } from './ShapeUpdaterService';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';
import type { FilletData } from './Fillet';

interface CustomParameter {
  id: string;
  name: string;
  expression: string;
  result: number;
  description: string;
}

interface ParametersPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SubtractionParam {
  expression: string;
  result: number;
}

interface ParameterRowProps {
  label: string;
  value: number;
  onChange?: (value: number) => void;
  display?: string;
  description: string;
  step?: number;
  readOnly?: boolean;
}

const ParameterRow: React.FC<ParameterRowProps> = ({
  label,
  value,
  onChange,
  display,
  description,
  step = 1,
  readOnly = false
}) => {
  const [inputValue, setInputValue] = useState(value.toString());
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setInputValue(value.toString());
    }
  }, [value, isFocused]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);

    if (onChange && !readOnly) {
      if (newValue === '' || newValue === '-' || newValue === '+' || newValue === '.') {
        return;
      }
      const parsed = parseFloat(newValue);
      if (!isNaN(parsed)) {
        onChange(parsed);
      }
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (onChange && !readOnly) {
      const parsed = parseFloat(inputValue);
      if (isNaN(parsed)) {
        setInputValue(value.toString());
      } else {
        onChange(parsed);
        setInputValue(parsed.toString());
      }
    }
  };

  return (
    <div className="flex gap-0.5 items-center">
      <input
        type="text"
        value={label}
        readOnly
        tabIndex={-1}
        className="w-10 px-1 py-0.5 text-xs font-mono bg-white text-gray-800 border border-gray-300 rounded text-center"
      />
      <input
        type="text"
        value={inputValue}
        onChange={handleChange}
        onFocus={() => setIsFocused(true)}
        onBlur={handleBlur}
        readOnly={readOnly}
        className={`w-16 px-1 py-0.5 text-xs font-mono border rounded text-left ${
          readOnly ? 'bg-white text-gray-400' : 'bg-white text-gray-800'
        } border-gray-300`}
      />
      <input
        type="text"
        value={display ?? value.toFixed(2)}
        readOnly
        tabIndex={-1}
        className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-400 border border-gray-300 rounded text-left"
      />
      <input
        type="text"
        value={description}
        readOnly
        tabIndex={-1}
        className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-600 border border-gray-300 rounded"
      />
    </div>
  );
};

export function ParametersPanel({ isOpen, onClose }: ParametersPanelProps) {
  const {
    selectedShapeId,
    shapes,
    updateShape,
    vertexEditMode,
    setVertexEditMode,
    subtractionViewMode,
    setSubtractionViewMode,
    selectedSubtractionIndex,
    setSelectedSubtractionIndex,
    deleteSubtraction,
    setShowParametersPanel,
    filletMode,
    setFilletMode,
    faceEditMode,
    setFaceEditMode,
    selectedFilletFaces,
    clearFilletFaces,
    clearFilletFaceData,
    roleEditMode,
    setRoleEditMode,
    updateFaceRole,
    backPanelLeftExtend,
    setBackPanelLeftExtend,
    showBackPanelLeftExtend,
    setShowBackPanelLeftExtend,
    backPanelRightExtend,
    setBackPanelRightExtend,
    showBackPanelRightExtend,
    setShowBackPanelRightExtend,
    recalculateVirtualFacesForShape
  } = useAppStore();

  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const renderSubtractionParamRow = (
    label: string,
    param: SubtractionParam,
    paramKey: string,
    description: string,
    onSubParamChange: (param: string, expression: string) => void
  ) => {
    return (
      <div key={paramKey} className="flex gap-0.5 items-center">
        <input
          type="text"
          value={label}
          readOnly
          tabIndex={-1}
          className="w-10 px-1 py-0.5 text-xs font-mono bg-white text-gray-800 border border-gray-300 rounded text-center"
        />
        <input
          type="text"
          value={param.expression}
          onChange={(e) => onSubParamChange(paramKey, e.target.value)}
          className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-800 border border-gray-300 rounded"
          placeholder="expr"
        />
        <input
          type="text"
          value={param.result.toFixed(2)}
          readOnly
          tabIndex={-1}
          className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-400 border border-gray-300 rounded text-left"
        />
        <input
          type="text"
          value={description}
          readOnly
          tabIndex={-1}
          className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-600 border border-gray-300 rounded"
        />
      </div>
    );
  };

  const handleClose = () => {
    setSubtractionViewMode(false);
    setVertexEditMode(false);
    setFilletMode(false);
    setFaceEditMode(false);
    setRoleEditMode(false);
    clearFilletFaces();
    clearFilletFaceData();
    setSelectedSubtractionIndex(null);
    setShowParametersPanel(false);
    onClose();
  };

  const selectedShape = shapes.find((s) => s.id === selectedShapeId);

  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [depth, setDepth] = useState(0);
  const [rotX, setRotX] = useState(0);
  const [rotY, setRotY] = useState(0);
  const [rotZ, setRotZ] = useState(0);
  const [customParameters, setCustomParameters] = useState<CustomParameter[]>([]);
  const [vertexModifications, setVertexModifications] = useState<any[]>([]);
  const [filletRadii, setFilletRadii] = useState<number[]>([]);

  const [subParams, setSubParams] = useState({
    width: { expression: '0', result: 0 },
    height: { expression: '0', result: 0 },
    depth: { expression: '0', result: 0 },
    posX: { expression: '0', result: 0 },
    posY: { expression: '0', result: 0 },
    posZ: { expression: '0', result: 0 },
    rotX: { expression: '0', result: 0 },
    rotY: { expression: '0', result: 0 },
    rotZ: { expression: '0', result: 0 }
  });

  useEffect(() => {
    if (selectedShape && selectedShape.parameters) {
      setWidth(selectedShape.parameters.width || 0);
      setHeight(selectedShape.parameters.height || 0);
      setDepth(selectedShape.parameters.depth || 0);
      setRotX((selectedShape.rotation?.[0] || 0) * (180 / Math.PI));
      setRotY((selectedShape.rotation?.[1] || 0) * (180 / Math.PI));
      setRotZ((selectedShape.rotation?.[2] || 0) * (180 / Math.PI));
      setCustomParameters(selectedShape.parameters.customParameters || []);
      setVertexModifications(selectedShape.vertexModifications || []);
      setFilletRadii((selectedShape.fillets || []).map(f => f.radius));
    } else {
      setWidth(0);
      setHeight(0);
      setDepth(0);
      setRotX(0);
      setRotY(0);
      setRotZ(0);
      setCustomParameters([]);
      setVertexModifications([]);
      setFilletRadii([]);
    }
  }, [selectedShape, selectedShapeId, shapes]);

  useEffect(() => {
    const handleBottomPanelSelection = async () => {
      if (
        selectedShape &&
        selectedShape.type === 'panel' &&
        selectedShape.parameters?.faceRole === 'Bottom' &&
        selectedShape.parameters?.parentShapeId
      ) {
        const { globalSettingsService } = await import('./GlobalSettingsDatabase');
        const { resolveAllPanelJoints } = await import('./PanelJointService');

        const defaultProfile = await globalSettingsService.getDefaultProfile();
        if (defaultProfile) {
          const { setShapeRebuilding } = useAppStore.getState();
          const parentId = selectedShape.parameters.parentShapeId;
          setShapeRebuilding(parentId, true);
          try {
            await resolveAllPanelJoints(parentId, defaultProfile.id);
          } finally {
            setShapeRebuilding(parentId, false);
          }
        }
      }
    };

    handleBottomPanelSelection();
  }, [selectedShapeId]);

  useEffect(() => {
    if (selectedShape && selectedSubtractionIndex !== null && selectedShape.subtractionGeometries) {
      const subtraction = selectedShape.subtractionGeometries[selectedSubtractionIndex];
      if (subtraction && subtraction !== null) {
        const round = (n: number) => Math.round(n * 100) / 100;

        const evalContext = {
          W: width,
          H: height,
          D: depth,
          ...customParameters.reduce((acc, param) => ({ ...acc, [param.name]: param.result }), {})
        };

        if (subtraction.parameters) {
          setSubParams({
            width: {
              expression: subtraction.parameters.width,
              result: evaluateExpression(subtraction.parameters.width, evalContext)
            },
            height: {
              expression: subtraction.parameters.height,
              result: evaluateExpression(subtraction.parameters.height, evalContext)
            },
            depth: {
              expression: subtraction.parameters.depth,
              result: evaluateExpression(subtraction.parameters.depth, evalContext)
            },
            posX: {
              expression: subtraction.parameters.posX,
              result: evaluateExpression(subtraction.parameters.posX, evalContext)
            },
            posY: {
              expression: subtraction.parameters.posY,
              result: evaluateExpression(subtraction.parameters.posY, evalContext)
            },
            posZ: {
              expression: subtraction.parameters.posZ,
              result: evaluateExpression(subtraction.parameters.posZ, evalContext)
            },
            rotX: {
              expression: subtraction.parameters.rotX,
              result: evaluateExpression(subtraction.parameters.rotX, evalContext)
            },
            rotY: {
              expression: subtraction.parameters.rotY,
              result: evaluateExpression(subtraction.parameters.rotY, evalContext)
            },
            rotZ: {
              expression: subtraction.parameters.rotZ,
              result: evaluateExpression(subtraction.parameters.rotZ, evalContext)
            }
          });
        } else {
          const box = new THREE.Box3().setFromBufferAttribute(
            subtraction.geometry.attributes.position as THREE.BufferAttribute
          );
          const size = new THREE.Vector3();
          box.getSize(size);

          const w = round(size.x);
          const h = round(size.y);
          const d = round(size.z);
          const localPx = round(subtraction.relativeOffset[0]);
          const localPy = round(subtraction.relativeOffset[1]);
          const localPz = round(subtraction.relativeOffset[2]);
          const rx = round((subtraction.relativeRotation?.[0] || 0) * (180 / Math.PI));
          const ry = round((subtraction.relativeRotation?.[1] || 0) * (180 / Math.PI));
          const rz = round((subtraction.relativeRotation?.[2] || 0) * (180 / Math.PI));

          setSubParams({
            width: { expression: String(w), result: w },
            height: { expression: String(h), result: h },
            depth: { expression: String(d), result: d },
            posX: { expression: String(localPx), result: localPx },
            posY: { expression: String(localPy), result: localPy },
            posZ: { expression: String(localPz), result: localPz },
            rotX: { expression: String(rx), result: rx },
            rotY: { expression: String(ry), result: ry },
            rotZ: { expression: String(rz), result: rz }
          });
        }
      }
    }
  }, [selectedShape?.id, selectedSubtractionIndex, selectedShape?.subtractionGeometries?.length, width, height, depth, customParameters]);

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

  const handleDimensionChange = (dimension: 'width' | 'height' | 'depth', value: number) => {
    if (dimension === 'width') setWidth(value);
    if (dimension === 'height') setHeight(value);
    if (dimension === 'depth') setDepth(value);
  };

  const handleSubParamChange = (param: string, expression: string) => {
    const evalContext = {
      W: width,
      H: height,
      D: depth,
      ...customParameters.reduce((acc, p) => ({ ...acc, [p.name]: p.result }), {})
    };

    const result = evaluateExpression(expression, evalContext);

    setSubParams(prev => ({
      ...prev,
      [param]: { expression, result }
    }));
  };

  const addCustomParameter = () => {
    const newParam: CustomParameter = {
      id: `param-${Date.now()}`,
      name: `P${customParameters.length + 1}`,
      expression: '0',
      result: 0,
      description: 'Custom Parameter'
    };
    const updatedParams = [...customParameters, newParam];
    setCustomParameters(updatedParams);

    if (selectedShape) {
      updateShape(selectedShape.id, {
        parameters: { ...selectedShape.parameters, customParameters: updatedParams }
      });
    }
  };

  const updateCustomParameter = (id: string, field: keyof CustomParameter, value: string) => {
    const evalContext = {
      W: width,
      H: height,
      D: depth,
      ...customParameters.reduce((acc, param) => ({ ...acc, [param.name]: param.result }), {})
    };

    const updatedParams = customParameters.map((param) => {
      if (param.id !== id) return param;
      const updated = { ...param, [field]: value };
      if (field === 'expression') {
        updated.result = evaluateExpression(value, evalContext);
      }
      return updated;
    });
    setCustomParameters(updatedParams);
  };

  const deleteCustomParameter = (id: string) => {
    const updatedParams = customParameters.filter((param) => param.id !== id);
    setCustomParameters(updatedParams);

    if (selectedShape) {
      updateShape(selectedShape.id, {
        parameters: { ...selectedShape.parameters, customParameters: updatedParams }
      });
    }
  };

  const updateVertexModification = (index: number, field: string, value: any) => {
    const evalContext = {
      W: width,
      H: height,
      D: depth,
      ...customParameters.reduce((acc, param) => {
        acc[param.name] = param.result;
        return acc;
      }, {} as Record<string, number>)
    };

    const updatedMods = vertexModifications.map((mod, idx) => {
      if (idx !== index) return mod;

      const updated = { ...mod, [field]: value };

      if (field === 'expression') {
        const result = evaluateExpression(value, evalContext);

        const directionMultiplier = mod.direction.includes('-') ? -1 : 1;
        const axis = mod.direction[0];

        let newOffset: [number, number, number] = [0, 0, 0];
        if (axis === 'x') {
          newOffset = [result * directionMultiplier, 0, 0];
        } else if (axis === 'y') {
          newOffset = [0, result * directionMultiplier, 0];
        } else if (axis === 'z') {
          newOffset = [0, 0, result * directionMultiplier];
        }

        updated.offset = newOffset;
        updated.newPosition = [
          mod.originalPosition[0] + newOffset[0],
          mod.originalPosition[1] + newOffset[1],
          mod.originalPosition[2] + newOffset[2]
        ];
      }

      return updated;
    });

    setVertexModifications(updatedMods);
  };

  const handleApplyChanges = async () => {
    const currentState = useAppStore.getState();
    const currentShape = currentState.shapes.find(s => s.id === selectedShapeId);
    if (!currentShape) return;

    const currentPosition: [number, number, number] = [
      currentShape.position[0],
      currentShape.position[1],
      currentShape.position[2]
    ];

    console.log('📍 Apply Changes - Reading CURRENT position from store:', currentPosition);
    console.log('📍 Shape ID:', currentShape.id);

    const evalContext = {
      W: width,
      H: height,
      D: depth,
      ...customParameters.reduce((acc, p) => ({ ...acc, [p.name]: p.result }), {})
    };

    const evaluatedSubParams = {
      width: { expression: subParams.width.expression, result: evaluateExpression(subParams.width.expression, evalContext) },
      height: { expression: subParams.height.expression, result: evaluateExpression(subParams.height.expression, evalContext) },
      depth: { expression: subParams.depth.expression, result: evaluateExpression(subParams.depth.expression, evalContext) },
      posX: { expression: subParams.posX.expression, result: evaluateExpression(subParams.posX.expression, evalContext) },
      posY: { expression: subParams.posY.expression, result: evaluateExpression(subParams.posY.expression, evalContext) },
      posZ: { expression: subParams.posZ.expression, result: evaluateExpression(subParams.posZ.expression, evalContext) },
      rotX: { expression: subParams.rotX.expression, result: evaluateExpression(subParams.rotX.expression, evalContext) },
      rotY: { expression: subParams.rotY.expression, result: evaluateExpression(subParams.rotY.expression, evalContext) },
      rotZ: { expression: subParams.rotZ.expression, result: evaluateExpression(subParams.rotZ.expression, evalContext) }
    };

    await applyShapeChanges({
      selectedShape: { ...currentShape, position: currentPosition },
      width,
      height,
      depth,
      rotX,
      rotY,
      rotZ,
      customParameters,
      vertexModifications,
      filletRadii,
      selectedSubtractionIndex,
      subWidth: evaluatedSubParams.width.result,
      subHeight: evaluatedSubParams.height.result,
      subDepth: evaluatedSubParams.depth.result,
      subPosX: evaluatedSubParams.posX.result,
      subPosY: evaluatedSubParams.posY.result,
      subPosZ: evaluatedSubParams.posZ.result,
      subRotX: evaluatedSubParams.rotX.result,
      subRotY: evaluatedSubParams.rotY.result,
      subRotZ: evaluatedSubParams.rotZ.result,
      subParams: evaluatedSubParams,
      updateShape
    });

    if (selectedShapeId) recalculateVirtualFacesForShape(selectedShapeId);
    console.log('✅ Apply Changes completed');
  };

  const handleApplySubtractionChanges = async (shapeOverride?: any) => {
    await applySubtractionChanges({
      selectedShapeId,
      selectedSubtractionIndex,
      shapes,
      subWidth,
      subHeight,
      subDepth,
      subPosX,
      subPosY,
      subPosZ,
      subRotX,
      subRotY,
      subRotZ,
      updateShape,
      shapeOverride
    });
    if (selectedShapeId) recalculateVirtualFacesForShape(selectedShapeId);
  };

  const handleDeleteFillet = async (filletIndex: number) => {
    const currentState = useAppStore.getState();
    const currentShape = currentState.shapes.find(s => s.id === selectedShapeId);
    if (!currentShape) return;

    console.log(`🗑️ Deleting fillet #${filletIndex + 1} from shape ${currentShape.id}`);

    const newFillets = (currentShape.fillets || []).filter((_: any, idx: number) => idx !== filletIndex);
    const newFilletRadii = filletRadii.filter((_, idx) => idx !== filletIndex);

    try {
      const { createReplicadBox, performBooleanCut, convertReplicadToThreeGeometry } = await import('./ReplicadService');
      const { getReplicadVertices } = await import('./VertexEditorService');
      const { applyFillets, updateFilletCentersForNewGeometry } = await import('./ShapeUpdaterService');

      let baseShape = await createReplicadBox({
        width,
        height,
        depth
      });

      if (currentShape.subtractionGeometries && currentShape.subtractionGeometries.length > 0) {
        console.log('🔄 Reapplying subtractions after fillet deletion...');

        for (let i = 0; i < currentShape.subtractionGeometries.length; i++) {
          const subtraction = currentShape.subtractionGeometries[i];
          if (!subtraction) continue;

          const subBox = new THREE.Box3().setFromBufferAttribute(
            subtraction.geometry.getAttribute('position')
          );
          const subSize = new THREE.Vector3();
          subBox.getSize(subSize);

          const subShape = await createReplicadBox({
            width: subSize.x,
            height: subSize.y,
            depth: subSize.z
          });

          baseShape = await performBooleanCut(
            baseShape,
            subShape,
            undefined,
            subtraction.relativeOffset,
            undefined,
            subtraction.relativeRotation || [0, 0, 0],
            undefined,
            subtraction.scale || [1, 1, 1]
          );
        }
      }

      let finalGeometry = convertReplicadToThreeGeometry(baseShape);
      let finalBaseVertices = await getReplicadVertices(baseShape);
      let finalShape = baseShape;
      let updatedFillets = newFillets;

      if (newFillets.length > 0) {
        console.log('🔄 Updating remaining fillet centers after deletion...');
        updatedFillets = await updateFilletCentersForNewGeometry(newFillets, finalGeometry, { width, height, depth });

        console.log('🔵 Reapplying remaining fillets...');
        finalShape = await applyFillets(finalShape, updatedFillets, { width, height, depth });
        finalGeometry = convertReplicadToThreeGeometry(finalShape);
        finalBaseVertices = await getReplicadVertices(finalShape);
      }

      const preservedPosition: [number, number, number] = [
        currentShape.position[0],
        currentShape.position[1],
        currentShape.position[2]
      ];
      console.log('📍 Preserving position after fillet delete (new array):', preservedPosition);

      updateShape(currentShape.id, {
        geometry: finalGeometry,
        replicadShape: finalShape,
        fillets: updatedFillets,
        position: preservedPosition,
        parameters: {
          ...currentShape.parameters,
          scaledBaseVertices: finalBaseVertices.map(v => [v.x, v.y, v.z])
        }
      });

      setFilletRadii(newFilletRadii);

      console.log('✅ Fillet deleted and shape updated, position preserved');
    } catch (error) {
      console.error('❌ Failed to delete fillet:', error);
    }
  };

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
          <span className="text-sm font-semibold text-slate-800">Parameters</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setVertexEditMode(!vertexEditMode);
              if (!vertexEditMode) {
                setFilletMode(false);
                setFaceEditMode(false);
                setRoleEditMode(false);
              }
            }}
            className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
              vertexEditMode
                ? 'bg-orange-600 text-white'
                : 'bg-stone-200 text-slate-700 hover:bg-stone-300'
            }`}
            title="Edit Vertices"
          >
            VERTEX
          </button>
          <button
            onClick={() => {
              setRoleEditMode(!roleEditMode);
              if (!roleEditMode) {
                setVertexEditMode(false);
                setFilletMode(false);
                setFaceEditMode(false);
              }
            }}
            className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
              roleEditMode
                ? 'bg-purple-600 text-white'
                : 'bg-stone-200 text-slate-700 hover:bg-stone-300'
            }`}
            title="Assign Face Roles"
          >
            ROLE
          </button>
          {selectedShape?.subtractionGeometries && selectedShape.subtractionGeometries.filter(s => s !== null).length > 0 && (
            <button
              onClick={() => {
                setSubtractionViewMode(!subtractionViewMode);
                if (!subtractionViewMode) {
                  setFilletMode(false);
                  setFaceEditMode(false);
                }
              }}
              className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                subtractionViewMode
                  ? 'bg-yellow-500 text-white'
                  : 'bg-stone-200 text-slate-700 hover:bg-stone-300'
              }`}
              title={`Show ${selectedShape.subtractionGeometries.filter(s => s !== null).length} Subtraction Geometr${selectedShape.subtractionGeometries.filter(s => s !== null).length > 1 ? 'ies' : 'y'}`}
            >
              SUB ({selectedShape.subtractionGeometries.filter(s => s !== null).length})
            </button>
          )}
          <button
            onClick={() => {
              const newFilletMode = !filletMode;
              setFilletMode(newFilletMode);
              setFaceEditMode(newFilletMode);
              clearFilletFaces();
              clearFilletFaceData();
              if (newFilletMode) {
                setVertexEditMode(false);
                setSubtractionViewMode(false);
              }
              console.log(`🔄 Fillet mode: ${newFilletMode ? 'ON' : 'OFF'}`);
            }}
            className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
              filletMode
                ? 'bg-blue-600 text-white'
                : 'bg-stone-200 text-slate-700 hover:bg-stone-300'
            }`}
            title="Fillet Mode - Select 2 faces"
          >
            FILLET {selectedFilletFaces.length > 0 && `(${selectedFilletFaces.length}/2)`}
          </button>
          <button
            onClick={addCustomParameter}
            className="p-0.5 hover:bg-stone-200 rounded transition-colors"
            title="Add Parameter"
          >
            <Plus size={14} className="text-stone-600" />
          </button>
          <button
            onClick={handleClose}
            className="p-0.5 hover:bg-stone-200 rounded transition-colors"
          >
            <X size={14} className="text-stone-600" />
          </button>
        </div>
      </div>

      <div className="p-3 max-h-[calc(100vh-200px)] overflow-y-auto">
        {selectedShape ? (
          <div className="space-y-0.5">
            <div className="space-y-0.5">
              <ParameterRow
                label="W"
                value={width}
                onChange={(v) => handleDimensionChange('width', v)}
                description="Width"
              />
              <ParameterRow
                label="H"
                value={height}
                onChange={(v) => handleDimensionChange('height', v)}
                description="Height"
              />
              <ParameterRow
                label="D"
                value={depth}
                onChange={(v) => handleDimensionChange('depth', v)}
                description="Depth"
              />
              <ParameterRow
                label="RX"
                value={rotX}
                onChange={setRotX}
                display={rotX.toFixed(1) + '°'}
                description="Rotation X"
                step={1}
              />
              <ParameterRow
                label="RY"
                value={rotY}
                onChange={setRotY}
                display={rotY.toFixed(1) + '°'}
                description="Rotation Y"
                step={1}
              />
              <ParameterRow
                label="RZ"
                value={rotZ}
                onChange={setRotZ}
                display={rotZ.toFixed(1) + '°'}
                description="Rotation Z"
                step={1}
              />

              {showBackPanelLeftExtend && (
                <div className="flex gap-0.5 items-center">
                  <input
                    type="text"
                    value="BPL"
                    readOnly
                    tabIndex={-1}
                    className="w-10 px-1 py-0.5 text-xs font-mono bg-orange-100 text-orange-800 border border-orange-300 rounded text-center"
                  />
                  <input
                    type="number"
                    value={backPanelLeftExtend}
                    onChange={(e) => setBackPanelLeftExtend(Number(e.target.value))}
                    className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-800 border border-orange-300 rounded text-left [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <input
                    type="text"
                    value={backPanelLeftExtend.toFixed(2)}
                    readOnly
                    tabIndex={-1}
                    className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-400 border border-gray-300 rounded text-left"
                  />
                  <input
                    type="text"
                    value="Back panel left extend"
                    readOnly
                    tabIndex={-1}
                    className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-600 border border-gray-300 rounded"
                  />
                  <button
                    onClick={() => {
                      setShowBackPanelLeftExtend(false);
                      setBackPanelLeftExtend(0);
                    }}
                    className="p-0.5 hover:bg-red-100 rounded transition-colors"
                    title="Remove"
                  >
                    <X size={12} className="text-red-600" />
                  </button>
                </div>
              )}

              {showBackPanelRightExtend && (
                <div className="flex gap-0.5 items-center">
                  <input
                    type="text"
                    value="BPR"
                    readOnly
                    tabIndex={-1}
                    className="w-10 px-1 py-0.5 text-xs font-mono bg-orange-100 text-orange-800 border border-orange-300 rounded text-center"
                  />
                  <input
                    type="number"
                    value={backPanelRightExtend}
                    onChange={(e) => setBackPanelRightExtend(Number(e.target.value))}
                    className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-800 border border-orange-300 rounded text-left [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <input
                    type="text"
                    value={backPanelRightExtend.toFixed(2)}
                    readOnly
                    tabIndex={-1}
                    className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-400 border border-gray-300 rounded text-left"
                  />
                  <input
                    type="text"
                    value="Back panel right extend"
                    readOnly
                    tabIndex={-1}
                    className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-600 border border-gray-300 rounded"
                  />
                  <button
                    onClick={() => {
                      setShowBackPanelRightExtend(false);
                      setBackPanelRightExtend(0);
                    }}
                    className="p-0.5 hover:bg-red-100 rounded transition-colors"
                    title="Remove"
                  >
                    <X size={12} className="text-red-600" />
                  </button>
                </div>
              )}
            </div>

            {filletRadii.length > 0 && (
              <div className="space-y-0.5 pt-2 border-t border-stone-300">
                {filletRadii.map((radius, idx) => (
                  <div key={`fillet-${idx}`} className="flex gap-0.5 items-center">
                    <div className="flex-1">
                      <ParameterRow
                        label={`F${idx + 1}`}
                        value={radius}
                        onChange={(newRadius) => {
                          const newRadii = [...filletRadii];
                          newRadii[idx] = newRadius;
                          setFilletRadii(newRadii);
                        }}
                        description={`Fillet ${idx + 1} Radius`}
                        step={0.1}
                      />
                    </div>
                    <button
                      onClick={async () => {
                        if (selectedShape) {
                          await handleDeleteFillet(idx);
                        }
                      }}
                      className="p-0.5 hover:bg-red-100 rounded transition-colors"
                      title="Delete fillet"
                    >
                      <Trash2 size={12} className="text-red-600" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {roleEditMode && selectedShape && (() => {
              const geometry = selectedShape.geometry;
              if (!geometry) return null;

              const faces = extractFacesFromGeometry(geometry);
              const faceGroups = groupCoplanarFaces(faces);
              const faceRoles = selectedShape.faceRoles || {};
              const faceDescriptions = selectedShape.faceDescriptions || {};
              const roleOptions: FaceRole[] = ['Left', 'Right', 'Top', 'Bottom', 'Back', 'Door'];
              const fillets: FilletData[] = selectedShape.fillets || [];

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

              const bbox = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
              const subtractionGeometries: Array<any> = selectedShape.subtractionGeometries || [];

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
                for (let i = 0; i < 6; i++) {
                  const pos = facePlanePositions[i];
                  const axisIdx = Math.floor(i / 2);
                  const minVal = axisIdx === 0 ? bbox.min.x : axisIdx === 1 ? bbox.min.y : bbox.min.z;
                  const maxVal = axisIdx === 0 ? bbox.max.x : axisIdx === 1 ? bbox.max.y : bbox.max.z;
                  if (pos > minVal + 1.0 && pos < maxVal - 1.0) {
                    cuttingPlanes.push({ normal: faceNormals[i], constant: faceConstants[i], subtractorIndex });
                  }
                }
              });

              const axisCandidates = new Map<string, Array<{ groupIndex: number }>>();
              const subtractorMap = new Map<number, Array<{ groupIndex: number }>>();
              const filletMap = new Map<number, Array<{ groupIndex: number }>>();

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
                      if (!filletMap.has(fi)) filletMap.set(fi, []);
                      filletMap.get(fi)!.push({ groupIndex });
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
                      if (!subtractorMap.has(plane.subtractorIndex)) subtractorMap.set(plane.subtractorIndex, []);
                      subtractorMap.get(plane.subtractorIndex)!.push({ groupIndex });
                      return;
                    }
                  }
                }

                if (!axisCandidates.has(axisDir)) axisCandidates.set(axisDir, []);
                axisCandidates.get(axisDir)!.push({ groupIndex });
              });

              const axisSorted = Array.from(axisCandidates.entries()).sort(
                ([a], [b]) => (AXIS_DIRECTION_ORDER[a] ?? 99) - (AXIS_DIRECTION_ORDER[b] ?? 99)
              );

              const faceEntries: Array<{ label: string; groupIndex: number; color: string }> = [];

              axisSorted.forEach(([, candidates], roleIdx) => {
                const roleNumber = roleIdx + 1;
                if (candidates.length > 1) {
                  candidates.forEach((c, subIdx) => {
                    faceEntries.push({ label: `${roleNumber}-${subIdx + 1}`, groupIndex: c.groupIndex, color: '#1a1a1a' });
                  });
                } else {
                  faceEntries.push({ label: `${roleNumber}`, groupIndex: candidates[0].groupIndex, color: '#1a1a1a' });
                }
              });

              subtractorMap.forEach((candidates, subtractorIdx) => {
                candidates.forEach((c, faceIdx) => {
                  faceEntries.push({ label: `S${subtractorIdx + 1}.${faceIdx + 1}`, groupIndex: c.groupIndex, color: '#b45000' });
                });
              });

              filletMap.forEach((candidates, filletIdx) => {
                candidates.forEach((c) => {
                  faceEntries.push({ label: `F${filletIdx + 1}`, groupIndex: c.groupIndex, color: '#006eb4' });
                });
              });

              return (
                <div className="space-y-0.5 pt-2 border-t border-stone-300">
                  <div className="text-xs font-semibold text-stone-600 mb-1">Face Roles ({faceEntries.length} faces)</div>
                  {faceEntries.map(({ label, groupIndex, color }) => (
                    <div key={`face-${groupIndex}`} className="flex gap-0.5 items-center">
                      <input
                        type="text"
                        value={label}
                        readOnly
                        tabIndex={-1}
                        style={{ color }}
                        className="w-12 px-1 py-0.5 text-xs font-mono font-bold bg-white border border-gray-300 rounded text-center"
                      />
                      <select
                        value={faceRoles[groupIndex] || ''}
                        onChange={(e) => {
                          const newRole = e.target.value === '' ? null : e.target.value as FaceRole;
                          updateFaceRole(selectedShape.id, groupIndex, newRole);
                        }}
                        className="w-20 px-1 py-0.5 text-xs bg-white text-gray-800 border border-gray-300 rounded"
                      >
                        <option value="">none</option>
                        {roleOptions.map(role => (
                          <option key={role} value={role}>{role}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={faceDescriptions[groupIndex] || ''}
                        onChange={(e) => {
                          const newDescriptions = { ...faceDescriptions, [groupIndex]: e.target.value };
                          updateShape(selectedShape.id, { faceDescriptions: newDescriptions });
                        }}
                        placeholder="description"
                        className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-800 border border-gray-300 rounded"
                      />
                    </div>
                  ))}
                </div>
              );
            })()}

            {customParameters.length > 0 && (
              <div className="space-y-0.5">
                {customParameters.map((param) => (
                  <div key={param.id} className="flex gap-0.5 items-center">
                    <input
                      type="text"
                      value={param.name}
                      onChange={(e) => updateCustomParameter(param.id, 'name', e.target.value)}
                      className="w-10 px-1 py-0.5 text-xs font-mono bg-white text-gray-800 border border-gray-300 rounded text-center"
                    />
                    <input
                      type="text"
                      value={param.expression}
                      onChange={(e) => updateCustomParameter(param.id, 'expression', e.target.value)}
                      className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-800 border border-gray-300 rounded"
                      placeholder="expr"
                    />
                    <input
                      type="text"
                      value={param.result.toFixed(2)}
                      readOnly
                      tabIndex={-1}
                      className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-400 border border-gray-300 rounded text-left"
                    />
                    <input
                      type="text"
                      value={param.description}
                      onChange={(e) => updateCustomParameter(param.id, 'description', e.target.value)}
                      className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-800 border border-gray-300 rounded"
                      placeholder="Description"
                    />
                    <button
                      onClick={() => deleteCustomParameter(param.id)}
                      className="p-0.5 hover:bg-red-100 rounded transition-colors"
                      title="Delete"
                    >
                      <X size={12} className="text-red-600" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {subtractionViewMode && selectedSubtractionIndex !== null && selectedShape.subtractionGeometries && selectedShape.subtractionGeometries[selectedSubtractionIndex] && (
              <div className="space-y-0.5 pt-2 border-t-2 border-yellow-400">
                <div className="flex items-center justify-between text-xs font-semibold text-yellow-700">
                  <span>Subtraction #{selectedSubtractionIndex + 1}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={async () => {
                        if (selectedShape && selectedSubtractionIndex !== null) {
                          await deleteSubtraction(selectedShape.id, selectedSubtractionIndex);
                        }
                      }}
                      className="p-0.5 hover:bg-red-200 rounded transition-colors text-red-600"
                      title="Delete subtraction"
                    >
                      <Trash2 size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setSelectedSubtractionIndex(null);
                      }}
                      className="p-0.5 hover:bg-yellow-200 rounded transition-colors"
                      title="Close subtraction parameters"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
                <div className="space-y-0.5">
                  {renderSubtractionParamRow('W', subParams.width, 'width', 'Subtraction Width', handleSubParamChange)}
                  {renderSubtractionParamRow('H', subParams.height, 'height', 'Subtraction Height', handleSubParamChange)}
                  {renderSubtractionParamRow('D', subParams.depth, 'depth', 'Subtraction Depth', handleSubParamChange)}
                  {renderSubtractionParamRow('X', subParams.posX, 'posX', 'Subtraction Position X', handleSubParamChange)}
                  {renderSubtractionParamRow('Y', subParams.posY, 'posY', 'Subtraction Position Y', handleSubParamChange)}
                  {renderSubtractionParamRow('Z', subParams.posZ, 'posZ', 'Subtraction Position Z', handleSubParamChange)}
                  {renderSubtractionParamRow('RX', subParams.rotX, 'rotX', 'Subtraction Rotation X', handleSubParamChange)}
                  {renderSubtractionParamRow('RY', subParams.rotY, 'rotY', 'Subtraction Rotation Y', handleSubParamChange)}
                  {renderSubtractionParamRow('RZ', subParams.rotZ, 'rotZ', 'Subtraction Rotation Z', handleSubParamChange)}
                </div>
              </div>
            )}

            {vertexEditMode && vertexModifications.length > 0 && (
              <div className="space-y-0.5 pt-2 border-t border-stone-300">
                <div className="text-xs font-semibold text-stone-600 mb-1">Vertex Modifications</div>
                {vertexModifications.map((mod, idx) => {
                  const context = {
                    W: width,
                    H: height,
                    D: depth,
                    ...customParameters.reduce((acc, param) => {
                      acc[param.name] = param.result;
                      return acc;
                    }, {} as Record<string, number>)
                  };
                  const result = evaluateExpression(mod.expression, context);

                  return (
                    <div key={idx} className="flex gap-0.5 items-center">
                      <input
                        type="text"
                        value={`V${mod.vertexIndex}`}
                        readOnly
                        tabIndex={-1}
                        className="w-10 px-1 py-0.5 text-xs font-mono bg-white text-gray-800 border border-gray-300 rounded text-center"
                      />
                      <input
                        type="text"
                        value={mod.expression}
                        onChange={(e) => updateVertexModification(idx, 'expression', e.target.value)}
                        className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-800 border border-gray-300 rounded"
                        placeholder="expr"
                      />
                      <input
                        type="text"
                        value={result.toFixed(2)}
                        readOnly
                        tabIndex={-1}
                        className="w-16 px-1 py-0.5 text-xs font-mono bg-white text-gray-400 border border-gray-300 rounded text-left"
                      />
                      <input
                        type="text"
                        value={mod.description || ''}
                        onChange={(e) => updateVertexModification(idx, 'description', e.target.value)}
                        className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-800 border border-gray-300 rounded"
                        placeholder="Description"
                      />
                    </div>
                  );
                })}
              </div>
            )}

            <button
              onClick={handleApplyChanges}
              className="w-full mt-2 px-3 py-1.5 bg-orange-500 text-white text-xs font-medium rounded hover:bg-orange-600 transition-colors flex items-center justify-center gap-1"
            >
              <Check size={12} />
              Apply Changes
            </button>
          </div>
        ) : (
          <div className="text-center text-stone-500 text-xs py-4">
            No shape selected
          </div>
        )}
      </div>
    </div>
  );
}
a