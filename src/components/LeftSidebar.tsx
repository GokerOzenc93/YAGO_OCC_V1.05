import React, { useState, useRef, useCallback, useEffect } from 'react';
import { SlidersHorizontal, PanelLeft, Pin, PinOff, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store';

interface LeftSidebarProps {
  parametersContent: React.ReactNode;
  panelEditorContent: React.ReactNode;
}

type SidebarTab = 'parameters' | 'panel-editor';

/* ═══════════════════════════════════════════════════════════════════
   DESIGN TOKENS — Aligned with Toolbar's bone/ivory palette
═══════════════════════════════════════════════════════════════════ */
const T = {
  /* Surfaces */
  bg:            'linear-gradient(180deg,#f4f2ee 0%,#ebe8e2 100%)',
  contentBg:     'linear-gradient(180deg,#fdfcfa 0%,#f6f3ed 100%)',
  tabStripBg:    '#fdfcfa',
  footerBg:      'linear-gradient(180deg,#f0ede7 0%,#e6e2da 100%)',

  /* Borders */
  border:        '#d6d1c8',
  borderSoft:    '#e4dfd7',
  groupBorder:   'rgba(60,50,40,0.14)',
  hairline:      'rgba(60,50,40,0.08)',

  /* Shadows */
  panelShadow:
    '6px 0 28px -6px rgba(40,30,20,0.14),' +
    '2px 0 6px -1px rgba(40,30,20,0.10),' +
    '0.5px 0 1px rgba(40,30,20,0.06),' +
    '0 0 0 0.5px rgba(60,50,40,0.07),' +
    'inset -0.5px 0 0 rgba(140,120,100,0.06),' +
    'inset 0.5px 0 0 rgba(255,255,255,0.95)',

  /* Text */
  textPrimary:   '#1c1917',
  textSecondary: '#44403c',
  textTertiary:  '#706b65',
  textMuted:     '#9c9590',

  /* Accent */
  accent:        '#ea580c',
  accentSoft:    '#fff7ed',
  accentBorder:  'rgba(234,88,12,0.28)',
  accentGradient:'linear-gradient(90deg,transparent,#f97316 50%,transparent)',

  /* Status colors */
  statusActive:  '#16a34a',
  statusIdle:    '#a8a09a',
};

/* ─── Tab button ─── */
const TabBtn: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}> = ({ active, onClick, icon, label }) => {
  const [hov, setHov] = useState(false);

  const color = active ? T.accent : hov ? T.textPrimary : T.textTertiary;
  const bg = active
    ? 'linear-gradient(180deg,#ffffff 0%,#fdfbf7 100%)'
    : hov
      ? 'rgba(60,50,40,0.045)'
      : 'transparent';

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        height: '100%',
        padding: '0 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: '7px',
        background: bg,
        border: 'none', cursor: 'pointer', outline: 'none',
        position: 'relative',
        color,
        fontSize: '12.5px',
        fontWeight: active ? 600 : 500,
        letterSpacing: active ? '-0.005em' : '0.02em',
        fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
        transition: 'color 0.12s,background 0.12s',
        boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.9)' : 'none',
        flexShrink: 0,
      }}
    >
      {icon}
      <span>{label}</span>

      {active && (
        <div style={{
          position: 'absolute',
          bottom: '-1px', left: '50%', transform: 'translateX(-50%)',
          width: 'calc(100% - 24px)', height: '2px',
          background: T.accentGradient,
          borderRadius: '99px',
        }} />
      )}
    </button>
  );
};

