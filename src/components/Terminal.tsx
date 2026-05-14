import React, { useState, useRef, useEffect } from 'react';
import { Send, ChevronRight, Hash } from 'lucide-react';
import { useAppStore } from '../store';

/* ─── Toolbar token sistemiyle uyumlu ─── */
const T = {
  /* Terminal bg: warm dark beige, blends with toolbar palette but reads as input area */
  bg:           'linear-gradient(180deg,#ebe8e2 0%,#e2ddd5 100%)',
  bgTop:        '#ebe8e2',
  border:       '#c9c3b8',
  borderTop:    '#d6d1c8',
  shineTop:     'inset 0 1px 0 rgba(255,255,255,0.55)',
  /* Input field */
  inputBg:      'linear-gradient(180deg,#ffffff 0%,#fbfaf7 100%)',
  inputBorder:  'rgba(60,50,40,0.14)',
  inputShadow:  'inset 0 1px 2px rgba(40,30,20,0.06),0 0 0 0.5px rgba(60,50,40,0.04)',
  inputText:    '#1c1917',
  placeholder: '#a8a29e',
  /* Prompt */
  promptClr:    '#d9540a',
  /* Send button */
  sendBg:       'linear-gradient(180deg,#f97316 0%,#ea580c 100%)',
  sendBgHover:  'linear-gradient(180deg,#fb923c 0%,#f97316 100%)',
  sendShadow:   '0 1px 2px rgba(234,88,12,0.35),0 0 0 0.5px rgba(154,52,18,0.4),inset 0 1px 0 rgba(255,255,255,0.25)',
  /* Polyline status overlay */
  poliBg:       'rgba(250,249,246,0.92)',
  poliBorder:   '#d6d1c8',
  labelClr:     '#9c9590',
  valueClr:     '#292524',
  monoFont:     "'SF Mono','Fira Code','Cascadia Code',monospace",
};

const StatusPair: React.FC<{ label: string; value: React.ReactNode; valueColor?: string }> = ({
  label, value, valueColor = T.valueClr,
}) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
    <span style={{
      color: T.labelClr, fontSize: '10.5px', fontWeight: 420,
      letterSpacing: '0.05em', textTransform: 'uppercase',
    }}>
      {label}
    </span>
    <span style={{
      color: valueColor, fontSize: '11.5px', fontWeight: 540,
      fontFamily: T.monoFont, letterSpacing: '0.02em',
    }}>
      {value}
    </span>
  </div>
);

const PoliSep = () => (
  <div style={{
    width: '1px', height: '14px', flexShrink: 0,
    background: 'linear-gradient(to bottom,transparent,rgba(60,50,40,0.16) 30%,rgba(60,50,40,0.16) 70%,transparent)',
  }} />
);

