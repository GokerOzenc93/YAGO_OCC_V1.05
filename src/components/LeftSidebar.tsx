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
  bg:            'linear-gradient(180deg,#f4f2ee 0%,#ebe8e2 100%)',
  contentBg:     'linear-gradient(180deg,#fdfcfa 0%,#f6f3ed 100%)',
  tabStripBg:    '#fdfcfa',
  footerBg:      'linear-gradient(180deg,#f0ede7 0%,#e6e2da 100%)',
  border:        '#d6d1c8',
  borderSoft:    '#e4dfd7',
  groupBorder:   'rgba(60,50,40,0.14)',
  hairline:      'rgba(60,50,40,0.08)',
  panelShadow:
    '6px 0 28px -6px rgba(40,30,20,0.14),' +
    '2px 0 6px -1px rgba(40,30,20,0.10),' +
    '0.5px 0 1px rgba(40,30,20,0.06),' +
    '0 0 0 0.5px rgba(60,50,40,0.07),' +
    'inset -0.5px 0 0 rgba(140,120,100,0.06),' +
    'inset 0.5px 0 0 rgba(255,255,255,0.95)',
  textPrimary:   '#1c1917',
  textSecondary: '#44403c',
  textTertiary:  '#706b65',
  textMuted:     '#9c9590',
  accent:        '#ea580c',
  accentSoft:    '#fff7ed',
  accentBorder:  'rgba(234,88,12,0.28)',
  accentGradient:'linear-gradient(90deg,transparent,#f97316 50%,transparent)',
  statusIdle:    '#a8a09a',
};

/* ─── Tab button ─── */
const TabBtn: React.FC<{
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}> = ({ active, onClick, icon, label }) => {
  const [hov, setHov] = useState(false);
  const color = active ? T.accent : hov ? T.textPrimary : T.textTertiary;
  const bg = active
    ? 'linear-gradient(180deg,#ffffff 0%,#fdfbf7 100%)'
    : hov ? 'rgba(60,50,40,0.045)' : 'transparent';

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        height: '100%', padding: '0 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
        background: bg, border: 'none', cursor: 'pointer', outline: 'none', position: 'relative',
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
      {icon}<span>{label}</span>
      {active && (
        <div style={{
          position: 'absolute', bottom: '-1px', left: '50%', transform: 'translateX(-50%)',
          width: 'calc(100% - 24px)', height: '2px',
          background: T.accentGradient, borderRadius: '99px',
        }} />
      )}
    </button>
  );
};

/* ─── EmptyState ─── */
const EmptyState: React.FC<{
  icon: React.ReactNode; title: string; description: string; hint: string;
}> = ({ icon, title, description, hint }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    minHeight: '320px', padding: '24px 32px', textAlign: 'center',
    animation: 'ls-empty-in 0.3s ease-out forwards',
  }}>
    <div style={{
      position: 'relative', width: '52px', height: '52px', borderRadius: '14px',
      background: 'linear-gradient(180deg,#ffffff 0%,#f4f1ea 100%)',
      border: `1px solid ${T.groupBorder}`,
      boxShadow:
        '0 4px 12px -2px rgba(40,30,20,0.10),' +
        '0 1px 3px rgba(40,30,20,0.06),' +
        '0 0 0 0.5px rgba(60,50,40,0.05),' +
        'inset 0 1px 0 rgba(255,255,255,0.95),' +
        'inset 0 -1px 0 rgba(140,120,100,0.06)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: T.textTertiary, marginBottom: '16px',
    }}>
      {icon}
      <div style={{
        position: 'absolute', top: '-3px', right: '-3px',
        width: '10px', height: '10px', borderRadius: '50%',
        background: 'radial-gradient(circle,rgba(234,88,12,0.18),transparent 70%)',
      }} />
    </div>
    <span style={{
      color: T.textPrimary, fontSize: '13.5px', fontWeight: 600,
      letterSpacing: '-0.01em', marginBottom: '6px',
    }}>{title}</span>
    <span style={{
      color: T.textTertiary, fontSize: '11.5px', fontWeight: 400,
      letterSpacing: '0.015em', lineHeight: 1.55, maxWidth: '260px', marginBottom: '16px',
    }}>{description}</span>
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      padding: '6px 11px',
      background: 'rgba(255,255,255,0.6)',
      border: `0.5px solid ${T.hairline}`,
      borderRadius: '99px',
      boxShadow: '0 1px 2px rgba(40,30,20,0.04),inset 0 1px 0 rgba(255,255,255,0.8)',
    }}>
      <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: T.accent }} />
      <span style={{ fontSize: '10.5px', fontWeight: 500, letterSpacing: '0.015em', color: T.textSecondary }}>
        {hint}
      </span>
    </div>
  </div>
);

