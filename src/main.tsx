// TARAYICI HARNESS: gerçek PanelEditor, tohumlanmış store (edge senaryosu). window.__yago ile Playwright sürer.
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { requestRebuild, useAppStore } from '../src/store';
import { initReplicad } from '../src/components/Geometry';
import { setBackEdgeRel, setBackPlacement, setVfBackBound, splitBackAtPanel } from '../src/components/BackService';
import { PanelEditor } from '../src/components/PanelEditor';
import { Sidebar } from '../src/components/Ui';
import { D, H, W, addBack, addBodyPanel, addDivider, boxOfVf, fmtBox, makeBody, materializePanels, st } from '../harness/lib';

(async () => {
  await initReplicad();
  const scen = new URLSearchParams(location.search).get('scen') || 'edge';
  const body = await makeBody();
  const left = await addBodyPanel(body.id, [-1, 0, 0], [0, H / 2, D / 2], 'Left');
  const right = await addBodyPanel(body.id, [1, 0, 0], [W, H / 2, D / 2], 'Right');
  const top = await addBodyPanel(body.id, [0, 1, 0], [W / 2, H, D / 2], 'Top');
  const bottom = await addBodyPanel(body.id, [0, -1, 0], [W / 2, 0, D / 2], 'Bottom');
  let div: any = null;
  if (scen === 'edge' || scen === 'split') div = await addDivider(body.id, W / 2);
  for (const vf of [left, right, top, bottom, ...(div ? [div] : [])]) setVfBackBound(vf.id, true);
  const bg = scen === 'edge'
    ? await addBack(body.id, [(boxOfVf(div.id)!.max[0] + W) / 2, H / 2], b => b.uMin === div.id && b.uMax === right.id)
    : await addBack(body.id, [W / 4, H / 2], b => b.uMin === left.id && b.uMax === right.id);
  if (scen === 'split') { splitBackAtPanel(bg.id, div.id); await materializePanels(); await requestRebuild(body.id); }
  st().selectShape(body.id);
  st().setSelectedBackGroupId(bg.id);
  (window as any).__yago = { st, useAppStore, bg, div, left, right, top, bottom, boxOfVf, fmtBox, setBackEdgeRel, setBackPlacement, requestRebuild };
  // ?ui=sidebar → gerçek kenar çubuğu kabuğu (docked / floating / ayrı pencere) içinde PanelEditor.
  const ui = new URLSearchParams(location.search).get('ui');
  createRoot(document.getElementById('root')!).render(ui === 'sidebar'
    ? <div style={{ height: '100vh' }}><Sidebar parametersContent={<div style={{ padding: 12 }}>Parameters (harness)</div>} panelEditorContent={<PanelEditor />} /></div>
    : <div style={{ height: '100vh' }}><PanelEditor /></div>);
  (window as any).__ready = true;
})().catch(e => { console.error('HARNESS HATA', e); (window as any).__error = String(e); });
