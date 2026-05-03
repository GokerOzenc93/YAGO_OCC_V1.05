import React from 'react';

// Registry: icon name → public path
const ICONS = {
  'add-box': '/icons/add-box.svg',
  'subtract-box': '/icons/subtract-box.svg',
  'camera-perspective': '/icons/camera-perspective.svg',
  'camera-orthographic': '/icons/camera-orthographic.svg',
  'view-solid': '/icons/view-solid.svg',
  'view-wireframe': '/icons/view-wireframe.svg',
  'view-xray': '/icons/view-xray.svg',
} as const;

type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export const Icon: React.FC<IconProps> = ({ name, size = 22, className = '' }) => (
  <img
    src={ICONS[name]}
    width={size}
    height={size}
    alt={name}
    className={className}
    draggable={false}
  />
);

interface IconButtonProps {
  icon: IconName;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export const IconButton: React.FC<IconButtonProps> = ({
  icon, title, onClick, disabled = false, className = '',
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`flex items-center justify-center w-[32px] h-[32px] rounded transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-stone-400 hover:bg-stone-100 active:scale-95 ${
      disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'
    } ${className}`}
    title={title}
  >
    <Icon name={icon} />
  </button>
);

// Named convenience exports
export const AddBoxButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="add-box" title="Kutu Ekle (B)" {...props} />
);

export const SubtractBoxButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="subtract-box" title="Kesişen Şekilleri Çıkar" {...props} />
);

export const CameraPerspectiveButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="camera-perspective" title="Perspektif Görünüm" {...props} />
);

export const CameraOrthographicButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="camera-orthographic" title="Ortografik Görünüm" {...props} />
);

export const ViewSolidButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="view-solid" title="Solid Görünüm" {...props} />
);

export const ViewWireframeButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="view-wireframe" title="Wireframe Görünüm" {...props} />
);

export const ViewXRayButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="view-xray" title="X-Ray Görünüm" {...props} />
);
