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
    className={`relative flex items-center justify-center w-10 h-10 rounded-lg transition-all duration-150 group outline-none focus-visible:ring-2 focus-visible:ring-orange-200 ${
      disabled
        ? 'opacity-30 cursor-not-allowed'
        : 'bg-gradient-to-br from-red-400 to-red-500 hover:from-red-500 hover:to-red-600 active:scale-95 shadow-md hover:shadow-lg text-white'
    } ${className}`}
    title="Kutu Ekle (B)"
  >
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="transition-transform duration-150 group-active:scale-110"
    >
      {/* Outer box */}
      <rect x="3" y="8" width="7" height="7" rx="0.5" fill="currentColor" opacity="0.8" />
      {/* Inner corners */}
      <rect x="13" y="2" width="8" height="8" rx="0.5" fill="currentColor" opacity="0.6" />
      <rect x="3" y="16" width="8" height="6" rx="0.5" fill="currentColor" opacity="0.7" />
      {/* Plus sign */}
      <line x1="12" y1="16" x2="12" y2="24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="8" y1="20" x2="16" y2="20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  </button>
);

export default AddBox;
