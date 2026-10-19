import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AppWindow, Box, ChevronRight, Columns3, Container, DoorClosed, GripHorizontal, Hash, Layers, LayoutPanelTop, type LucideIcon,
  PanelLeft, PictureInPicture2, Pin, PinOff, Plus, Radius, Rows3, Send, SendToBack, SlidersHorizontal, Spline, Square,
} from 'lucide-react';
import { CameraType, OrthoMode, type Shape, SnapType, Tool, ViewMode, shapeById, useAppStore, useStoreFields } from '../store';
import { type Vec3, convertReplicadToThreeGeometry, createReplicadBox, getReplicadVertices, performBooleanCut, translatedBboxOf } from './Geometry';

/* Uygulama kabuğu: tasarım jetonları, ErrorBoundary, ikonlar, durum çubuğu, terminal,
   üst araç çubuğu (boolean çıkarma) ve sol kenar çubuğu (yaslı / yüzen / ayrı pencere) + kemik teması. */

export const UI_FONT = "'Inter','SF Pro Text',system-ui,sans-serif";
export const MONO_FONT = "'SF Mono','Fira Code','Cascadia Code',monospace";
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

/** Fare üzerinde mi: [durum, onMouseEnter/onMouseLeave işleyicileri]. */
const useHover = () => {
  const [hov, setHov] = useState(false);
  return [hov, { onMouseEnter: () => setHov(true), onMouseLeave: () => setHov(false) }] as const;
};
/** Pencere / işaretçi API'si erişilemez ya da desteklenmiyorsa sessizce geçilir. */
const attempt = (f: () => unknown) => { try { f(); } catch { /* erişilemez / desteklenmiyor */ } };
/** Doğrudan stil yazımı (DOM hover/odak efektleri; React yeniden çizimi gerekmez). */
const paint = (el: HTMLElement, css: Partial<CSSStyleDeclaration>) => { Object.assign(el.style, css); };
/** Dikey kıl çizgisi ayırıcı. */
const vline = (h: number, o = 0.14, margin?: string): React.CSSProperties =>
  ({ width: '1px', height: `${h}px`, flexShrink: 0, margin, background: hairline(o) });

type LabelValueProps = { label: string; value: React.ReactNode; valueColor?: string; mono?: boolean; small?: boolean };
export const LabelValue: React.FC<LabelValueProps> = ({ label, value, valueColor = TOKENS.valueClr, mono = false, small = false }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
    <span style={{
      color: TOKENS.labelClr, fontSize: small ? '10.5px' : '11px', fontWeight: 420, letterSpacing: small ? '0.05em' : '0.04em',
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>{label}</span>
    <span style={{
      color: valueColor, fontSize: '11.5px', fontWeight: 540, letterSpacing: mono ? '0.02em' : '-0.005em',
      fontFamily: mono ? MONO_FONT : UI_FONT, whiteSpace: 'nowrap',
    }}>{value}</span>
  </div>
);
export const VSep: React.FC<{ opacity?: number }> = ({ opacity = 0.14 }) => <div style={vline(14, opacity)} />;

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
          <button onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-orange-600 text-white rounded-md hover:bg-orange-700 text-sm font-medium">Retry</button>
        </div>
      </div>
    );
  }
}

/* DİKEY ARAÇ RAYI (kenar çubuğu kabuğunun sol kenarı, tam yükseklik): ikon + altında yatay kısa etiket (ikon tek başına
   anlaşılmıyordu). İki grup — Parameters / Panel Editor araçları; yalnız etkin sekmenin grubu canlı, şekil seçili değilken
   ikisi de pasif. Ayrıntılı açıklama tarayıcı ipucunda (title). */
export const RAIL_W = 60;
type SidebarTab = 'parameters' | 'panel-editor';
type RailSpec = { key: string; label: string; icon: LucideIcon; title: string; active?: boolean; badge?: string | number; onClick: () => void };
/* Panelin YEREL durumuna bağlı ray eylemleri buraya kaydolur (ParametersPanel → özel parametre ekleme). */
export const railActions: { addCustomParameter: (() => void) | null } = { addCustomParameter: null };

const RAIL_BTN: React.CSSProperties = {
  position: 'relative', width: '50px', height: '46px', borderRadius: '8px', border: 'none', outline: 'none', padding: 0, flexShrink: 0,
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px',
  transition: 'background 0.12s,box-shadow 0.12s,opacity 0.15s', fontFamily: UI_FONT,
};
const RAIL_BADGE: React.CSSProperties = {
  position: 'absolute', top: '-6px', right: '-11px', minWidth: '13px', height: '13px', padding: '0 3px', borderRadius: '99px', fontSize: '8px',
  fontWeight: 700, lineHeight: '13px', textAlign: 'center', fontVariantNumeric: 'tabular-nums', color: '#fff',
};
// Etkin işaret çubuğu — rayın sol kenarına oturur.
const RAIL_MARK: React.CSSProperties = {
  position: 'absolute', left: '-5px', top: '9px', bottom: '9px', width: '2px', borderRadius: '0 2px 2px 0', background: '#ea580c',
  transition: 'opacity 0.15s', pointerEvents: 'none',
};
const RAIL_SEP: React.CSSProperties = { width: '28px', height: '1px', margin: '6px 0', background: 'rgba(60,50,40,0.14)', flexShrink: 0 };
const RAIL_STYLE: React.CSSProperties = {
  position: 'relative', zIndex: 2, width: `${RAIL_W}px`, flexShrink: 0, alignSelf: 'stretch', display: 'flex', flexDirection: 'column',
  alignItems: 'center', gap: '2px', padding: '8px 0', background: '#f3f0ea', borderRight: '1px solid rgba(60,50,40,0.10)',
  boxShadow: 'inset -1px 0 0 rgba(255,255,255,0.7)', fontFamily: UI_FONT,
};

const RailTool: React.FC<Omit<RailSpec, 'key'> & { passive: boolean }> = ({ label, icon: Icon, active = false, badge, onClick, title, passive }) => {
  const [hov, hoverProps] = useHover();
  const on = active && !passive, hv = hov && !passive;
  const idle = hv ? '#1c1917' : '#57534e';
  return (
    <button type="button" onClick={onClick} aria-pressed={on} disabled={passive} title={`${label} — ${title}`} {...hoverProps} className="yago-rail-btn"
      style={{
        ...RAIL_BTN, cursor: passive ? 'default' : 'pointer', opacity: passive ? 0.32 : 1,
        background: on ? '#ffffff' : hv ? 'rgba(255,255,255,0.75)' : 'transparent',
        boxShadow: on ? '0 0 0 1px rgba(234,88,12,0.35),0 1px 3px rgba(40,30,20,0.10)'
          : hv ? '0 0 0 1px rgba(60,50,40,0.10),0 1px 2px rgba(40,30,20,0.06)' : 'none',
      }}>
      <span style={{ position: 'relative', display: 'flex' }}>
        <Icon size={17} strokeWidth={2} style={{ color: on ? '#ea580c' : idle, transition: 'color 0.12s' }} />
        {badge !== undefined && badge !== '' && <span style={{ ...RAIL_BADGE, background: on ? '#ea580c' : '#78716c' }}>{badge}</span>}
      </span>
      <span style={{
        fontSize: '10px', lineHeight: 1, fontWeight: on ? 600 : 500, letterSpacing: '0.01em', color: on ? '#c2410c' : idle,
        whiteSpace: 'nowrap', transition: 'color 0.12s',
      }}>{label}</span>
      <span style={{ ...RAIL_MARK, opacity: on ? 1 : 0 }} />
    </button>
  );
};

export const SidebarRail: React.FC<{ activeTab: SidebarTab; hasShape: boolean }> = ({ activeTab, hasShape }) => {
  const s = useStoreFields('raycastMode', 'setRaycastMode', 'volumePickMode', 'setVolumePickMode', 'volumePickGroupId', 'doorPickMode',
    'setDoorPickMode', 'backPickMode', 'setBackPickMode', 'quickBodyMode', 'setQuickBodyMode', 'vertexEditMode', 'setVertexEditMode',
    'subtractionViewMode', 'setSubtractionViewMode', 'filletMode', 'setFilletMode', 'setFaceEditMode', 'selectedFilletFaces', 'clearFilletFaces',
    'clearFilletFaceData', 'selectedShapeId', 'shapes');
  const sel = shapeById(s.selectedShapeId, s.shapes);
  const subN = sel?.subtractionGeometries?.filter(x => x !== null).length ?? 0;
  const filletN = s.selectedFilletFaces.length;
  const toggle = (on: boolean, set: (b: boolean) => void) => ({ active: on, onClick: () => set(!on) });
  // Vertex / Subtract açılınca fillet ve yüz düzenleme kapanır; Fillet açılınca ikisi kapanır.
  const toggleEdit = (on: boolean, set: (b: boolean) => void) => ({
    active: on, onClick: () => { set(!on); if (!on) { s.setFilletMode(false); s.setFaceEditMode(false); } },
  });
  const toggleFillet = () => {
    const n = !s.filletMode;
    s.setFilletMode(n); s.setFaceEditMode(n); s.clearFilletFaces(); s.clearFilletFaceData();
    if (n) { s.setVertexEditMode(false); s.setSubtractionViewMode(false); }
  };
  const params: RailSpec[] = [
    { key: 'vertex', label: 'Vertex', icon: Spline, title: 'Edit the body outline by moving vertices', ...toggleEdit(s.vertexEditMode, s.setVertexEditMode) },
    { key: 'subtract', label: 'Subtract', icon: Layers, title: 'Show and edit boolean subtractions', badge: subN > 0 ? subN : undefined,
      ...toggleEdit(s.subtractionViewMode, s.setSubtractionViewMode) },
    { key: 'fillet', label: 'Fillet', icon: Radius, title: 'Round the edge between two faces', active: s.filletMode,
      badge: filletN > 0 ? `${filletN}/2` : undefined, onClick: toggleFillet },
    { key: 'param', label: 'Param', icon: Plus, title: 'Add a custom parameter', onClick: () => railActions.addCustomParameter?.() },
  ];
  const vp = (m: 'shelf' | 'divider') => s.volumePickMode === m && !s.volumePickGroupId;
  const volume = (m: 'shelf' | 'divider') => ({ active: vp(m), onClick: () => s.setVolumePickMode(vp(m) ? null : m) });
  const panels: RailSpec[] = [
    { key: 'body', label: 'Body', icon: Container, ...toggle(s.quickBodyMode, s.setQuickBodyMode),
      title: 'Quick body: corner joints, base (plain / legs / plinth) and back panel placed in one step' },
    { key: 'panel', label: 'Panel', icon: LayoutPanelTop, title: 'Body panel: click a body face in the 3D view', ...toggle(s.raycastMode, s.setRaycastMode) },
    { key: 'shelf', label: 'Shelf', icon: Rows3, title: 'Click inside a cavity in the 3D view', ...volume('shelf') },
    { key: 'divider', label: 'Divider', icon: Columns3, title: 'Click inside a cavity in the 3D view', ...volume('divider') },
    { key: 'door', label: 'Door', icon: DoorClosed, ...toggle(s.doorPickMode, s.setDoorPickMode),
      title: 'Mark door references on panels, then click a body face' },
    { key: 'back', label: 'Back', icon: SendToBack, ...toggle(s.backPickMode, s.setBackPickMode),
      title: 'Back panel: mark back references on panels, then click the body — each click cycles the candidates, largest first' },
  ];
  const group = (list: RailSpec[], tab: SidebarTab) => list.map(({ key, ...t }) => <RailTool key={key} {...t} passive={!hasShape || activeTab !== tab} />);
  return (
    <div className="yago-rail" style={RAIL_STYLE}>
      {group(params, 'parameters')}
      <div style={RAIL_SEP} />
      {group(panels, 'panel-editor')}
    </div>
  );
};

