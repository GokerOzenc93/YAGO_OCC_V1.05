import React from 'react';

interface IconButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export const AddBoxButton: React.FC<IconButtonProps> = ({ onClick, disabled = false, className = '' }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`flex items-center justify-center w-8 h-8 rounded transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-stone-400 hover:bg-stone-100 active:scale-95 ${
      disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'
    } ${className}`}
    title="Kutu Ekle (B)"
  >
    <svg width="19" height="19" viewBox="0 0 19 19" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 0.360001C1 0.161178 1.16118 0 1.36 0H18.64C18.8388 0 19 0.161178 19 0.36V17.64C19 17.8388 18.8388 18 18.64 18H1.36C1.16118 18 1 17.8388 1 17.64V0.360001Z" fill="#ffffff"/>
      <path d="M2.44 6.12V16.56H12.52V6.12H2.44Z" stroke="black" strokeWidth="1.0"/>
      <path d="M2.44 6.12L7.3 1.98M12.52 6.12L17.02 1.98M12.52 16.56L17.02 12.24" stroke="black" strokeWidth="1.0"/>
      <path d="M7.3 1.98H17.02V12.24" stroke="black" strokeWidth="1.0"/>
      <g style={{ mixBlendMode: 'plus-darker' }}>
        <path d="M6.765 11.995H3.075V10.765H6.765V7.075H7.995V10.765H11.685V11.995H7.995V15.685H6.765V11.995Z" fill="#FF8D28"/>
      </g>
    </svg>
  </button>
);
