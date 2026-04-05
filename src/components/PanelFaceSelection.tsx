import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useAppStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  createFaceHighlightGeometry,
} from './FaceEditor';

const HoverHighlightMesh: React.FC<{ geometry: THREE.BufferGeometry }> = ({ geometry }) => {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const shaderMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x3b82f6) },
        uOpacity: { value: 0.85 },
      },
      vertexShader: `
        void main() {
          vec3 offsetPos = position + normal * 0.5;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(offsetPos, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        void main() {
          gl_FragColor = vec4(uColor, uOpacity);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }, []);

  useFrame(({ clock }) => {
    if (matRef.current) {
      const pulse = 0.7 + 0.15 * Math.sin(clock.getElapsedTime() * 4);
      matRef.current.uniforms.uOpacity.value = pulse;
    }
  });

  return (
    <mesh geometry={geometry} renderOrder={999}>
      <primitive object={shaderMaterial} ref={matRef} attach="material" />
    </mesh>
  );
};

export const PanelFaceSelectionOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const {
    panelFaceEditMode,
    editingPanelId,
    hoveredPanelFaceIndex,
    setHoveredPanelFaceIndex,
  } = useAppStore(useShallow(state => ({
    panelFaceEditMode: state.panelFaceEditMode,
    editingPanelId: state.editingPanelId,
    hoveredPanelFaceIndex: state.hoveredPanelFaceIndex,
    setHoveredPanelFaceIndex: state.setHoveredPanelFaceIndex,
  })));

  const isEditingThis = panelFaceEditMode && editingPanelId === shape.id;
  const geometryUuid = shape.geometry?.uuid || '';

  const { faces, faceGroups } = useMemo(() => {
    if (!shape.geometry) return { faces: [], faceGroups: [] };
    const f = extractFacesFromGeometry(shape.geometry);
    const g = groupCoplanarFaces(f);
    return { faces: f, faceGroups: g };
  }, [shape.geometry, geometryUuid]);

  const hoverHighlightGeometry = useMemo(() => {
    if (hoveredPanelFaceIndex === null || !faceGroups[hoveredPanelFaceIndex]) return null;
    const geo = createFaceHighlightGeometry(faces, faceGroups[hoveredPanelFaceIndex].faceIndices);
    if (geo) geo.computeVertexNormals();
    return geo;
  }, [hoveredPanelFaceIndex, faceGroups, faces]);

  if (!isEditingThis || faces.length === 0) return null;

  return (
    <>
      <mesh
        geometry={shape.geometry}
        onPointerMove={(e) => {
          e.stopPropagation();
          if (e.faceIndex !== undefined) {
            const gi = faceGroups.findIndex(g => g.faceIndices.includes(e.faceIndex));
            if (gi !== -1 && gi !== hoveredPanelFaceIndex) {
              setHoveredPanelFaceIndex(gi);
            }
          }
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          setHoveredPanelFaceIndex(null);
        }}
      >
        <meshBasicMaterial
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {hoverHighlightGeometry && (
        <HoverHighlightMesh geometry={hoverHighlightGeometry} />
      )}
    </>
  );
};
