import React, { useState, useRef, useCallback, useEffect } from 'react';
import { SlidersHorizontal, PanelLeft, Pin, PinOff } from 'lucide-react';
import { useAppStore } from '../store';

interface LeftSidebarProps {
  parametersContent: React.ReactNode;
  panelEditorContent: React.ReactNode;
}

type SidebarTab = 'parameters' | 'panel-editor';

/* ─── Toolbar token sistemiyle uyumlu ─── */
const T = {
  /* sidebar yüzeyi — toolbar header ile aynı krem-beyaz */
  bg:          '#fdfcfa',
  /* tab strip — toolbar Row 2 ile aynı */
  tabStripBg:  'linear-gradient(180deg,#faf9f6 0%,#f4f2ee 100%)',
  /* borders */
  border:      '#e4dfd7',
  borderSoft:  'rgba(60,50,40,0.08)',
  /* shadows */
  panelShadow: '4px 0 24px -8px rgba(40,30,20,0.10),2px 0 8px -4px rgba(40,30,20,0.06),1px 0 0 0 rgba(60,50,40,0.06)',
  topShine:    'inset 0 1px 0 rgba(255,255,255,0.7)',
  /* text */
  labelIdle:   '#9c9590',
  labelHover:  '#44403c',
  labelActive: '#d9540a',
  /* accent */
  accent:      '#ea580c',
  accentSoft:  '#fff7ed',
  /* hover zone indicator */
  hintIdle:    '#cfc8be',
  hintHover:   '#f97316',
  /* divider gradients */
  divH:        'linear-gradient(to right,transparent,rgba(60,50,40,0.12) 20%,rgba(60,50,40,0.12) 80%,transparent)',
  divV:        'linear-gradient(to bottom,transparent,rgba(60,50,40,0.14) 30%,rgba(60,50,40,0.14) 70%,transparent)',
};

/* ─── Tab button ─── */
const TabBtn: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}> = ({ active, onClick, icon, label }) => {
  const [hov, setHov] = useState(false);

  const color = active ? T.labelActive : hov ? T.labelHover : T.labelIdle;
  const bg = active
    ? 'linear-gradient(180deg,#ffffff 0%,#fdfbf7 100%)'
    : hov
      ? 'rgba(60,50,40,0.04)'
      : 'transparent';

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        flex: 1, height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: '7px',
        background: bg,
        border: 'none', cursor: 'pointer', outline: 'none',
        position: 'relative',
        color,
        fontSize: '12px',
        fontWeight: active ? 600 : 500,
        letterSpacing: active ? '-0.005em' : '0.015em',
        fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
        transition: 'color 0.12s,background 0.12s',
      }}
    >
      {icon}
      <span>{label}</span>

      {/* Active underline — gradient pill */}
      {active && (
        <div style={{
          position: 'absolute',
          bottom: '-1px', left: '50%', transform: 'translateX(-50%)',
          width: '70%', height: '2px',
          background: 'linear-gradient(90deg,transparent,#f97316 50%,transparent)',
          borderRadius: '99px',
        }} />
      )}
    </button>
  );
};

