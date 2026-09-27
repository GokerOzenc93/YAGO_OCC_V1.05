import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Hash, type LucideIcon, PanelLeft, Pin, PinOff, Send, SlidersHorizontal, Square, Box, RectangleHorizontal } from 'lucide-react';
import { CameraType, OrthoMode, type Shape, SnapType, Tool, ViewMode, shapeById, useAppStore, useStoreFields } from '../store';
import {
  type Vec3, convertReplicadToThreeGeometry, createReplicadBox, getReplicadVertices,
  performBooleanCut, translatedBboxOf,
} from './Geometry';

/* ═══════════════════════════════════════════════════════════════════════════
   UYGULAMA KABUĞU (chrome) — (A) tasarım tokenları, ilkel bileşenler, ikonlar,
   ErrorBoundary, durum çubuğu, terminal; (B) üst araç çubuğu (menüler, araçlar,
   kamera/görünüm, boolean çıkarma); (C) sol kenar çubuğu kabuğu + kemik teması.
   ═══════════════════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════════════════
// Ui — ORTAK ARAYÜZ PARÇALARI: tasarım jetonları, ErrorBoundary, ToolChip,
// ikon kaydı + düğmeleri, StatusBar, Terminal (komut satırı).
// (Eski UiPrimitives + icons + StatusBar + Terminal.)
// ═══════════════════════════════════════════════════════════════════════════

// ── TASARIM JETONLARI (kemik/fildişi palet) ──────────────────────────────────
export const UI_FONT = "'Inter','SF Pro Text',system-ui,sans-serif";
export const MONO_FONT = "'SF Mono','Fira Code','Cascadia Code',monospace";
/** Dikey/yatay ince ayırıcı (saydamdan koyuya gradyan). */
export const hairline = (opacity = 0.14, dir: 'bottom' | 'right' = 'bottom') =>
  `linear-gradient(to ${dir},transparent,rgba(60,50,40,${opacity}) 30%,rgba(60,50,40,${opacity}) 70%,transparent)`;
export const TOKENS = {
  bg: 'linear-gradient(180deg,#faf9f6 0%,#f4f2ee 100%)',
  border: '#e4dfd7',
  topShine: 'inset 0 1px 0 rgba(255,255,255,0.7)',
  labelClr: '#9c9590',
  valueClr: '#292524',
  accentClr: '#d9540a',
  infoClr: '#0369a1',
  modClr: '#7c3aed',
} as const;

/** Etiket · değer çifti (durum çubuğu). */
export const LabelValue: React.FC<{ label: string; value: React.ReactNode; valueColor?: string; mono?: boolean; small?: boolean }> = ({ label, value, valueColor = TOKENS.valueClr, mono = false, small = false }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
    <span style={{ color: TOKENS.labelClr, fontSize: small ? '10.5px' : '11px', fontWeight: 420, letterSpacing: small ? '0.05em' : '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{label}</span>
    <span style={{ color: valueColor, fontSize: '11.5px', fontWeight: 540, letterSpacing: mono ? '0.02em' : '-0.005em', fontFamily: mono ? MONO_FONT : UI_FONT, whiteSpace: 'nowrap' }}>{value}</span>
  </div>
);
export const VSep: React.FC<{ opacity?: number }> = ({ opacity = 0.14 }) => <div style={{ width: '1px', height: '14px', flexShrink: 0, background: hairline(opacity) }} />;

// ── ErrorBoundary — render hatalarını yakalayıp arayüzü çökertmez ────────────
interface ErrorBoundaryState { hasError: boolean; error: Error | null }
export class ErrorBoundary extends React.Component<{ children: React.ReactNode; fallback?: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('ErrorBoundary caught:', error, info.componentStack); }
  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="flex items-center justify-center h-full bg-stone-100">
        <div className="bg-white rounded-lg shadow-lg p-6 max-w-md text-center">
          <div className="text-red-500 text-lg font-semibold mb-2">Render Error</div>
          <div className="text-sm text-stone-600 mb-4">{this.state.error?.message || 'An unexpected error occurred.'}</div>
          <button onClick={() => this.setState({ hasError: false, error: null })} className="px-4 py-2 bg-orange-600 text-white rounded-md hover:bg-orange-700 text-sm font-medium">Retry</button>
        </div>
      </div>
    );
  }
}

// ── ToolChip / ToolChipBar — Panel Editor + Parameters üst araç çubuğu ───────
// Zeminsiz "hayalet" düğmeler: pasifte soluk metin/gri ikon, aktifte koyu metin +
// turuncu ikon + ince turuncu alt çizgi. Her düğme bağımsız aç/kapa.
export const ToolChip: React.FC<{ label: string; icon: LucideIcon; active?: boolean; onClick: () => void; title?: string; badge?: string | number }> =
  ({ label, icon: Icon, active = false, onClick, title, badge }) => (
    <button type="button" onClick={onClick} title={title || label} aria-pressed={active}
      className={`group/chip relative h-[26px] px-2 rounded-[6px] flex items-center gap-1.5 text-[11.5px] tracking-[0.01em] whitespace-nowrap bg-transparent transition-colors duration-150
        ${active ? 'text-stone-800 font-semibold' : 'text-stone-500 font-medium hover:text-stone-800 hover:bg-[rgba(60,50,40,0.045)]'}`}>
      <Icon size={12.5} strokeWidth={2} className={`shrink-0 transition-colors duration-150 ${active ? 'text-orange-600' : 'text-stone-400 group-hover/chip:text-stone-600'}`} />
      <span>{label}</span>
      {badge !== undefined && badge !== '' && (
        <span className={`min-w-[16px] h-[15px] px-1 rounded-full text-[9.5px] font-semibold tabular-nums leading-[15px] text-center ${active ? 'bg-orange-100 text-orange-700' : 'bg-[#efeae2] text-stone-500'}`}>{badge}</span>
      )}
      <span className={`pointer-events-none absolute left-2 right-2 -bottom-[3px] h-[2px] rounded-full bg-orange-500 transition-opacity duration-150 ${active ? 'opacity-100' : 'opacity-0'}`} />
    </button>
  );
export const ToolChipBar: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="flex items-center gap-1 flex-wrap -ml-1">{children}</div>;

// ── İKON KAYDI — /public/icons/*.svg (stroke="currentColor" → düğme rengini alır) ──
const ICONS = {
  'add-box': '/icons/add-box.svg', 'subtract-box': '/icons/subtract-box.svg', 'camera-perspective': '/icons/camera-perspective.svg', 'camera-orthographic': '/icons/camera-orthographic.svg',
  'view-solid': '/icons/view-solid.svg', 'view-wireframe': '/icons/view-wireframe.svg', 'view-xray': '/icons/view-xray.svg', 'linear-mode-on': '/icons/linear-mode-on.svg', 'linear-mode-off': '/icons/linear-mode-off.svg',
  'search': '/icons/search.svg', 'settings': '/icons/settings.svg', 'help-circle': '/icons/help-circle.svg', 'log-out': '/icons/log-out.svg', 'crosshair': '/icons/crosshair.svg',
  'file-plus': '/icons/file-plus.svg', 'file-down': '/icons/file-down.svg', 'save': '/icons/save.svg', 'upload': '/icons/upload.svg',
  'undo-2': '/icons/undo-2.svg', 'redo-2': '/icons/redo-2.svg', 'scissors': '/icons/scissors.svg', 'copy': '/icons/copy.svg', 'clipboard-paste': '/icons/clipboard-paste.svg', 'eraser': '/icons/eraser.svg',
  'mouse-pointer-2': '/icons/mouse-pointer-2.svg', 'move': '/icons/move.svg', 'navigation': '/icons/navigation.svg', 'refresh-ccw': '/icons/refresh-ccw.svg', 'maximize-2': '/icons/maximize-2.svg',
  'box': '/icons/box.svg', 'cog': '/icons/cog.svg', 'sliders-horizontal': '/icons/sliders-horizontal.svg', 'panel-left': '/icons/panel-left.svg', 'folder-open': '/icons/folder-open.svg',
  'camera': '/icons/camera.svg', 'box-select': '/icons/box-select.svg', 'scan-eye': '/icons/scan-eye.svg', 'cuboid': '/icons/cuboid.svg', 'eye': '/icons/eye.svg',
  'grid-2x2': '/icons/grid-2x2.svg', 'layers': '/icons/layers.svg', 'cylinder': '/icons/cylinder.svg', 'package': '/icons/package.svg', 'square': '/icons/square.svg', 'flip-horizontal': '/icons/flip-horizontal.svg',
  'maximize': '/icons/maximize.svg', 'bar-chart-3': '/icons/bar-chart-3.svg', 'file-text': '/icons/file-text.svg', 'git-branch': '/icons/git-branch.svg', 'target': '/icons/target.svg', 'rotate-cw': '/icons/rotate-cw.svg',
  'rotate-ccw': '/icons/rotate-ccw.svg', 'zap': '/icons/zap.svg', 'inspection-panel': '/icons/inspection-panel.svg', 'map-pin': '/icons/map-pin.svg', 'ruler': '/icons/ruler.svg', 'monitor': '/icons/monitor.svg',
  'snap-endpoint': '/icons/snap-endpoint.svg', 'snap-midpoint': '/icons/snap-midpoint.svg', 'snap-center': '/icons/snap-center.svg', 'snap-quadrant': '/icons/snap-quadrant.svg', 'snap-intersection': '/icons/snap-intersection.svg',
  'dimension': '/icons/dimension.svg',
} as const;
export type IconName = keyof typeof ICONS;
const svgCache: Record<string, string> = {};   // her SVG oturumda bir kez indirilir
interface IconProps { name: IconName; size?: number; className?: string; style?: React.CSSProperties }