/* ─── EmptyState ─── */
const EmptyState: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  hint: string;
}> = ({ icon, title, description, hint }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center',
    minHeight: '320px',
    padding: '24px 32px',
    textAlign: 'center',
    animation: 'ls-empty-in 0.3s ease-out forwards',
  }}>
    <div style={{
      position: 'relative',
      width: '52px', height: '52px',
      borderRadius: '14px',
      background: 'linear-gradient(180deg,#ffffff 0%,#f4f1ea 100%)',
      border: `1px solid ${T.groupBorder}`,
      boxShadow:
        '0 4px 12px -2px rgba(40,30,20,0.10),' +
        '0 1px 3px rgba(40,30,20,0.06),' +
        '0 0 0 0.5px rgba(60,50,40,0.05),' +
        'inset 0 1px 0 rgba(255,255,255,0.95),' +
        'inset 0 -1px 0 rgba(140,120,100,0.06)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: T.textTertiary,
      marginBottom: '16px',
    }}>
      {icon}
      <div style={{
        position: 'absolute',
        top: '-3px', right: '-3px',
        width: '10px', height: '10px',
        borderRadius: '50%',
        background: 'radial-gradient(circle,rgba(234,88,12,0.18),transparent 70%)',
      }} />
    </div>

    <span style={{
      color: T.textPrimary,
      fontSize: '13.5px',
      fontWeight: 600,
      letterSpacing: '-0.01em',
      marginBottom: '6px',
    }}>
      {title}
    </span>

    <span style={{
      color: T.textTertiary,
      fontSize: '11.5px',
      fontWeight: 400,
      letterSpacing: '0.015em',
      lineHeight: 1.55,
      maxWidth: '260px',
      marginBottom: '16px',
    }}>
      {description}
    </span>

    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 11px',
      background: 'rgba(255,255,255,0.6)',
      border: `0.5px solid ${T.hairline}`,
      borderRadius: '99px',
      boxShadow: '0 1px 2px rgba(40,30,20,0.04),inset 0 1px 0 rgba(255,255,255,0.8)',
    }}>
      <div style={{
        width: '4px', height: '4px',
        borderRadius: '50%',
        background: T.accent,
      }} />
      <span style={{
        fontSize: '10.5px',
        fontWeight: 500,
        letterSpacing: '0.015em',
        color: T.textSecondary,
      }}>
        {hint}
      </span>
    </div>
  </div>
);

