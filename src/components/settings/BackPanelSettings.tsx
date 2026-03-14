import React from 'react';
import { Canvas } from '@react-three/fiber';
import { OrthographicCamera, Text } from '@react-three/drei';
import * as THREE from 'three';
import { SaveButtons } from './SaveButtons';
import { globalSettingsService, GlobalSettingsProfile } from '../GlobalSettingsDatabase';
import { useAppStore } from '../../store';

interface BackPanelSettingsProps {
  profileId: string;
  isDefaultProfile?: boolean;
  onSettingsSaved?: () => void;
}

const BackPanelArrow: React.FC<{
  position: [number, number, number];
  direction: 'left' | 'right';
  onClick: () => void;
  active?: boolean;
}> = ({ position, direction, onClick, active = false }) => {
  const [hovered, setHovered] = React.useState(false);
  const rotation: [number, number, number] = direction === 'left'
    ? [-Math.PI / 2, 0, Math.PI / 2]
    : [-Math.PI / 2, 0, -Math.PI / 2];

  const getColor = () => {
    if (active) return "#f97316";
    if (hovered) return "#f97316";
    return "#3b82f6";
  };

  return (
    <mesh
      position={position}
      rotation={rotation}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = 'auto';
      }}
    >
      <coneGeometry args={[0.008, 0.016, 8]} />
      <meshStandardMaterial color={getColor()} />
    </mesh>
  );
};

const VerticalBackPanelArrow: React.FC<{
  position: [number, number, number];
  direction: 'up' | 'down';
  onClick: () => void;
  active?: boolean;
}> = ({ position, direction, onClick, active = false }) => {
  const [hovered, setHovered] = React.useState(false);
  const rotation: [number, number, number] = direction === 'up'
    ? [0, 0, 0]
    : [Math.PI, 0, 0];

  const getColor = () => {
    if (active) return "#f97316";
    if (hovered) return "#f97316";
    return "#3b82f6";
  };

  return (
    <mesh
      position={position}
      rotation={rotation}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = 'auto';
      }}
    >
      <coneGeometry args={[0.008, 0.016, 8]} />
      <meshStandardMaterial color={getColor()} />
    </mesh>
  );
};