/* ═══════════════════════════════════════════════════════════════════
   LeftSidebar  (default pinned + click-to-open + bone theme)
═══════════════════════════════════════════════════════════════════ */
const LeftSidebar: React.FC<LeftSidebarProps> = ({ parametersContent, panelEditorContent }) => {
  const { selectedShapeId } = useAppStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>('panel-editor');
  const [pinHover, setPinHover] = useState(false);
  const [handleHover, setHandleHover] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const handleRef  = useRef<HTMLDivElement>(null);

  // Clicking the reveal arrow opens AND pins the sidebar.
  const openSidebar = useCallback(() => {
    setIsOpen(true);
    setIsPinned(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (isOpen || isPinned)) {
        setIsOpen(false); setIsPinned(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isPinned]);

  useEffect(() => {
    if (!isOpen || isPinned) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (sidebarRef.current?.contains(target)) return;
      if (handleRef.current?.contains(target))  return;
      setIsOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [isOpen, isPinned]);

  const sidebarWidth = 425;
  const isVisible = isOpen || isPinned;

  return (
    <>
      {/* ═══ CLOSED STATE — Click-to-open reveal handle ═══ */}
      {!isVisible && (
        <div
          ref={handleRef}
          className="fixed left-0 z-40"
          style={{ top: '120px', bottom: '64px', width: '24px', pointerEvents: 'none' }}
        >
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: '1px',
            background: 'linear-gradient(to bottom,transparent,rgba(60,50,40,0.10) 20%,rgba(60,50,40,0.10) 80%,transparent)',
            pointerEvents: 'none',
          }} />

          <button
            type="button"
            onClick={openSidebar}
            onMouseEnter={() => setHandleHover(true)}
            onMouseLeave={() => setHandleHover(false)}
            aria-label="Open sidebar"
            style={{
              position: 'absolute', top: '50%',
              transform: `translateY(-50%) translateX(${handleHover ? '3px' : '0'})`,
              left: '0', width: '24px', height: '72px', padding: 0,
              borderRadius: '0 11px 11px 0',
              background: T.contentBg,
              border: `1px solid ${T.groupBorder}`, borderLeft: 'none',
              boxShadow: handleHover
                ? '4px 3px 16px rgba(40,30,20,0.16),1.5px 0 4px rgba(40,30,20,0.10),0 0 0 0.5px rgba(60,50,40,0.08),inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.08)'
                : '2px 1px 8px rgba(40,30,20,0.09),0.5px 0 1px rgba(40,30,20,0.05),0 0 0 0.5px rgba(60,50,40,0.07),inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.06)',
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: '5px',
              cursor: 'pointer', outline: 'none',
              transition: 'transform 0.22s cubic-bezier(0.4,0,0.2,1),box-shadow 0.22s',
              pointerEvents: 'auto',
            }}
          >
            <ChevronRight
              size={14} strokeWidth={2.5}
              style={{
                color: handleHover ? T.accent : T.textSecondary,
                transition: 'color 0.15s,transform 0.22s',
                transform: handleHover ? 'translateX(1.5px)' : 'translateX(0)',
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'center' }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: '2.5px', height: '2.5px', borderRadius: '50%',
                  background: handleHover ? T.accent : T.textMuted,
                  transition: 'background 0.15s',
                  opacity: handleHover ? 0.95 : 0.65,
                }} />
              ))}
            </div>
          </button>

          {handleHover && (
            <div style={{
              position: 'absolute', top: '50%', left: '0',
              transform: 'translateY(-50%)',
              width: '48px', height: '110px', borderRadius: '0 50% 50% 0',
              background: 'radial-gradient(ellipse at left center,rgba(249,115,22,0.12),transparent 70%)',
              pointerEvents: 'none', animation: 'ls-glow-in 0.25s ease-out forwards',
            }} />
          )}
        </div>
      )}

      {/* ═══ SIDEBAR PANEL ═══ */}
      <div
        ref={sidebarRef}
        className="fixed z-40 flex transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{
          top: '120px', bottom: '64px', left: 0, width: `${sidebarWidth}px`,
          transform: isVisible ? 'translateX(0)' : `translateX(-${sidebarWidth}px)`,
        }}
      >
        <div style={{
          display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
          background: T.bg,
          borderRight: `1px solid ${T.border}`,
          boxShadow: T.panelShadow,
          fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
        }}>

          {/* ── Tab strip ── */}
          <div style={{
            position: 'relative', display: 'flex', alignItems: 'center', height: '40px',
            background: T.tabStripBg,
            borderBottom: `1px solid ${T.borderSoft}`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.7),0 1px 0 rgba(255,255,255,0.4)',
            flexShrink: 0,
          }}>
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

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', height: '100%', flexShrink: 0 }}>
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
                onMouseEnter={() => setPinHover(true)} onMouseLeave={() => setPinHover(false)}
                title={isPinned ? 'Unpin panel' : 'Pin panel'}
                style={{
                  width: '40px', height: '100%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: 'none', outline: 'none', cursor: 'pointer',
                  background: isPinned ? T.accentSoft
                    : pinHover ? 'rgba(60,50,40,0.05)' : 'transparent',
                  color: isPinned ? T.accent : pinHover ? T.textPrimary : T.textTertiary,
                  transition: 'background 0.12s,color 0.12s,transform 0.18s',
                  transform: pinHover && !isPinned ? 'rotate(-12deg)' : 'rotate(0deg)',
                  position: 'relative',
                }}
              >
                {isPinned ? <Pin size={14} strokeWidth={2.2} /> : <PinOff size={14} strokeWidth={2} />}
                {isPinned && (
                  <div style={{
                    position: 'absolute', bottom: '-1px', left: '50%', transform: 'translateX(-50%)',
                    width: '65%', height: '2px',
                    background: T.accentGradient, borderRadius: '99px',
                  }} />
                )}
              </button>
            </div>
          </div>

          {/* ── Content area — wrapped in `bone-skin` for theme overrides ── */}
          <div
            className="custom-scrollbar bone-skin"
            style={{
              flex: 1, overflowY: 'auto', overflowX: 'hidden',
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

          {/* ── Footer removed by user request ── */}
        </div>
      </div>

      {/* ═══════════════════════════════════════════
          BONE THEME — restyles ParametersPanel + PanelEditor
          without touching their source. Toolbar-matched palette.
      ═══════════════════════════════════════════ */}
      <style>{`
        @keyframes ls-glow-in   { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ls-empty-in  { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

        .custom-scrollbar::-webkit-scrollbar { width: 10px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
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

        /* ─── BONE SKIN: re-style the embedded panels ─── */
        .bone-skin {
          --bone-bg:           #fdfcfa;
          --bone-row:          linear-gradient(180deg,#fbfaf6 0%,#f3f0e9 100%);
          --bone-row-hover:    linear-gradient(180deg,#fff8eb 0%,#fef3dc 100%);
          --bone-border-soft:  #e4dfd7;
          --bone-text:         #1c1917;
          --bone-text-soft:    #44403c;
          --bone-text-muted:   #706b65;
          --bone-text-faint:   #9c9590;
          --bone-accent:       #ea580c;
          --bone-accent-soft:  #fff7ed;
          --bone-accent-bord:  rgba(234,88,12,0.28);
          font-family: 'Inter','SF Pro Text',system-ui,sans-serif;
          color: var(--bone-text);
          padding: 8px 6px 16px !important;
        }

        /* All inputs/selects/textarea inside the sidebar */
        .bone-skin input[type="text"],
        .bone-skin input[type="number"],
        .bone-skin select,
        .bone-skin textarea {
          background: linear-gradient(180deg,#ffffff 0%,#fbfaf6 100%) !important;
          border: 1px solid rgba(60,50,40,0.14) !important;
          border-radius: 6px !important;
          color: var(--bone-text) !important;
          font-family: 'Inter',system-ui,sans-serif !important;
          font-size: 11.5px !important;
          font-weight: 500 !important;
          letter-spacing: 0.012em !important;
          height: 24px !important;
          padding: 0 8px !important;
          box-shadow: inset 0 1px 2px rgba(40,30,20,0.04),
                      0 0 0 0.5px rgba(60,50,40,0.04) !important;
          transition: border-color 0.15s, box-shadow 0.15s, background 0.15s !important;
          outline: none !important;
        }

        /* Mono-style numeric inputs */
        .bone-skin input[type="text"].font-mono,
        .bone-skin input[type="number"] {
          font-family: 'SF Mono','Fira Code','Cascadia Code',monospace !important;
          font-size: 11px !important;
          letter-spacing: 0.02em !important;
        }

        /* Focus state — orange ring matching the toolbar search */
        .bone-skin input[type="text"]:focus,
        .bone-skin input[type="number"]:focus,
        .bone-skin select:focus,
        .bone-skin textarea:focus {
          border-color: #f97316 !important;
          box-shadow: 0 0 0 2.5px rgba(249,115,22,0.14),
                      inset 0 1px 2px rgba(40,30,20,0.03) !important;
          background: #ffffff !important;
        }

        /* Read-only inputs — recessed milled-bone look */
        .bone-skin input[readonly],
        .bone-skin input[tabindex="-1"] {
          background: linear-gradient(180deg,#f4f1ea 0%,#ebe7df 100%) !important;
          color: var(--bone-text-muted) !important;
          border-color: rgba(60,50,40,0.10) !important;
          box-shadow: inset 0 1px 1px rgba(40,30,20,0.04) !important;
          cursor: default !important;
        }

        /* Label cells (40px width, center text — used as row labels) */
        .bone-skin input.w-10 {
          background: linear-gradient(180deg,#fff8ed 0%,#fdedd2 100%) !important;
          color: var(--bone-accent) !important;
          border-color: var(--bone-accent-bord) !important;
          font-family: 'Inter',system-ui,sans-serif !important;
          font-weight: 700 !important;
          font-size: 10.5px !important;
          letter-spacing: 0.06em !important;
          text-transform: uppercase !important;
          text-align: center !important;
          box-shadow: 0 0 0 0.5px rgba(234,88,12,0.08),
                      inset 0 1px 0 rgba(255,255,255,0.9) !important;
        }

        /* Buttons inside the panels */
        .bone-skin button {
          font-family: 'Inter',system-ui,sans-serif;
          font-weight: 500;
          letter-spacing: 0.012em;
          transition: background 0.12s, color 0.12s, box-shadow 0.12s, transform 0.12s !important;
        }
        .bone-skin button.p-0\\.5,
        .bone-skin button.p-1,
        .bone-skin button.p-1\\.5 {
          border-radius: 5px !important;
          color: var(--bone-text-soft) !important;
        }
        .bone-skin button.p-0\\.5:hover:not(:disabled),
        .bone-skin button.p-1:hover:not(:disabled),
        .bone-skin button.p-1\\.5:hover:not(:disabled) {
          background: rgba(60,50,40,0.06) !important;
          color: var(--bone-text) !important;
        }
        .bone-skin button:disabled {
          opacity: 0.4 !important;
          cursor: not-allowed !important;
        }

        /* Remap Tailwind text shades */
        .bone-skin .text-gray-400, .bone-skin .text-stone-400, .bone-skin .text-slate-400 { color: var(--bone-text-faint) !important; }
        .bone-skin .text-gray-500, .bone-skin .text-stone-500, .bone-skin .text-slate-500 { color: var(--bone-text-muted) !important; }
        .bone-skin .text-gray-600, .bone-skin .text-stone-600, .bone-skin .text-slate-600 { color: var(--bone-text-soft) !important; }
        .bone-skin .text-gray-700, .bone-skin .text-stone-700, .bone-skin .text-slate-700 { color: var(--bone-text) !important; }
        .bone-skin .text-gray-800, .bone-skin .text-stone-800, .bone-skin .text-slate-800 { color: var(--bone-text) !important; }

        /* Backgrounds */
        .bone-skin .bg-white         { background: var(--bone-bg) !important; }
        .bone-skin .bg-stone-50      { background: #f7f4ee !important; }
        .bone-skin .bg-stone-100     { background: #efeae0 !important; }
        .bone-skin .bg-stone-200     { background: #e4dfd5 !important; }
        .bone-skin .bg-gray-50       { background: #f7f4ee !important; }
        .bone-skin .bg-gray-100      { background: #efeae0 !important; }

        /* Border colors */
        .bone-skin .border-gray-300,
        .bone-skin .border-stone-300,
        .bone-skin .border-stone-200,
        .bone-skin .border-gray-200 { border-color: var(--bone-border-soft) !important; }

        /* ─── BONE ROWS ───
           Each ParameterRow renders as a flex gap-0.5 items-center container.
           Convert it into a tactile "bone strip" with subtle gradient + inset highlight. */
        .bone-skin .flex.gap-0\\.5.items-center {
          padding: 5px 9px !important;
          background: var(--bone-row) !important;
          border-radius: 8px !important;
          margin-bottom: 4px !important;
          gap: 4px !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.75),
                      inset 0 -1px 0 rgba(140,120,100,0.06),
                      0 0 0 0.5px rgba(60,50,40,0.05),
                      0 1px 2px rgba(40,30,20,0.03) !important;
          transition: background 0.12s, box-shadow 0.12s !important;
        }
        .bone-skin .flex.gap-0\\.5.items-center:hover {
          background: var(--bone-row-hover) !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.9),
                      inset 0 -1px 0 rgba(234,88,12,0.08),
                      0 0 0 0.5px rgba(234,88,12,0.16),
                      0 1px 3px rgba(234,88,12,0.06) !important;
        }
        .bone-skin .flex.gap-0\\.5.items-center:focus-within {
          background: linear-gradient(180deg,#fff8eb 0%,#fdebcc 100%) !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.9),
                      0 0 0 1px rgba(234,88,12,0.22),
                      0 2px 6px rgba(234,88,12,0.08) !important;
        }

        /* Section dividers — milled hairlines */
        .bone-skin .border-t,
        .bone-skin .border-t-2 {
          border-top: none !important;
          background-image: linear-gradient(to right,
                            transparent 0%,
                            rgba(60,50,40,0.12) 12%,
                            rgba(60,50,40,0.12) 88%,
                            transparent 100%) !important;
          background-repeat: no-repeat !important;
          background-position: top !important;
          background-size: 100% 1px !important;
          padding-top: 12px !important;
          margin-top: 10px !important;
        }
        .bone-skin .border-t-yellow-400 {
          background-image: linear-gradient(to right, transparent, rgba(234,88,12,0.28), transparent) !important;
        }

        /* Section titles (uppercase "eyebrow") */
        .bone-skin .text-xs.font-semibold {
          font-size: 10px !important;
          font-weight: 700 !important;
          letter-spacing: 0.08em !important;
          text-transform: uppercase !important;
          color: var(--bone-text-soft) !important;
          padding: 0 4px 7px !important;
        }

        /* Yellow subtraction header — convert to bone-accent semantic */
        .bone-skin .text-yellow-700 { color: var(--bone-accent) !important; }
        .bone-skin .bg-yellow-50    { background: var(--bone-accent-soft) !important; }
        .bone-skin .bg-yellow-100   { background: #fde7c2 !important; }

        /* Orange highlights stay orange but get matching tint */
        .bone-skin .bg-orange-50,
        .bone-skin .hover\\:bg-orange-50:hover  { background: var(--bone-accent-soft) !important; }
        .bone-skin .bg-orange-100,
        .bone-skin .hover\\:bg-orange-100:hover { background: #ffedd5 !important; }
        .bone-skin .text-orange-600,
        .bone-skin .text-orange-700,
        .bone-skin .hover\\:text-orange-600:hover { color: var(--bone-accent) !important; }
        .bone-skin .border-orange-300,
        .bone-skin .border-orange-400 { border-color: var(--bone-accent-bord) !important; }

        /* Primary action buttons (orange filled) get send-button treatment */
        .bone-skin button.bg-orange-500,
        .bone-skin button.bg-orange-600 {
          background: linear-gradient(180deg,#f97316 0%,#ea580c 100%) !important;
          color: #fff !important;
          border: none !important;
          border-radius: 6px !important;
          padding: 5px 10px !important;
          font-weight: 600 !important;
          font-size: 11px !important;
          letter-spacing: 0.02em !important;
          box-shadow: 0 1px 2px rgba(234,88,12,0.35),
                      0 0 0 0.5px rgba(154,52,18,0.4),
                      inset 0 1px 0 rgba(255,255,255,0.25) !important;
        }
        .bone-skin button.bg-orange-500:hover:not(:disabled),
        .bone-skin button.bg-orange-600:hover:not(:disabled) {
          background: linear-gradient(180deg,#fb923c 0%,#f97316 100%) !important;
          transform: translateY(-0.5px) !important;
        }

        /* Red destructive elements — stay red but soften */
        .bone-skin .text-red-500,
        .bone-skin .text-red-600 { color: #dc2626 !important; }
        .bone-skin .hover\\:bg-red-100:hover { background: rgba(239,68,68,0.10) !important; }
        .bone-skin .hover\\:bg-red-200:hover { background: rgba(239,68,68,0.16) !important; }

        /* Blue accents (selected panel rows, info) — convert to a calmer slate-blue */
        .bone-skin .text-blue-600 { color: #1d4ed8 !important; }
        .bone-skin .bg-blue-50    { background: #eff5ff !important; }
        .bone-skin .hover\\:bg-blue-100:hover { background: #dbe7ff !important; }

        /* Green accents kept restrained */
        .bone-skin .text-green-600 { color: #16a34a !important; }

        /* Spacing rhythm */
        .bone-skin .space-y-0\\.5 > * + * { margin-top: 4px !important; }
        .bone-skin .p-2  { padding: 12px !important; }
        .bone-skin .p-3  { padding: 14px !important; }
        .bone-skin .px-3 { padding-left: 14px !important; padding-right: 14px !important; }
        .bone-skin .py-2 { padding-top: 10px !important; padding-bottom: 10px !important; }

        /* Disabled inputs */
        .bone-skin input:disabled {
          opacity: 0.55 !important;
          background: #f0ece4 !important;
        }

        /* Checkboxes adopt accent color */
        .bone-skin input[type="checkbox"] {
          width: 13px !important;
          height: 13px !important;
          accent-color: var(--bone-accent) !important;
          cursor: pointer !important;
        }

        /* Profile select dropdown — bone-style chevron */
        .bone-skin select {
          padding-right: 22px !important;
          background-image:
            linear-gradient(180deg,#ffffff 0%,#fbfaf6 100%),
            url("data:image/svg+xml;charset=US-ASCII,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath fill='none' stroke='%23706b65' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' d='M2 2l4 4 4-4'/%3E%3C/svg%3E") !important;
          background-position: left center, right 7px center !important;
          background-repeat: no-repeat, no-repeat !important;
          background-size: 100% 100%, 10px !important;
          appearance: none !important;
          -webkit-appearance: none !important;
        }
      `}</style>
    </>
  );
};

export default LeftSidebar;