/** Satır içi SVG ikon — currentColor'ı miras alır. */
export const Icon: React.FC<IconProps> = ({ name, size = 16, className = '', style }) => {
  const src = ICONS[name];
  const [markup, setMarkup] = useState<string>(() => svgCache[src] ?? '');
  useEffect(() => {
    if (svgCache[src]) { setMarkup(svgCache[src]); return; }
    let cancelled = false;
    fetch(src).then(r => r.text()).then(txt => {
      if (cancelled) return;
      const cleaned = txt.replace(/\swidth="[^"]*"/i, '').replace(/\sheight="[^"]*"/i, '');   // boyutu sarmalayıcı belirler
      svgCache[src] = cleaned;
      setMarkup(cleaned);
    }).catch(() => { if (!cancelled) setMarkup(''); });
    return () => { cancelled = true; };
  }, [src]);
  // SVG içeriği /public/icons altındaki yerel dosyalardan gelir — enjeksiyon güvenli.
  return <span role="img" aria-label={name} className={className} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, lineHeight: 0, flexShrink: 0, ...style }} dangerouslySetInnerHTML={{ __html: markup }} />;
};

interface IconButtonProps { icon: IconName; title: string; onClick?: () => void; disabled?: boolean; className?: string; size?: number; iconSize?: number; tone?: 'default' | 'exit' }
/** <img> tabanlı (kendi renklerini koruyan) ikon düğmesi. */
export const IconButton: React.FC<IconButtonProps> = ({ icon, title, onClick, disabled = false, className = '', size = 30, iconSize = 18, tone = 'default' }) => (
  <button onClick={onClick} disabled={disabled} style={{ width: size, height: size }} title={title}
    className={`flex items-center justify-center rounded transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-stone-400 active:scale-95 ${tone === 'exit' ? 'text-amber-700 hover:bg-amber-50 hover:text-amber-800' : 'hover:bg-stone-100'} ${disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'} ${className}`}>
    <img src={ICONS[icon]} width={iconSize} height={iconSize} alt={icon} draggable={false} />
  </button>
);
type PresetProps = Omit<IconButtonProps, 'icon' | 'title'>;
const preset = (icon: IconName, title: string): React.FC<PresetProps> => (props) => <IconButton icon={icon} title={title} {...props} />;
export const AddBoxButton = preset('add-box', 'Add Box (B)');
export const SubtractBoxButton = preset('subtract-box', 'Subtract Intersecting Shapes');
export const CameraPerspectiveButton = preset('camera-perspective', 'Perspective View');
export const CameraOrthographicButton = preset('camera-orthographic', 'Orthographic View');
export const ViewSolidButton = preset('view-solid', 'Solid View');
export const ViewWireframeButton = preset('view-wireframe', 'Wireframe View');
export const ViewXRayButton = preset('view-xray', 'X-Ray View');
export const LinearModeOnButton = preset('linear-mode-on', 'Linear Mode: On');
export const LinearModeOffButton = preset('linear-mode-off', 'Linear Mode: Off');

