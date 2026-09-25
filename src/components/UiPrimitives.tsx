import React from 'react';
import type { LucideIcon } from 'lucide-react';

/* Genel amaçlı, küçük ve yeniden kullanılabilir UI parçaları — kendi başlarına
   ayrı dosyayı hak etmeyecek kadar küçük bileşenler burada toplanır. */

/* ── ErrorBoundary — render hatalarını yakalayıp arayüzü çökertmez ────────── */
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex items-center justify-center h-full bg-stone-100">
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-md text-center">
            <div className="text-red-500 text-lg font-semibold mb-2">Render Error</div>
            <div className="text-sm text-stone-600 mb-4">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </div>
            <button
              onClick={this.handleRetry}
              className="px-4 py-2 bg-orange-600 text-white rounded-md hover:bg-orange-700 text-sm font-medium"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ── ToolChip / ToolChipBar — Panel Editor + Parameters üst araç çubuğu ────
   Zeminsiz "hayalet" düğmeler: pasifte soluk metin/gri ikon, aktifte koyu
   metin + turuncu ikon + altında ince turuncu çizgi. Her düğme bağımsız
   aç/kapa (segment değil, çoklu seçim). İki panel de aynı bileşeni kullanır. */
export interface ToolChipProps {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onClick: () => void;
  title?: string;
  /** Aktif değil ama bir değer taşıyan düğme (ör. "Fillet 1/2"). */
  badge?: string | number;
}

export const ToolChip: React.FC<ToolChipProps> = ({ label, icon: Icon, active = false, onClick, title, badge }) => (
  <button
    type="button"
    onClick={onClick}
    title={title || label}
    aria-pressed={active}
    className={`group/chip relative h-[26px] px-2 rounded-[6px] flex items-center gap-1.5 text-[11.5px] tracking-[0.01em] whitespace-nowrap bg-transparent transition-colors duration-150
      ${active ? 'text-stone-800 font-semibold' : 'text-stone-500 font-medium hover:text-stone-800 hover:bg-[rgba(60,50,40,0.045)]'}`}
  >
    <Icon size={12.5} strokeWidth={2} className={`shrink-0 transition-colors duration-150 ${active ? 'text-orange-600' : 'text-stone-400 group-hover/chip:text-stone-600'}`} />
    <span>{label}</span>
    {badge !== undefined && badge !== '' && (
      <span className={`min-w-[16px] h-[15px] px-1 rounded-full text-[9.5px] font-semibold tabular-nums leading-[15px] text-center
        ${active ? 'bg-orange-100 text-orange-700' : 'bg-[#efeae2] text-stone-500'}`}>{badge}</span>
    )}
    <span className={`pointer-events-none absolute left-2 right-2 -bottom-[3px] h-[2px] rounded-full bg-orange-500 transition-opacity duration-150 ${active ? 'opacity-100' : 'opacity-0'}`} />
  </button>
);

export const ToolChipBar: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-1 flex-wrap -ml-1">
    {children}
  </div>
);
