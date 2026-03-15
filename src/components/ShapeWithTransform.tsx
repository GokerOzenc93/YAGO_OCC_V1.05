import React, { useRef, useEffect, useState, useMemo } from 'react';
import { TransformControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useAppStore, Tool, ViewMode } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { SubtractionMesh } from './SubtractionMesh';
import { FilletEdgeLines } from './Fillet';
import { FaceEditor } from './FaceEditor';
import { RoleLabels } from './RoleLabels';
import { FaceRaycastOverlay, VirtualFaceOverlay } from './FaceRaycastOverlay';

interface ShapeWithTransformProps {
  shape: any;
  isSelected: boolean;
  orbitControlsRef: any;
  onContextMenu: (e: any, shapeId: string) => void;
}

export const ShapeWithTransform: React.FC<ShapeWithTransformProps> = React.memo(({
  shape,
  isSelected,
  orbitControlsRef,
  onContextMenu
}) => {
  const {
    selectShape,
    selectSecondaryShape,
    secondarySelectedShapeId,
    selectedShapeId,
    updateShape,
    activeTool,
    viewMode,
    subtractionViewMode,
    hoveredSubtractionIndex,
    setHoveredSubtractionIndex,
    selectedSubtractionIndex,
    setSelectedSubtractionIndex,
    setShowParametersPanel,
    showOutlines,
    showRoleNumbers,
    selectedPanelRow,
    setSelectedPanelRow,
    panelSelectMode,
    faceEditMode,
    filletMode,
    roleEditMode,
    setSelectedVertexIndex,
    setVertexDirection,
    panelSurfaceSelectMode,
    waitingForSurfaceSelection,
    raycastMode,
    shapes,
    rebuildingShapeIds
  } = useAppStore(useShallow(state => ({
    selectShape: state.selectShape,
    selectSecondaryShape: state.selectSecondaryShape,
    secondarySelectedShapeId: state.secondarySelectedShapeId,
    selectedShapeId: state.selectedShapeId,
    updateShape: state.updateShape,
    activeTool: state.activeTool,
    viewMode: state.viewMode,
    subtractionViewMode: state.subtractionViewMode,
    hoveredSubtractionIndex: state.hoveredSubtractionIndex,
    setHoveredSubtractionIndex: state.setHoveredSubtractionIndex,
    selectedSubtractionIndex: state.selectedSubtractionIndex,
    setSelectedSubtractionIndex: state.setSelectedSubtractionIndex,
    setShowParametersPanel: state.setShowParametersPanel,
    showOutlines: state.showOutlines,
    showRoleNumbers: state.showRoleNumbers,
    selectedPanelRow: state.selectedPanelRow,
    setSelectedPanelRow: state.setSelectedPanelRow,
    panelSelectMode: state.panelSelectMode,
    faceEditMode: state.faceEditMode,
    filletMode: state.filletMode,
    roleEditMode: state.roleEditMode,
    setSelectedVertexIndex: state.setSelectedVertexIndex,
    setVertexDirection: state.setVertexDirection,
    panelSurfaceSelectMode: state.panelSurfaceSelectMode,
    waitingForSurfaceSelection: state.waitingForSurfaceSelection,
    raycastMode: state.raycastMode,
    shapes: state.shapes,
    rebuildingShapeIds: state.rebuildingShapeIds
  })));

  const { scene } = useThree();
  const transformRef = useRef<any>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const isUpdatingRef = useRef(false);
  const initialTransformRef = useRef<{
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
    childPanels: Map<string, {
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
    }>;
  } | null>(null);
  const [localGeometry, setLocalGeometry] = useState(shape.geometry);
  const [edgeGeometry, setEdgeGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [geometryKey, setGeometryKey] = useState(0);
  const vertexModsString = useMemo(() => JSON.stringify(shape.vertexModifications || []), [shape.vertexModifications]);

  useEffect(() => {
    const loadEdges = async () => {
      const hasVertexMods = shape.vertexModifications && shape.vertexModifications.length > 0;
      const shouldUpdate = (shape.geometry && shape.geometry !== localGeometry) || hasVertexMods;

      if (shouldUpdate && shape.geometry) {
        let geom = shape.geometry.clone();

        if (hasVertexMods) {
          const positionAttribute = geom.getAttribute('position');
          const positions = positionAttribute.array as Float32Array;

          const vertexMap = new Map<string, number[]>();
          for (let i = 0; i < positions.length; i += 3) {
            const x = Math.round(positions[i] * 100) / 100;
            const y = Math.round(positions[i + 1] * 100) / 100;
            const z = Math.round(positions[i + 2] * 100) / 100;
            const key = `${x},${y},${z}`;

            if (!vertexMap.has(key)) {
              vertexMap.set(key, []);
            }
            vertexMap.get(key)!.push(i);
          }

          const { getBoxVertices, getReplicadVertices } = await import('./VertexEditorService');
          let baseVertices: THREE.Vector3[] = [];

          if (shape.parameters?.scaledBaseVertices && shape.parameters.scaledBaseVertices.length > 0) {
            baseVertices = shape.parameters.scaledBaseVertices.map((v: number[]) =>
              new THREE.Vector3(v[0], v[1], v[2])
            );
          } else if (shape.replicadShape) {
            baseVertices = await getReplicadVertices(shape.replicadShape);
          } else if (shape.type === 'box' && shape.parameters) {
            baseVertices = getBoxVertices(
              shape.parameters.width,
              shape.parameters.height,
              shape.parameters.depth
            );
          }

          shape.vertexModifications.forEach((mod: any) => {
            const baseVertex = baseVertices[mod.vertexIndex];
            if (!baseVertex) return;

            const key = `${Math.round(baseVertex.x * 100) / 100},${Math.round(baseVertex.y * 100) / 100},${Math.round(baseVertex.z * 100) / 100}`;
            const indices = vertexMap.get(key);

            if (indices) {
              indices.forEach(idx => {
                positions[idx] = mod.newPosition[0];
                positions[idx + 1] = mod.newPosition[1];
                positions[idx + 2] = mod.newPosition[2];
              });
            }
          });

          positionAttribute.needsUpdate = true;
          geom.computeVertexNormals();
          geom.computeBoundingBox();
          geom.computeBoundingSphere();
        }

        setLocalGeometry(geom);
        const edges = new THREE.EdgesGeometry(geom, 15);
        setEdgeGeometry(edges);
        setGeometryKey(prev => prev + 1);
        return;
      }

      if (shape.parameters?.modified && shape.geometry) {
        let geom = shape.geometry.clone();

        geom.computeVertexNormals();
        geom.computeBoundingBox();
        geom.computeBoundingSphere();

        setLocalGeometry(geom);
        const edges = new THREE.EdgesGeometry(geom, 15);
        setEdgeGeometry(edges);
        setGeometryKey(prev => prev + 1);
        return;
      }

      setEdgeGeometry(null);
    };

    loadEdges();
  }, [shape.parameters?.width, shape.parameters?.height, shape.parameters?.depth, vertexModsString, shape.parameters?.modified, shape.geometry, shape.id]);

  useEffect(() => {
    if (!groupRef.current) return;
    if (isUpdatingRef.current && shape.id === useAppStore.getState().selectedShapeId) return;

    groupRef.current.position.set(shape.position[0], shape.position[1], shape.position[2]);
    groupRef.current.rotation.set(shape.rotation[0], shape.rotation[1], shape.rotation[2]);
    groupRef.current.scale.set(shape.scale[0], shape.scale[1], shape.scale[2]);
  }, [shape.position, shape.rotation, shape.scale, shape.id]);

  useEffect(() => {
    if (transformRef.current && isSelected && groupRef.current) {
      const controls = transformRef.current;
      let isDragging = false;

      const onDraggingChanged = (event: any) => {
        isDragging = event.value;
        if (orbitControlsRef.current) {
          orbitControlsRef.current.enabled = !event.value;
        }

        if (event.value && groupRef.current) {
          const allShapes = useAppStore.getState().shapes;
          const childPanels = allShapes.filter(
            s => s.type === 'panel' && s.parameters?.parentShapeId === shape.id
          );

          const childPanelMap = new Map<string, {
            position: [number, number, number];
            rotation: [number, number, number];
            scale: [number, number, number];
          }>();

          childPanels.forEach(panel => {
            childPanelMap.set(panel.id, {
              position: [...panel.position] as [number, number, number],
              rotation: [...panel.rotation] as [number, number, number],
              scale: [...panel.scale] as [number, number, number]
            });
          });

          initialTransformRef.current = {
            position: groupRef.current.position.toArray() as [number, number, number],
            rotation: groupRef.current.rotation.toArray().slice(0, 3) as [number, number, number],
            scale: groupRef.current.scale.toArray() as [number, number, number],
            childPanels: childPanelMap
          };
        }

        if (!event.value && groupRef.current && initialTransformRef.current) {
          const finalPosition = groupRef.current.position.toArray() as [number, number, number];
          const finalRotation = groupRef.current.rotation.toArray().slice(0, 3) as [number, number, number];
          const finalScale = groupRef.current.scale.toArray() as [number, number, number];

          isUpdatingRef.current = true;

          const positionDelta: [number, number, number] = [
            finalPosition[0] - initialTransformRef.current.position[0],
            finalPosition[1] - initialTransformRef.current.position[1],
            finalPosition[2] - initialTransformRef.current.position[2]
          ];
          const rotationDelta: [number, number, number] = [
            finalRotation[0] - initialTransformRef.current.rotation[0],
            finalRotation[1] - initialTransformRef.current.rotation[1],
            finalRotation[2] - initialTransformRef.current.rotation[2]
          ];
          const scaleDelta: [number, number, number] = [
            finalScale[0] / initialTransformRef.current.scale[0],
            finalScale[1] / initialTransformRef.current.scale[1],
            finalScale[2] / initialTransformRef.current.scale[2]
          ];

          const capturedPanels = initialTransformRef.current.childPanels;
          initialTransformRef.current = null;

          useAppStore.setState((state) => {
            const sh = state.shapes.find(s => s.id === shape.id);
            if (!sh) return state;

            const updatedShapes = state.shapes.map(s => {
              if (s.id === shape.id) {
                return { ...s, position: finalPosition, rotation: finalRotation, scale: finalScale };
              }
              if (sh.groupId && s.groupId === sh.groupId && s.id !== shape.id) {
                return {
                  ...s,
                  position: [
                    s.position[0] + positionDelta[0],
                    s.position[1] + positionDelta[1],
                    s.position[2] + positionDelta[2]
                  ] as [number, number, number],
                  rotation: [
                    s.rotation[0] + rotationDelta[0],
                    s.rotation[1] + rotationDelta[1],
                    s.rotation[2] + rotationDelta[2]
                  ] as [number, number, number],
                  scale: [
                    s.scale[0] * scaleDelta[0],
                    s.scale[1] * scaleDelta[1],
                    s.scale[2] * scaleDelta[2]
                  ] as [number, number, number]
                };
              }
              const panelInitial = capturedPanels.get(s.id);
              if (panelInitial) {
                return {
                  ...s,
                  position: [
                    panelInitial.position[0] + positionDelta[0],
                    panelInitial.position[1] + positionDelta[1],
                    panelInitial.position[2] + positionDelta[2]
                  ] as [number, number, number],
                  rotation: [
                    panelInitial.rotation[0] + rotationDelta[0],
                    panelInitial.rotation[1] + rotationDelta[1],
                    panelInitial.rotation[2] + rotationDelta[2]
                  ] as [number, number, number],
                  scale: [
                    panelInitial.scale[0] * scaleDelta[0],
                    panelInitial.scale[1] * scaleDelta[1],
                    panelInitial.scale[2] * scaleDelta[2]
                  ] as [number, number, number]
                };
              }
              return s;
            });

            return { shapes: updatedShapes };
          });

          requestAnimationFrame(() => {
            isUpdatingRef.current = false;
          });
        }
      };

      const onChange = () => {
        if (groupRef.current && isDragging && initialTransformRef.current) {
          isUpdatingRef.current = true;

          const currentPosition = groupRef.current.position.toArray() as [number, number, number];
          const currentRotation = groupRef.current.rotation.toArray().slice(0, 3) as [number, number, number];
          const currentScale = groupRef.current.scale.toArray() as [number, number, number];

          const positionDelta: [number, number, number] = [
            currentPosition[0] - initialTransformRef.current.position[0],
            currentPosition[1] - initialTransformRef.current.position[1],
            currentPosition[2] - initialTransformRef.current.position[2]
          ];
          const rotationDelta: [number, number, number] = [
            currentRotation[0] - initialTransformRef.current.rotation[0],
            currentRotation[1] - initialTransformRef.current.rotation[1],
            currentRotation[2] - initialTransformRef.current.rotation[2]
          ];
          const scaleDelta: [number, number, number] = [
            currentScale[0] / initialTransformRef.current.scale[0],
            currentScale[1] / initialTransformRef.current.scale[1],
            currentScale[2] / initialTransformRef.current.scale[2]
          ];

          initialTransformRef.current.childPanels.forEach((initialState, panelId) => {
            const childGroup = scene.getObjectByName(`shape-${panelId}`);
            if (childGroup) {
              childGroup.position.set(
                initialState.position[0] + positionDelta[0],
                initialState.position[1] + positionDelta[1],
                initialState.position[2] + positionDelta[2]
              );
              childGroup.rotation.set(
                initialState.rotation[0] + rotationDelta[0],
                initialState.rotation[1] + rotationDelta[1],
                initialState.rotation[2] + rotationDelta[2]
              );
              childGroup.scale.set(
                initialState.scale[0] * scaleDelta[0],
                initialState.scale[1] * scaleDelta[1],
                initialState.scale[2] * scaleDelta[2]
              );
            }
          });
        }
      };

      controls.addEventListener('dragging-changed', onDraggingChanged);
      controls.addEventListener('change', onChange);

      return () => {
        controls.removeEventListener('dragging-changed', onDraggingChanged);
        controls.removeEventListener('change', onChange);
      };
    }
  }, [isSelected, shape.id, updateShape, orbitControlsRef, geometryKey, scene]);

  const getTransformMode = () => {
    switch (activeTool) {
      case Tool.MOVE:
        return 'translate';
      case Tool.ROTATE:
        return 'rotate';
      case Tool.SCALE:
        return 'scale';
      default:
        return 'translate';
    }
  };

  const isWireframe = viewMode === ViewMode.WIREFRAME;
  const isXray = viewMode === ViewMode.XRAY;
  const isSecondarySelected = shape.id === secondarySelectedShapeId;
  const isReferenceBox = shape.isReferenceBox;
  const shouldShowAsReference = isReferenceBox || isSecondarySelected;
  const isPanel = shape.type === 'panel';
  const parentShapeId = isPanel ? shape.parameters?.parentShapeId : null;
  const isParentRebuilding = parentShapeId ? rebuildingShapeIds.has(parentShapeId) : false;
  const hasPanels = (shape.facePanels && Object.keys(shape.facePanels).length > 0) ||
    shapes.some(s => s.type === 'panel' && s.parameters?.parentShapeId === shape.id);
  const hasFillets = shape.fillets && shape.fillets.length > 0;

  const isParentSelected = isPanel && shape.parameters?.parentShapeId === selectedShapeId;
  const isPanelRowSelected = isPanel &&
    isParentSelected &&
    shape.parameters?.faceIndex !== undefined &&
    shape.parameters.faceIndex === selectedPanelRow;
  const isVirtualPanelRowSelected = isPanel &&
    isParentSelected &&
    shape.parameters?.virtualFaceId &&
    `vf-${shape.parameters.virtualFaceId}` === selectedPanelRow;
  const panelColor = (isPanelRowSelected || isVirtualPanelRowSelected) ? '#ef4444' : (shape.color || '#ffffff');
  if (shape.isolated === false) {
    return null;
  }

  if (isParentRebuilding) {
    return null;
  }

  return (
    <>
      <group
        ref={groupRef}
        name={`shape-${shape.id}`}
        onClick={(e) => {
          if (panelSelectMode && hasPanels) {
            return;
          }
          e.stopPropagation();
          if (e.nativeEvent.ctrlKey || e.nativeEvent.metaKey) {
            if (shape.id === secondarySelectedShapeId) {
              selectSecondaryShape(null);
            } else {
              selectSecondaryShape(shape.id);
            }
          } else if (panelSelectMode && isPanel && shape.parameters?.parentShapeId) {
            const parentId = shape.parameters.parentShapeId;
            if (selectedShapeId !== parentId) {
              selectShape(parentId);
            }
            setSelectedPanelRow(shape.parameters.faceIndex ?? null);
            selectSecondaryShape(null);
          } else if (panelSelectMode && !isPanel) {
            selectShape(shape.id);
            selectSecondaryShape(null);
            setSelectedPanelRow(null);
          } else {
            selectShape(shape.id);
            selectSecondaryShape(null);
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          selectShape(shape.id);
          setShowParametersPanel(true);
        }}
        onContextMenu={(e) => {
          e.stopPropagation();
          onContextMenu(e, shape.id);
        }}
      >
        {shape.subtractionGeometries && subtractionViewMode && shape.subtractionGeometries.map((subtraction, index) => {
          if (!subtraction) return null;

          const isHovered = hoveredSubtractionIndex === index && isSelected;
          const isSubtractionSelected = selectedSubtractionIndex === index && isSelected;

          return (
            <SubtractionMesh
              key={`${shape.id}-subtraction-${index}`}
              subtraction={subtraction}
              index={index}
              isHovered={isHovered}
              isSubtractionSelected={isSubtractionSelected}
              isSelected={isSelected}
              setHoveredSubtractionIndex={setHoveredSubtractionIndex}
              setSelectedSubtractionIndex={setSelectedSubtractionIndex}
            />
          );
        })}
        {!isWireframe && !isXray && !shouldShowAsReference && (
          <>
            <mesh
              ref={meshRef}
              geometry={localGeometry}
              castShadow
              receiveShadow
            >
              <meshStandardMaterial
                color={isPanel ? panelColor : "#94b8d9"}
                emissive={isPanel ? panelColor : undefined}
                emissiveIntensity={isPanel ? (isPanelRowSelected ? 0.3 : 0.08) : 0}
                metalness={isPanel ? 0 : 0.1}
                roughness={isPanel ? 0.45 : 0.6}
                transparent
                opacity={hasPanels ? 0 : isPanel ? 1 : 0.12}
                side={isPanel ? THREE.FrontSide : THREE.DoubleSide}
                depthWrite={!hasPanels}
                flatShading={false}
                polygonOffset={true}
                polygonOffsetFactor={1}
                polygonOffsetUnits={1}
              />
            </mesh>
            {showOutlines && (
              <lineSegments>
                {edgeGeometry ? (
                  <bufferGeometry {...edgeGeometry} />
                ) : (
                  <edgesGeometry args={[localGeometry, 15]} />
                )}
                <lineBasicMaterial
                  color="#111111"
                  linewidth={1}
                  opacity={1}
                  transparent={false}
                  depthTest={true}
                />
              </lineSegments>
            )}
          </>
        )}
        {isWireframe && (
          <>
            <mesh
              ref={meshRef}
              geometry={localGeometry}
              visible={false}
            />
            {showOutlines && (
              <lineSegments>
                {edgeGeometry ? (
                  <bufferGeometry {...edgeGeometry} />
                ) : (
                  <edgesGeometry args={[localGeometry, 15]} />
                )}
                <lineBasicMaterial
                  color={isSelected ? '#60a5fa' : shouldShowAsReference ? '#ef4444' : '#1a1a1a'}
                  linewidth={1}
                  depthTest={true}
                  depthWrite={true}
                />
              </lineSegments>
            )}
          </>
        )}
        {(isXray || shouldShowAsReference) && (
          <>
            <mesh
              ref={meshRef}
              geometry={localGeometry}
              castShadow
              receiveShadow
            >
              <meshStandardMaterial
                color={isPanel ? panelColor : isSelected ? '#60a5fa' : shouldShowAsReference ? '#ef4444' : shape.color || '#2563eb'}
                emissive={isPanel ? panelColor : undefined}
                emissiveIntensity={isPanel ? (isPanelRowSelected ? 0.3 : 0.08) : 0}
                metalness={isPanel ? 0 : 0.2}
                roughness={isPanel ? 0.45 : 0.5}
                transparent
                opacity={hasPanels ? 0 : isPanel ? 1 : 0.25}
                side={isPanel ? THREE.FrontSide : THREE.DoubleSide}
                depthWrite={!hasPanels}
                flatShading={false}
                polygonOffset={true}
                polygonOffsetFactor={1}
                polygonOffsetUnits={1}
              />
            </mesh>
            {showOutlines && (
              <lineSegments>
                {edgeGeometry ? (
                  <bufferGeometry {...edgeGeometry} />
                ) : (
                  <edgesGeometry args={[localGeometry, 15]} />
                )}
                <lineBasicMaterial
                  color={isSelected ? '#1e40af' : shouldShowAsReference ? '#991b1b' : '#0a0a0a'}
                  linewidth={1}
                  depthTest={true}
                  transparent={false}
                  opacity={1}
                />
              </lineSegments>
            )}
          </>
        )}
        {hasFillets && filletMode && (
          <FilletEdgeLines shape={shape} isSelected={isSelected} />
        )}
        {isSelected && (faceEditMode || (panelSurfaceSelectMode && waitingForSurfaceSelection)) && (
          <FaceEditor
            key={`face-editor-${shape.id}-${shape.geometry?.uuid || ''}-${(shape.fillets || []).length}`}
            shape={shape}
            isActive={true}
          />
        )}
        {(showRoleNumbers || roleEditMode) && isSelected && (
          <RoleLabels
            key={`role-labels-${shape.id}-${shape.geometry?.uuid || ''}`}
            shape={shape}
            isActive={true}
          />
        )}
        {isSelected && raycastMode && !isPanel && (
          <FaceRaycastOverlay
            key={`raycast-${shape.id}-${shape.geometry?.uuid || ''}`}
            shape={shape}
            allShapes={shapes}
          />
        )}
        {!isPanel && (
          <VirtualFaceOverlay shape={shape} />
        )}
      </group>

      {isSelected && activeTool !== Tool.SELECT && groupRef.current && !shape.isReferenceBox && !panelSelectMode && (
        <TransformControls
          key={geometryKey}
          ref={transformRef}
          object={groupRef.current}
          mode={getTransformMode()}
          size={0.8}
        />
      )}
    </>
  );
});

ShapeWithTransform.displayName = 'ShapeWithTransform';