// ── DURUM ÇUBUĞU ─────────────────────────────────────────────────────────────
export const StatusBar: React.FC = () => {
  const { shapes, selectedShapeId, vertexEditMode, selectedVertexIndex } = useStoreFields('shapes', 'selectedShapeId', 'vertexEditMode', 'selectedVertexIndex');
  const selectedShape = shapes.find(s => s.id === selectedShapeId);
  const vertexModCount = selectedShape?.vertexModifications?.length || 0;
  return (
    <div className="fixed left-0 right-0 z-20" style={{ bottom: '38px', height: '26px', display: 'flex', alignItems: 'center', padding: '0 14px', gap: '10px', background: TOKENS.bg,
      borderTop: `1px solid ${TOKENS.border}`, borderBottom: `1px solid ${TOKENS.border}`, boxShadow: TOKENS.topShine, fontFamily: UI_FONT, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 0 2.5px rgba(16,185,129,0.18),0 0 4px rgba(16,185,129,0.4)' }} />
        <span style={{ color: '#047857', fontSize: '11px', fontWeight: 540, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Ready</span>
      </div>
      <VSep />
      <LabelValue label="Objects" value={shapes.length} mono />
      <VSep />
      <LabelValue label="Selected" value={selectedShape ? `${selectedShape.type} · ${selectedShape.id.slice(0, 8)}` : '—'} valueColor={selectedShape ? TOKENS.accentClr : '#b0aaa4'} mono={!!selectedShape} />
      {selectedShape && <><VSep /><LabelValue label="Position" value={`[${selectedShape.position.map(v => v.toFixed(1)).join(', ')}]`} mono /></>}
      {vertexEditMode && <><VSep /><LabelValue label="Vertex Edit" value={selectedVertexIndex !== null ? `V${selectedVertexIndex}` : 'Active'} valueColor={TOKENS.infoClr} mono /></>}
      {vertexModCount > 0 && <><VSep /><LabelValue label="Edits" value={vertexModCount} valueColor={TOKENS.modClr} mono /></>}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        <span style={{ color: TOKENS.labelClr, fontSize: '10.5px', fontWeight: 420, letterSpacing: '0.05em', textTransform: 'uppercase' }}>mm</span>
        <VSep />
        <span style={{ color: '#6b6560', fontSize: '11px', fontWeight: 500, fontFamily: MONO_FONT, letterSpacing: '0.02em' }}>YAGO v1.0</span>
      </div>
    </div>
  );
};

// ── TERMİNAL / KOMUT SATIRI ──────────────────────────────────────────────────
// Bekleyen bir fillet / vertex düzenleme işlemi varsa girilen sayı ona gider
// (Scene'in window köprüsü); klavyede yazılan karakterler otomatik odaklanır.
const TT = {
  bg: 'linear-gradient(180deg,#ebe8e2 0%,#e2ddd5 100%)', borderTop: '#d6d1c8', shineTop: 'inset 0 1px 0 rgba(255,255,255,0.55)',
  inputBg: 'linear-gradient(180deg,#ffffff 0%,#fbfaf7 100%)', inputBorder: 'rgba(60,50,40,0.14)', inputShadow: 'inset 0 1px 2px rgba(40,30,20,0.06),0 0 0 0.5px rgba(60,50,40,0.04)', inputText: '#1c1917',
  promptClr: '#d9540a', sendBg: 'linear-gradient(180deg,#f97316 0%,#ea580c 100%)', sendBgHover: 'linear-gradient(180deg,#fb923c 0%,#f97316 100%)',
  sendShadow: '0 1px 2px rgba(234,88,12,0.35),0 0 0 0.5px rgba(154,52,18,0.4),inset 0 1px 0 rgba(255,255,255,0.25)',
};

export const Terminal: React.FC = () => {
  const [commandInput, setCommandInput] = useState('');
  const [inputFocus, setInputFocus] = useState(false);
  const [sendHover, setSendHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (['t', 'f', 'r', 'l', 'b', 'u', 'i', 'c', 'h', 'v', 'z', '1', '2', '3'].includes(e.key.toLowerCase())) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.key.startsWith('F') ||
          ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Escape', 'Shift', 'CapsLock', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) return;
      if (e.key.length > 1 && !['Backspace', 'Enter', 'Space'].includes(e.key)) return;
      if (/^[a-zA-Z0-9\.\,\+\-\*\/\(\)]$/.test(e.key) || e.key === 'Backspace' || e.key === 'Space') {
        e.preventDefault();
        if (!inputRef.current) return;
        inputRef.current.focus();
        setCommandInput(prev => (e.key === 'Backspace' ? prev.slice(0, -1) : e.key === 'Space' ? prev + ' ' : prev + e.key));
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, []);

  const executeCommand = (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    const w = window as any;
    const num = parseFloat(trimmed);
    if (w.pendingFilletOperation) { if (!isNaN(num) && num > 0) w.handleFilletRadius?.(num); setCommandInput(''); return; }
    if (w.pendingVertexEdit) { if (!isNaN(num)) { w.handleVertexOffset?.(num); setCommandInput(''); } return; }
    setCommandInput('');
  };
  const hasCmd = !!commandInput.trim();

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30" style={{ height: '38px', background: TT.bg, borderTop: `1px solid ${TT.borderTop}`, boxShadow: `${TT.shineTop},0 -1px 4px rgba(40,30,20,0.05)`, fontFamily: UI_FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: '0 10px', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0, padding: '0 8px', height: '26px', background: 'rgba(217,84,10,0.08)', border: '1px solid rgba(217,84,10,0.18)', borderRadius: '6px' }}>
          <Hash size={11} style={{ color: TT.promptClr }} />
          <span style={{ color: TT.promptClr, fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>CMD</span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', height: '26px', padding: '0 10px', gap: '6px', background: TT.inputBg, border: `1px solid ${inputFocus ? '#f97316' : TT.inputBorder}`, borderRadius: '7px',
          boxShadow: inputFocus ? '0 0 0 2.5px rgba(249,115,22,0.14),inset 0 1px 2px rgba(40,30,20,0.04)' : TT.inputShadow, transition: 'border-color 0.15s,box-shadow 0.15s' }}>
          <ChevronRight size={12} style={{ color: inputFocus ? TT.promptClr : '#a8a29e', flexShrink: 0, transition: 'color 0.15s' }} />
          <input ref={inputRef} type="text" value={commandInput} onChange={e => setCommandInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') executeCommand(commandInput); }}
            onFocus={() => setInputFocus(true)} onBlur={() => setInputFocus(false)} placeholder="Enter a command or value..."
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: TT.inputText, fontFamily: MONO_FONT, fontSize: '12px', fontWeight: 500, letterSpacing: '0.01em' }} />
          {commandInput && <span style={{ color: '#b0aaa4', fontSize: '9.5px', fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', padding: '2px 5px', background: 'rgba(60,50,40,0.06)', borderRadius: '4px', flexShrink: 0 }}>⏎ Enter</span>}
        </div>
        <button onClick={() => executeCommand(commandInput)} onMouseEnter={() => setSendHover(true)} onMouseLeave={() => setSendHover(false)} disabled={!hasCmd}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '26px', background: hasCmd ? (sendHover ? TT.sendBgHover : TT.sendBg) : 'rgba(60,50,40,0.08)', border: 'none', borderRadius: '6px',
            boxShadow: hasCmd ? TT.sendShadow : 'inset 0 0 0 0.5px rgba(60,50,40,0.1)', color: hasCmd ? '#fff' : '#b0aaa4', cursor: hasCmd ? 'pointer' : 'not-allowed', outline: 'none', flexShrink: 0,
            transition: 'background 0.12s,transform 0.08s,box-shadow 0.12s', transform: sendHover && hasCmd ? 'translateY(-0.5px)' : 'translateY(0)' }}
          onMouseDown={e => { if (hasCmd) (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0.5px)'; }}
          onMouseUp={e => { if (hasCmd) (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-0.5px)'; }}>
          <Send size={12} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// Toolbar — üst başlık (logo, breadcrumb, arama, görünüm düğmeleri), menü çubuğu
// ve ana araç çubuğu. Kemik/fildişi "işlenmiş kemik" yüzeyler, turuncu aksan.
// ═══════════════════════════════════════════════════════════════════════════

const TS = { ui: '12.5px', uiSep: '11.5px', ls: '0.012em', lsTight: '-0.005em' };
const T = {
  headerBg: '#fdfcfa', menuBg: 'linear-gradient(180deg,#f7f5f0 0%,#efece5 100%)', rowBg: 'linear-gradient(180deg,#f4f2ee 0%,#ebe8e2 100%)',
  groupBg: 'linear-gradient(180deg,#fdfcfa 0%,#f6f3ed 100%)', groupBorder: 'rgba(60,50,40,0.14)',
  groupShadow: '0 1.5px 3px rgba(40,30,20,0.09),0 0.5px 1px rgba(40,30,20,0.05),0 0 0 0.5px rgba(60,50,40,0.07),inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.06)',
  hdrBorder: '#e4dfd7', rowBorder: '#d6d1c8', menuBorder: '#dcd6cb',
  iconIdle: '#6b6560', iconHover: '#1c1917', iconActive: '#ea580c', activeBg: 'rgba(234,88,12,0.08)', activeBord: 'rgba(234,88,12,0.28)', hoverBg: 'rgba(0,0,0,0.05)',
  textStrong: '#292524', textBody: '#44403c', textMute: '#706b65', textFaint: '#9c9590', textWhisper: '#c9c4be',
};

/** Araç düğmesi: hover'da hafif büyür, altında ipucu balonu. */
const TBtn: React.FC<{ icon: IconName; label: string; active?: boolean; disabled?: boolean; onClick?: () => void }> = ({ icon, label, active = false, disabled = false, onClick }) => {
  const [hov, setHov] = useState(false);
  const color = disabled ? '#c4bfbb' : active ? T.iconActive : hov ? T.iconHover : T.iconIdle;
  const bg = !disabled && active ? T.activeBg : !disabled && hov ? T.hoverBg : 'transparent';
  return (
    <button title={label} disabled={disabled} onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', borderRadius: '6px', border: 'none', background: bg,
        boxShadow: !disabled && active ? `0 0 0 1px ${T.activeBord}` : 'none', color, cursor: disabled ? 'not-allowed' : 'pointer', flexShrink: 0, outline: 'none',
        transition: 'background 0.1s,color 0.1s,box-shadow 0.1s,transform 0.1s', transform: hov && !disabled && !active ? 'scale(1.06)' : 'scale(1)' }}>
      <Icon name={icon} size={18} />
      <span style={{ pointerEvents: 'none', position: 'absolute', top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', background: '#1c1917', color: '#fafaf9', fontSize: '10px', fontWeight: 500,
        letterSpacing: '0.02em', padding: '3px 7px', borderRadius: '5px', whiteSpace: 'nowrap', zIndex: 60, opacity: hov && !disabled ? 1 : 0, transition: 'opacity 0.12s' }}>{label}</span>
    </button>
  );
};
const BtnGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '1px', padding: '2px', background: T.groupBg, border: `1px solid ${T.groupBorder}`, borderRadius: '8px', boxShadow: T.groupShadow, flexShrink: 0 }}>{children}</div>
);
const VLine: React.FC<{ h?: number; m?: string; o?: number }> = ({ h = 18, m = '0 8px', o = 0.12 }) => <div style={{ width: '1px', height: `${h}px`, flexShrink: 0, margin: m, background: hairline(o) }} />;
const Breadcrumb: React.FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: UI_FONT }}>
    <span style={{ fontSize: TS.ui, fontWeight: 400, letterSpacing: TS.ls, color: T.textFaint }}>{label}</span>
    <span style={{ fontSize: TS.uiSep, color: T.textWhisper, fontWeight: 300 }}>›</span>
    <span style={{ fontSize: TS.ui, fontWeight: 600, letterSpacing: TS.lsTight, color }}>{value}</span>
  </div>
);

/** Menü tanımları: [ikon, etiket, kısayol]; '-' = ayırıcı. */
type MenuItem = [IconName | null, string, string] | '-';
const MENUS: Array<{ label: string; items: MenuItem[] }> = [
  { label: 'File', items: [['file-plus', 'New Project', 'Ctrl+N'], ['upload', 'Open Project...', 'Ctrl+O'], '-', ['save', 'Save', 'Ctrl+S'], ['file-down', 'Save As...', 'Ctrl+Shift+S'], '-', ['upload', 'Import...', 'Ctrl+I'], ['file-down', 'Export...', 'Ctrl+E']] },
  { label: 'Edit', items: [['undo-2', 'Undo', 'Ctrl+Z'], ['redo-2', 'Redo', 'Ctrl+Y'], '-', ['scissors', 'Cut', 'Ctrl+X'], ['copy', 'Copy', 'Ctrl+C'], ['clipboard-paste', 'Paste', 'Ctrl+V'], '-', ['eraser', 'Delete', 'Del']] },
  { label: 'View', items: [['grid-2x2', 'Show Grid', 'G'], ['layers', 'Show Layers', 'L'], ['eye', 'Visibility', 'V'], '-', ['cuboid', 'Solid View', '1'], ['box-select', 'Wireframe View', '2'], ['scan-eye', 'X-Ray View', '3'], '-', [null, 'Zoom In', 'Ctrl++'], [null, 'Zoom Out', 'Ctrl+-'], [null, 'Fit to View', 'F']] },
  { label: 'Place', items: [['box', 'Add Box', 'B'], ['cylinder', 'Add Cylinder', 'C'], ['package', '3D Objects', '3'], '-', ['square', '2D Shapes', '2'], ['git-branch', 'Drawing Tools', 'L']] },
  { label: 'Modify', items: [['move', 'Move', 'M'], ['rotate-ccw', 'Rotate', 'R'], ['maximize', 'Scale', 'S'], '-', ['flip-horizontal', 'Mirror', 'Mi'], ['copy', 'Array', 'Ar'], ['sliders-horizontal', 'Edit', 'E']] },
  { label: 'Snap', items: [['target', 'Endpoint Snap', 'End'], ['navigation', 'Midpoint Snap', 'Mid'], ['crosshair', 'Center Snap', 'Cen'], ['rotate-cw', 'Quadrant Snap', 'Qua'], ['zap', 'Perpendicular Snap', 'Per'], ['inspection-panel', 'Intersection Snap', 'Int'], ['map-pin', 'Nearest Snap', 'Nea'], '-', ['settings', 'Snap Settings', 'Ctrl+Snap']] },
  { label: 'Measure', items: [['ruler', 'Distance', 'D'], ['ruler', 'Angle', 'A'], ['maximize-2', 'Area', 'Ar'], '-', ['ruler', 'Add Dimension', 'Ctrl+D'], ['settings', 'Dimension Style', 'Ctrl+M']] },
  { label: 'Display', items: [['monitor', 'Render Settings', 'R'], ['eye', 'View Modes', 'V'], ['camera', 'Camera Settings', 'C'], '-', ['layers', 'Material Editor', 'M'], ['settings', 'Lighting', 'L']] },
  { label: 'Settings', items: [['cog', 'General Settings', 'Ctrl+,'], ['grid-2x2', 'Grid Settings', 'G'], ['ruler', 'Unit Settings', 'U'], '-', ['settings', 'Toolbar', 'T'], ['panel-left', 'Panel Layout', 'P']] },
  { label: 'Report', items: [['file-text', 'Project Report', 'Ctrl+R'], ['bar-chart-3', 'Material List', 'Ctrl+L'], ['file-text', 'Dimension Report', 'Ctrl+M'], '-', ['file-down', 'PDF Export', 'Ctrl+P'], ['file-down', 'Excel Export', 'Ctrl+E']] },
  { label: 'Window', items: [['panel-left', 'New Window', 'Ctrl+N'], ['layers', 'Window Layout', 'Ctrl+W'], '-', ['monitor', 'Full Screen', 'F11'], ['panel-left', 'Hide Panels', 'Tab']] },
  { label: 'Help', items: [['help-circle', 'User Manual', 'F1'], ['help-circle', 'Keyboard Shortcuts', 'Ctrl+?'], ['monitor', 'Video Tutorials', 'Ctrl+T'], '-', ['help-circle', 'About', 'Ctrl+H'], ['help-circle', 'Check Updates', 'Ctrl+U']] },
];
const MENU_ACTIONS: Record<string, ViewMode> = { 'Solid View': ViewMode.SOLID, 'Wireframe View': ViewMode.WIREFRAME, 'X-Ray View': ViewMode.XRAY };

/** Seçili gövdeyle (dünya kutusu) kesişen diğer gövdeler. */
const intersectingBodies = (sel: Shape | undefined, shapes: Shape[]): Shape[] => {
  const sb = sel && sel.type !== 'panel' ? translatedBboxOf(sel) : null;
  if (!sb) return [];
  return shapes.filter(s => { if (s.id === sel!.id || s.type === 'panel') return false; const b = translatedBboxOf(s); return !!b && sb.intersectsBox(b); });
};

export const Toolbar: React.FC<{ onOpenCatalog: () => void }> = ({ onOpenCatalog }) => {
  const { setActiveTool, activeTool, addShape, selectedShapeId, cameraType, setCameraType, snapSettings, toggleSnapSetting, viewMode, setViewMode, cycleViewMode, orthoMode, toggleOrthoMode, shapes, updateShape, deleteShape, panelSelectMode } =
    useStoreFields('setActiveTool', 'activeTool', 'addShape', 'selectedShapeId', 'cameraType', 'setCameraType', 'snapSettings', 'toggleSnapSetting', 'viewMode', 'setViewMode', 'cycleViewMode', 'orthoMode', 'toggleOrthoMode', 'shapes', 'updateShape', 'deleteShape', 'panelSelectMode');
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const selectedShape = shapeById(selectedShapeId, shapes);
  const intersecting = React.useMemo(() => { try { return intersectingBodies(selectedShape, shapes); } catch { return []; } }, [selectedShape, shapes]);
  const hasIntersectingShapes = intersecting.length > 0;
  const isBoxSelected = selectedShape?.type === 'box';
  React.useEffect(() => { if (panelSelectMode && activeTool !== Tool.SELECT) setActiveTool(Tool.SELECT); }, [panelSelectMode, activeTool, setActiveTool]);

  const handleAddBox = async (e?: React.MouseEvent) => {
    e?.preventDefault(); e?.stopPropagation();
    try {
      const w = 600, h = 600, d = 600;
      const rs = await createReplicadBox({ width: w, height: h, depth: d });
      addShape({ id: `box-${Date.now()}`, type: 'box', geometry: convertReplicadToThreeGeometry(rs), replicadShape: rs, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#2563eb', parameters: { width: w, height: h, depth: d } });
    } catch (err) { alert(`Failed to add box: ${(err as Error).message}`); }
  };
  /** Seçili gövde, kesiştiği her gövdeden çıkarılır (çıkarma kaydı eklenir) ve silinir. */
  const handleSubtract = async () => {
    if (!selectedShapeId || !hasIntersectingShapes) return;
    try {
      const sel = selectedShape;
      if (!sel?.geometry || !sel.replicadShape) return;
      for (const tgt of intersecting) {
        if (!tgt.replicadShape) continue;
        const relOff = sel.position.map((v, i) => v - tgt.position[i]) as Vec3;
        const relRot = sel.rotation.map((v, i) => v - tgt.rotation[i]) as Vec3;
        const result = await performBooleanCut(tgt.replicadShape, sel.replicadShape, relOff, relRot, sel.scale);
        const newVerts = await getReplicadVertices(result);
        updateShape(tgt.id, { geometry: convertReplicadToThreeGeometry(result), replicadShape: result,
          subtractionGeometries: [...(tgt.subtractionGeometries || []), { geometry: sel.geometry.clone(), relativeOffset: relOff, relativeRotation: relRot, scale: [1, 1, 1] }],
          parameters: { ...tgt.parameters, scaledBaseVertices: newVerts.map(v => [v.x, v.y, v.z]) } });
      }
      deleteShape(selectedShapeId);
    } catch (err) { alert(`Failed to subtract: ${(err as Error).message}`); }
  };

  const menuItemBase: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: '30px', padding: '0 10px', fontSize: TS.ui, fontFamily: UI_FONT, fontWeight: 420, letterSpacing: TS.ls, color: T.textBody, background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: '6px', outline: 'none', transition: 'background 0.08s,color 0.08s' };
  const menuBtnStyle = (on: boolean): React.CSSProperties => ({
    height: '100%', padding: '0 13px', fontSize: TS.ui, fontFamily: UI_FONT, fontWeight: on ? 600 : 450, letterSpacing: on ? TS.lsTight : TS.ls, color: on ? '#ea580c' : T.textMute,
    background: on ? 'linear-gradient(180deg,#fff7ed 0%,#ffedd5 100%)' : 'transparent',
    boxShadow: on ? '0 0 0 0.5px rgba(234,88,12,0.12),inset 0 1px 0 rgba(255,255,255,0.9),inset 0 -1px 0 rgba(234,88,12,0.06)' : 'none',
    border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', position: 'relative', outline: 'none', borderRadius: '5px', transition: 'color 0.12s,background 0.12s,box-shadow 0.12s,letter-spacing 0.12s',
  });

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        @keyframes tb-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
        .tb-drop{animation:tb-in 0.11s ease-out forwards;}
        .tb-dot{position:absolute;bottom:-1px;left:50%;transform:translateX(-50%);width:18px;height:2px;border-radius:99px;background:linear-gradient(90deg,transparent,#f97316 50%,transparent);}
        .tb-mi:hover{background:#fff7ed!important;color:#ea580c!important;}
      `}</style>
      <div className="flex flex-col select-none" style={{ fontFamily: UI_FONT }}>
        {/* ROW 1 · Header */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', height: '46px', padding: '0 18px', background: T.headerBg, borderBottom: `1px solid ${T.hdrBorder}`, boxShadow: '0 1px 0 rgba(255,255,255,0.5)', gap: '12px' }}>
          <img src="/yago_logo.png" alt="YAGO" style={{ height: '26px', width: 'auto', objectFit: 'contain', flexShrink: 0 }} />
          <VLine h={20} m="0" o={0.18} />
          <Breadcrumb label="Company" value="Göker İnşaat" color="#d9540a" />
          <VLine h={20} m="0" o={0.18} />
          <Breadcrumb label="Project" value="Drawing1" color={T.textStrong} />
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <span style={{ position: 'absolute', left: '10px', pointerEvents: 'none', color: '#b0aaa4', display: 'inline-flex' }}><Icon name="search" size={12} /></span>
              <input type="text" placeholder="Search..."
                style={{ width: '180px', height: '28px', paddingLeft: '30px', paddingRight: '10px', fontSize: TS.ui, fontFamily: UI_FONT, fontWeight: 400, letterSpacing: TS.ls, color: T.textStrong, background: '#f7f6f3',
                  border: `1px solid ${T.groupBorder}`, borderRadius: '7px', outline: 'none', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.04)', transition: 'border-color 0.15s,box-shadow 0.15s,background 0.15s' }}
                onFocus={e => { e.currentTarget.style.borderColor = '#f97316'; e.currentTarget.style.boxShadow = '0 0 0 2.5px rgba(249,115,22,0.14),inset 0 1px 2px rgba(0,0,0,0.03)'; e.currentTarget.style.background = '#fff'; }}
                onBlur={e => { e.currentTarget.style.borderColor = T.groupBorder; e.currentTarget.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.04)'; e.currentTarget.style.background = '#f7f6f3'; }} />
            </div>
            <VLine m="0 4px" o={0.16} />
            <BtnGroup>
              {viewMode === ViewMode.SOLID ? <ViewSolidButton onClick={cycleViewMode} /> : viewMode === ViewMode.WIREFRAME ? <ViewWireframeButton onClick={cycleViewMode} /> : <ViewXRayButton onClick={cycleViewMode} />}
              {cameraType === CameraType.PERSPECTIVE
                ? <CameraPerspectiveButton onClick={() => setCameraType(CameraType.ORTHOGRAPHIC)} />
                : <CameraOrthographicButton onClick={() => setCameraType(CameraType.PERSPECTIVE)} />}
              {orthoMode === OrthoMode.ON ? <LinearModeOnButton onClick={toggleOrthoMode} /> : <LinearModeOffButton onClick={toggleOrthoMode} />}
              <VLine h={16} m="0 2px" o={0.14} />
              <IconButton icon="settings" title="Settings" />
              <IconButton icon="help-circle" title="Help" />
              <VLine h={16} m="0 2px" o={0.14} />
              <IconButton icon="log-out" title="Exit" tone="exit" />
            </BtnGroup>
          </div>
        </div>

        {/* ROW 2 · Menu bar — işlenmiş kemik yüzey */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', height: '34px', padding: '0 14px', background: T.menuBg, borderBottom: `1px solid ${T.menuBorder}`,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.85),inset 0 -1px 0 rgba(140,120,100,0.08),inset 1px 0 0 rgba(255,255,255,0.4),inset -1px 0 0 rgba(140,120,100,0.04),0 1px 0 rgba(255,255,255,0.45),0 2px 4px -1px rgba(60,50,40,0.06)' }}>
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: 'repeating-linear-gradient(0deg,rgba(255,255,255,0) 0px,rgba(255,255,255,0) 2px,rgba(140,120,100,0.012) 2px,rgba(140,120,100,0.012) 3px)', opacity: 0.6 }} />
          {MENUS.map(menu => {
            const on = activeMenu === menu.label;
            return (
              <div key={menu.label} style={{ position: 'relative', height: '100%', zIndex: 1 }}>
                <button style={menuBtnStyle(on)} onClick={() => setActiveMenu(on ? null : menu.label)}
                  onMouseEnter={e => {
                    if (activeMenu) setActiveMenu(menu.label);
                    if (!on) { const b = e.currentTarget; b.style.color = T.textStrong; b.style.background = 'linear-gradient(180deg,#fdfcfa 0%,#f4f1ea 100%)'; b.style.boxShadow = '0 0 0 0.5px rgba(60,50,40,0.08),inset 0 1px 0 rgba(255,255,255,0.9)'; }
                  }}
                  onMouseLeave={e => { if (!on) { const b = e.currentTarget; b.style.color = T.textMute; b.style.background = 'transparent'; b.style.boxShadow = 'none'; } }}>
                  {menu.label}
                  {on && <div className="tb-dot" />}
                </button>
                {on && (
                  <div className="tb-drop" onMouseLeave={() => setActiveMenu(null)}
                    style={{ position: 'absolute', left: 0, top: '100%', marginTop: '5px', width: '216px', background: '#ffffff', border: `1px solid ${T.hdrBorder}`, borderRadius: '10px', padding: '5px', zIndex: 50,
                      boxShadow: '0 12px 36px -4px rgba(40,30,20,0.14),0 4px 12px -2px rgba(40,30,20,0.06),0 0 0 0.5px rgba(40,30,20,0.04)' }}>
                    {menu.items.map((item, i) => item === '-'
                      ? <div key={i} style={{ height: '1px', background: '#f0ede8', margin: '3px 0' }} />
                      : (
                        <button key={i} className="tb-mi" style={menuItemBase} onClick={() => { const vm = MENU_ACTIONS[item[1]]; if (vm) setViewMode(vm); setActiveMenu(null); }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>{item[0] && <Icon name={item[0]} size={11} />}<span>{item[1]}</span></div>
                          <span style={{ fontFamily: MONO_FONT, fontSize: '10px', letterSpacing: '0.03em', color: T.textFaint, fontWeight: 400 }}>{item[2]}</span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ROW 3 · Main toolbar */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', height: '42px', padding: '0 14px', background: T.rowBg, borderBottom: `1px solid ${T.rowBorder}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.85),inset 0 -1px 0 rgba(140,120,100,0.06),0 1px 4px rgba(60,50,40,0.04)' }}>
          <BtnGroup><TBtn icon="file-plus" label="New (Ctrl+N)" /><TBtn icon="save" label="Save (Ctrl+S)" /><TBtn icon="file-down" label="Save As" /></BtnGroup>
          <VLine />
          <BtnGroup><TBtn icon="undo-2" label="Undo (Ctrl+Z)" /><TBtn icon="redo-2" label="Redo (Ctrl+Y)" /></BtnGroup>
          <VLine />
          <BtnGroup>
            <TBtn icon="mouse-pointer-2" label="Select (V)" active={activeTool === Tool.SELECT} onClick={() => setActiveTool(Tool.SELECT)} />
            <TBtn icon="move" label="Move (M)" active={activeTool === Tool.MOVE} disabled={!selectedShapeId} onClick={() => setActiveTool(Tool.MOVE)} />
            <TBtn icon="navigation" label="Point to Point" active={activeTool === Tool.POINT_TO_POINT_MOVE} disabled={!selectedShapeId} onClick={() => setActiveTool(Tool.POINT_TO_POINT_MOVE)} />
            <TBtn icon="refresh-ccw" label="Rotate (R)" active={activeTool === Tool.ROTATE} disabled={!selectedShapeId} onClick={() => setActiveTool(Tool.ROTATE)} />
            <TBtn icon="maximize-2" label={isBoxSelected ? 'Scale — disabled for box' : 'Scale (S)'} active={activeTool === Tool.SCALE} disabled={!selectedShapeId || isBoxSelected} onClick={() => setActiveTool(Tool.SCALE)} />
          </BtnGroup>
          <VLine />
          <BtnGroup>
            <TBtn icon="snap-endpoint" label="Endpoint" active={snapSettings.endpoint} onClick={() => toggleSnapSetting(SnapType.ENDPOINT)} />
            <TBtn icon="snap-midpoint" label="Midpoint" active={snapSettings.midpoint} onClick={() => toggleSnapSetting(SnapType.MIDPOINT)} />
            <TBtn icon="snap-center" label="Center" active={snapSettings.center} onClick={() => toggleSnapSetting(SnapType.CENTER)} />
            <TBtn icon="snap-quadrant" label="Quadrant" onClick={() => console.warn('Quadrant snap not wired yet — add SnapType.QUADRANT to store')} />
            <TBtn icon="snap-intersection" label="Intersection" active={snapSettings.intersection} onClick={() => toggleSnapSetting(SnapType.INTERSECTION)} />
          </BtnGroup>
          <VLine />
          <BtnGroup>
            <AddBoxButton onClick={handleAddBox} />
            <SubtractBoxButton onClick={handleSubtract} disabled={!selectedShapeId || !hasIntersectingShapes} className={hasIntersectingShapes ? 'text-red-400 hover:bg-red-50 hover:text-red-500' : ''} />
            <VLine h={16} m="0 2px" o={0.14} />
            <IconButton icon="dimension" title="Dimensioning" onClick={() => setActiveTool(Tool.DIMENSION)} className={activeTool === Tool.DIMENSION ? 'bg-orange-50 ring-1 ring-orange-200' : ''} />
            <VLine h={16} m="0 2px" o={0.14} />
            <IconButton icon="folder-open" title="Catalog" onClick={onOpenCatalog} />
          </BtnGroup>
        </div>
      </div>
    </>
  );
};

/* ═══ SOL KENAR ÇUBUĞU — sekmeli (Parameters / Panel Editor), varsayılan sabit, tıkla-aç tutamacı, kemik teması ═══ */
/* ─── Tasarım tokenları — Toolbar'ın kemik/fildişi paletiyle hizalı ─── */
const SB = {
  bg:            'linear-gradient(180deg,#f4f2ee 0%,#ebe8e2 100%)',
  contentBg:     'linear-gradient(180deg,#fdfcfa 0%,#f6f3ed 100%)',
  tabStripBg:    '#fdfcfa',
  border:        '#d6d1c8',
  borderSoft:    '#e4dfd7',
  groupBorder:   'rgba(60,50,40,0.14)',
  hairline:      'rgba(60,50,40,0.08)',
  panelShadow:   '6px 0 28px -6px rgba(40,30,20,0.14),2px 0 6px -1px rgba(40,30,20,0.10),0.5px 0 1px rgba(40,30,20,0.06),0 0 0 0.5px rgba(60,50,40,0.07),inset -0.5px 0 0 rgba(140,120,100,0.06),inset 0.5px 0 0 rgba(255,255,255,0.95)',
  textPrimary:   '#1c1917',
  textSecondary: '#44403c',
  textTertiary:  '#706b65',
  textMuted:     '#9c9590',
  accent:        '#ea580c',
  accentSoft:    '#fff7ed',
  accentGradient:'linear-gradient(90deg,transparent,#f97316 50%,transparent)',
};
const SIDEBAR_WIDTH = 560;
const VSEP: React.CSSProperties = { width: '1px', height: '22px', background: 'linear-gradient(to bottom,transparent,rgba(60,50,40,0.14) 30%,rgba(60,50,40,0.14) 70%,transparent)', flexShrink: 0 };
const ACCENT_UNDERLINE = (width: string): React.CSSProperties => ({ position: 'absolute', bottom: '-1px', left: '50%', transform: 'translateX(-50%)', width, height: '2px', background: SB.accentGradient, borderRadius: '99px' });

/* ─── Sekme düğmesi ─── */
const TabBtn: React.FC<{ active: boolean; onClick: () => void; icon: React.ReactNode; label: string }> = ({ active, onClick, icon, label }) => {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        height: '100%', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
        background: active ? 'linear-gradient(180deg,#ffffff 0%,#fdfbf7 100%)' : hov ? 'rgba(60,50,40,0.045)' : 'transparent',
        border: 'none', cursor: 'pointer', outline: 'none', position: 'relative',
        color: active ? SB.accent : hov ? SB.textPrimary : SB.textTertiary,
        fontSize: '12.5px', fontWeight: active ? 600 : 500, letterSpacing: active ? '-0.005em' : '0.02em', fontFamily: UI_FONT,
        transition: 'color 0.12s,background 0.12s', boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.9)' : 'none', flexShrink: 0,
      }}>
      {icon}<span>{label}</span>
      {active && <div style={ACCENT_UNDERLINE('calc(100% - 24px)')} />}
    </button>
  );
};