const CabinetTopView: React.FC<{
  backrestThickness: number;
  grooveOffset: number;
  grooveDepth: number;
  looseWid: number;
  viewMode: 'plan' | 'side';
  isSelected: boolean;
  onSelect: () => void;
  onLeftArrowClick: () => void;
  onRightArrowClick: () => void;
  leftExtendActive: boolean;
  rightExtendActive: boolean;
  leftExtendValue: number;
  rightExtendValue: number;
  isLeftPanelSelected: boolean;
  isRightPanelSelected: boolean;
  onLeftPanelSelect: () => void;
  onRightPanelSelect: () => void;
  onLeftPanelArrowClick: () => void;
  onRightPanelArrowClick: () => void;
  leftPanelShortenActive: boolean;
  rightPanelShortenActive: boolean;
  leftPanelShortenValue: number;
  rightPanelShortenValue: number;
  onTopArrowClick: () => void;
  onBottomArrowClick: () => void;
  topExtendActive: boolean;
  bottomExtendActive: boolean;
  topExtendValue: number;
  bottomExtendValue: number;
  isTopPanelSelected: boolean;
  isBottomPanelSelected: boolean;
  onTopPanelSelect: () => void;
  onBottomPanelSelect: () => void;
  onTopPanelArrowClick: () => void;
  onBottomPanelArrowClick: () => void;
  topPanelShortenActive: boolean;
  bottomPanelShortenActive: boolean;
  topPanelShortenValue: number;
  bottomPanelShortenValue: number;
}> = ({ backrestThickness, grooveOffset, grooveDepth, looseWid, viewMode, isSelected, onSelect, onLeftArrowClick, onRightArrowClick, leftExtendActive, rightExtendActive, leftExtendValue, rightExtendValue, isLeftPanelSelected, isRightPanelSelected, onLeftPanelSelect, onRightPanelSelect, onLeftPanelArrowClick, onRightPanelArrowClick, leftPanelShortenActive, rightPanelShortenActive, leftPanelShortenValue, rightPanelShortenValue, onTopArrowClick, onBottomArrowClick, topExtendActive, bottomExtendActive, topExtendValue, bottomExtendValue, isTopPanelSelected, isBottomPanelSelected, onTopPanelSelect, onBottomPanelSelect, onTopPanelArrowClick, onBottomPanelArrowClick, topPanelShortenActive, bottomPanelShortenActive, topPanelShortenValue, bottomPanelShortenValue }) => {
  const [hovered, setHovered] = React.useState(false);
  const [leftPanelHovered, setLeftPanelHovered] = React.useState(false);
  const [rightPanelHovered, setRightPanelHovered] = React.useState(false);
  const [topPanelHovered, setTopPanelHovered] = React.useState(false);
  const [bottomPanelHovered, setBottomPanelHovered] = React.useState(false);
  const cabinetWidth = 0.10;
  const cabinetDepth = 0.1;
  const panelThickness = 0.018;

  const backPanelColor = isSelected ? "#ef4444" : (hovered ? "#ef4444" : "#fed7aa");

  if (viewMode === 'side') {
    const sideHeight = 0.1;
    const topPanelY = sideHeight / 2 - panelThickness / 2;
    const bottomPanelY = -sideHeight / 2 + panelThickness / 2;
    const backPanelZ = -cabinetDepth / 2 + grooveOffset + backrestThickness / 2;
    const innerWidth = cabinetWidth - panelThickness * 2;

    const topGrooveTotal = grooveDepth + (topExtendValue / 1000);
    const bottomGrooveTotal = grooveDepth + (bottomExtendValue / 1000);
    const backPanelHeight = sideHeight - panelThickness * 2 + topGrooveTotal + bottomGrooveTotal;

    const dimStartZ = -cabinetDepth / 2;
    const dimEndZ = -cabinetDepth / 2 + grooveOffset + backrestThickness;
    const dimX = 0;
    const dimY = -sideHeight / 2 - 0.012;
    const dimensionValue = (grooveOffset + backrestThickness) * 1000;
    const tickLength = 0.006;
    const textOffset = 0.01;

    const gapHeight = 0.02;
    const backPanelHalfHeight = (backPanelHeight - gapHeight) / 2;
    const backPanelCenterY = (topGrooveTotal - bottomGrooveTotal) / 2;
    const topBackPanelY = backPanelCenterY + gapHeight / 2 + backPanelHalfHeight / 2;
    const bottomBackPanelY = backPanelCenterY - gapHeight / 2 - backPanelHalfHeight / 2;

    const topPanelDepth = cabinetDepth - (topPanelShortenValue / 1000);
    const bottomPanelDepth = cabinetDepth - (bottomPanelShortenValue / 1000);
    const topPanelZOffset = (topPanelShortenValue / 1000) / 2;
    const bottomPanelZOffset = (bottomPanelShortenValue / 1000) / 2;

    const topPanelColor = isTopPanelSelected ? "#ef4444" : (topPanelHovered ? "#ef4444" : "#d4d4d4");
    const bottomPanelColor = isBottomPanelSelected ? "#ef4444" : (bottomPanelHovered ? "#ef4444" : "#d4d4d4");

    return (
      <group>
        <mesh
          position={[0, topPanelY, topPanelZOffset]}
          onClick={(e) => { e.stopPropagation(); onTopPanelSelect(); }}
          onPointerOver={() => { setTopPanelHovered(true); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { setTopPanelHovered(false); document.body.style.cursor = 'auto'; }}
        >
          <boxGeometry args={[innerWidth, panelThickness, topPanelDepth]} />
          <meshStandardMaterial color={topPanelColor} transparent opacity={isTopPanelSelected || topPanelHovered ? 0.8 : 0.4} />
        </mesh>
        <lineSegments position={[0, topPanelY, topPanelZOffset]}>
          <edgesGeometry attach="geometry" args={[new THREE.BoxGeometry(innerWidth, panelThickness, topPanelDepth)]} />
          <lineBasicMaterial attach="material" color="#000000" linewidth={2} />
        </lineSegments>


        <mesh
          position={[0, bottomPanelY, bottomPanelZOffset]}
          onClick={(e) => { e.stopPropagation(); onBottomPanelSelect(); }}
          onPointerOver={() => { setBottomPanelHovered(true); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { setBottomPanelHovered(false); document.body.style.cursor = 'auto'; }}
        >
          <boxGeometry args={[innerWidth, panelThickness, bottomPanelDepth]} />
          <meshStandardMaterial color={bottomPanelColor} transparent opacity={isBottomPanelSelected || bottomPanelHovered ? 0.8 : 0.4} />
        </mesh>
        <lineSegments position={[0, bottomPanelY, bottomPanelZOffset]}>
          <edgesGeometry attach="geometry" args={[new THREE.BoxGeometry(innerWidth, panelThickness, bottomPanelDepth)]} />
          <lineBasicMaterial attach="material" color="#000000" linewidth={2} />
        </lineSegments>


        <mesh
          position={[0, topBackPanelY, backPanelZ]}
          onClick={onSelect}
          onPointerOver={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
        >
          <boxGeometry args={[innerWidth + grooveDepth * 2, backPanelHalfHeight, backrestThickness]} />
          <meshStandardMaterial color={backPanelColor} />
        </mesh>
        <lineSegments position={[0, topBackPanelY, backPanelZ]}>
          <edgesGeometry attach="geometry" args={[new THREE.BoxGeometry(innerWidth + grooveDepth * 2, backPanelHalfHeight, backrestThickness)]} />
          <lineBasicMaterial attach="material" color="#000000" linewidth={2} />
        </lineSegments>

        <mesh
          position={[0, bottomBackPanelY, backPanelZ]}
          onClick={onSelect}
          onPointerOver={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
        >
          <boxGeometry args={[innerWidth + grooveDepth * 2, backPanelHalfHeight, backrestThickness]} />
          <meshStandardMaterial color={backPanelColor} />
        </mesh>
        <lineSegments position={[0, bottomBackPanelY, backPanelZ]}>
          <edgesGeometry attach="geometry" args={[new THREE.BoxGeometry(innerWidth + grooveDepth * 2, backPanelHalfHeight, backrestThickness)]} />
          <lineBasicMaterial attach="material" color="#000000" linewidth={2} />
        </lineSegments>

        <Text
          position={[0, 0, backPanelZ + 0.0001]}
          rotation={[0, -Math.PI / 2, 0]}
          fontSize={0.008}
          color="#666666"
          anchorX="center"
          anchorY="middle"
        >
          {(backrestThickness * 1000).toFixed(1)}
        </Text>

        <line key={`tick-start-side-depth-${dimStartZ}`}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              count={2}
              array={new Float32Array([dimX, dimY - tickLength, dimStartZ, dimX, dimY + tickLength, dimStartZ])}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#666666" linewidth={1} />
        </line>

        <line key={`tick-end-side-depth-${dimEndZ}`}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              count={2}
              array={new Float32Array([dimX, dimY - tickLength, dimEndZ, dimX, dimY + tickLength, dimEndZ])}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#666666" linewidth={1} />
        </line>

        <Text
          position={[0, dimY - textOffset, (dimStartZ + dimEndZ) / 2]}
          rotation={[0, -Math.PI / 2, 0]}
          fontSize={0.008}
          color="#666666"
          anchorX="center"
          anchorY="middle"
        >
          {dimensionValue.toFixed(1)}
        </Text>

        {(() => {
          const bottomPanelTopEdge = bottomPanelY + panelThickness / 2;
          const grooveBottomEdge = bottomPanelTopEdge - bottomGrooveTotal;
          const grooveDepthValue = grooveDepth * 1000 + bottomExtendValue;
          const grooveDimZ = -cabinetDepth / 2 - 0.012;
          const grooveTickLength = 0.006;
          const grooveTextOffset = 0.01;
          const bottomDimColor = bottomExtendActive ? "#f97316" : "#666666";

          return (
            <>
              <line key={`tick-groove-top-${bottomGrooveTotal}`}>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    count={2}
                    array={new Float32Array([0, bottomPanelTopEdge, grooveDimZ - grooveTickLength, 0, bottomPanelTopEdge, grooveDimZ + grooveTickLength])}
                    itemSize={3}
                  />
                </bufferGeometry>
                <lineBasicMaterial color={bottomDimColor} linewidth={1} />
              </line>

              <line key={`tick-groove-bottom-${bottomGrooveTotal}`}>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    count={2}
                    array={new Float32Array([0, grooveBottomEdge, grooveDimZ - grooveTickLength, 0, grooveBottomEdge, grooveDimZ + grooveTickLength])}
                    itemSize={3}
                  />
                </bufferGeometry>
                <lineBasicMaterial color={bottomDimColor} linewidth={1} />
              </line>

              <Text
                key={`groove-depth-text-${bottomGrooveTotal}`}
                position={[0, (bottomPanelTopEdge + grooveBottomEdge) / 2, grooveDimZ - grooveTextOffset]}
                rotation={[0, -Math.PI / 2, 0]}
                fontSize={0.008}
                color={bottomDimColor}
                anchorX="center"
                anchorY="middle"
              >
                {grooveDepthValue.toFixed(1)}
              </Text>
            </>
          );
        })()}

        {isSelected && (
          <>
            <VerticalBackPanelArrow
              position={[innerWidth / 2 - 0.012, topPanelY, backPanelZ - backrestThickness / 2 - 0.01]}
              direction="up"
              onClick={onTopArrowClick}
              active={topExtendActive}
            />
            <VerticalBackPanelArrow
              position={[innerWidth / 2 - 0.012, bottomPanelY, backPanelZ - backrestThickness / 2 - 0.01]}
              direction="down"
              onClick={onBottomArrowClick}
              active={bottomExtendActive}
            />
          </>
        )}

        {topExtendValue > 0 && (() => {
          const topPanelBottomEdge = topPanelY - panelThickness / 2;
          const backPanelTopEdge = topPanelBottomEdge + topGrooveTotal;
          const topDimZ = -cabinetDepth / 2 - 0.012;
          const topTickLength = 0.006;
          const topTextOffset = 0.01;
          const topDimValue = (grooveDepth * 1000) + topExtendValue;
          const topDimColor = topExtendActive ? "#f97316" : "#666666";

          return (
            <>
              <line key={`tick-top-panel-edge-${topPanelBottomEdge}`}>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    count={2}
                    array={new Float32Array([0, topPanelBottomEdge, topDimZ - topTickLength, 0, topPanelBottomEdge, topDimZ + topTickLength])}
                    itemSize={3}
                  />
                </bufferGeometry>
                <lineBasicMaterial color={topDimColor} linewidth={1} />
              </line>

              <line key={`tick-back-panel-top-edge-${backPanelTopEdge}`}>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    count={2}
                    array={new Float32Array([0, backPanelTopEdge, topDimZ - topTickLength, 0, backPanelTopEdge, topDimZ + topTickLength])}
                    itemSize={3}
                  />
                </bufferGeometry>
                <lineBasicMaterial color={topDimColor} linewidth={1} />
              </line>

              <Text
                position={[0, (topPanelBottomEdge + backPanelTopEdge) / 2, topDimZ - topTextOffset]}
                rotation={[0, -Math.PI / 2, 0]}
                fontSize={0.008}
                color={topDimColor}
                anchorX="center"
                anchorY="middle"
              >
                {topDimValue.toFixed(1)}
              </Text>
            </>
          );
        })()}

        <ambientLight intensity={0.7} />
        <directionalLight position={[-5, 5, 5]} intensity={0.6} />
        <directionalLight position={[-5, 3, -5]} intensity={0.3} />
      </group>
    );
  }

  const cabinetHeight = 0.25;
  const leftPanelX = -cabinetWidth / 2 + panelThickness / 2;
  const rightPanelX = cabinetWidth / 2 - panelThickness / 2;
  const backPanelZ = -cabinetDepth / 2 + grooveOffset + backrestThickness / 2;

  const leftGrooveTotal = grooveDepth + (leftExtendValue / 1000);
  const rightGrooveTotal = grooveDepth + (rightExtendValue / 1000);
  const innerWidth = cabinetWidth - panelThickness * 2;
  const backPanelFullWidth = innerWidth + leftGrooveTotal + rightGrooveTotal;
  const backPanelCenterX = (rightGrooveTotal - leftGrooveTotal) / 2;

  const gapWidth = 0.025;
  const backPanelHalfWidth = (backPanelFullWidth - gapWidth) / 2;
  const leftBackPanelX = backPanelCenterX - backPanelFullWidth / 2 + backPanelHalfWidth / 2;
  const rightBackPanelX = backPanelCenterX + backPanelFullWidth / 2 - backPanelHalfWidth / 2;

  const dimStartZ = -cabinetDepth / 2;
  const dimEndZ = -cabinetDepth / 2 + grooveOffset + backrestThickness;
  const dimX = leftPanelX - panelThickness / 2 - 0.008;
  const dimY = 0;
  const dimensionValue = (grooveOffset + backrestThickness) * 1000;
  const tickLength = 0.006;
  const textOffset = 0.012;

  const leftSidePanelDepth = cabinetDepth - (leftPanelShortenValue / 1000);
  const rightSidePanelDepth = cabinetDepth - (rightPanelShortenValue / 1000);
  const leftSidePanelZ = (leftPanelShortenValue / 1000) / 2;
  const rightSidePanelZ = (rightPanelShortenValue / 1000) / 2;

  const leftPanelColor = isLeftPanelSelected ? "#ef4444" : (leftPanelHovered ? "#ef4444" : "#d4d4d4");
  const rightPanelColor = isRightPanelSelected ? "#ef4444" : (rightPanelHovered ? "#ef4444" : "#d4d4d4");

  return (
    <group>
      <mesh
        position={[leftPanelX, 0, leftSidePanelZ]}
        onClick={(e) => { e.stopPropagation(); onLeftPanelSelect(); }}
        onPointerOver={() => { setLeftPanelHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setLeftPanelHovered(false); document.body.style.cursor = 'auto'; }}
      >
        <boxGeometry args={[panelThickness, cabinetHeight, leftSidePanelDepth]} />
        <meshStandardMaterial color={leftPanelColor} transparent opacity={isLeftPanelSelected || leftPanelHovered ? 0.8 : 0.4} />
      </mesh>
      <lineSegments position={[leftPanelX, 0, leftSidePanelZ]}>
        <edgesGeometry attach="geometry" args={[new THREE.BoxGeometry(panelThickness, cabinetHeight, leftSidePanelDepth)]} />
        <lineBasicMaterial attach="material" color="#000000" linewidth={2} />
      </lineSegments>


      <mesh
        position={[rightPanelX, 0, rightSidePanelZ]}
        onClick={(e) => { e.stopPropagation(); onRightPanelSelect(); }}
        onPointerOver={() => { setRightPanelHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setRightPanelHovered(false); document.body.style.cursor = 'auto'; }}
      >
        <boxGeometry args={[panelThickness, cabinetHeight, rightSidePanelDepth]} />
        <meshStandardMaterial color={rightPanelColor} transparent opacity={isRightPanelSelected || rightPanelHovered ? 0.8 : 0.4} />
      </mesh>
      <lineSegments position={[rightPanelX, 0, rightSidePanelZ]}>
        <edgesGeometry attach="geometry" args={[new THREE.BoxGeometry(panelThickness, cabinetHeight, rightSidePanelDepth)]} />
        <lineBasicMaterial attach="material" color="#000000" linewidth={2} />
      </lineSegments>


      <mesh
        position={[leftBackPanelX, 0, backPanelZ]}
        onClick={onSelect}
        onPointerOver={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
      >
        <boxGeometry args={[backPanelHalfWidth, cabinetHeight, backrestThickness]} />
        <meshStandardMaterial color={backPanelColor} />
      </mesh>
      <lineSegments position={[leftBackPanelX, 0, backPanelZ]}>
        <edgesGeometry attach="geometry" args={[new THREE.BoxGeometry(backPanelHalfWidth, cabinetHeight, backrestThickness)]} />
        <lineBasicMaterial attach="material" color="#000000" linewidth={2} />
      </lineSegments>

      <mesh
        position={[rightBackPanelX, 0, backPanelZ]}
        onClick={onSelect}
        onPointerOver={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
      >
        <boxGeometry args={[backPanelHalfWidth, cabinetHeight, backrestThickness]} />
        <meshStandardMaterial color={backPanelColor} />
      </mesh>
      <lineSegments position={[rightBackPanelX, 0, backPanelZ]}>
        <edgesGeometry attach="geometry" args={[new THREE.BoxGeometry(backPanelHalfWidth, cabinetHeight, backrestThickness)]} />
        <lineBasicMaterial attach="material" color="#000000" linewidth={2} />
      </lineSegments>

      {isSelected && (
        <>
          <BackPanelArrow
            position={[-backPanelFullWidth / 2 + 0.012, -0.002, backPanelZ - backrestThickness / 2 - 0.020]}
            direction="left"
            onClick={onLeftArrowClick}
            active={leftExtendActive}
          />
          <BackPanelArrow
            position={[backPanelFullWidth / 2 - 0.012, -0.002, backPanelZ - backrestThickness / 2 - 0.020]}
            direction="right"
            onClick={onRightArrowClick}
            active={rightExtendActive}
          />
        </>
      )}

      <Text
        position={[0, 0.0002, backPanelZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.008}
        color="#666666"
        anchorX="center"
        anchorY="middle"
      >
        {(backrestThickness * 1000).toFixed(1)}
      </Text>

      <line key={`tick-start-plan-${dimStartZ}`}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={2}
            array={new Float32Array([dimX, dimY, dimStartZ, dimX - tickLength, dimY, dimStartZ])}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color="#666666" linewidth={1} />
      </line>

      <line key={`tick-end-plan-${dimEndZ}`}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={2}
            array={new Float32Array([dimX, dimY, dimEndZ, dimX - tickLength, dimY, dimEndZ])}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color="#666666" linewidth={1} />
      </line>

      <Text
        position={[dimX - textOffset, dimY, (dimStartZ + dimEndZ) / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.008}
        color="#666666"
        anchorX="right"
        anchorY="middle"
      >
        {dimensionValue.toFixed(1)}
      </Text>

      {(() => {
        const sidePanelInnerEdgeLeft = leftPanelX + panelThickness / 2;
        const sidePanelInnerEdgeRight = rightPanelX - panelThickness / 2;
        const backPanelLeftEdge = sidePanelInnerEdgeLeft - leftGrooveTotal;
        const backPanelRightEdge = sidePanelInnerEdgeRight + rightGrooveTotal;
        const widthDimZ = -cabinetDepth / 2 - 0.008;
        const widthTickLength = 0.006;
        const widthTextOffset = 0.012;

        const leftWidthDimValue = grooveDepth * 1000 + leftExtendValue;
        const rightWidthDimValue = grooveDepth * 1000 + rightExtendValue;

        const leftDimColor = leftExtendActive ? "#f97316" : "#666666";
        const rightDimColor = rightExtendActive ? "#f97316" : "#666666";

        return (
          <>
            <line key={`tick-start-width-left-${backPanelLeftEdge}`}>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  count={2}
                  array={new Float32Array([backPanelLeftEdge, dimY, widthDimZ, backPanelLeftEdge, dimY, widthDimZ - widthTickLength])}
                  itemSize={3}
                />
              </bufferGeometry>
              <lineBasicMaterial color={leftDimColor} linewidth={1} />
            </line>

            <line key={`tick-end-width-left-${sidePanelInnerEdgeLeft}`}>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  count={2}
                  array={new Float32Array([sidePanelInnerEdgeLeft, dimY, widthDimZ, sidePanelInnerEdgeLeft, dimY, widthDimZ - widthTickLength])}
                  itemSize={3}
                />
              </bufferGeometry>
              <lineBasicMaterial color={leftDimColor} linewidth={1} />
            </line>

            <Text
              position={[(backPanelLeftEdge + sidePanelInnerEdgeLeft) / 2, dimY, widthDimZ - widthTextOffset]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={0.008}
              color={leftDimColor}
              anchorX="center"
              anchorY="middle"
            >
              {leftWidthDimValue.toFixed(1)}
            </Text>

            {rightExtendValue > 0 && (
              <>
                <line key={`tick-start-width-right-${sidePanelInnerEdgeRight}`}>
                  <bufferGeometry>
                    <bufferAttribute
                      attach="attributes-position"
                      count={2}
                      array={new Float32Array([sidePanelInnerEdgeRight, dimY, widthDimZ, sidePanelInnerEdgeRight, dimY, widthDimZ - widthTickLength])}
                      itemSize={3}
                    />
                  </bufferGeometry>
                  <lineBasicMaterial color={rightDimColor} linewidth={1} />
                </line>

                <line key={`tick-end-width-right-${backPanelRightEdge}`}>
                  <bufferGeometry>
                    <bufferAttribute
                      attach="attributes-position"
                      count={2}
                      array={new Float32Array([backPanelRightEdge, dimY, widthDimZ, backPanelRightEdge, dimY, widthDimZ - widthTickLength])}
                      itemSize={3}
                    />
                  </bufferGeometry>
                  <lineBasicMaterial color={rightDimColor} linewidth={1} />
                </line>

                <Text
                  position={[(sidePanelInnerEdgeRight + backPanelRightEdge) / 2, dimY, widthDimZ - widthTextOffset]}
                  rotation={[-Math.PI / 2, 0, 0]}
                  fontSize={0.008}
                  color={rightDimColor}
                  anchorX="center"
                  anchorY="middle"
                >
                  {rightWidthDimValue.toFixed(1)}
                </Text>
              </>
            )}
          </>
        );
      })()}

      <ambientLight intensity={0.7} />
      <directionalLight position={[0, 5, 5]} intensity={0.6} />
      <directionalLight position={[0, 3, -5]} intensity={0.3} />
    </group>
  );
};

export function BackPanelSettings({
  profileId,
  isDefaultProfile = false,
  onSettingsSaved
}: BackPanelSettingsProps) {
  const [hasSettings, setHasSettings] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [looseWid, setLooseWid] = React.useState(0.5);
  const [looseDep, setLooseDep] = React.useState(1);
  const [backPanelThickness, setBackPanelThickness] = React.useState(8);
  const [grooveOffset, setGrooveOffset] = React.useState(12);
  const [grooveDepth, setGrooveDepth] = React.useState(8);
  const [profiles, setProfiles] = React.useState<GlobalSettingsProfile[]>([]);
  const [viewMode, setViewMode] = React.useState<'plan' | 'side'>('plan');
  const [isBackPanelSelected, setIsBackPanelSelected] = React.useState(false);

  const {
    backPanelLeftExtend,
    setBackPanelLeftExtend,
    backPanelRightExtend,
    setBackPanelRightExtend,
    showBackPanelLeftExtend,
    showBackPanelRightExtend,
    setShowBackPanelLeftExtend,
    setShowBackPanelRightExtend,
    backPanelTopExtend,
    setBackPanelTopExtend,
    backPanelBottomExtend,
    setBackPanelBottomExtend,
    showBackPanelTopExtend,
    showBackPanelBottomExtend,
    setShowBackPanelTopExtend,
    setShowBackPanelBottomExtend,
    leftPanelBackShorten,
    setLeftPanelBackShorten,
    rightPanelBackShorten,
    setRightPanelBackShorten,
    showLeftPanelBackShorten,
    showRightPanelBackShorten,
    setShowLeftPanelBackShorten,
    setShowRightPanelBackShorten,
    isLeftPanelSelected,
    setIsLeftPanelSelected,
    isRightPanelSelected,
    setIsRightPanelSelected,
    isTopPanelSelected,
    setIsTopPanelSelected,
    isBottomPanelSelected,
    setIsBottomPanelSelected,
    topPanelBackShorten,
    setTopPanelBackShorten,
    bottomPanelBackShorten,
    setBottomPanelBackShorten,
    showTopPanelBackShorten,
    showBottomPanelBackShorten,
    setShowTopPanelBackShorten,
    setShowBottomPanelBackShorten
  } = useAppStore();

  React.useEffect(() => {
    loadProfiles();
  }, []);

  React.useEffect(() => {
    if (profiles.length > 0) {
      loadProfileSettings();
    }
  }, [profileId, profiles]);

  const loadProfiles = async () => {
    try {
      const data = await globalSettingsService.listProfiles();
      setProfiles(data);
    } catch (error) {
      console.error('Failed to load profiles:', error);
      setProfiles([]);
    }
  };

  const loadProfileSettings = async () => {
    try {
      setLoading(true);
      const settings = await globalSettingsService.getProfileSettings(profileId, 'back_panel');

      if (settings && settings.settings) {
        setHasSettings(true);
        loadSettings(settings.settings as Record<string, unknown>);
      } else if (isDefaultProfile) {
        setHasSettings(true);
        resetToDefaults();
      } else {
        setHasSettings(false);
        resetToDefaults();
      }
    } catch (error) {
      console.error('Failed to load profile settings:', error);
      if (isDefaultProfile) {
        setHasSettings(true);
        resetToDefaults();
      } else {
        setHasSettings(false);
        resetToDefaults();
      }
    } finally {
      setLoading(false);
    }
  };

  const resetToDefaults = () => {
    setLooseWid(0.5);
    setLooseDep(1);
    setBackPanelThickness(8);
    setGrooveOffset(12);
    setGrooveDepth(8);
  };

  const loadSettings = (settings: Record<string, unknown>) => {
    if (settings.looseWid !== undefined)
      setLooseWid(settings.looseWid as number);
    if (settings.looseDep !== undefined)
      setLooseDep(settings.looseDep as number);
    if (settings.backPanelThickness !== undefined)
      setBackPanelThickness(settings.backPanelThickness as number);
    if (settings.grooveOffset !== undefined)
      setGrooveOffset(settings.grooveOffset as number);
    if (settings.grooveDepth !== undefined)
      setGrooveDepth(settings.grooveDepth as number);
  };

  const getCurrentSettings = () => ({
    looseWid,
    looseDep,
    backPanelThickness,
    grooveOffset,
    grooveDepth
  });

  const handleSave = async () => {
    try {
      await globalSettingsService.saveProfileSettings(profileId, 'back_panel', getCurrentSettings());
      setHasSettings(true);
      if (onSettingsSaved) {
        onSettingsSaved();
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      alert('Failed to save settings');
    }
  };

  const handleSaveAs = async (targetProfileId: string, _profileName: string) => {
    try {
      await globalSettingsService.saveProfileSettings(targetProfileId, 'back_panel', getCurrentSettings());
      if (onSettingsSaved) {
        onSettingsSaved();
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      alert('Failed to save settings');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-stone-400 text-sm">
        Loading...
      </div>
    );
  }

  if (!hasSettings) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-stone-400">
        <p className="text-sm mb-4">No back panel settings saved for this profile.</p>
        <button
          onClick={() => {
            setHasSettings(true);
            resetToDefaults();
          }}
          className="px-4 py-2 bg-orange-500 text-white text-xs font-medium rounded hover:bg-orange-600 transition-colors"
        >
          Create Settings
        </button>
      </div>
    );
  }

  return (
    <div className="border border-stone-200 rounded-lg p-3 bg-white flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        <div className="h-80 border border-stone-200 rounded overflow-hidden mb-3">
          <Canvas>
            <color attach="background" args={['#ffffff']} />
            {viewMode === 'plan' ? (
              <OrthographicCamera makeDefault position={[0, 1, 0]} rotation={[-Math.PI / 2, 0, 0]} zoom={1800} />
            ) : (
              <OrthographicCamera makeDefault position={[-1, 0, 0]} rotation={[0, -Math.PI / 2, 0]} zoom={1800} />
            )}
            <CabinetTopView
              backrestThickness={backPanelThickness / 1000}
              grooveOffset={grooveOffset / 1000}
              grooveDepth={grooveDepth / 1000}
              looseWid={looseWid / 1000}
              viewMode={viewMode}
              isSelected={isBackPanelSelected}
              onSelect={() => {
                if (isBackPanelSelected) {
                  setShowBackPanelLeftExtend(false);
                  setShowBackPanelRightExtend(false);
                  setShowBackPanelTopExtend(false);
                  setShowBackPanelBottomExtend(false);
                }
                setIsLeftPanelSelected(false);
                setIsRightPanelSelected(false);
                setShowLeftPanelBackShorten(false);
                setShowRightPanelBackShorten(false);
                setIsTopPanelSelected(false);
                setIsBottomPanelSelected(false);
                setShowTopPanelBackShorten(false);
                setShowBottomPanelBackShorten(false);
                setIsBackPanelSelected(!isBackPanelSelected);
              }}
              onLeftArrowClick={() => setShowBackPanelLeftExtend(!showBackPanelLeftExtend)}
              onRightArrowClick={() => setShowBackPanelRightExtend(!showBackPanelRightExtend)}
              leftExtendActive={showBackPanelLeftExtend || backPanelLeftExtend > 0}
              rightExtendActive={showBackPanelRightExtend || backPanelRightExtend > 0}
              leftExtendValue={backPanelLeftExtend}
              rightExtendValue={backPanelRightExtend}
              isLeftPanelSelected={isLeftPanelSelected}
              isRightPanelSelected={isRightPanelSelected}
              onLeftPanelSelect={() => {
                setIsBackPanelSelected(false);
                setShowBackPanelLeftExtend(false);
                setShowBackPanelRightExtend(false);
                setShowBackPanelTopExtend(false);
                setShowBackPanelBottomExtend(false);
                setIsRightPanelSelected(false);
                setShowRightPanelBackShorten(false);
                setIsTopPanelSelected(false);
                setIsBottomPanelSelected(false);
                setShowTopPanelBackShorten(false);
                setShowBottomPanelBackShorten(false);
                setIsLeftPanelSelected(!isLeftPanelSelected);
                setShowLeftPanelBackShorten(!isLeftPanelSelected);
              }}
              onRightPanelSelect={() => {
                setIsBackPanelSelected(false);
                setShowBackPanelLeftExtend(false);
                setShowBackPanelRightExtend(false);
                setShowBackPanelTopExtend(false);
                setShowBackPanelBottomExtend(false);
                setIsLeftPanelSelected(false);
                setShowLeftPanelBackShorten(false);
                setIsTopPanelSelected(false);
                setIsBottomPanelSelected(false);
                setShowTopPanelBackShorten(false);
                setShowBottomPanelBackShorten(false);
                setIsRightPanelSelected(!isRightPanelSelected);
                setShowRightPanelBackShorten(!isRightPanelSelected);
              }}
              onLeftPanelArrowClick={() => setShowLeftPanelBackShorten(!showLeftPanelBackShorten)}
              onRightPanelArrowClick={() => setShowRightPanelBackShorten(!showRightPanelBackShorten)}
              leftPanelShortenActive={showLeftPanelBackShorten || leftPanelBackShorten > 0}
              rightPanelShortenActive={showRightPanelBackShorten || rightPanelBackShorten > 0}
              leftPanelShortenValue={leftPanelBackShorten}
              rightPanelShortenValue={rightPanelBackShorten}
              onTopArrowClick={() => setShowBackPanelTopExtend(!showBackPanelTopExtend)}
              onBottomArrowClick={() => setShowBackPanelBottomExtend(!showBackPanelBottomExtend)}
              topExtendActive={showBackPanelTopExtend || backPanelTopExtend > 0}
              bottomExtendActive={showBackPanelBottomExtend || backPanelBottomExtend > 0}
              topExtendValue={backPanelTopExtend}
              bottomExtendValue={backPanelBottomExtend}
              isTopPanelSelected={isTopPanelSelected}
              isBottomPanelSelected={isBottomPanelSelected}
              onTopPanelSelect={() => {
                setIsBackPanelSelected(false);
                setShowBackPanelLeftExtend(false);
                setShowBackPanelRightExtend(false);
                setShowBackPanelTopExtend(false);
                setShowBackPanelBottomExtend(false);
                setIsLeftPanelSelected(false);
                setIsRightPanelSelected(false);
                setShowLeftPanelBackShorten(false);
                setShowRightPanelBackShorten(false);
                setIsBottomPanelSelected(false);
                setShowBottomPanelBackShorten(false);
                setIsTopPanelSelected(!isTopPanelSelected);
                setShowTopPanelBackShorten(!isTopPanelSelected);
              }}
              onBottomPanelSelect={() => {
                setIsBackPanelSelected(false);
                setShowBackPanelLeftExtend(false);
                setShowBackPanelRightExtend(false);
                setShowBackPanelTopExtend(false);
                setShowBackPanelBottomExtend(false);
                setIsLeftPanelSelected(false);
                setIsRightPanelSelected(false);
                setShowLeftPanelBackShorten(false);
                setShowRightPanelBackShorten(false);
                setIsTopPanelSelected(false);
                setShowTopPanelBackShorten(false);
                setIsBottomPanelSelected(!isBottomPanelSelected);
                setShowBottomPanelBackShorten(!isBottomPanelSelected);
              }}
              onTopPanelArrowClick={() => setShowTopPanelBackShorten(!showTopPanelBackShorten)}
              onBottomPanelArrowClick={() => setShowBottomPanelBackShorten(!showBottomPanelBackShorten)}
              topPanelShortenActive={showTopPanelBackShorten || topPanelBackShorten > 0}
              bottomPanelShortenActive={showBottomPanelBackShorten || bottomPanelBackShorten > 0}
              topPanelShortenValue={topPanelBackShorten}
              bottomPanelShortenValue={bottomPanelBackShorten}
            />
          </Canvas>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <p className="text-xs text-slate-600">View:</p>
          <select
            value={viewMode}
            onChange={(e) => setViewMode(e.target.value as 'plan' | 'side')}
            className="text-xs px-2 py-1 bg-transparent border-none focus:outline-none cursor-pointer text-slate-700"
          >
            <option value="plan">Plan</option>
            <option value="side">Side</option>
          </select>
        </div>

        <div className="space-y-1 pt-2 border-t border-stone-200">
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-600">Loosewid</label>
            <input
              type="number"
              value={looseWid}
              onChange={(e) => setLooseWid(Number(e.target.value))}
              step="0.1"
              className="text-xs px-2 py-0.5 w-16 border border-stone-300 rounded focus:outline-none focus:border-orange-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-600">Loosedep</label>
            <input
              type="number"
              value={looseDep}
              onChange={(e) => setLooseDep(Number(e.target.value))}
              step="0.1"
              className="text-xs px-2 py-0.5 w-16 border border-stone-300 rounded focus:outline-none focus:border-orange-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-600">Back panel thickness</label>
            <input
              type="number"
              value={backPanelThickness}
              onChange={(e) => setBackPanelThickness(Number(e.target.value))}
              step="0.1"
              className="text-xs px-2 py-0.5 w-16 border border-stone-300 rounded focus:outline-none focus:border-orange-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-600">Groove offset</label>
            <input
              type="number"
              value={grooveOffset}
              onChange={(e) => setGrooveOffset(Number(e.target.value))}
              step="0.1"
              className="text-xs px-2 py-0.5 w-16 border border-stone-300 rounded focus:outline-none focus:border-orange-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-600">Groove depth</label>
            <input
              type="number"
              value={grooveDepth}
              onChange={(e) => setGrooveDepth(Number(e.target.value))}
              step="0.1"
              className="text-xs px-2 py-0.5 w-16 border border-stone-300 rounded focus:outline-none focus:border-orange-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>

          {showLeftPanelBackShorten && (
            <div className="flex items-center justify-between">
              <label className="text-xs text-red-600 font-medium">Left panel back shorten</label>
              <input
                type="number"
                value={leftPanelBackShorten}
                onChange={(e) => setLeftPanelBackShorten(Number(e.target.value))}
                step="0.1"
                className="text-xs px-2 py-0.5 w-16 border border-red-400 rounded focus:outline-none focus:border-red-500 bg-red-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          )}

          {showRightPanelBackShorten && (
            <div className="flex items-center justify-between">
              <label className="text-xs text-red-600 font-medium">Right panel back shorten</label>
              <input
                type="number"
                value={rightPanelBackShorten}
                onChange={(e) => setRightPanelBackShorten(Number(e.target.value))}
                step="0.1"
                className="text-xs px-2 py-0.5 w-16 border border-red-400 rounded focus:outline-none focus:border-red-500 bg-red-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          )}

          {showBackPanelLeftExtend && (
            <div className="flex items-center justify-between">
              <label className="text-xs text-orange-600 font-medium">Back panel left extend</label>
              <input
                type="number"
                value={backPanelLeftExtend}
                onChange={(e) => setBackPanelLeftExtend(Number(e.target.value))}
                step="0.1"
                className="text-xs px-2 py-0.5 w-16 border border-orange-400 rounded focus:outline-none focus:border-orange-500 bg-orange-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          )}

          {showBackPanelRightExtend && (
            <div className="flex items-center justify-between">
              <label className="text-xs text-orange-600 font-medium">Back panel right extend</label>
              <input
                type="number"
                value={backPanelRightExtend}
                onChange={(e) => setBackPanelRightExtend(Number(e.target.value))}
                step="0.1"
                className="text-xs px-2 py-0.5 w-16 border border-orange-400 rounded focus:outline-none focus:border-orange-500 bg-orange-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          )}

          {showBackPanelTopExtend && (
            <div className="flex items-center justify-between">
              <label className="text-xs text-orange-600 font-medium">Back panel top extend</label>
              <input
                type="number"
                value={backPanelTopExtend}
                onChange={(e) => setBackPanelTopExtend(Number(e.target.value))}
                step="0.1"
                className="text-xs px-2 py-0.5 w-16 border border-orange-400 rounded focus:outline-none focus:border-orange-500 bg-orange-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          )}

          {showBackPanelBottomExtend && (
            <div className="flex items-center justify-between">
              <label className="text-xs text-orange-600 font-medium">Back panel bottom extend</label>
              <input
                type="number"
                value={backPanelBottomExtend}
                onChange={(e) => setBackPanelBottomExtend(Number(e.target.value))}
                step="0.1"
                className="text-xs px-2 py-0.5 w-16 border border-orange-400 rounded focus:outline-none focus:border-orange-500 bg-orange-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          )}

          {showTopPanelBackShorten && (
            <div className="flex items-center justify-between">
              <label className="text-xs text-red-600 font-medium">Top panel back shorten</label>
              <input
                type="number"
                value={topPanelBackShorten}
                onChange={(e) => setTopPanelBackShorten(Number(e.target.value))}
                step="0.1"
                className="text-xs px-2 py-0.5 w-16 border border-red-400 rounded focus:outline-none focus:border-red-500 bg-red-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          )}

          {showBottomPanelBackShorten && (
            <div className="flex items-center justify-between">
              <label className="text-xs text-red-600 font-medium">Bottom panel back shorten</label>
              <input
                type="number"
                value={bottomPanelBackShorten}
                onChange={(e) => setBottomPanelBackShorten(Number(e.target.value))}
                step="0.1"
                className="text-xs px-2 py-0.5 w-16 border border-red-400 rounded focus:outline-none focus:border-red-500 bg-red-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          )}
        </div>
      </div>

      <SaveButtons
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        profiles={profiles}
        currentProfileId={profileId}
      />
    </div>
  );
}
