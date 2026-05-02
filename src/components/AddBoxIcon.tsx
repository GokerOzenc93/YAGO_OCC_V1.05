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
    className={`flex items-center justify-center w-8 h-8 rounded transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-stone-400 hover:bg-stone-100 active:scale-95 ${
      disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'
    } ${className}`}
    title="Kutu Ekle (B)"
  >
    <svg width="19" height="19" viewBox="0 0 19 19" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M0.730769 0.365385C0.730769 0.163589 0.894358 0 1.09615 0H18.6346C18.8364 0 19 0.163588 19 0.365385V17.9038C19 18.1056 18.8364 18.2692 18.6346 18.2692H1.09615C0.894358 18.2692 0.730769 18.1056 0.730769 17.9038V0.365385Z" fill="#F0EBEB"/>
      <path d="M2.19231 6.21154V16.8077H12.4231V6.21154H2.19231Z" stroke="black" strokeWidth="0.216"/>
      <path d="M2.19231 6.21154L7.125 2.00962M12.4231 6.21154L16.9904 2.00962M12.4231 16.8077L16.9904 12.4231" stroke="black" strokeWidth="0.216"/>
      <path d="M7.125 2.00962H16.9904V12.4231" stroke="black" strokeWidth="0.216"/>
      <g style={{ mixBlendMode: 'plus-darker' }}>
        <path d="M6.86619 12.1338H3.12099V10.8854H6.86619V7.14022H8.11458V10.8854H11.8598V12.1338H8.11458V15.879H6.86619V12.1338Z" fill="#FF383C"/>
      </g>
    </svg>
  </button>
);

export default AddBox;