/* ─── Boş durum ─── */
const EmptyState: React.FC<{ icon: React.ReactNode; title: string; description: string; hint: string }> = ({ icon, title, description, hint }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '320px', padding: '24px 32px', textAlign: 'center', animation: 'ls-empty-in 0.3s ease-out forwards' }}>
    <div style={{
      position: 'relative', width: '52px', height: '52px', borderRadius: '14px', background: 'linear-gradient(180deg,#ffffff 0%,#f4f1ea 100%)', border: `1px solid ${SB.groupBorder}`,
      boxShadow: '0 4px 12px -2px rgba(40,30,20,0.10),0 1px 3px rgba(40,30,20,0.06),0 0 0 0.5px rgba(60,50,40,0.05),inset 0 1px 0 rgba(255,255,255,0.95),inset 0 -1px 0 rgba(140,120,100,0.06)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', color: SB.textTertiary, marginBottom: '16px',
    }}>
      {icon}
      <div style={{ position: 'absolute', top: '-3px', right: '-3px', width: '10px', height: '10px', borderRadius: '50%', background: 'radial-gradient(circle,rgba(234,88,12,0.18),transparent 70%)' }} />
    </div>
    <span style={{ color: SB.textPrimary, fontSize: '13.5px', fontWeight: 600, letterSpacing: '-0.01em', marginBottom: '6px' }}>{title}</span>
    <span style={{ color: SB.textTertiary, fontSize: '11.5px', fontWeight: 400, letterSpacing: '0.015em', lineHeight: 1.55, maxWidth: '260px', marginBottom: '16px' }}>{description}</span>
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 11px', background: 'rgba(255,255,255,0.6)', border: `0.5px solid ${SB.hairline}`, borderRadius: '99px', boxShadow: '0 1px 2px rgba(40,30,20,0.04),inset 0 1px 0 rgba(255,255,255,0.8)' }}>
      <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: SB.accent }} />
      <span style={{ fontSize: '10.5px', fontWeight: 500, letterSpacing: '0.015em', color: SB.textSecondary }}>{hint}</span>
    </div>
  </div>
);

