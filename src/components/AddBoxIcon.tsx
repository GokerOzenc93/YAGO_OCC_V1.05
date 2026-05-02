import React from 'react';

interface AddBoxProps {
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

const AddBox: React.FC<AddBoxProps> = ({ onClick, disabled = false, className = '' }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`relative flex items-center justify-center w-10 h-10 rounded transition-all duration-150 group outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-red-300 ${
      disabled
        ? 'opacity-30 cursor-not-allowed'
        : 'bg-red-500 hover:bg-red-600 active:scale-95 shadow hover:shadow-md text-white'
    } ${className}`}
    title="Kutu Ekle (B)"
  >
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="transition-transform duration-150"
    >
      <g fill="currentColor">
        {/* Main square box */}
        <rect x="3" y="3" width="18" height="18" rx="1" fillOpacity="0.9" />
        {/* Plus sign center */}
        <rect x="11" y="7" width="2" height="10" rx="1" />
        <rect x="7" y="11" width="10" height="2" rx="1" />
      </g>
    </svg>
  </button>
);

export default AddBox;