// /public/icons/<ad>.svg — stroke="currentColor" sayesinde düğme rengini alır.
export type IconName =
  | 'add-box' | 'subtract-box' | 'camera-perspective' | 'camera-orthographic' | 'view-solid' | 'view-wireframe' | 'view-xray'
  | 'linear-mode-on' | 'linear-mode-off' | 'search' | 'settings' | 'help-circle' | 'log-out' | 'crosshair' | 'file-plus' | 'file-down'
  | 'save' | 'upload' | 'undo-2' | 'redo-2' | 'scissors' | 'copy' | 'clipboard-paste' | 'eraser' | 'mouse-pointer-2' | 'move' | 'navigation'
  | 'refresh-ccw' | 'maximize-2' | 'box' | 'cog' | 'sliders-horizontal' | 'panel-left' | 'folder-open' | 'camera' | 'box-select' | 'scan-eye'
  | 'cuboid' | 'eye' | 'grid-2x2' | 'layers' | 'cylinder' | 'package' | 'square' | 'flip-horizontal' | 'maximize' | 'bar-chart-3' | 'file-text'
  | 'git-branch' | 'target' | 'rotate-cw' | 'rotate-ccw' | 'zap' | 'inspection-panel' | 'map-pin' | 'ruler' | 'monitor' | 'snap-endpoint'
  | 'snap-midpoint' | 'snap-center' | 'snap-quadrant' | 'snap-intersection' | 'dimension';
const iconSrc = (name: IconName) => `/icons/${name}.svg`;
const svgCache: Record<string, string> = {};
interface IconProps { name: IconName; size?: number; className?: string; style?: React.CSSProperties }

export const Icon: React.FC<IconProps> = ({ name, size = 16, className = '', style }) => {
  const src = iconSrc(name);
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
  return (
    <span role="img" aria-label={name} className={className} dangerouslySetInnerHTML={{ __html: markup }}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, lineHeight: 0, flexShrink: 0, ...style }} />
  );
};

const ICON_BTN = 'flex items-center justify-center rounded transition-all duration-150 outline-none'
  + ' focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-stone-400 active:scale-95';
interface IconButtonProps {
  icon: IconName; title: string; onClick?: () => void; disabled?: boolean; className?: string; size?: number; iconSize?: number; tone?: 'default' | 'exit';
}
/** <img> tabanlı (kendi renklerini koruyan) ikon düğmesi. */
export const IconButton: React.FC<IconButtonProps> = ({ icon, title, onClick, disabled = false, className = '', size = 30, iconSize = 18, tone }) => {
  const toneCls = tone === 'exit' ? 'text-amber-700 hover:bg-amber-50 hover:text-amber-800' : 'hover:bg-stone-100';
  return (
    <button onClick={onClick} disabled={disabled} style={{ width: size, height: size }} title={title}
      className={`${ICON_BTN} ${toneCls} ${disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'} ${className}`}>
      <img src={iconSrc(icon)} width={iconSize} height={iconSize} alt={icon} draggable={false} />
    </button>
  );
};
/** Açık/kapalı ikon düğmesi (lucide) — IconButton ile aynı ölçü; açıkken açık turuncu zemin + turuncu ikon. */
type ToggleIconButtonProps = { active: boolean; onClick: () => void; title: string; icon: LucideIcon; size?: number };
export const ToggleIconButton: React.FC<ToggleIconButtonProps> = ({ active, onClick, title, icon: Icon, size = 30 }) => (
  <button onClick={onClick} title={title} aria-pressed={active} style={{ width: size, height: size }}
    className={`${ICON_BTN} cursor-pointer ${active
      ? 'bg-[#fff1e6] text-[#ea580c] shadow-[inset_0_0_0_1px_rgba(234,88,12,0.28)]' : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'}`}>
    <Icon size={17} strokeWidth={1.9} />
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

const STATUS_BAR: React.CSSProperties = {
  bottom: '38px', height: '26px', display: 'flex', alignItems: 'center', padding: '0 14px', gap: '10px', background: TOKENS.bg,
  borderTop: `1px solid ${TOKENS.border}`, borderBottom: `1px solid ${TOKENS.border}`, boxShadow: TOKENS.topShine, fontFamily: UI_FONT, overflow: 'hidden',
};
const READY_DOT: React.CSSProperties = {
  width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 0 2.5px rgba(16,185,129,0.18),0 0 4px rgba(16,185,129,0.4)',
};

export const StatusBar: React.FC = () => {
  const { shapes, selectedShapeId, vertexEditMode, selectedVertexIndex } = useStoreFields('shapes', 'selectedShapeId', 'vertexEditMode', 'selectedVertexIndex');
  const selectedShape = shapeById(selectedShapeId, shapes);
  const vertexModCount = selectedShape?.vertexModifications?.length || 0;
  return (
    <div className="fixed left-0 right-0 z-20" style={STATUS_BAR}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        <span style={READY_DOT} />
        <span style={{ color: '#047857', fontSize: '11px', fontWeight: 540, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Ready</span>
      </div>
      <VSep />
      <LabelValue label="Objects" value={shapes.length} mono />
      <VSep />
      <LabelValue label="Selected" value={selectedShape ? `${selectedShape.type} · ${selectedShape.id.slice(0, 8)}` : '—'}
        valueColor={selectedShape ? TOKENS.accentClr : '#b0aaa4'} mono={!!selectedShape} />
      {selectedShape && (
        <><VSep /><LabelValue label="Position" value={`[${selectedShape.position.map(v => v.toFixed(1)).join(', ')}]`} mono /></>
      )}
      {vertexEditMode && (
        <><VSep /><LabelValue label="Vertex Edit" value={selectedVertexIndex !== null ? `V${selectedVertexIndex}` : 'Active'}
          valueColor={TOKENS.infoClr} mono /></>
      )}
      {vertexModCount > 0 && <><VSep /><LabelValue label="Edits" value={vertexModCount} valueColor={TOKENS.modClr} mono /></>}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        <span style={{ color: TOKENS.labelClr, fontSize: '10.5px', fontWeight: 420, letterSpacing: '0.05em', textTransform: 'uppercase' }}>mm</span>
        <VSep />
        <span style={{ color: '#6b6560', fontSize: '11px', fontWeight: 500, fontFamily: MONO_FONT, letterSpacing: '0.02em' }}>YAGO v1.0</span>
      </div>
    </div>
  );
};

const TT = {
  bg: 'linear-gradient(180deg,#ebe8e2 0%,#e2ddd5 100%)', borderTop: '#d6d1c8', shineTop: 'inset 0 1px 0 rgba(255,255,255,0.55)',
  inputBg: 'linear-gradient(180deg,#ffffff 0%,#fbfaf7 100%)', inputBorder: 'rgba(60,50,40,0.14)', inputText: '#1c1917',
  inputShadow: 'inset 0 1px 2px rgba(40,30,20,0.06),0 0 0 0.5px rgba(60,50,40,0.04)',
  promptClr: '#d9540a', sendBg: 'linear-gradient(180deg,#f97316 0%,#ea580c 100%)', sendBgHover: 'linear-gradient(180deg,#fb923c 0%,#f97316 100%)',
  sendShadow: '0 1px 2px rgba(234,88,12,0.35),0 0 0 0.5px rgba(154,52,18,0.4),inset 0 1px 0 rgba(255,255,255,0.25)',
};
const TERM_BAR: React.CSSProperties = {
  height: '38px', background: TT.bg, borderTop: `1px solid ${TT.borderTop}`, boxShadow: `${TT.shineTop},0 -1px 4px rgba(40,30,20,0.05)`, fontFamily: UI_FONT,
};
const TERM_CMD: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0, padding: '0 8px', height: '26px',
  background: 'rgba(217,84,10,0.08)', border: '1px solid rgba(217,84,10,0.18)', borderRadius: '6px',
};
const TERM_INPUT: React.CSSProperties = {
  flex: 1, background: 'transparent', border: 'none', outline: 'none', color: TT.inputText, fontFamily: MONO_FONT, fontSize: '12px', fontWeight: 500,
  letterSpacing: '0.01em',
};
const TERM_ENTER_HINT: React.CSSProperties = {
  color: '#b0aaa4', fontSize: '9.5px', fontFamily: MONO_FONT, fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', padding: '2px 5px',
  background: 'rgba(60,50,40,0.06)', borderRadius: '4px', flexShrink: 0,
};
// Kısayol harfleri ve gezinme/düzenleme tuşları terminale yazılmaz.
const TERM_HOTKEYS = ['t', 'f', 'r', 'l', 'b', 'u', 'i', 'c', 'h', 'v', 'z', '1', '2', '3'];
const TERM_PASS_KEYS = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Escape', 'Shift', 'CapsLock', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
];

export const Terminal: React.FC = () => {
  const [commandInput, setCommandInput] = useState('');
  const [inputFocus, setInputFocus] = useState(false);
  const [sendHover, sendHoverProps] = useHover();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (TERM_HOTKEYS.includes(e.key.toLowerCase())) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.key.startsWith('F') || TERM_PASS_KEYS.includes(e.key)) return;
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

  // Bekleyen fillet / vertex işlemi varsa girilen sayı ona gider (Scene'in window köprüsü).
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
  const sendLift = (y: string) => (e: React.MouseEvent<HTMLButtonElement>) => { if (hasCmd) e.currentTarget.style.transform = `translateY(${y})`; };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30" style={TERM_BAR}>
      <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: '0 10px', gap: '8px' }}>
        <div style={TERM_CMD}>
          <Hash size={11} style={{ color: TT.promptClr }} />
          <span style={{ color: TT.promptClr, fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>CMD</span>
        </div>
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', height: '26px', padding: '0 10px', gap: '6px', background: TT.inputBg,
          border: `1px solid ${inputFocus ? '#f97316' : TT.inputBorder}`, borderRadius: '7px', transition: 'border-color 0.15s,box-shadow 0.15s',
          boxShadow: inputFocus ? '0 0 0 2.5px rgba(249,115,22,0.14),inset 0 1px 2px rgba(40,30,20,0.04)' : TT.inputShadow,
        }}>
          <ChevronRight size={12} style={{ color: inputFocus ? TT.promptClr : '#a8a29e', flexShrink: 0, transition: 'color 0.15s' }} />
          <input ref={inputRef} type="text" value={commandInput} onChange={e => setCommandInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') executeCommand(commandInput); }}
            onFocus={() => setInputFocus(true)} onBlur={() => setInputFocus(false)} placeholder="Enter a command or value..." style={TERM_INPUT} />
          {commandInput && <span style={TERM_ENTER_HINT}>⏎ Enter</span>}
        </div>
        <button onClick={() => executeCommand(commandInput)} {...sendHoverProps} disabled={!hasCmd}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '26px', border: 'none', borderRadius: '6px',
            background: hasCmd ? (sendHover ? TT.sendBgHover : TT.sendBg) : 'rgba(60,50,40,0.08)',
            boxShadow: hasCmd ? TT.sendShadow : 'inset 0 0 0 0.5px rgba(60,50,40,0.1)', color: hasCmd ? '#fff' : '#b0aaa4',
            cursor: hasCmd ? 'pointer' : 'not-allowed', outline: 'none', flexShrink: 0,
            transition: 'background 0.12s,transform 0.08s,box-shadow 0.12s', transform: sendHover && hasCmd ? 'translateY(-0.5px)' : 'translateY(0)',
          }}
          onMouseDown={sendLift('0.5px')} onMouseUp={sendLift('-0.5px')}>
          <Send size={12} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
};