/* ═══════════════════════════════════════════════════════════════════════════
   KEMİK TEMASI — ParametersPanel + PanelEditor'ü kaynağına dokunmadan yeniden
   giydirir (Toolbar paletiyle uyumlu). Yalnız bugün kullanılan seçiciler.
   ═══════════════════════════════════════════════════════════════════════════ */
const SIDEBAR_CSS = `
@keyframes ls-glow-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ls-empty-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.custom-scrollbar::-webkit-scrollbar { width: 10px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(60,50,40,0.18); border-radius: 99px; border: 2.5px solid transparent; background-clip: padding-box; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(60,50,40,0.32); background-clip: padding-box; border: 2.5px solid transparent; }
.bone-skin {
  --bone-bg: #fdfcfa; --bone-border-soft: #e4dfd7; --bone-text: #1c1917; --bone-text-soft: #44403c; --bone-text-muted: #706b65; --bone-text-faint: #9c9590;
  --bone-accent: #ea580c; --bone-accent-soft: #fff7ed; --bone-accent-bord: rgba(234,88,12,0.28);
  font-family: 'Inter','SF Pro Text',system-ui,sans-serif; color: var(--bone-text); padding: 8px 6px 16px !important;
}
/* Kenar çubuğundaki tüm girişler */
.bone-skin input[type="text"], .bone-skin textarea {
  background: linear-gradient(180deg,#ffffff 0%,#fbfaf6 100%) !important; border: 1px solid rgba(60,50,40,0.14) !important; border-radius: 6px !important;
  color: var(--bone-text) !important; font-family: 'Inter',system-ui,sans-serif !important; font-size: 11.5px !important; font-weight: 500 !important; letter-spacing: 0.012em !important;
  height: 24px !important; padding: 0 8px !important; box-shadow: inset 0 1px 2px rgba(40,30,20,0.04),0 0 0 0.5px rgba(60,50,40,0.04) !important;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s !important; outline: none !important;
}
/* Panel satırı notu — kutusuz, sessiz alan: yalnız üzerine gelince kıl-çizgi, odakta beyaz zemin + turuncu halka. Özgüllük (0,3,1) genel kuralı geçer. */
.bone-skin input[type="text"].yago-row-note { background: transparent !important; border: 1px solid transparent !important; border-radius: 5px !important; box-shadow: none !important; height: 22px !important; padding: 0 5px !important; font-size: 11.5px !important; font-weight: 450 !important; letter-spacing: 0.005em !important; color: #57534e !important; }
.bone-skin input[type="text"].yago-row-note::placeholder { color: #c9c2b8 !important; font-weight: 400 !important; }
.bone-skin input[type="text"].yago-row-note:hover { border-color: #ebe5dc !important; background: rgba(255,255,255,0.6) !important; }
.bone-skin input[type="text"].yago-row-note:focus { background: #ffffff !important; border-color: rgba(249,115,22,0.45) !important; box-shadow: 0 0 0 2px rgba(249,115,22,0.10) !important; color: #1c1917 !important; }
/* Parametre değeri — aynı sessiz alan, sayısal yazı. */
.bone-skin input[type="text"].yago-param-input { background: transparent !important; border: 1px solid transparent !important; border-radius: 6px !important; box-shadow: none !important; height: 22px !important; padding: 0 6px !important; font-family: 'SF Mono',ui-monospace,Menlo,monospace !important; font-size: 12px !important; font-weight: 500 !important; letter-spacing: 0 !important; color: #292524 !important; font-variant-numeric: tabular-nums; }
.bone-skin input[type="text"].yago-param-input::placeholder { color: #c9c2b8 !important; }
.bone-skin input[type="text"].yago-param-input:hover { border-color: #ebe5dc !important; background: rgba(255,255,255,0.6) !important; }
.bone-skin input[type="text"].yago-param-input:focus { background: #ffffff !important; border-color: rgba(249,115,22,0.45) !important; box-shadow: 0 0 0 2px rgba(249,115,22,0.10) !important; }
.bone-skin input[type="text"].font-mono { font-family: 'SF Mono','Fira Code','Cascadia Code',monospace !important; font-size: 11px !important; letter-spacing: 0.02em !important; }
/* Odak — araç çubuğu aramasıyla aynı turuncu halka */
.bone-skin input[type="text"]:focus, .bone-skin textarea:focus { border-color: #f97316 !important; box-shadow: 0 0 0 2.5px rgba(249,115,22,0.14),inset 0 1px 2px rgba(40,30,20,0.03) !important; background: #ffffff !important; }
/* Düğmeler */
.bone-skin button { font-family: 'Inter',system-ui,sans-serif; font-weight: 500; letter-spacing: 0.012em; transition: background 0.12s, color 0.12s, box-shadow 0.12s, transform 0.12s !important; }
.bone-skin button:disabled { opacity: 0.4 !important; cursor: not-allowed !important; }
/* Tailwind metin tonları */
.bone-skin .text-stone-400 { color: var(--bone-text-faint) !important; }
.bone-skin .text-stone-500 { color: var(--bone-text-muted) !important; }
.bone-skin .text-stone-600 { color: var(--bone-text-soft) !important; }
.bone-skin .text-stone-700, .bone-skin .text-stone-800 { color: var(--bone-text) !important; }
/* Zeminler / kenarlar */
.bone-skin .bg-white { background: var(--bone-bg) !important; }
.bone-skin .bg-stone-50 { background: #f7f4ee !important; }
.bone-skin .bg-stone-100 { background: #efeae0 !important; }
.bone-skin .bg-stone-200 { background: #e4dfd5 !important; }
.bone-skin .border-stone-300, .bone-skin .border-stone-200 { border-color: var(--bone-border-soft) !important; }
/* Turuncu vurgular */
.bone-skin .bg-orange-50, .bone-skin .hover\\:bg-orange-50:hover { background: var(--bone-accent-soft) !important; }
.bone-skin .bg-orange-100, .bone-skin .hover\\:bg-orange-100:hover { background: #ffedd5 !important; }
.bone-skin .text-orange-600, .bone-skin .text-orange-700, .bone-skin .hover\\:text-orange-600:hover { color: var(--bone-accent) !important; }
.bone-skin .border-orange-300, .bone-skin .border-orange-400 { border-color: var(--bone-accent-bord) !important; }
/* Kırmızı yıkıcı öğeler */
.bone-skin .text-red-500, .bone-skin .text-red-600 { color: #dc2626 !important; }
.bone-skin .hover\\:bg-red-100:hover { background: rgba(239,68,68,0.10) !important; }
/* Aralık ritmi */
.bone-skin .p-2 { padding: 12px !important; }
.bone-skin .px-3 { padding-left: 14px !important; padding-right: 14px !important; }
.bone-skin .py-2 { padding-top: 10px !important; padding-bottom: 10px !important; }
.bone-skin input:disabled { opacity: 0.55 !important; background: #f0ece4 !important; }
`;

