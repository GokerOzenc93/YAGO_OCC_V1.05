import React from 'react';

// Registry: icon name → public path
const ICONS = {
  'add-box': '/icons/add-box.svg',
} as const;

type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export const Icon: React.FC<IconProps> = ({ name, size = 19, className = '' }) => (
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
    className={`flex items-center justify-center w-7 h-7 rounded transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-stone-400 hover:bg-stone-100 active:scale-95 ${
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