const LeftSidebar: React.FC<LeftSidebarProps> = ({ parametersContent, panelEditorContent }) => {
  const { selectedShapeId } = useAppStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>('panel-editor');
  const [pinHover, setPinHover] = useState(false);
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
    closeTimeoutRef.current = setTimeout(() => setIsOpen(false), 300);
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
      {/* ── Hover zone indicator (closed state) ── */}
      {!isOpen && !isPinned && (
        <div
          ref={hoverZoneRef}
          className="fixed left-0 z-40 group cursor-pointer"
          style={{ top: '120px', bottom: '64px', width: '8px' }}
          onMouseEnter={handleMouseEnter}
        >
          {/* Soft fade hint on hover */}
          <div
            className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
            style={{
              background: 'linear-gradient(to right,rgba(60,50,40,0.08),transparent)',
            }}
          />
          {/* Vertical "grip" pill */}
          <div
            className="absolute left-[1px] top-1/2 -translate-y-1/2 transition-all duration-200 group-hover:left-[2px]"
            style={{
              width: '3px',
              height: '44px',
              borderRadius: '99px',
              background: T.hintIdle,
              boxShadow: '0 1px 2px rgba(40,30,20,0.08)',
            }}
          />
          {/* Active accent on hover */}
          <div
            className="absolute left-[1px] top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-all duration-200 group-hover:left-[2px]"
            style={{
              width: '3px',
              height: '44px',
              borderRadius: '99px',
              background: 'linear-gradient(180deg,#fb923c,#ea580c)',
              boxShadow: '0 0 8px rgba(249,115,22,0.5),0 1px 2px rgba(40,30,20,0.15)',
            }}
          />
        </div>
      )}

      {/* ── Sidebar panel ── */}
      <div
        ref={sidebarRef}
        className="fixed z-40 flex transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{
          top: '120px',
          bottom: '64px',
          left: 0,
          width: `${sidebarWidth}px`,
          transform: isOpen || isPinned ? 'translateX(0)' : `translateX(-${sidebarWidth}px)`,
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            background: T.bg,
            borderRight: `1px solid ${T.border}`,
            boxShadow: T.panelShadow,
            fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
          }}
        >
          {/* ── Tab strip ── */}
          <div style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            height: '36px',
            background: T.tabStripBg,
            borderBottom: `1px solid ${T.border}`,
            boxShadow: T.topShine,
            flexShrink: 0,
          }}>
            <TabBtn
              active={activeTab === 'parameters'}
              onClick={() => setActiveTab('parameters')}
              icon={<SlidersHorizontal size={13} strokeWidth={2} />}
              label="Parameters"
            />

            <div style={{ width: '1px', height: '18px', background: T.divV, flexShrink: 0 }} />

            <TabBtn
              active={activeTab === 'panel-editor'}
              onClick={() => setActiveTab('panel-editor')}
              icon={<PanelLeft size={13} strokeWidth={2} />}
              label="Panel Editor"
            />

            <div style={{ width: '1px', height: '18px', background: T.divV, flexShrink: 0 }} />

            {/* Pin button */}
            <button
              onClick={() => {
                if (isPinned) { setIsPinned(false); setIsOpen(false); }
                else setIsPinned(true);
              }}
              onMouseEnter={() => setPinHover(true)}
              onMouseLeave={() => setPinHover(false)}
              title={isPinned ? 'Sabitlemeyi kaldır' : 'Paneli sabitle'}
              style={{
                width: '36px', height: '100%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: 'none', outline: 'none', cursor: 'pointer',
                background: isPinned
                  ? T.accentSoft
                  : pinHover
                    ? 'rgba(60,50,40,0.05)'
                    : 'transparent',
                color: isPinned ? T.accent : pinHover ? T.labelHover : T.labelIdle,
                transition: 'background 0.12s,color 0.12s,transform 0.15s',
                transform: pinHover && !isPinned ? 'rotate(-12deg)' : 'rotate(0deg)',
              }}
            >
              {isPinned ? <Pin size={14} strokeWidth={2.2} /> : <PinOff size={14} strokeWidth={2} />}
            </button>
          </div>

          {/* ── Content area ── */}
          <div
            className="custom-scrollbar"
            style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              background: T.bg,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6)',
            }}
          >
            <div style={{ display: activeTab === 'parameters' ? 'block' : 'none' }}>
              {selectedShapeId ? parametersContent : (
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  height: '160px', gap: '8px', padding: '0 24px', textAlign: 'center',
                }}>
                  <div style={{
                    width: '36px', height: '36px', borderRadius: '50%',
                    background: 'rgba(60,50,40,0.05)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <SlidersHorizontal size={16} style={{ color: T.labelIdle }} strokeWidth={1.5} />
                  </div>
                  <span style={{
                    color: T.labelIdle, fontSize: '12px', fontWeight: 500, letterSpacing: '0.01em',
                  }}>
                    Henüz şekil seçilmedi
                  </span>
                  <span style={{
                    color: '#c9c4be', fontSize: '11px', fontWeight: 400,
                    letterSpacing: '0.02em', lineHeight: 1.5,
                  }}>
                    Görüntü alanından bir nesne seçin
                  </span>
                </div>
              )}
            </div>

            <div style={{ display: activeTab === 'panel-editor' ? 'block' : 'none' }}>
              {selectedShapeId ? panelEditorContent : (
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  height: '160px', gap: '8px', padding: '0 24px', textAlign: 'center',
                }}>
                  <div style={{
                    width: '36px', height: '36px', borderRadius: '50%',
                    background: 'rgba(60,50,40,0.05)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <PanelLeft size={16} style={{ color: T.labelIdle }} strokeWidth={1.5} />
                  </div>
                  <span style={{
                    color: T.labelIdle, fontSize: '12px', fontWeight: 500, letterSpacing: '0.01em',
                  }}>
                    Henüz şekil seçilmedi
                  </span>
                  <span style={{
                    color: '#c9c4be', fontSize: '11px', fontWeight: 400,
                    letterSpacing: '0.02em', lineHeight: 1.5,
                  }}>
                    Düzenlemek için bir panel seçin
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Custom scrollbar style */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 8px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(60,50,40,0.18);
          border-radius: 99px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(60,50,40,0.32);
          background-clip: padding-box;
          border: 2px solid transparent;
        }
      `}</style>

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