/* ─── Başlık kontrolleri: sekmelerden BAĞIMSIZ, tüm menüleri kapsayan görünüm/seçim ayarları ───
   (Goker: "outline ve panel/body seçim modu diğer düğmelerle aynı işlevde değil, tüm menüleri
   kapsıyor" → Panel Editor araç çubuğundan sekme şeridine, Pin'in yanına taşındı.) */
const HeaderToggle: React.FC<{ active: boolean; onClick: () => void; title: string; icon: React.ReactNode; label?: string }> = ({ active, onClick, title, icon, label }) => {
  const [hov, setHov] = useState(false);
  return (
    <button type="button" onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} title={title} aria-pressed={active}
      style={{
        ...(label ? { padding: '0 11px', gap: '6px' } : { width: '36px' }),
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', outline: 'none', cursor: 'pointer', position: 'relative',
        background: active ? SB.accentSoft : hov ? 'rgba(60,50,40,0.05)' : 'transparent',
        color: active ? SB.accent : hov ? SB.textPrimary : SB.textTertiary, transition: 'background 0.12s,color 0.12s', flexShrink: 0,
        fontFamily: UI_FONT, fontSize: '12px', fontWeight: active ? 600 : 500, letterSpacing: '0.01em',
      }}>
      {icon}
      {label && <span>{label}</span>}
      {active && <div style={ACCENT_UNDERLINE(label ? 'calc(100% - 16px)' : '60%')} />}
    </button>
  );
};
/* ═══════════════════════════════════════════════════════════════════════════
   Sidebar — varsayılan sabit + tıkla-aç + kemik teması
   ═══════════════════════════════════════════════════════════════════════════ */
