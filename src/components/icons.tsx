import React, { useEffect, useState } from 'react';

/* ─────────────────────────────────────────────────────────────
   Icon registry
   Add or remove icons by editing the ICONS map below.
   Each value is the public path to an SVG file in /public/icons/.
   SVG files use stroke="currentColor", so they inherit the
   parent button's text color (hover / active / danger states).
   ───────────────────────────────────────────────────────────── */
const ICONS = {
  // existing custom icons (color-filled SVGs you already have)
  'add-box':             '/icons/add-box.svg',
  'subtract-box':        '/icons/subtract-box.svg',
  'camera-perspective':  '/icons/camera-perspective.svg',
  'camera-orthographic': '/icons/camera-orthographic.svg',
  'view-solid':          '/icons/view-solid.svg',
  'view-wireframe':      '/icons/view-wireframe.svg',
  'view-xray':           '/icons/view-xray.svg',
  'linear-mode-on':      '/icons/linear-mode-on.svg',
  'linear-mode-off':     '/icons/linear-mode-off.svg',

  // header / meta
  'search':              '/icons/search.svg',
  'settings':            '/icons/settings.svg',
  'help-circle':         '/icons/help-circle.svg',
  'log-out':             '/icons/log-out.svg',
  'crosshair':           '/icons/crosshair.svg',

  // file ops
  'file-plus':           '/icons/file-plus.svg',
  'file-down':           '/icons/file-down.svg',
  'save':                '/icons/save.svg',
  'upload':              '/icons/upload.svg',

  // edit ops
  'undo-2':              '/icons/undo-2.svg',
  'redo-2':              '/icons/redo-2.svg',
  'scissors':            '/icons/scissors.svg',
  'copy':                '/icons/copy.svg',
  'clipboard-paste':     '/icons/clipboard-paste.svg',
  'eraser':              '/icons/eraser.svg',

  // transform tools
  'mouse-pointer-2':     '/icons/mouse-pointer-2.svg',
  'move':                '/icons/move.svg',
  'navigation':          '/icons/navigation.svg',
  'refresh-ccw':         '/icons/refresh-ccw.svg',
  'maximize-2':          '/icons/maximize-2.svg',

  // geometry / panels
  'box':                 '/icons/box.svg',
  'cog':                 '/icons/cog.svg',
  'sliders-horizontal':  '/icons/sliders-horizontal.svg',
  'minus-square':        '/icons/minus-square.svg',
  'panel-left':          '/icons/panel-left.svg',
  'folder-open':         '/icons/folder-open.svg',

  // camera / view (lucide companions)
  'camera':              '/icons/camera.svg',
  'camera-off':          '/icons/camera-off.svg',
  'box-select':          '/icons/box-select.svg',
  'scan-eye':            '/icons/scan-eye.svg',
  'cuboid':              '/icons/cuboid.svg',
  'eye':                 '/icons/eye.svg',

  // menu icons
  'grid-2x2':            '/icons/grid-2x2.svg',
  'layers':              '/icons/layers.svg',
  'cylinder':            '/icons/cylinder.svg',
  'package':             '/icons/package.svg',
  'square':              '/icons/square.svg',
  'flip-horizontal':     '/icons/flip-horizontal.svg',
  'maximize':            '/icons/maximize.svg',
  'bar-chart-3':         '/icons/bar-chart-3.svg',
  'file-text':           '/icons/file-text.svg',
  'git-branch':          '/icons/git-branch.svg',
  'target':              '/icons/target.svg',
  'rotate-cw':           '/icons/rotate-cw.svg',
  'rotate-ccw':          '/icons/rotate-ccw.svg',
  'zap':                 '/icons/zap.svg',
  'inspection-panel':    '/icons/inspection-panel.svg',
  'map-pin':             '/icons/map-pin.svg',
  'ruler':               '/icons/ruler.svg',
  'monitor':             '/icons/monitor.svg',
  'arrow-down-up':       '/icons/arrow-down-up.svg',
} as const;

export type IconName = keyof typeof ICONS;