const Terminal: React.FC = () => {
  const [commandInput, setCommandInput] = useState('');
  const [inputFocus, setInputFocus] = useState(false);
  const [sendHover, setSendHover] = useState(false);
  const { activeTool } = useAppStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [polylineStatus, setPolylineStatus] = useState<{
    distance: number;
    angle?: number;
    unit: string;
  } | null>(null);

  useEffect(() => {
    (window as any).terminalInputRef = inputRef;
    (window as any).setPolylineStatus = setPolylineStatus;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const drawingToolKeys = ['t', 'f', 'r', 'l', 'b', 'u', 'i', 'c', 'h', 'v', 'z', '1', '2', '3'];
      if (drawingToolKeys.includes(e.key.toLowerCase())) return;
      if (e.ctrlKey || e.altKey || e.metaKey ||
          e.key.startsWith('F') ||
          ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab','Escape','Shift','CapsLock','Insert','Delete','Home','End','PageUp','PageDown'].includes(e.key)) return;
      if (e.key.length > 1 && !['Backspace', 'Enter', 'Space'].includes(e.key)) return;

      if (/^[a-zA-Z0-9\.\,\+\-\*\/\(\)]$/.test(e.key) || e.key === 'Backspace' || e.key === 'Space') {
        e.preventDefault();
        if (inputRef.current) {
          inputRef.current.focus();
          if (e.key === 'Backspace') setCommandInput(prev => prev.slice(0, -1));
          else if (e.key === 'Space') setCommandInput(prev => prev + ' ');
          else setCommandInput(prev => prev + e.key);
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, true);
      delete (window as any).terminalInputRef;
      delete (window as any).setPolylineStatus;
    };
  }, []);

  const executeCommand = (command: string) => {
    const trimmedCommand = command.trim();
    if (!trimmedCommand) return;

    if ((window as any).pendingFilletOperation) {
      const radiusValue = parseFloat(trimmedCommand);
      if (!isNaN(radiusValue) && radiusValue > 0) {
        (window as any).handleFilletRadius?.(radiusValue);
        setCommandInput('');
        return;
      }
      setCommandInput('');
      return;
    }

    if ((window as any).pendingVertexEdit) {
      const offsetValue = parseFloat(trimmedCommand);
      if (!isNaN(offsetValue)) {
        (window as any).handleVertexOffset?.(offsetValue);
        setCommandInput('');
        return;
      }
      return;
    }

    if ((window as any).pendingExtrudeShape) {
      if (trimmedCommand === '' || trimmedCommand.toLowerCase() === 'enter') {
        (window as any).handleConvertTo2D?.();
        setCommandInput('');
        return;
      }
      const extrudeValue = parseFloat(trimmedCommand);
      if (!isNaN(extrudeValue) && extrudeValue > 0) {
        (window as any).handleExtrudeHeight?.(extrudeValue);
        setCommandInput('');
        return;
      }
      return;
    }

    if (/^[\d.,\s]+$/.test(trimmedCommand)) {
      (window as any).handlePolylineMeasurement?.(trimmedCommand);
      setCommandInput('');
      return;
    }

    setCommandInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') executeCommand(commandInput);
  };

  return (
    <>
      {/* ── Polyline status overlay (sits above terminal) ── */}
      {polylineStatus && (
        <div
          className="fixed left-0 right-0 z-20"
          style={{
            bottom: '64px',
            height: '24px',
            background: T.poliBg,
            backdropFilter: 'blur(8px) saturate(180%)',
            WebkitBackdropFilter: 'blur(8px) saturate(180%)',
            borderTop: `1px solid ${T.poliBorder}`,
            borderBottom: `1px solid ${T.poliBorder}`,
            boxShadow: T.shineTop,
            fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            height: '100%', padding: '0 14px', gap: '10px',
          }}>
            <StatusPair label="Tool" value={activeTool} valueColor={T.valueClr} />

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <StatusPair
                label="Uzunluk"
                value={`${polylineStatus.distance.toFixed(1)}${polylineStatus.unit}`}
                valueColor={T.promptClr}
              />
              {polylineStatus.angle !== undefined && (
                <>
                  <PoliSep />
                  <StatusPair
                    label="Açı"
                    value={`${polylineStatus.angle.toFixed(1)}°`}
                  />
                </>
              )}
            </div>

            <StatusPair label="Mod" value="Çizim" valueColor="#047857" />
          </div>
        </div>
      )}

      {/* ── Terminal / Command Bar ── */}
      <div
        className="fixed bottom-0 left-0 right-0 z-30"
        style={{
          height: '38px',
          background: T.bg,
          borderTop: `1px solid ${T.borderTop}`,
          boxShadow: `${T.shineTop},0 -1px 4px rgba(40,30,20,0.05)`,
          fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', height: '100%',
          padding: '0 10px', gap: '8px',
        }}>

          {/* Prompt indicator */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0,
            padding: '0 8px', height: '26px',
            background: 'rgba(217,84,10,0.08)',
            border: '1px solid rgba(217,84,10,0.18)',
            borderRadius: '6px',
          }}>
            <Hash size={11} style={{ color: T.promptClr }} />
            <span style={{
              color: T.promptClr, fontSize: '10.5px', fontWeight: 600,
              letterSpacing: '0.05em', textTransform: 'uppercase',
            }}>
              CMD
            </span>
          </div>

          {/* Input wrapper with focus state */}
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center',
            height: '26px', padding: '0 10px', gap: '6px',
            background: T.inputBg,
            border: `1px solid ${inputFocus ? '#f97316' : T.inputBorder}`,
            borderRadius: '7px',
            boxShadow: inputFocus
              ? '0 0 0 2.5px rgba(249,115,22,0.14),inset 0 1px 2px rgba(40,30,20,0.04)'
              : T.inputShadow,
            transition: 'border-color 0.15s,box-shadow 0.15s',
          }}>
            <ChevronRight
              size={12}
              style={{
                color: inputFocus ? T.promptClr : '#a8a29e',
                flexShrink: 0,
                transition: 'color 0.15s',
              }}
            />
            <input
              ref={inputRef}
              type="text"
              value={commandInput}
              onChange={e => setCommandInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setInputFocus(true)}
              onBlur={() => setInputFocus(false)}
              placeholder="Komut girin veya değer yazın..."
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: T.inputText,
                fontFamily: T.monoFont,
                fontSize: '12px',
                fontWeight: 500,
                letterSpacing: '0.01em',
              }}
            />
            {commandInput && (
              <span style={{
                color: '#b0aaa4',
                fontSize: '9.5px',
                fontFamily: T.monoFont,
                fontWeight: 500,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                padding: '2px 5px',
                background: 'rgba(60,50,40,0.06)',
                borderRadius: '4px',
                flexShrink: 0,
              }}>
                ⏎ Enter
              </span>
            )}
          </div>

          {/* Send button */}
          <button
            onClick={() => executeCommand(commandInput)}
            onMouseEnter={() => setSendHover(true)}
            onMouseLeave={() => setSendHover(false)}
            disabled={!commandInput.trim()}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '28px', height: '26px',
              background: commandInput.trim()
                ? (sendHover ? T.sendBgHover : T.sendBg)
                : 'rgba(60,50,40,0.08)',
              border: 'none',
              borderRadius: '6px',
              boxShadow: commandInput.trim() ? T.sendShadow : 'inset 0 0 0 0.5px rgba(60,50,40,0.1)',
              color: commandInput.trim() ? '#fff' : '#b0aaa4',
              cursor: commandInput.trim() ? 'pointer' : 'not-allowed',
              outline: 'none',
              flexShrink: 0,
              transition: 'background 0.12s,transform 0.08s,box-shadow 0.12s',
              transform: sendHover && commandInput.trim() ? 'translateY(-0.5px)' : 'translateY(0)',
            }}
            onMouseDown={e => {
              if (commandInput.trim()) (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0.5px)';
            }}
            onMouseUp={e => {
              if (commandInput.trim()) (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-0.5px)';
            }}
          >
            <Send size={12} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </>
  );
};

export default Terminal;