type SidebarTab = 'parameters' | 'panel-editor';
export const Sidebar: React.FC<{ parametersContent: React.ReactNode; panelEditorContent: React.ReactNode }> = ({ parametersContent, panelEditorContent }) => {
  const { selectedShapeId, showOutlines, setShowOutlines, panelSelectMode, setPanelSelectMode } =
    useStoreFields('selectedShapeId', 'showOutlines', 'setShowOutlines', 'panelSelectMode', 'setPanelSelectMode');
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>('panel-editor');
  const [pinHover, setPinHover] = useState(false);
  const [handleHover, setHandleHover] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  // Açma okuna tıklamak kenar çubuğunu hem açar hem sabitler.
  const openSidebar = useCallback(() => { setIsOpen(true); setIsPinned(true); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !(isOpen || isPinned)) return;
      // Escape, şerit girdisinde / aktif araçta "iptal" tuşudur. Yazı alanındayken
      // ya da bir panel aracı (Extrude / Taşı / Döndür) açıkken kenar çubuğu KAPANMAZ.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const st = useAppStore.getState();
      if (st.faceExtrudeMode || st.panelMoveMode || st.panelRotateMode) return;
      setIsOpen(false); setIsPinned(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isPinned]);

  useEffect(() => {
    if (!isOpen || isPinned) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || sidebarRef.current?.contains(target) || handleRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [isOpen, isPinned]);

  const isVisible = isOpen || isPinned;
  const tabPane = (tab: SidebarTab, content: React.ReactNode, empty: React.ReactNode) => (
    <div style={{ display: activeTab === tab ? 'block' : 'none' }}>{selectedShapeId ? content : empty}</div>
  );

  return (
    <>
      {/* ═══ KAPALI DURUM — tıkla-aç tutamacı ═══ */}
      {!isVisible && (
        <div ref={handleRef} className="fixed left-0 z-40" style={{ top: '120px', bottom: '64px', width: '24px', pointerEvents: 'none' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '1px', background: 'linear-gradient(to bottom,transparent,rgba(60,50,40,0.10) 20%,rgba(60,50,40,0.10) 80%,transparent)', pointerEvents: 'none' }} />
          <button type="button" onClick={openSidebar} onMouseEnter={() => setHandleHover(true)} onMouseLeave={() => setHandleHover(false)} aria-label="Open sidebar"
            style={{
              position: 'absolute', top: '50%', transform: `translateY(-50%) translateX(${handleHover ? '3px' : '0'})`, left: '0', width: '24px', height: '72px', padding: 0,
              borderRadius: '0 11px 11px 0', background: SB.contentBg, border: `1px solid ${SB.groupBorder}`, borderLeft: 'none',
              boxShadow: handleHover
                ? '4px 3px 16px rgba(40,30,20,0.16),1.5px 0 4px rgba(40,30,20,0.10),0 0 0 0.5px rgba(60,50,40,0.08),inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.08)'
                : '2px 1px 8px rgba(40,30,20,0.09),0.5px 0 1px rgba(40,30,20,0.05),0 0 0 0.5px rgba(60,50,40,0.07),inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.06)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '5px', cursor: 'pointer', outline: 'none',
              transition: 'transform 0.22s cubic-bezier(0.4,0,0.2,1),box-shadow 0.22s', pointerEvents: 'auto',
            }}>
            <ChevronRight size={14} strokeWidth={2.5} style={{ color: handleHover ? SB.accent : SB.textSecondary, transition: 'color 0.15s,transform 0.22s', transform: handleHover ? 'translateX(1.5px)' : 'translateX(0)' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'center' }}>
              {[0, 1, 2].map(i => <div key={i} style={{ width: '2.5px', height: '2.5px', borderRadius: '50%', background: handleHover ? SB.accent : SB.textMuted, transition: 'background 0.15s', opacity: handleHover ? 0.95 : 0.65 }} />)}
            </div>
          </button>
          {handleHover && (
            <div style={{ position: 'absolute', top: '50%', left: '0', transform: 'translateY(-50%)', width: '48px', height: '110px', borderRadius: '0 50% 50% 0', background: 'radial-gradient(ellipse at left center,rgba(249,115,22,0.12),transparent 70%)', pointerEvents: 'none', animation: 'ls-glow-in 0.25s ease-out forwards' }} />
          )}
        </div>
      )}

      {/* ═══ KENAR ÇUBUĞU ═══ */}
      <div ref={sidebarRef} className="fixed z-40 flex transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{ top: '120px', bottom: '64px', left: 0, width: `${SIDEBAR_WIDTH}px`, transform: isVisible ? 'translateX(0)' : `translateX(-${SIDEBAR_WIDTH}px)` }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: SB.bg, borderRight: `1px solid ${SB.border}`, boxShadow: SB.panelShadow, fontFamily: UI_FONT }}>
          {/* ── Sekme şeridi ── */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', height: '40px', background: SB.tabStripBg, borderBottom: `1px solid ${SB.borderSoft}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.7),0 1px 0 rgba(255,255,255,0.4)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', height: '100%', flexShrink: 0 }}>
              <TabBtn active={activeTab === 'parameters'} onClick={() => setActiveTab('parameters')} icon={<SlidersHorizontal size={13.5} strokeWidth={2} />} label="Parameters" />
              <div style={VSEP} />
              <TabBtn active={activeTab === 'panel-editor'} onClick={() => setActiveTab('panel-editor')} icon={<PanelLeft size={13.5} strokeWidth={2} />} label="Panel Editor" />
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', height: '100%', flexShrink: 0 }}>
              <div style={VSEP} />
              {/* SEÇİM MODU: tek düğme — her tıklama Body ↔ Panel arasında geçer; etiket/ikon GÜNCEL modu gösterir. */}
              <HeaderToggle active={panelSelectMode} onClick={() => setPanelSelectMode(!panelSelectMode)}
                title={panelSelectMode ? 'Selection: Panel (individual panels) — click to switch to Body' : 'Selection: Body (whole bodies) — click to switch to Panel'}
                icon={panelSelectMode ? <RectangleHorizontal size={13} strokeWidth={2.1} /> : <Box size={13} strokeWidth={2.1} />} label={panelSelectMode ? 'Panel' : 'Body'} />
              <div style={VSEP} />
              <HeaderToggle active={showOutlines} onClick={() => setShowOutlines(!showOutlines)} title="Show panel outlines" icon={<Square size={13} strokeWidth={2.1} />} />
              <div style={VSEP} />
              <button onClick={() => { if (isPinned) { setIsPinned(false); setIsOpen(false); } else setIsPinned(true); }}
                onMouseEnter={() => setPinHover(true)} onMouseLeave={() => setPinHover(false)} title={isPinned ? 'Unpin panel' : 'Pin panel'}
                style={{
                  width: '40px', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', outline: 'none', cursor: 'pointer',
                  background: isPinned ? SB.accentSoft : pinHover ? 'rgba(60,50,40,0.05)' : 'transparent',
                  color: isPinned ? SB.accent : pinHover ? SB.textPrimary : SB.textTertiary,
                  transition: 'background 0.12s,color 0.12s,transform 0.18s', transform: pinHover && !isPinned ? 'rotate(-12deg)' : 'rotate(0deg)', position: 'relative',
                }}>
                {isPinned ? <Pin size={14} strokeWidth={2.2} /> : <PinOff size={14} strokeWidth={2} />}
                {isPinned && <div style={ACCENT_UNDERLINE('65%')} />}
              </button>
            </div>
          </div>
          {/* ── İçerik — `bone-skin` tema sarmalayıcısı ── */}
          <div className="custom-scrollbar bone-skin" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', background: SB.contentBg, boxShadow: 'inset 0 2px 4px rgba(40,30,20,0.05),inset 0 -1px 0 rgba(140,120,100,0.04)' }}>
            {tabPane('parameters', parametersContent, <EmptyState icon={<SlidersHorizontal size={18} strokeWidth={1.6} />} title="No shape selected" description="Select an object from the 3D view to edit its parameters" hint="Tip: Click an object or drag a selection box" />)}
            {tabPane('panel-editor', panelEditorContent, <EmptyState icon={<PanelLeft size={18} strokeWidth={1.6} />} title="No panel selected" description="Select a panel or surface to edit its properties" hint="Tip: Click a surface in face select mode" />)}
          </div>
        </div>
      </div>
      <style>{SIDEBAR_CSS}</style>
    </>
  );
};
