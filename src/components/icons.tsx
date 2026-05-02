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
    className={`flex items-center justify-center w-7 h-7 rounded transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-stone-400 hover:bg-stone-100 active:scale-55 ${
      disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'
    } ${className}`}
    title="Kutu Ekle (B)"
  >
    <svg width="25" height="25" viewBox="0 0 25 25" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M4 3.36C4 3.16118 4.16118 3 4.36 3H21.64C21.8388 3 22 3.16118 22 3.36V20.64C22 20.8388 21.8388 21 21.64 21H4.36C4.16118 21 4 20.8388 4 20.64V3.36Z" fill="#F0EBEB"/>
<path d="M5.44 9.12V19.56H15.52V9.12H5.44Z" stroke="black" stroke-width="0.7"/>
<path d="M5.44 9.12L10.3 4.98M15.52 9.12L20.02 4.98M15.52 19.56L20.02 15.24" stroke="black" stroke-width="0.7"/>
<path d="M10.3 4.98H20.02V15.24" stroke="black" stroke-width="0.7"/>
<g style="mix-blend-mode:plus-darker">
<path d="M11.4583 13.5417H5.20833V11.4583H11.4583V5.20833H13.5417V11.4583H19.7917V13.5417H13.5417V19.7917H11.4583V13.5417Z" fill="#FF8D28"/>
</g>
</svg>
  </button>
);

<svg width="25" height="25" viewBox="0 0 25 25" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M4 3.36C4 3.16118 4.16118 3 4.36 3H21.64C21.8388 3 22 3.16118 22 3.36V20.64C22 20.8388 21.8388 21 21.64 21H4.36C4.16118 21 4 20.8388 4 20.64V3.36Z" fill="#F0EBEB"/>
<path d="M5.44 9.12V19.56H15.52V9.12H5.44Z" stroke="black" stroke-width="0.7"/>
<path d="M5.44 9.12L10.3 4.98M15.52 9.12L20.02 4.98M15.52 19.56L20.02 15.24" stroke="black" stroke-width="0.7"/>
<path d="M10.3 4.98H20.02V15.24" stroke="black" stroke-width="0.7"/>
<g style="mix-blend-mode:plus-darker">
<path d="M11.4583 13.5417H5.20833V11.4583H11.4583V5.20833H13.5417V11.4583H19.7917V13.5417H13.5417V19.7917H11.4583V13.5417Z" fill="#FF8D28"/>
</g>
</svg>