/* ─────────────────────────────────────────────────────────────
   Two flavors of icon:
   • <Icon>      — inline SVG (recommended). Inherits currentColor
                   from the parent, so hover/active/disabled colors
                   defined on the button apply to strokes/fills.
   • <IconImg>   — <img src="..."> (kept for icons that should
                   keep their own colors, e.g. the existing
                   colorful add-box / view-solid icons).
   ───────────────────────────────────────────────────────────── */

/* In-memory cache so each SVG is fetched once per session */
const svgCache: Record<string, string> = {};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

/** Inline SVG icon — inherits currentColor. */
export const Icon: React.FC<IconProps> = ({
  name,
  size = 16,
  className = '',
  style,
}) => {
  const src = ICONS[name];
  const [markup, setMarkup] = useState<string>(() => svgCache[src] ?? '');

  useEffect(() => {
    if (svgCache[src]) {
      setMarkup(svgCache[src]);
      return;
    }
    let cancelled = false;
    fetch(src)
      .then((r) => r.text())
      .then((txt) => {
        if (cancelled) return;
        // Strip any explicit width/height so the wrapper controls size.
        const cleaned = txt
          .replace(/\swidth="[^"]*"/i, '')
          .replace(/\sheight="[^"]*"/i, '');
        svgCache[src] = cleaned;
        setMarkup(cleaned);
      })
      .catch(() => {
        if (!cancelled) setMarkup('');
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <span
      role="img"
      aria-label={name}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        lineHeight: 0,
        flexShrink: 0,
        ...style,
      }}
      // SVG markup comes from local files in /public/icons — safe to inject.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
};

/** <img>-based icon — keeps its own colors (no currentColor). */
export const IconImg: React.FC<IconProps> = ({
  name,
  size = 22,
  className = '',
  style,
}) => (
  <img
    src={ICONS[name]}
    width={size}
    height={size}
    alt={name}
    className={className}
    draggable={false}
    style={style}
  />
);

/* ─────────────────────────────────────────────────────────────
   Button wrappers
   ───────────────────────────────────────────────────────────── */
interface IconButtonProps {
  icon: IconName;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  /** Size of the rendered button (square). Default 30. */
  size?: number;
  /** Size of the icon inside the button. Default 18. */
  iconSize?: number;
  /** Visual tone — 'exit' adds an amber tint for sign-out actions. */
  tone?: 'default' | 'exit';
}

/** Plain image button (kept for backwards compatibility with the
 *  colorful add-box / subtract-box / view-* / camera-* icons). */
export const IconButton: React.FC<IconButtonProps> = ({
  icon,
  title,
  onClick,
  disabled = false,
  className = '',
  size = 30,
  iconSize = 18,
  tone = 'default',
}) => {
  const toneClasses =
    tone === 'exit'
      ? 'text-amber-700 hover:bg-amber-50 hover:text-amber-800'
      : 'hover:bg-stone-100';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ width: size, height: size }}
      className={`flex items-center justify-center rounded transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-stone-400 active:scale-95 ${toneClasses} ${
        disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'
      } ${className}`}
      title={title}
    >
      <IconImg name={icon} size={iconSize} />
    </button>
  );
};

/* Named convenience exports (your existing colorful icons) */
export const AddBoxButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="add-box" title="Kutu Ekle (B)" {...props} />
);
export const SubtractBoxButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="subtract-box" title="Kesişen Şekilleri Çıkar" {...props} />
);
export const CameraPerspectiveButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="camera-perspective" title="Perspektif Görünüm" {...props} />
);
export const CameraOrthographicButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="camera-orthographic" title="Ortografik Görünüm" {...props} />
);
export const ViewSolidButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="view-solid" title="Solid Görünüm" {...props} />
);
export const ViewWireframeButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="view-wireframe" title="Wireframe Görünüm" {...props} />
);
export const ViewXRayButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="view-xray" title="X-Ray Görünüm" {...props} />
);
export const LinearModeOnButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="linear-mode-on" title="Linear Mode: Açık" {...props} />
);
export const LinearModeOffButton: React.FC<Omit<IconButtonProps, 'icon' | 'title'>> = (props) => (
  <IconButton icon="linear-mode-off" title="Linear Mode: Kapalı" {...props} />
);
