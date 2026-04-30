import React, { useState, useRef, useCallback, useEffect } from 'react';
import { SlidersHorizontal, PanelLeft, ChevronLeft } from 'lucide-react';
import { useAppStore } from '../store';

interface LeftSidebarProps {
  parametersContent: React.ReactNode;
  panelEditorContent: React.ReactNode;
}

type SidebarTab = 'parameters' | 'panel-editor';

const LeftSidebar: React.FC<LeftSidebarProps> = ({ parametersContent, panelEditorContent }) => {
  const { selectedShapeId } = useAppStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>('panel-editor');
  const sidebarRef = useRef<HTMLDivElement>(null);
  const hoverZoneRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    if (isPinned) return;
    cancelClose();
    closeTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 300);
  }, [isPinned, cancelClose]);

  const handleMouseEnter = useCallback(() => {
    cancelClose();
    setIsOpen(true);
  }, [cancelClose]);

  const handleMouseLeave = useCallback(() => {
    scheduleClose();
  }, [scheduleClose]);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  const sidebarWidth = 365;

  return (
    <>
      {!isOpen && !isPinned && (
        <div
          ref={hoverZoneRef}
          className="fixed left-0 w-[6px] z-40 group cursor-pointer"
          style={{ top: '110px', bottom: '80px' }}
          onMouseEnter={handleMouseEnter}
        >
          <div className="absolute inset-0 bg-gradient-to-r from-stone-300/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
          <div className="absolute left-0 top-1/2 -translate-y-1/2 flex flex-col gap-3 py-4 px-[2px]">
            <div className="w-[3px] h-6 rounded-full bg-stone-300 group-hover:bg-orange-400 transition-colors duration-200" />
            <div className="w-[3px] h-6 rounded-full bg-stone-300 group-hover:bg-orange-400 transition-colors duration-200" />
          </div>
        </div>
      )}

      <div
        ref={sidebarRef}
        className="fixed z-40 flex transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{
          top: '110px',
          bottom: '80px',
          left: 0,
          width: `${sidebarWidth}px`,
          transform: isOpen || isPinned ? 'translateX(0)' : `translateX(-${sidebarWidth}px)`,
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex flex-col w-full h-full bg-white border-r border-stone-200 shadow-xl shadow-stone-300/30">
          <div className="flex items-center h-9 border-b border-stone-200 bg-stone-50 shrink-0">
            <button
              onClick={() => setActiveTab('parameters')}
              className={`flex-1 h-full flex items-center justify-center gap-1.5 text-xs font-semibold transition-all duration-150 border-b-2 ${
                activeTab === 'parameters'
                  ? 'text-orange-600 border-orange-500 bg-white'
                  : 'text-stone-500 border-transparent hover:text-stone-700 hover:bg-stone-100'
              }`}
            >
              <SlidersHorizontal size={13} />
              <span>Parameters</span>
            </button>
            <div className="w-px h-5 bg-stone-200" />
            <button
              onClick={() => setActiveTab('panel-editor')}
              className={`flex-1 h-full flex items-center justify-center gap-1.5 text-xs font-semibold transition-all duration-150 border-b-2 ${
                activeTab === 'panel-editor'
                  ? 'text-orange-600 border-orange-500 bg-white'
                  : 'text-stone-500 border-transparent hover:text-stone-700 hover:bg-stone-100'
              }`}
            >
              <PanelLeft size={13} />
              <span>Panel Editor</span>
            </button>
            <div className="w-px h-5 bg-stone-200" />
            <button
              onClick={() => {
                if (isPinned) {
                  setIsPinned(false);
                  setIsOpen(false);
                } else {
                  setIsPinned(true);
                }
              }}
              className={`w-9 h-full flex items-center justify-center transition-colors duration-150 ${
                isPinned
                  ? 'text-orange-500 bg-orange-50 hover:bg-orange-100'
                  : 'text-stone-400 hover:text-stone-600 hover:bg-stone-100'
              }`}
              title={isPinned ? 'Unpin sidebar' : 'Pin sidebar'}
            >
              <ChevronLeft size={14} className={`transition-transform duration-200 ${isPinned ? '' : 'rotate-180'}`} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            <div className={activeTab === 'parameters' ? '' : 'hidden'}>
              {selectedShapeId ? parametersContent : (
                <div className="flex items-center justify-center h-32 text-xs text-stone-400">
                  No shape selected
                </div>
              )}
            </div>
            <div className={activeTab === 'panel-editor' ? '' : 'hidden'}>
              {selectedShapeId ? panelEditorContent : (
                <div className="flex items-center justify-center h-32 text-xs text-stone-400">
                  No shape selected
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {isOpen && !isPinned && (
        <div
          className="fixed inset-0 z-30"
          onMouseEnter={handleMouseLeave}
          style={{ pointerEvents: 'none' }}
        />
      )}
    </>
  );
};

export default LeftSidebar;
