import React from 'react';
import type { LucideIcon } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════════════════
   TOOLBAR CHIPS — Panel Editor ve Parameters üst araç çubuğu (ortak bileşen).
   Goker: "üstteki düğmeler daha şık ve profesyonel olsun" — iki panel AYNI
   bileşeni kullanır, görünüm yapısal olarak ayrışamaz.

   Tasarım: zeminsiz "hayalet" düğmeler — başlığın beyaz zeminiyle bütün. Pasif:
   soluk metin + gri ikon, hover'da çok hafif ton. Aktif: koyu metin, turuncu
   ikon ve altında ince turuncu çizgi (üstteki sekmelerle aynı dil).
   Her düğme bağımsız aç/kapa olabilir (segment değil, çoklu seçim).

   NOT: bone-skin `.text-xs.font-semibold` birleşimini büyük harfli başlığa
   (eyebrow) çevirir ve `button.p-1` sınıflarını yeniden boyar — burada bilinçli
   olarak text-[11px] ve özel dolgu kullanılır.
   ═══════════════════════════════════════════════════════════════════════════ */

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
    {/* Aktif göstergesi: sekmelerdeki (Parameters / Panel Editor) ince turuncu çizgiyle aynı dil. */}
    <span className={`pointer-events-none absolute left-2 right-2 -bottom-[3px] h-[2px] rounded-full bg-orange-500 transition-opacity duration-150 ${active ? 'opacity-100' : 'opacity-0'}`} />
  </button>
);

/* Tepsi YOK (Goker: "yazıların arka planı arkadaki beyazla bütünlük sağlamadı"):
   düğmeler doğrudan başlık zemininin üstünde durur; aralarında yalnız boşluk. */
export const ToolChipBar: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-1 flex-wrap -ml-1">
    {children}
  </div>
);
