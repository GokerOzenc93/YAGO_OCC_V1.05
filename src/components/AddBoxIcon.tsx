import React from 'react';

interface AddBoxIconProps {
  size?: number;
  className?: string;
}

const AddBoxIcon: React.FC<AddBoxIconProps> = ({ size = 24, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <rect x="3" y="3" width="18" height="18" rx="1" stroke="currentColor" strokeWidth="2" />
    <line x1="12" y1="8" x2="12" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export default AddBoxIcon;