const TS = { ui: '12.5px', uiSep: '11.5px', ls: '0.012em', lsTight: '-0.005em' };
const T = {
  headerBg: '#fdfcfa', menuBg: 'linear-gradient(180deg,#f7f5f0 0%,#efece5 100%)', rowBg: 'linear-gradient(180deg,#f4f2ee 0%,#ebe8e2 100%)',
  groupBg: 'linear-gradient(180deg,#fdfcfa 0%,#f6f3ed 100%)', groupBorder: 'rgba(60,50,40,0.14)',
  groupShadow: '0 1.5px 3px rgba(40,30,20,0.09),0 0.5px 1px rgba(40,30,20,0.05),0 0 0 0.5px rgba(60,50,40,0.07),'
    + 'inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.06)',
  hdrBorder: '#e4dfd7', rowBorder: '#d6d1c8', menuBorder: '#dcd6cb',
  iconIdle: '#6b6560', iconHover: '#1c1917', iconActive: '#ea580c',
  activeBg: 'rgba(234,88,12,0.08)', activeBord: 'rgba(234,88,12,0.28)', hoverBg: 'rgba(0,0,0,0.05)',
  textStrong: '#292524', textBody: '#44403c', textMute: '#706b65', textFaint: '#9c9590', textWhisper: '#c9c4be',
};

const TBTN_BASE: React.CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', borderRadius: '6px',
  border: 'none', flexShrink: 0, outline: 'none', transition: 'background 0.1s,color 0.1s,box-shadow 0.1s,transform 0.1s',
};
const TBTN_TIP: React.CSSProperties = {
  pointerEvents: 'none', position: 'absolute', top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', background: '#1c1917',
  color: '#fafaf9', fontSize: '10px', fontWeight: 500, letterSpacing: '0.02em', padding: '3px 7px', borderRadius: '5px', whiteSpace: 'nowrap',
  zIndex: 60, transition: 'opacity 0.12s',
};
type TBtnProps = { icon: IconName; label: string; active?: boolean; disabled?: boolean; onClick?: () => void };
const TBtn: React.FC<TBtnProps> = ({ icon, label, active = false, disabled = false, onClick }) => {
  const [hov, hoverProps] = useHover();
  const color = disabled ? '#c4bfbb' : active ? T.iconActive : hov ? T.iconHover : T.iconIdle;
  const bg = !disabled && active ? T.activeBg : !disabled && hov ? T.hoverBg : 'transparent';
  return (
    <button title={label} disabled={disabled} onClick={onClick} {...hoverProps}
      style={{
        ...TBTN_BASE, background: bg, color, boxShadow: !disabled && active ? `0 0 0 1px ${T.activeBord}` : 'none',
        cursor: disabled ? 'not-allowed' : 'pointer', transform: hov && !disabled && !active ? 'scale(1.06)' : 'scale(1)',
      }}>
      <Icon name={icon} size={18} />
      <span style={{ ...TBTN_TIP, opacity: hov && !disabled ? 1 : 0 }}>{label}</span>
    </button>
  );
};
const BTN_GROUP: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '1px', padding: '2px', background: T.groupBg, border: `1px solid ${T.groupBorder}`,
  borderRadius: '8px', boxShadow: T.groupShadow, flexShrink: 0,
};
const BtnGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => <div style={BTN_GROUP}>{children}</div>;
const VLine: React.FC<{ h?: number; m?: string; o?: number }> = ({ h = 18, m = '0 8px', o = 0.12 }) => <div style={vline(h, o, m)} />;
/** Düğme grubu içi ayırıcı. */
const GroupSep = () => <VLine h={16} m="0 2px" o={0.14} />;
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
  { label: 'File', items: [['file-plus', 'New Project', 'Ctrl+N'], ['upload', 'Open Project...', 'Ctrl+O'], '-', ['save', 'Save', 'Ctrl+S'],
    ['file-down', 'Save As...', 'Ctrl+Shift+S'], '-', ['upload', 'Import...', 'Ctrl+I'], ['file-down', 'Export...', 'Ctrl+E']] },
  { label: 'Edit', items: [['undo-2', 'Undo', 'Ctrl+Z'], ['redo-2', 'Redo', 'Ctrl+Y'], '-', ['scissors', 'Cut', 'Ctrl+X'], ['copy', 'Copy', 'Ctrl+C'],
    ['clipboard-paste', 'Paste', 'Ctrl+V'], '-', ['eraser', 'Delete', 'Del']] },
  { label: 'View', items: [['grid-2x2', 'Show Grid', 'G'], ['layers', 'Show Layers', 'L'], ['eye', 'Visibility', 'V'], '-',
    ['cuboid', 'Solid View', '1'], ['box-select', 'Wireframe View', '2'], ['scan-eye', 'X-Ray View', '3'], '-',
    [null, 'Zoom In', 'Ctrl++'], [null, 'Zoom Out', 'Ctrl+-'], [null, 'Fit to View', 'F']] },
  { label: 'Place', items: [['box', 'Add Box', 'B'], ['cylinder', 'Add Cylinder', 'C'], ['package', '3D Objects', '3'], '-',
    ['square', '2D Shapes', '2'], ['git-branch', 'Drawing Tools', 'L']] },
  { label: 'Modify', items: [['move', 'Move', 'M'], ['rotate-ccw', 'Rotate', 'R'], ['maximize', 'Scale', 'S'], '-',
    ['flip-horizontal', 'Mirror', 'Mi'], ['copy', 'Array', 'Ar'], ['sliders-horizontal', 'Edit', 'E']] },
  { label: 'Snap', items: [['target', 'Endpoint Snap', 'End'], ['navigation', 'Midpoint Snap', 'Mid'], ['crosshair', 'Center Snap', 'Cen'],
    ['rotate-cw', 'Quadrant Snap', 'Qua'], ['zap', 'Perpendicular Snap', 'Per'], ['inspection-panel', 'Intersection Snap', 'Int'],
    ['map-pin', 'Nearest Snap', 'Nea'], '-', ['settings', 'Snap Settings', 'Ctrl+Snap']] },
  { label: 'Measure', items: [['ruler', 'Distance', 'D'], ['ruler', 'Angle', 'A'], ['maximize-2', 'Area', 'Ar'], '-',
    ['ruler', 'Add Dimension', 'Ctrl+D'], ['settings', 'Dimension Style', 'Ctrl+M']] },
  { label: 'Display', items: [['monitor', 'Render Settings', 'R'], ['eye', 'View Modes', 'V'], ['camera', 'Camera Settings', 'C'], '-',
    ['layers', 'Material Editor', 'M'], ['settings', 'Lighting', 'L']] },
  { label: 'Settings', items: [['cog', 'General Settings', 'Ctrl+,'], ['grid-2x2', 'Grid Settings', 'G'], ['ruler', 'Unit Settings', 'U'], '-',
    ['settings', 'Toolbar', 'T'], ['panel-left', 'Panel Layout', 'P']] },
  { label: 'Report', items: [['file-text', 'Project Report', 'Ctrl+R'], ['bar-chart-3', 'Material List', 'Ctrl+L'],
    ['file-text', 'Dimension Report', 'Ctrl+M'], '-', ['file-down', 'PDF Export', 'Ctrl+P'], ['file-down', 'Excel Export', 'Ctrl+E']] },
  { label: 'Window', items: [['panel-left', 'New Window', 'Ctrl+N'], ['layers', 'Window Layout', 'Ctrl+W'], '-',
    ['monitor', 'Full Screen', 'F11'], ['panel-left', 'Hide Panels', 'Tab']] },
  { label: 'Help', items: [['help-circle', 'User Manual', 'F1'], ['help-circle', 'Keyboard Shortcuts', 'Ctrl+?'], ['monitor', 'Video Tutorials', 'Ctrl+T'], '-',
    ['help-circle', 'About', 'Ctrl+H'], ['help-circle', 'Check Updates', 'Ctrl+U']] },
];
const MENU_ACTIONS: Record<string, ViewMode> = { 'Solid View': ViewMode.SOLID, 'Wireframe View': ViewMode.WIREFRAME, 'X-Ray View': ViewMode.XRAY };

