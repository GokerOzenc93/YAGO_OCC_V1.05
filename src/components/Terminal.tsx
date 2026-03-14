import React, { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import { useAppStore } from '../store';

const Terminal: React.FC = () => {
  const [commandInput, setCommandInput] = useState('');
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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const drawingToolKeys = ['t', 'f', 'r', 'l', 'b', 'u', 'i', 'c', 'h', 'v', 'z', '1', '2', '3'];
      if (drawingToolKeys.includes(e.key.toLowerCase())) {
        return;
      }

      if (e.ctrlKey || e.altKey || e.metaKey ||
          e.key.startsWith('F') ||
          ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Escape', 'Shift', 'CapsLock', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
        return;
      }

      if (e.key.length > 1 && !['Backspace', 'Enter', 'Space'].includes(e.key)) {
        return;
      }

      if (/^[a-zA-Z0-9\.\,\+\-\*\/\(\)]$/.test(e.key) || e.key === 'Backspace' || e.key === 'Space') {
        e.preventDefault();

        if (inputRef.current) {
          inputRef.current.focus();

          if (e.key === 'Backspace') {
            setCommandInput(prev => prev.slice(0, -1));
          } else if (e.key === 'Space') {
            setCommandInput(prev => prev + ' ');
          } else {
            setCommandInput(prev => prev + e.key);
          }

          console.log(`🎯 Global key captured: "${e.key}" -> Terminal input`);
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
        if ((window as any).handleFilletRadius) {
          (window as any).handleFilletRadius(radiusValue);
          setCommandInput('');
          return;
        }
      }
      console.log('⚠️ Invalid fillet radius. Enter a positive number.');
      setCommandInput('');
      return;
    }

    if ((window as any).pendingVertexEdit) {
      const offsetValue = parseFloat(trimmedCommand);
      if (!isNaN(offsetValue)) {
        if ((window as any).handleVertexOffset) {
          (window as any).handleVertexOffset(offsetValue);
          setCommandInput('');
          return;
        }
      }
      console.log('Geçersiz offset değeri. Bir sayı girin.');
      return;
    }

    if ((window as any).pendingExtrudeShape) {
      if (trimmedCommand === '' || trimmedCommand.toLowerCase() === 'enter') {
        if ((window as any).handleConvertTo2D) {
          (window as any).handleConvertTo2D();
          setCommandInput('');
          return;
        }
      }

      const extrudeValue = parseFloat(trimmedCommand);
      if (!isNaN(extrudeValue) && extrudeValue > 0) {
        if ((window as any).handleExtrudeHeight) {
          (window as any).handleExtrudeHeight(extrudeValue);
          setCommandInput('');
          return;
        }
      }

      console.log('Geçersiz extrude değeri. Pozitif bir sayı girin veya Enter ile 2D nesne olarak ekleyin.');
      return;
    }

    if (/^[\d.,\s]+$/.test(trimmedCommand)) {
      if ((window as any).handlePolylineMeasurement) {
        (window as any).handlePolylineMeasurement(trimmedCommand);
        setCommandInput('');
        return;
      }
    }

    console.log(`Command executed: ${trimmedCommand}`);
    setCommandInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      executeCommand(commandInput);
    }
  };

  return (
    <>
      {polylineStatus && (
        <div className="fixed bottom-5 left-0 right-0 bg-stone-100/95 backdrop-blur-sm border-t border-stone-300 z-20" style={{ height: '4mm' }}>
          <div className="flex items-center justify-between h-full px-3">
            <div className="flex items-center gap-4 text-xs text-stone-600">
              <span className="font-medium">
                Tool: <span className="text-slate-800">{activeTool}</span>
              </span>
            </div>

            <div className="flex items-center gap-4 text-xs">
              <span className="text-gray-300">
                Length: <span className="text-orange-600 font-mono font-medium">{polylineStatus.distance.toFixed(1)}{polylineStatus.unit}</span>
              </span>
              {polylineStatus.angle !== undefined && (
                <span className="text-stone-600">
                  Angle: <span className="text-slate-700 font-mono font-medium">{polylineStatus.angle.toFixed(1)}°</span>
                </span>
              )}
            </div>

            <div className="flex items-center gap-4 text-xs text-stone-600">
              <span>Ready</span>
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 bg-stone-100 border-t border-stone-300 z-30" style={{ height: '7mm' }}>
      <div className="flex items-center h-full px-2">
        <span className="text-stone-500 font-mono text-xs mr-2"></span>
        <input
          ref={inputRef}
          type="text"
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter command or value..."
          className="flex-1 bg-transparent text-slate-800 font-mono text-xs outline-none placeholder-stone-500"
        />
        <button
          onClick={() => executeCommand(commandInput)}
          className="ml-2 p-1 bg-orange-500 hover:bg-orange-600 text-white rounded transition-colors"
        >
          <Send className="w-2 h-2" />
        </button>
      </div>
      </div>
    </>
  );
};

export default Terminal;