/* ═══════════════════════════════════════════════════════════════════
   LeftSidebar
═══════════════════════════════════════════════════════════════════ */
const LeftSidebar: React.FC<LeftSidebarProps> = ({ parametersContent, panelEditorContent }) => {
  const { selectedShapeId } = useAppStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>('panel-editor');
  const [pinHover, setPinHover] = useState(false);
  const [handleHover, setHandleHover] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
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

  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (isOpen || isPinned)) {
        setIsOpen(false);
        setIsPinned(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isPinned]);

  const sidebarWidth = 420;

  return (
    <>
      {/* ═══════════════════════════════════════════
          CLOSED STATE — Professional reveal handle
      ═══════════════════════════════════════════ */}
      {!isOpen && !isPinned && (
        <div
          className="fixed left-0 z-40"
          style={{ top: '120px', bottom: '64px', width: '8px' }}
          onMouseEnter={handleMouseEnter}
        >
          <div
            style={{ position: 'absolute', inset: 0, width: '28px', cursor: 'pointer' }}
            onMouseEnter={() => setHandleHover(true)}
            onMouseLeave={() => setHandleHover(false)}
          />

          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: '1px',
            background: 'linear-gradient(to bottom,transparent,rgba(60,50,40,0.10) 20%,rgba(60,50,40,0.10) 80%,transparent)',
            pointerEvents: 'none',
          }} />

          <div
            onMouseEnter={() => setHandleHover(true)}
            onMouseLeave={() => setHandleHover(false)}
            style={{
              position: 'absolute',
              top: '50%',
              transform: `translateY(-50%) translateX(${handleHover ? '3px' : '0'})`,
              left: '0',
              width: '24px',
              height: '72px',
              borderRadius: '0 11px 11px 0',
              background: T.contentBg,
              border: `1px solid ${T.groupBorder}`,
              borderLeft: 'none',
              boxShadow: handleHover
                ? '4px 3px 16px rgba(40,30,20,0.16),1.5px 0 4px rgba(40,30,20,0.10),0 0 0 0.5px rgba(60,50,40,0.08),inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.08)'
                : '2px 1px 8px rgba(40,30,20,0.09),0.5px 0 1px rgba(40,30,20,0.05),0 0 0 0.5px rgba(60,50,40,0.07),inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.06)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '5px',
              cursor: 'pointer',
              transition: 'transform 0.22s cubic-bezier(0.4,0,0.2,1),box-shadow 0.22s',
              pointerEvents: 'auto',
            }}
          >
            <ChevronRight
              size={14}
              strokeWidth={2.5}
              style={{
                color: handleHover ? T.accent : T.textSecondary,
                transition: 'color 0.15s,transform 0.22s',
                transform: handleHover ? 'translateX(1.5px)' : 'translateX(0)',
              }}
            />

            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'center' }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: '2.5px', height: '2.5px',
                  borderRadius: '50%',
                  background: handleHover ? T.accent : T.textMuted,
                  transition: 'background 0.15s',
                  opacity: handleHover ? 0.95 : 0.65,
                }} />
              ))}
            </div>
          </div>

          {handleHover && (
            <div style={{
              position: 'absolute', top: '50%', left: '0',
              transform: 'translateY(-50%)',
              width: '48px', height: '110px',
              borderRadius: '0 50% 50% 0',
              background: 'radial-gradient(ellipse at left center,rgba(249,115,22,0.12),transparent 70%)',
              pointerEvents: 'none',
              animation: 'ls-glow-in 0.25s ease-out forwards',
            }} />
          )}


        </div>
      )}

      {/* ═══════════════════════════════════════════
          SIDEBAR PANEL
      ═══════════════════════════════════════════ */}
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
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          background: T.bg,
          borderRight: `1px solid ${T.border}`,
          boxShadow: T.panelShadow,
          fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
        }}>

          {/* ── Tab strip ── */}
          <div style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            height: '40px',
            background: T.tabStripBg,
            borderBottom: `1px solid ${T.borderSoft}`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.7),0 1px 0 rgba(255,255,255,0.4)',
            flexShrink: 0,
          }}>
            {/* Left group: tab buttons */}
            <div style={{ display: 'flex', alignItems: 'center', height: '100%', flexShrink: 0 }}>
              <TabBtn
                active={activeTab === 'parameters'}
                onClick={() => setActiveTab('parameters')}
                icon={<SlidersHorizontal size={13.5} strokeWidth={2} />}
                label="Parameters"
              />

              <div style={{
                width: '1px', height: '22px',
                background: 'linear-gradient(to bottom,transparent,rgba(60,50,40,0.14) 30%,rgba(60,50,40,0.14) 70%,transparent)',
                flexShrink: 0,
              }} />

              <TabBtn
                active={activeTab === 'panel-editor'}
                onClick={() => setActiveTab('panel-editor')}
                icon={<PanelLeft size={13.5} strokeWidth={2} />}
                label="Panel Editor"
              />
            </div>

            {/* Right group: pin button */}
            <div style={{
              marginLeft: 'auto',
              display: 'flex', alignItems: 'center', height: '100%',
              flexShrink: 0,
            }}>
              <div style={{
                width: '1px', height: '22px',
                background: 'linear-gradient(to bottom,transparent,rgba(60,50,40,0.14) 30%,rgba(60,50,40,0.14) 70%,transparent)',
                flexShrink: 0,
              }} />

              <button
                onClick={() => {
                  if (isPinned) { setIsPinned(false); setIsOpen(false); }
                  else setIsPinned(true);
                }}
                onMouseEnter={() => setPinHover(true)}
                onMouseLeave={() => setPinHover(false)}
                title={isPinned ? 'Unpin panel' : 'Pin panel'}
                style={{
                  width: '40px', height: '100%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: 'none', outline: 'none', cursor: 'pointer',
                  background: isPinned
                    ? T.accentSoft
                    : pinHover
                      ? 'rgba(60,50,40,0.05)'
                      : 'transparent',
                  color: isPinned ? T.accent : pinHover ? T.textPrimary : T.textTertiary,
                  transition: 'background 0.12s,color 0.12s,transform 0.18s',
                  transform: pinHover && !isPinned ? 'rotate(-12deg)' : 'rotate(0deg)',
                  position: 'relative',
                }}
              >
                {isPinned ? <Pin size={14} strokeWidth={2.2} /> : <PinOff size={14} strokeWidth={2} />}
                {isPinned && (
                  <div style={{
                    position: 'absolute',
                    bottom: '-1px', left: '50%', transform: 'translateX(-50%)',
                    width: '65%', height: '2px',
                    background: T.accentGradient,
                    borderRadius: '99px',
                  }} />
                )}
              </button>
            </div>
          </div>

          {/* ── Content area ── */}
          <div
            className="custom-scrollbar"
            style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              background: T.contentBg,
              boxShadow: 'inset 0 2px 4px rgba(40,30,20,0.05),inset 0 -1px 0 rgba(140,120,100,0.04)',
            }}
          >
            <div style={{ display: activeTab === 'parameters' ? 'block' : 'none' }}>
              {selectedShapeId ? parametersContent : (
                <EmptyState
                  icon={<SlidersHorizontal size={18} strokeWidth={1.6} />}
                  title="No shape selected"
                  description="Select an object from the 3D view to edit its parameters"
                  hint="Tip: Click an object or drag a selection box"
                />
              )}
            </div>

            <div style={{ display: activeTab === 'panel-editor' ? 'block' : 'none' }}>
              {selectedShapeId ? panelEditorContent : (
                <EmptyState
                  icon={<PanelLeft size={18} strokeWidth={1.6} />}
                  title="No panel selected"
                  description="Select a panel or surface to edit its properties"
                  hint="Tip: Click a surface in face select mode"
                />
              )}
            </div>
          </div>

          {/* ── Footer status bar ── */}
          <div style={{
            display: 'flex', alignItems: 'center',
            height: '26px',
            padding: '0 14px',
            background: T.footerBg,
            borderTop: `1px solid ${T.border}`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5),inset 0 -1px 0 rgba(140,120,100,0.04)',
            flexShrink: 0,
            gap: '10px',
          }}>
            {/* Mode (Pinned/Hover) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <div style={{
                width: '5px', height: '5px',
                borderRadius: '50%',
                background: isPinned ? T.accent : T.statusIdle,
                boxShadow: isPinned ? '0 0 4px rgba(234,88,12,0.5)' : 'none',
              }} />
              <span style={{
                fontSize: '10px',
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: T.textTertiary,
              }}>
                {isPinned ? 'Pinned' : 'Hover'}
              </span>
            </div>

            <div style={{ width: '1px', height: '12px', background: T.hairline }} />

            {/* Units indicator — architectural CAD standard */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                fontSize: '9.5px',
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: T.textMuted,
              }}>
                Units
              </span>
              <span style={{
                fontFamily: "'SF Mono','Fira Code',monospace",
                fontSize: '10.5px',
                fontWeight: 500,
                letterSpacing: '0.01em',
                color: T.textSecondary,
              }}>
                mm
              </span>
            </div>

            <div style={{ width: '1px', height: '12px', background: T.hairline }} />

            {/* Precision indicator */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                fontSize: '9.5px',
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: T.textMuted,
              }}>
                Prec
              </span>
              <span style={{
                fontFamily: "'SF Mono','Fira Code',monospace",
                fontSize: '10.5px',
                fontWeight: 500,
                letterSpacing: '0.01em',
                color: T.textSecondary,
              }}>
                0.01
              </span>
            </div>

            {/* Esc shortcut on the right */}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                fontSize: '10px',
                fontWeight: 500,
                letterSpacing: '0.04em',
                color: T.textMuted,
              }}>
                Press to close
              </span>
              <span style={{
                fontFamily: "'SF Mono','Fira Code',monospace",
                fontSize: '9.5px',
                fontWeight: 500,
                letterSpacing: '0.04em',
                color: T.textSecondary,
                background: 'rgba(255,255,255,0.6)',
                padding: '1.5px 5px',
                borderRadius: '3px',
                border: `0.5px solid ${T.hairline}`,
              }}>
                Esc
              </span>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes ls-glow-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes ls-empty-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .custom-scrollbar::-webkit-scrollbar { width: 10px; }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(60,50,40,0.18);
          border-radius: 99px;
          border: 2.5px solid transparent;
          background-clip: padding-box;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(60,50,40,0.32);
          background-clip: padding-box;
          border: 2.5px solid transparent;
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