/** Seçili gövdeyle (dünya kutusu) kesişen diğer gövdeler. */
const intersectingBodies = (sel: Shape | undefined, shapes: Shape[]): Shape[] => {
  const sb = sel && sel.type !== 'panel' ? translatedBboxOf(sel) : null;
  if (!sb) return [];
  return shapes.filter(s => { if (s.id === sel!.id || s.type === 'panel') return false; const b = translatedBboxOf(s); return !!b && sb.intersectsBox(b); });
};

const TOOLBAR_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
  @keyframes tb-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
  .tb-drop{animation:tb-in 0.11s ease-out forwards;}
  .tb-dot{position:absolute;bottom:-1px;left:50%;transform:translateX(-50%);width:18px;height:2px;border-radius:99px;
    background:linear-gradient(90deg,transparent,#f97316 50%,transparent);}
  .tb-mi:hover{background:#fff7ed!important;color:#ea580c!important;}
`;
const HEADER_ROW: React.CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'center', height: '46px', padding: '0 18px', background: T.headerBg,
  borderBottom: `1px solid ${T.hdrBorder}`, boxShadow: '0 1px 0 rgba(255,255,255,0.5)', gap: '12px',
};
const SEARCH_INPUT: React.CSSProperties = {
  width: '180px', height: '28px', paddingLeft: '30px', paddingRight: '10px', fontSize: TS.ui, fontFamily: UI_FONT, fontWeight: 400,
  letterSpacing: TS.ls, color: T.textStrong, background: '#f7f6f3', border: `1px solid ${T.groupBorder}`, borderRadius: '7px', outline: 'none',
  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.04)', transition: 'border-color 0.15s,box-shadow 0.15s,background 0.15s',
};
const MENU_BAR: React.CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'center', height: '34px', padding: '0 14px', background: T.menuBg,
  borderBottom: `1px solid ${T.menuBorder}`,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.85),inset 0 -1px 0 rgba(140,120,100,0.08),inset 1px 0 0 rgba(255,255,255,0.4),'
    + 'inset -1px 0 0 rgba(140,120,100,0.04),0 1px 0 rgba(255,255,255,0.45),0 2px 4px -1px rgba(60,50,40,0.06)',
};
const MENU_GRAIN: React.CSSProperties = {
  position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0.6,
  backgroundImage: 'repeating-linear-gradient(0deg,rgba(255,255,255,0) 0px,rgba(255,255,255,0) 2px,rgba(140,120,100,0.012) 2px,rgba(140,120,100,0.012) 3px)',
};
const menuBtnStyle = (on: boolean): React.CSSProperties => ({
  height: '100%', padding: '0 13px', fontSize: TS.ui, fontFamily: UI_FONT, fontWeight: on ? 600 : 450, letterSpacing: on ? TS.lsTight : TS.ls,
  color: on ? '#ea580c' : T.textMute, background: on ? 'linear-gradient(180deg,#fff7ed 0%,#ffedd5 100%)' : 'transparent',
  boxShadow: on ? '0 0 0 0.5px rgba(234,88,12,0.12),inset 0 1px 0 rgba(255,255,255,0.9),inset 0 -1px 0 rgba(234,88,12,0.06)' : 'none',
  border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', position: 'relative', outline: 'none', borderRadius: '5px',
  transition: 'color 0.12s,background 0.12s,box-shadow 0.12s,letter-spacing 0.12s',
});
const MENU_DROP: React.CSSProperties = {
  position: 'absolute', left: 0, top: '100%', marginTop: '5px', width: '216px', background: '#ffffff', border: `1px solid ${T.hdrBorder}`,
  borderRadius: '10px', padding: '5px', zIndex: 50,
  boxShadow: '0 12px 36px -4px rgba(40,30,20,0.14),0 4px 12px -2px rgba(40,30,20,0.06),0 0 0 0.5px rgba(40,30,20,0.04)',
};
const MENU_ITEM: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: '30px', padding: '0 10px', fontSize: TS.ui,
  fontFamily: UI_FONT, fontWeight: 420, letterSpacing: TS.ls, color: T.textBody, background: 'transparent', border: 'none', cursor: 'pointer',
  borderRadius: '6px', outline: 'none', transition: 'background 0.08s,color 0.08s',
};
const MENU_SHORTCUT: React.CSSProperties = { fontFamily: MONO_FONT, fontSize: '10px', letterSpacing: '0.03em', color: T.textFaint, fontWeight: 400 };
const TOOL_ROW: React.CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'center', height: '42px', padding: '0 14px', background: T.rowBg,
  borderBottom: `1px solid ${T.rowBorder}`,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.85),inset 0 -1px 0 rgba(140,120,100,0.06),0 1px 4px rgba(60,50,40,0.04)',
};

export const Toolbar: React.FC<{ onOpenCatalog: () => void }> = ({ onOpenCatalog }) => {
  const s = useStoreFields('setActiveTool', 'activeTool', 'addShape', 'selectedShapeId', 'cameraType', 'setCameraType', 'snapSettings',
    'toggleSnapSetting', 'viewMode', 'setViewMode', 'cycleViewMode', 'orthoMode', 'toggleOrthoMode', 'shapes', 'updateShape', 'deleteShape',
    'panelSelectMode', 'setPanelSelectMode', 'showOutlines', 'setShowOutlines');
  const { activeTool, setActiveTool, selectedShapeId, panelSelectMode } = s;
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const selectedShape = shapeById(selectedShapeId, s.shapes);
  const intersecting = React.useMemo(() => { try { return intersectingBodies(selectedShape, s.shapes); } catch { return []; } }, [selectedShape, s.shapes]);
  const hasIntersectingShapes = intersecting.length > 0;
  const isBoxSelected = selectedShape?.type === 'box';
  React.useEffect(() => { if (panelSelectMode && activeTool !== Tool.SELECT) setActiveTool(Tool.SELECT); }, [panelSelectMode, activeTool, setActiveTool]);

  const handleAddBox = async (e?: React.MouseEvent) => {
    e?.preventDefault(); e?.stopPropagation();
    try {
      const w = 600, h = 600, d = 600;
      const rs = await createReplicadBox({ width: w, height: h, depth: d });
      s.addShape({
        id: `box-${Date.now()}`, type: 'box', geometry: convertReplicadToThreeGeometry(rs), replicadShape: rs,
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#2563eb', parameters: { width: w, height: h, depth: d },
      });
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
        const sub = { geometry: sel.geometry.clone(), relativeOffset: relOff, relativeRotation: relRot, scale: [1, 1, 1] as Vec3 };
        s.updateShape(tgt.id, {
          geometry: convertReplicadToThreeGeometry(result), replicadShape: result,
          subtractionGeometries: [...(tgt.subtractionGeometries || []), sub],
          parameters: { ...tgt.parameters, scaledBaseVertices: newVerts.map(v => [v.x, v.y, v.z]) },
        });
      }
      s.deleteShape(selectedShapeId);
    } catch (err) { alert(`Failed to subtract: ${(err as Error).message}`); }
  };

  const toolBtn = (icon: IconName, label: string, tool: Tool, disabled = false) => (
    <TBtn icon={icon} label={label} active={activeTool === tool} disabled={disabled} onClick={() => setActiveTool(tool)} />
  );
  const snapBtn = (icon: IconName, label: string, t: SnapType) => (
    <TBtn icon={icon} label={label} active={s.snapSettings[t]} onClick={() => s.toggleSnapSetting(t)} />
  );
  const ViewBtn = s.viewMode === ViewMode.SOLID ? ViewSolidButton : s.viewMode === ViewMode.WIREFRAME ? ViewWireframeButton : ViewXRayButton;
  const noSel = !selectedShapeId;

  return (
    <>
      <style>{TOOLBAR_CSS}</style>
      <div className="flex flex-col select-none" style={{ fontFamily: UI_FONT }}>
        <div style={HEADER_ROW}>
          <img src="/yago_logo.png" alt="YAGO" style={{ height: '26px', width: 'auto', objectFit: 'contain', flexShrink: 0 }} />
          <VLine h={20} m="0" o={0.18} />
          <Breadcrumb label="Company" value="Göker İnşaat" color="#d9540a" />
          <VLine h={20} m="0" o={0.18} />
          <Breadcrumb label="Project" value="Drawing1" color={T.textStrong} />
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <span style={{ position: 'absolute', left: '10px', pointerEvents: 'none', color: '#b0aaa4', display: 'inline-flex' }}>
                <Icon name="search" size={12} />
              </span>
              <input type="text" placeholder="Search..." style={SEARCH_INPUT}
                onFocus={e => paint(e.currentTarget, {
                  borderColor: '#f97316', boxShadow: '0 0 0 2.5px rgba(249,115,22,0.14),inset 0 1px 2px rgba(0,0,0,0.03)', background: '#fff',
                })}
                onBlur={e => paint(e.currentTarget, { borderColor: T.groupBorder, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.04)', background: '#f7f6f3' })} />
            </div>
            <VLine m="0 4px" o={0.16} />
            <BtnGroup>
              <ViewBtn onClick={s.cycleViewMode} />
              {/* Seçim kipi Body ↔ Panel ve panel çizgileri — tel görünüş düğmesinin yanında. */}
              <ToggleIconButton active={panelSelectMode} onClick={() => s.setPanelSelectMode(!panelSelectMode)}
                title={panelSelectMode ? 'Selection: Panel — click to select whole bodies' : 'Selection: Body — click to select individual panels'}
                icon={panelSelectMode ? Layers : Box} />
              <ToggleIconButton active={s.showOutlines} onClick={() => s.setShowOutlines(!s.showOutlines)}
                title={s.showOutlines ? 'Panel outlines: on' : 'Panel outlines: off'} icon={Square} />
              <GroupSep />
              {s.cameraType === CameraType.PERSPECTIVE
                ? <CameraPerspectiveButton onClick={() => s.setCameraType(CameraType.ORTHOGRAPHIC)} />
                : <CameraOrthographicButton onClick={() => s.setCameraType(CameraType.PERSPECTIVE)} />}
              {s.orthoMode === OrthoMode.ON ? <LinearModeOnButton onClick={s.toggleOrthoMode} /> : <LinearModeOffButton onClick={s.toggleOrthoMode} />}
              <GroupSep />
              <IconButton icon="settings" title="Settings" />
              <IconButton icon="help-circle" title="Help" />
              <GroupSep />
              <IconButton icon="log-out" title="Exit" tone="exit" />
            </BtnGroup>
          </div>
        </div>

        <div style={MENU_BAR}>
          <div style={MENU_GRAIN} />
          {MENUS.map(menu => {
            const on = activeMenu === menu.label;
            return (
              <div key={menu.label} style={{ position: 'relative', height: '100%', zIndex: 1 }}>
                <button style={menuBtnStyle(on)} onClick={() => setActiveMenu(on ? null : menu.label)}
                  onMouseEnter={e => {
                    if (activeMenu) setActiveMenu(menu.label);
                    if (!on) paint(e.currentTarget, {
                      color: T.textStrong, background: 'linear-gradient(180deg,#fdfcfa 0%,#f4f1ea 100%)',
                      boxShadow: '0 0 0 0.5px rgba(60,50,40,0.08),inset 0 1px 0 rgba(255,255,255,0.9)',
                    });
                  }}
                  onMouseLeave={e => { if (!on) paint(e.currentTarget, { color: T.textMute, background: 'transparent', boxShadow: 'none' }); }}>
                  {menu.label}
                  {on && <div className="tb-dot" />}
                </button>
                {on && (
                  <div className="tb-drop" onMouseLeave={() => setActiveMenu(null)} style={MENU_DROP}>
                    {menu.items.map((item, i) => item === '-'
                      ? <div key={i} style={{ height: '1px', background: '#f0ede8', margin: '3px 0' }} />
                      : (
                        <button key={i} className="tb-mi" style={MENU_ITEM}
                          onClick={() => { const vm = MENU_ACTIONS[item[1]]; if (vm) s.setViewMode(vm); setActiveMenu(null); }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {item[0] && <Icon name={item[0]} size={11} />}<span>{item[1]}</span>
                          </div>
                          <span style={MENU_SHORTCUT}>{item[2]}</span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={TOOL_ROW}>
          <BtnGroup><TBtn icon="file-plus" label="New (Ctrl+N)" /><TBtn icon="save" label="Save (Ctrl+S)" /><TBtn icon="file-down" label="Save As" /></BtnGroup>
          <VLine />
          <BtnGroup><TBtn icon="undo-2" label="Undo (Ctrl+Z)" /><TBtn icon="redo-2" label="Redo (Ctrl+Y)" /></BtnGroup>
          <VLine />
          <BtnGroup>
            {toolBtn('mouse-pointer-2', 'Select (V)', Tool.SELECT)}
            {toolBtn('move', 'Move (M)', Tool.MOVE, noSel)}
            {toolBtn('navigation', 'Point to Point', Tool.POINT_TO_POINT_MOVE, noSel)}
            {toolBtn('refresh-ccw', 'Rotate (R)', Tool.ROTATE, noSel)}
            {toolBtn('maximize-2', isBoxSelected ? 'Scale — disabled for box' : 'Scale (S)', Tool.SCALE, noSel || isBoxSelected)}
          </BtnGroup>
          <VLine />
          <BtnGroup>
            {snapBtn('snap-endpoint', 'Endpoint', SnapType.ENDPOINT)}
            {snapBtn('snap-midpoint', 'Midpoint', SnapType.MIDPOINT)}
            {snapBtn('snap-center', 'Center', SnapType.CENTER)}
            {/* Quadrant snap henüz bağlı değil (store'da SnapType.QUADRANT yok) — düğme yer tutucu. */}
            <TBtn icon="snap-quadrant" label="Quadrant" onClick={() => {}} />
            {snapBtn('snap-intersection', 'Intersection', SnapType.INTERSECTION)}
          </BtnGroup>
          <VLine />
          <BtnGroup>
            <AddBoxButton onClick={handleAddBox} />
            <SubtractBoxButton onClick={handleSubtract} disabled={noSel || !hasIntersectingShapes}
              className={hasIntersectingShapes ? 'text-red-400 hover:bg-red-50 hover:text-red-500' : ''} />
            <GroupSep />
            <IconButton icon="dimension" title="Dimensioning" onClick={() => setActiveTool(Tool.DIMENSION)}
              className={activeTool === Tool.DIMENSION ? 'bg-orange-50 ring-1 ring-orange-200' : ''} />
            <GroupSep />
            <IconButton icon="folder-open" title="Catalog" onClick={onOpenCatalog} />
          </BtnGroup>
        </div>
      </div>
    </>
  );
};

const SB = {
  bg:            'linear-gradient(180deg,#f4f2ee 0%,#ebe8e2 100%)',
  contentBg:     'linear-gradient(180deg,#fdfcfa 0%,#f6f3ed 100%)',
  tabStripBg:    '#fdfcfa',
  border:        '#d6d1c8',
  borderSoft:    '#e4dfd7',
  groupBorder:   'rgba(60,50,40,0.14)',
  hairline:      'rgba(60,50,40,0.08)',
  panelShadow:   '6px 0 28px -6px rgba(40,30,20,0.14),2px 0 6px -1px rgba(40,30,20,0.10),0.5px 0 1px rgba(40,30,20,0.06),'
    + '0 0 0 0.5px rgba(60,50,40,0.07),inset -0.5px 0 0 rgba(140,120,100,0.06),inset 0.5px 0 0 rgba(255,255,255,0.95)',
  textPrimary:   '#1c1917',
  textSecondary: '#44403c',
  textTertiary:  '#706b65',
  textMuted:     '#9c9590',
  accent:        '#ea580c',
  accentSoft:    '#fff7ed',
  accentGradient:'linear-gradient(90deg,transparent,#f97316 50%,transparent)',
};
const SIDEBAR_WIDTH = 528 + RAIL_W;   // içerik + dikey araç rayı (480'de panel adı sütunu ~57 px'e düşüyordu)
const VSEP = vline(22);
const ACCENT_UNDERLINE = (width: string): React.CSSProperties => ({
  position: 'absolute', bottom: '-1px', left: '50%', transform: 'translateX(-50%)', width, height: '2px', background: SB.accentGradient, borderRadius: '99px',
});

const TabBtn: React.FC<{ active: boolean; onClick: () => void; icon: React.ReactNode; label: string }> = ({ active, onClick, icon, label }) => {
  const [hov, hoverProps] = useHover();
  return (
    <button onClick={onClick} {...hoverProps}
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

const EMPTY_WRAP: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '320px', padding: '24px 32px',
  textAlign: 'center', animation: 'ls-empty-in 0.3s ease-out forwards',
};
const EMPTY_ICON: React.CSSProperties = {
  position: 'relative', width: '52px', height: '52px', borderRadius: '14px', background: 'linear-gradient(180deg,#ffffff 0%,#f4f1ea 100%)',
  border: `1px solid ${SB.groupBorder}`,
  boxShadow: '0 4px 12px -2px rgba(40,30,20,0.10),0 1px 3px rgba(40,30,20,0.06),0 0 0 0.5px rgba(60,50,40,0.05),'
    + 'inset 0 1px 0 rgba(255,255,255,0.95),inset 0 -1px 0 rgba(140,120,100,0.06)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', color: SB.textTertiary, marginBottom: '16px',
};
const EMPTY_GLOW: React.CSSProperties = {
  position: 'absolute', top: '-3px', right: '-3px', width: '10px', height: '10px', borderRadius: '50%',
  background: 'radial-gradient(circle,rgba(234,88,12,0.18),transparent 70%)',
};
const EMPTY_HINT: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 11px', background: 'rgba(255,255,255,0.6)', border: `0.5px solid ${SB.hairline}`,
  borderRadius: '99px', boxShadow: '0 1px 2px rgba(40,30,20,0.04),inset 0 1px 0 rgba(255,255,255,0.8)',
};
const EmptyState: React.FC<{ icon: React.ReactNode; title: string; description: string; hint: string }> = ({ icon, title, description, hint }) => (
  <div style={EMPTY_WRAP}>
    <div style={EMPTY_ICON}>
      {icon}
      <div style={EMPTY_GLOW} />
    </div>
    <span style={{ color: SB.textPrimary, fontSize: '13.5px', fontWeight: 600, letterSpacing: '-0.01em', marginBottom: '6px' }}>{title}</span>
    <span style={{
      color: SB.textTertiary, fontSize: '11.5px', fontWeight: 400, letterSpacing: '0.015em', lineHeight: 1.55, maxWidth: '260px', marginBottom: '16px',
    }}>{description}</span>
    <div style={EMPTY_HINT}>
      <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: SB.accent }} />
      <span style={{ fontSize: '10.5px', fontWeight: 500, letterSpacing: '0.015em', color: SB.textSecondary }}>{hint}</span>
    </div>
  </div>
);

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
  font-family: ${UI_FONT}; color: var(--bone-text); padding: 8px 6px 16px !important;
}
/* Kenar çubuğundaki tüm girişler */
.bone-skin input[type="text"], .bone-skin textarea {
  background: linear-gradient(180deg,#ffffff 0%,#fbfaf6 100%) !important; border: 1px solid rgba(60,50,40,0.14) !important; border-radius: 6px !important;
  color: var(--bone-text) !important; font-family: 'Inter',system-ui,sans-serif !important; font-size: 11.5px !important; font-weight: 500 !important;
  letter-spacing: 0.012em !important; height: 24px !important; padding: 0 8px !important;
  box-shadow: inset 0 1px 2px rgba(40,30,20,0.04),0 0 0 0.5px rgba(60,50,40,0.04) !important;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s !important; outline: none !important;
}
/* Panel satırı notu — kutusuz, sessiz alan: üzerine gelince kıl-çizgi, odakta beyaz zemin + turuncu halka (özgüllük genel kuralı geçer). */
.bone-skin input[type="text"].yago-row-note { background: transparent !important; border: 1px solid transparent !important; border-radius: 5px !important;
  box-shadow: none !important; height: 22px !important; padding: 0 5px !important; font-size: 11.5px !important; font-weight: 450 !important;
  letter-spacing: 0.005em !important; color: #57534e !important; }
.bone-skin input[type="text"].yago-row-note::placeholder { color: #c9c2b8 !important; font-weight: 400 !important; }
.bone-skin input[type="text"].yago-row-note:hover { border-color: #ebe5dc !important; background: rgba(255,255,255,0.6) !important; }
.bone-skin input[type="text"].yago-row-note:focus { background: #ffffff !important; border-color: rgba(249,115,22,0.45) !important;
  box-shadow: 0 0 0 2px rgba(249,115,22,0.10) !important; color: #1c1917 !important; }
/* Grup kartı değer kutusu içi giriş — çerçeve kutunun kendisinde; giriş çıplak, odakta yalnız hafif zemin. */
.bone-skin input[type="text"].yago-field { background: transparent !important; border: 1px solid transparent !important; border-radius: 5px !important;
  box-shadow: none !important; height: 22px !important; padding: 0 4px !important; font-family: 'SF Mono',ui-monospace,Menlo,monospace !important;
  font-size: 12.5px !important; font-weight: 600 !important; letter-spacing: 0 !important; color: #1c1917 !important; }
.bone-skin input[type="text"].yago-field::placeholder { color: #c9c2b8 !important; font-weight: 500 !important; }
.bone-skin input[type="text"].yago-field:hover { background: #faf8f4 !important; }
.bone-skin input[type="text"].yago-field:focus { background: #fff7ed !important; border-color: rgba(249,115,22,0.35) !important; }
/* Ad girişi (yerleştirme şeridi): metin alanı — sayı fontu değil arayüz fontu. */
.bone-skin input[type="text"].yago-field.yago-field-text { font-family: 'Inter',system-ui,sans-serif !important; font-size: 12px !important;
  font-weight: 500 !important; text-align: left !important; }
/* Parametre değeri — aynı sessiz alan, sayısal yazı. */
.bone-skin input[type="text"].yago-param-input { background: transparent !important; border: 1px solid transparent !important; border-radius: 6px !important;
  box-shadow: none !important; height: 22px !important; padding: 0 6px !important; font-family: 'SF Mono',ui-monospace,Menlo,monospace !important;
  font-size: 12px !important; font-weight: 500 !important; letter-spacing: 0 !important; color: #292524 !important; font-variant-numeric: tabular-nums; }
.bone-skin input[type="text"].yago-param-input::placeholder { color: #c9c2b8 !important; }
.bone-skin input[type="text"].yago-param-input:hover { border-color: #ebe5dc !important; background: rgba(255,255,255,0.6) !important; }
.bone-skin input[type="text"].yago-param-input:focus { background: #ffffff !important; border-color: rgba(249,115,22,0.45) !important;
  box-shadow: 0 0 0 2px rgba(249,115,22,0.10) !important; }
.bone-skin input[type="text"].font-mono { font-family: ${MONO_FONT} !important; font-size: 11px !important; letter-spacing: 0.02em !important; }
/* Odak — araç çubuğu aramasıyla aynı turuncu halka */
.bone-skin input[type="text"]:focus, .bone-skin textarea:focus { border-color: #f97316 !important;
  box-shadow: 0 0 0 2.5px rgba(249,115,22,0.14),inset 0 1px 2px rgba(40,30,20,0.03) !important; background: #ffffff !important; }
/* Düğmeler */
.bone-skin button { font-family: 'Inter',system-ui,sans-serif; font-weight: 500; letter-spacing: 0.012em;
  transition: background 0.12s, color 0.12s, box-shadow 0.12s, transform 0.12s !important; }
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

/* Sekmelerden BAĞIMSIZ, tüm menüleri kapsayan görünüm/seçim ayarları. */
type HeaderToggleProps = { active: boolean; onClick: () => void; title: string; icon: React.ReactNode; label?: string };
const HeaderToggle: React.FC<HeaderToggleProps> = ({ active, onClick, title, icon, label }) => {
  const [hov, hoverProps] = useHover();
  return (
    <button type="button" onClick={onClick} {...hoverProps} title={title} aria-pressed={active}
      style={{
        ...(label ? { padding: '0 11px', gap: '6px' } : { width: '36px' }),
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', outline: 'none', cursor: 'pointer',
        position: 'relative', background: active ? SB.accentSoft : hov ? 'rgba(60,50,40,0.05)' : 'transparent',
        color: active ? SB.accent : hov ? SB.textPrimary : SB.textTertiary, transition: 'background 0.12s,color 0.12s', flexShrink: 0,
        fontFamily: UI_FONT, fontSize: '12px', fontWeight: active ? 600 : 500, letterSpacing: '0.01em',
      }}>
      {icon}
      {label && <span>{label}</span>}
      {active && <div style={ACCENT_UNDERLINE(label ? 'calc(100% - 16px)' : '60%')} />}
    </button>
  );
};
/* Kenar çubuğu yerleşimi: 'docked' soldan kayan klasik şerit; 'floating' pencere içinde sürüklenip
   boyutlanabilen yüzen panel; 'window' ayrı tarayıcı penceresi (portal). Sekmeler ve içerik üç kipte aynıdır. */
type SidebarMode = 'docked' | 'floating' | 'window';
type FloatRect = { x: number; y: number; w: number; h: number };
const SIDEBAR_LAYOUT_KEY = 'yago.sidebar.layout';
const SIDEBAR_HEADER_H = 40;
const FLOAT_MIN_W = 460;
const FLOAT_MIN_H = 280;
const FLOAT_SHADOW = '0 22px 56px -14px rgba(40,30,20,0.30),0 8px 20px -6px rgba(40,30,20,0.16),0 0 0 0.5px rgba(60,50,40,0.10),'
  + 'inset 0 0.5px 0 rgba(255,255,255,0.95)';
const SIDEBAR_WINDOW_NAME = 'yago-sidebar';
/** Ayrı tarayıcı penceresi düğmesi şimdilik arayüzde GİZLİ; kod yolu duruyor — true yapınca geri gelir. */
const SIDEBAR_WINDOW_ENABLED = false;

const defaultFloatRect = (): FloatRect => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(SIDEBAR_WIDTH, Math.max(FLOAT_MIN_W, vw - 48));
  const h = Math.min(820, Math.max(FLOAT_MIN_H, vh - 132 - 80));
  return { x: 24, y: 132, w, h };
};
/* Panel görünür alanda kalsın: başlığın en az 120 px'i yatayda, başlık şeridi dikeyde pencere içinde. */
const clampFloatRect = (r: FloatRect): FloatRect => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.max(FLOAT_MIN_W, Math.min(r.w, Math.max(FLOAT_MIN_W, vw - 16)));
  const h = Math.max(FLOAT_MIN_H, Math.min(r.h, Math.max(FLOAT_MIN_H, vh - 16)));
  const x = Math.max(120 - w, Math.min(r.x, vw - 120));
  const y = Math.max(0, Math.min(r.y, vh - SIDEBAR_HEADER_H));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
};
const readSidebarLayout = (): { mode: 'docked' | 'floating'; rect: FloatRect | null } => {
  try {
    const raw = localStorage.getItem(SIDEBAR_LAYOUT_KEY);
    if (!raw) return { mode: 'docked', rect: null };
    const j = JSON.parse(raw) as { mode?: unknown; rect?: Partial<FloatRect> | null };
    const r = j.rect;
    const ok = !!r && [r.x, r.y, r.w, r.h].every(v => typeof v === 'number' && Number.isFinite(v));
    return { mode: j.mode === 'floating' ? 'floating' : 'docked', rect: ok ? (r as FloatRect) : null };
  } catch { return { mode: 'docked', rect: null }; }
};
const writeSidebarLayout = (mode: 'docked' | 'floating', rect: FloatRect) => {
  try { localStorage.setItem(SIDEBAR_LAYOUT_KEY, JSON.stringify({ mode, rect })); } catch { /* depolama yok: yalnız oturum içi */ }
};

/* Ana belgedeki stil kaynaklarını (Tailwind/Vite stilleri, Google Fonts bağlantısı) açılır pencereye kopyalar. */
const copyStyleNode = (dst: Document, n: Node) => {
  if (n instanceof HTMLLinkElement) {
    if (!/\bstylesheet\b/.test(n.rel)) return;
    const c = dst.createElement('link'); c.rel = 'stylesheet'; c.href = n.href; dst.head.appendChild(c);
  } else if (n instanceof HTMLStyleElement) {
    const c = dst.createElement('style');
    let css = n.textContent ?? '';
    if (!css.trim() && n.sheet) { try { css = Array.from(n.sheet.cssRules).map(r => r.cssText).join('\n'); } catch { /* çapraz kaynak */ } }
    c.textContent = css; dst.head.appendChild(c);
  }
};
/* Ayrı pencere about:blank YERİNE aynı kaynaktan bir kabuk sayfası (public/sidebar-window.html) açar: COOP/COEP yalıtımında
   about:blank'e yazılan içerik asıl yüklemeyle silinir; kabuk aynı başlıklarla sunulduğu için açan pencereyle bağ korunur. */
const SIDEBAR_WINDOW_URL = `${import.meta.env.BASE_URL}sidebar-window.html`;
const SIDEBAR_WINDOW_ROOT_ID = 'yago-sidebar-root';
const SIDEBAR_WINDOW_TIMEOUT_MS = 8000;
type SidebarWindowHandle = { win: Window; root: HTMLElement; dispose: () => void };
/** Pencereyi açar, kabuk yüklenince stilleri kopyalayıp `onReady`, olmazsa (engellendi / erişilemedi / zaman aşımı) `onFail` çağırır.
 *  Dönen fonksiyon bekleyen açılışı iptal eder. */
const openSidebarWindow = (rect: FloatRect, onReady: (h: SidebarWindowHandle) => void, onFail: () => void): (() => void) => {
  const left = Math.round(window.screenX + rect.x + 40), top = Math.round(window.screenY + rect.y + 40);
  let win: Window | null = null;
  const features = `popup=yes,width=${rect.w},height=${rect.h},left=${left},top=${top}`;
  try { win = window.open(SIDEBAR_WINDOW_URL, SIDEBAR_WINDOW_NAME, features); } catch { win = null; }
  if (!win) { onFail(); return () => {}; }
  const w = win;
  const t0 = performance.now();
  let timer = 0, cancelled = false;
  const attach = (doc: Document, root: HTMLElement) => {
    document.head.querySelectorAll('link, style').forEach(n => copyStyleNode(doc, n));
    // Sonradan eklenen stiller (Vite HMR, tembel yüklenen parçalar) de aktarılsın.
    const mo = new MutationObserver(muts => { for (const m of muts) m.addedNodes.forEach(n => copyStyleNode(doc, n)); });
    mo.observe(document.head, { childList: true });
    doc.body.className = document.body.className;
    onReady({ win: w, root, dispose: () => mo.disconnect() });
  };
  const fail = () => { attempt(() => w.close()); onFail(); };
  const poll = () => {
    if (cancelled) return;
    let doc: Document | null = null;
    try {
      if (w.closed) { onFail(); return; }
      doc = w.document;
    } catch { fail(); return; }   // çapraz-kaynak yalıtımı: pencereye erişilemiyor
    // Geçici about:blank değil, kabuk sayfanın kendisi yüklendi mi?
    const root = doc.getElementById(SIDEBAR_WINDOW_ROOT_ID);
    if (root && doc.readyState !== 'loading') { attach(doc, root); return; }
    if (performance.now() - t0 > SIDEBAR_WINDOW_TIMEOUT_MS) { fail(); return; }
    timer = window.setTimeout(poll, 40);
  };
  poll();
  return () => { cancelled = true; window.clearTimeout(timer); attempt(() => w.close()); };
};

const SIDEBAR_HEADER: React.CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'center', height: `${SIDEBAR_HEADER_H}px`, background: SB.tabStripBg,
  borderBottom: `1px solid ${SB.borderSoft}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.7),0 1px 0 rgba(255,255,255,0.4)', flexShrink: 0,
  userSelect: 'none', touchAction: 'none',
};
const HEADER_SIDE: React.CSSProperties = { display: 'flex', alignItems: 'center', height: '100%', flexShrink: 0, cursor: 'default' };
const SIDEBAR_SCROLL: React.CSSProperties = {
  flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', background: SB.contentBg,
  boxShadow: 'inset 0 2px 4px rgba(40,30,20,0.05),inset 0 -1px 0 rgba(140,120,100,0.04)',
};
const EDGE_LINE: React.CSSProperties = {
  position: 'absolute', left: 0, top: 0, bottom: 0, width: '1px', pointerEvents: 'none',
  background: 'linear-gradient(to bottom,transparent,rgba(60,50,40,0.10) 20%,rgba(60,50,40,0.10) 80%,transparent)',
};
const EDGE_BTN: React.CSSProperties = {
  position: 'absolute', top: '50%', left: '0', width: '24px', height: '72px', padding: 0, borderRadius: '0 11px 11px 0', background: SB.contentBg,
  border: `1px solid ${SB.groupBorder}`, borderLeft: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: '5px', cursor: 'pointer', outline: 'none', transition: 'transform 0.22s cubic-bezier(0.4,0,0.2,1),box-shadow 0.22s', pointerEvents: 'auto',
};
const EDGE_SHADOW_HOVER = '4px 3px 16px rgba(40,30,20,0.16),1.5px 0 4px rgba(40,30,20,0.10),0 0 0 0.5px rgba(60,50,40,0.08),'
  + 'inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.08)';
const EDGE_SHADOW = '2px 1px 8px rgba(40,30,20,0.09),0.5px 0 1px rgba(40,30,20,0.05),0 0 0 0.5px rgba(60,50,40,0.07),'
  + 'inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.06)';
const EDGE_GLOW: React.CSSProperties = {
  position: 'absolute', top: '50%', left: '0', transform: 'translateY(-50%)', width: '48px', height: '110px', borderRadius: '0 50% 50% 0',
  background: 'radial-gradient(ellipse at left center,rgba(249,115,22,0.12),transparent 70%)', pointerEvents: 'none',
  animation: 'ls-glow-in 0.25s ease-out forwards',
};
const RESIZE_GRIP_BG = 'linear-gradient(135deg,transparent 50%,rgba(60,50,40,0.22) 50%,rgba(60,50,40,0.22) 58%,transparent 58%,'
  + 'transparent 72%,rgba(60,50,40,0.22) 72%,rgba(60,50,40,0.22) 80%,transparent 80%)';

export const Sidebar: React.FC<{ parametersContent: React.ReactNode; panelEditorContent: React.ReactNode }> = ({ parametersContent, panelEditorContent }) => {
  const { selectedShapeId } = useStoreFields('selectedShapeId');
  const [initial] = useState(readSidebarLayout);
  // Açılışta her zaman sola yaslı ve KAPALI başlar; kaydedilen kip yalnız yüzen panelin konum/boyutu için okunur.
  const [mode, setMode] = useState<SidebarMode>('docked');
  const [rect, setRect] = useState<FloatRect>(() => clampFloatRect(initial.rect ?? defaultFloatRect()));
  const rectRef = useRef(rect); rectRef.current = rect;
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>('panel-editor');
  const [pinHover, pinHoverProps] = useHover();
  const [handleHover, handleHoverProps] = useHover();
  const [popupRoot, setPopupRoot] = useState<HTMLElement | null>(null);
  const popupRef = useRef<{ win: Window; dispose: () => void } | null>(null);
  const popupPendingRef = useRef<(() => void) | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: 'move' | 'resize'; dx: boolean; dy: boolean; sx: number; sy: number; start: FloatRect; live: FloatRect } | null>(null);
  const openSidebar = useCallback(() => { setIsOpen(true); setIsPinned(true); }, []);
  const showDocked = useCallback(() => {
    setMode('docked'); setIsPinned(true); setIsOpen(true); writeSidebarLayout('docked', rectRef.current);
  }, []);

  /* ---- kip geçişleri ---- */
  const closePopup = useCallback(() => {
    popupPendingRef.current?.(); popupPendingRef.current = null;
    const p = popupRef.current; popupRef.current = null;
    setPopupRoot(null);
    if (!p) return;
    p.dispose();
    // Portal önce sökülsün (React commit), pencere sonra kapansın.
    window.setTimeout(() => attempt(() => { if (!p.win.closed) p.win.close(); }), 0);
  }, []);
  const dockSidebar = useCallback(() => { closePopup(); showDocked(); }, [closePopup, showDocked]);
  const floatSidebar = useCallback(() => {
    closePopup(); setMode('floating'); writeSidebarLayout('floating', rectRef.current);
  }, [closePopup]);
  const popOutSidebar = useCallback(() => {
    if (popupRef.current) { const p = popupRef.current; attempt(() => p.win.focus()); return; }
    if (popupPendingRef.current) return; // açılış sürüyor
    // Pencere yüklenene kadar panel olduğu yerde kalır; hazır olunca portal oraya taşınır; açılamazsa yüzen panele düşer.
    popupPendingRef.current = openSidebarWindow(rectRef.current,
      h => {
        popupPendingRef.current = null;
        popupRef.current = { win: h.win, dispose: h.dispose };
        setPopupRoot(h.root); setMode('window');
        writeSidebarLayout('floating', rectRef.current); // yeniden yüklemede en yakın kip: yüzen
      },
      () => { popupPendingRef.current = null; floatSidebar(); });
  }, [floatSidebar]);

  /* Kullanıcı ayrı pencereyi kapatırsa panel ana pencereye (sabitli) döner. */
  useEffect(() => {
    const p = popupRef.current;
    if (!popupRoot || !p) return;
    let done = false;
    const back = () => {
      if (done || popupRef.current !== p) return;
      done = true; popupRef.current = null; p.dispose();
      setPopupRoot(null); showDocked();
    };
    attempt(() => p.win.addEventListener('pagehide', back));
    const iv = window.setInterval(() => { try { if (p.win.closed) back(); } catch { back(); } }, 500);
    return () => { window.clearInterval(iv); attempt(() => p.win.removeEventListener('pagehide', back)); };
  }, [popupRoot]);
  /* Ana sayfa kapanır / yenilenirse yetim pencere kalmasın. */
  useEffect(() => {
    const bye = () => { popupPendingRef.current?.(); const p = popupRef.current; if (p) attempt(() => p.win.close()); };
    window.addEventListener('pagehide', bye);
    return () => { window.removeEventListener('pagehide', bye); bye(); };
  }, []);
  /* Pencere boyutu değişince yüzen panel görünür alanda kalsın. */
  useEffect(() => {
    if (mode !== 'floating') return;
    const onResize = () => setRect(r => { const c = clampFloatRect(r); writeSidebarLayout('floating', c); return c; });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'docked') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !(isOpen || isPinned)) return;
      // Escape şerit girdisinde / aktif panel aracında "iptal"dir — o durumlarda kenar çubuğu KAPANMAZ.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const st = useAppStore.getState();
      if (st.faceExtrudeMode || st.panelMoveMode || st.panelRotateMode) return;
      setIsOpen(false); setIsPinned(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, isOpen, isPinned]);

  useEffect(() => {
    if (mode !== 'docked' || !isOpen || isPinned) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || sidebarRef.current?.contains(target) || handleRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [mode, isOpen, isPinned]);

  /* ---- yüzen panel: sürükleme / boyutlandırma (işaretçi yakalama, canlı DOM güncellemesi, bırakınca state) ---- */
  const dragStart = (e: React.PointerEvent<HTMLElement>, kind: 'move' | 'resize', dx = false, dy = false) => {
    if (mode !== 'floating' || e.button !== 0) return;
    if (kind === 'move' && (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const el = e.currentTarget;
    attempt(() => el.setPointerCapture(e.pointerId));
    dragRef.current = { kind, dx, dy, sx: e.clientX, sy: e.clientY, start: rectRef.current, live: rectRef.current };
  };
  const dragMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current; if (!d) return;
    const mx = e.clientX - d.sx, my = e.clientY - d.sy;
    const next = d.kind === 'move'
      ? { ...d.start, x: d.start.x + mx, y: d.start.y + my }
      : { ...d.start, w: d.start.w + (d.dx ? mx : 0), h: d.start.h + (d.dy ? my : 0) };
    const c = clampFloatRect(next); d.live = c;
    const el = sidebarRef.current;
    if (el) paint(el, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
  };
  const dragEnd = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current; if (!d) return;
    dragRef.current = null;
    const el = e.currentTarget;
    attempt(() => el.releasePointerCapture(e.pointerId));
    setRect(d.live); writeSidebarLayout('floating', d.live);
  };
  const dragHandlers = { onPointerMove: dragMove, onPointerUp: dragEnd, onPointerCancel: dragEnd };
  const resizeHandle = (style: React.CSSProperties, dx: boolean, dy: boolean) => (
    <div onPointerDown={e => dragStart(e, 'resize', dx, dy)} {...dragHandlers} style={{ position: 'absolute', zIndex: 2, touchAction: 'none', ...style }} />
  );

  const isVisible = mode !== 'docked' || isOpen || isPinned;
  const docked = mode === 'docked', floating = mode === 'floating';
  const tabPane = (tab: SidebarTab, content: React.ReactNode, empty: React.ReactNode) => (
    <div style={{ display: activeTab === tab ? 'block' : 'none' }}>{selectedShapeId ? content : empty}</div>
  );
  const togglePin = () => { if (isPinned) { setIsPinned(false); setIsOpen(false); } else setIsPinned(true); };

  /* Sekme şeridi + içerik: üç kipte de aynı ağaç (docked ↔ floating geçişinde içerik yeniden kurulmaz). */
  const panelBody = (
    <div style={{
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: SB.bg, fontFamily: UI_FONT,
      borderRight: docked ? `1px solid ${SB.border}` : 'none', boxShadow: docked ? SB.panelShadow : 'none',
    }}>
      <div onPointerDown={e => dragStart(e, 'move')} {...dragHandlers} title={floating ? 'Drag to move the panel' : undefined}
        style={{ ...SIDEBAR_HEADER, cursor: floating ? 'move' : 'default' }}>
        <div style={HEADER_SIDE}>
          <TabBtn active={activeTab === 'parameters'} onClick={() => setActiveTab('parameters')}
            icon={<SlidersHorizontal size={13.5} strokeWidth={2} />} label="Parameters" />
          <div style={VSEP} />
          <TabBtn active={activeTab === 'panel-editor'} onClick={() => setActiveTab('panel-editor')}
            icon={<PanelLeft size={13.5} strokeWidth={2} />} label="Panel Editor" />
        </div>
        {/* Yüzen kipte boş şerit tutamaktır; ortadaki grip yalnız ipucu. */}
        <div style={{
          flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: SB.textMuted,
          opacity: floating ? 0.7 : 0, pointerEvents: 'none',
        }}>
          <GripHorizontal size={14} strokeWidth={2} />
        </div>
        <div style={HEADER_SIDE}>
          <div style={VSEP} />
          {/* Yerleşim: yüzen panel ↔ sol şerit; ayrı pencere ↔ ana pencere. Etkin olan düğmeye basmak sola yaslar. */}
          <HeaderToggle active={floating} onClick={floating ? dockSidebar : floatSidebar}
            title={floating ? 'Dock the panel back to the left edge' : 'Undock — floating panel you can drag and resize'}
            icon={<PictureInPicture2 size={14} strokeWidth={2} />} />
          {(SIDEBAR_WINDOW_ENABLED || mode === 'window') && (
            <HeaderToggle active={mode === 'window'} onClick={mode === 'window' ? dockSidebar : popOutSidebar}
              title={mode === 'window' ? 'Return the panel to the main window' : 'Open the panel in a separate browser window'}
              icon={<AppWindow size={14} strokeWidth={2} />} />
          )}
          {docked && (
            <>
              <div style={VSEP} />
              <button onClick={togglePin} {...pinHoverProps} title={isPinned ? 'Unpin panel' : 'Pin panel'}
                style={{
                  width: '40px', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', outline: 'none',
                  cursor: 'pointer',
                  background: isPinned ? SB.accentSoft : pinHover ? 'rgba(60,50,40,0.05)' : 'transparent',
                  color: isPinned ? SB.accent : pinHover ? SB.textPrimary : SB.textTertiary,
                  transition: 'background 0.12s,color 0.12s,transform 0.18s', transform: pinHover && !isPinned ? 'rotate(-12deg)' : 'rotate(0deg)',
                  position: 'relative',
                }}>
                {isPinned ? <Pin size={14} strokeWidth={2.2} /> : <PinOff size={14} strokeWidth={2} />}
                {isPinned && <div style={ACCENT_UNDERLINE('65%')} />}
              </button>
            </>
          )}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <SidebarRail activeTab={activeTab} hasShape={!!selectedShapeId} />
        <div className="custom-scrollbar bone-skin" style={SIDEBAR_SCROLL}>
          {tabPane('parameters', parametersContent,
            <EmptyState icon={<SlidersHorizontal size={18} strokeWidth={1.6} />} title="No shape selected"
              description="Select an object from the 3D view to edit its parameters" hint="Tip: Click an object or drag a selection box" />)}
          {tabPane('panel-editor', panelEditorContent,
            <EmptyState icon={<PanelLeft size={18} strokeWidth={1.6} />} title="No panel selected"
              description="Select a panel or surface to edit its properties" hint="Tip: Click a surface in face select mode" />)}
        </div>
      </div>
      <style>{SIDEBAR_CSS}</style>
    </div>
  );

  /* Sol kenar tutamağı: kapalı şeridi açar; ayrı pencere kipinde o pencereyi öne getirir. */
  const edgeHandle = (icon: React.ReactNode, label: string, onClick: () => void) => (
    <div ref={handleRef} className="fixed left-0 z-40" style={{ top: '120px', bottom: '64px', width: '24px', pointerEvents: 'none' }}>
      <div style={EDGE_LINE} />
      <button type="button" onClick={onClick} {...handleHoverProps} aria-label={label} title={label}
        style={{
          ...EDGE_BTN, transform: `translateY(-50%) translateX(${handleHover ? '3px' : '0'})`, boxShadow: handleHover ? EDGE_SHADOW_HOVER : EDGE_SHADOW,
        }}>
        {icon}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'center' }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: '2.5px', height: '2.5px', borderRadius: '50%', background: handleHover ? SB.accent : SB.textMuted, transition: 'background 0.15s',
              opacity: handleHover ? 0.95 : 0.65,
            }} />
          ))}
        </div>
      </button>
      {handleHover && <div style={EDGE_GLOW} />}
    </div>
  );
  const handleInk = handleHover ? SB.accent : SB.textSecondary;

  return (
    <>
      {docked && !isVisible && edgeHandle(
        <ChevronRight size={14} strokeWidth={2.5}
          style={{ color: handleInk, transition: 'color 0.15s,transform 0.22s', transform: handleHover ? 'translateX(1.5px)' : 'translateX(0)' }} />,
        'Open sidebar', openSidebar)}
      {mode === 'window' && edgeHandle(
        <AppWindow size={14} strokeWidth={2.2} style={{ color: handleInk, transition: 'color 0.15s' }} />,
        'Panel is open in a separate window — click to bring it to front', popOutSidebar)}

      {/* Tek çerçeve, iki görünüm: aynı ağaç yuvası → docked ↔ floating geçişinde içerik yeniden kurulmaz. */}
      {mode !== 'window' && (
        <div ref={sidebarRef} className={docked ? 'fixed z-40 flex transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]' : 'fixed z-40 flex'}
          style={docked
            ? { top: '120px', bottom: '64px', left: 0, width: `${SIDEBAR_WIDTH}px`, transform: isVisible ? 'translateX(0)' : `translateX(-${SIDEBAR_WIDTH}px)` }
            : {
              left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`, borderRadius: '10px', overflow: 'hidden',
              border: `1px solid ${SB.border}`, boxShadow: FLOAT_SHADOW, background: SB.bg,
            }}>
          {panelBody}
          {floating && (
            <>
              {resizeHandle({ top: 0, right: 0, width: '6px', height: '100%', cursor: 'ew-resize' }, true, false)}
              {resizeHandle({ left: 0, bottom: 0, width: '100%', height: '6px', cursor: 'ns-resize' }, false, true)}
              {resizeHandle({ right: 0, bottom: 0, width: '16px', height: '16px', cursor: 'nwse-resize', background: RESIZE_GRIP_BG }, true, true)}
            </>
          )}
        </div>
      )}
      {mode === 'window' && popupRoot && createPortal(panelBody, popupRoot)}
    </>
  );
};
