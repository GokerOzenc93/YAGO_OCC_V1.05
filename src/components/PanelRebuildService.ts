// ═══════════════════════════════════════════════════════════════════════════
// PanelRebuildService — İNCE KABUK.
// Tüm yeniden-üretim mantığı PanelEngine'e taşındı (temiz çekirdek; bkz.
// PanelEngine.ts başlığındaki tasarım sözleşmesi ve K1..K6 kuralları).
// Bu dosya yalnız dışa açık girişleri (store + PanelEditor'ün import ettiği)
// aynı imzayla korur.
// ═══════════════════════════════════════════════════════════════════════════
export { rebuildPanelsForParent } from './PanelEngine';
