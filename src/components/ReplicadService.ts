import { setOC } from 'replicad';
import initOpenCascade from 'opencascade.js';
import * as THREE from 'three';

declare global {
  interface Window {
    __ocInstance?: any;
    __ocInitPromise?: Promise<any>;
  }
}

export const initReplicad = async () => {
  if (window.__ocInstance) return window.__ocInstance;
  if (window.__ocInitPromise) return window.__ocInitPromise;

  window.__ocInitPromise = (async () => {
    const oc = await initOpenCascade();
    setOC(oc);
    window.__ocInstance = oc;
    return oc;
  })().catch((error) => {
    window.__ocInitPromise = undefined;
    console.error('Failed to initialize Replicad:', error);
    throw error;
  });

  return window.__ocInitPromise;
};

export interface ReplicadBoxParams {
  width: number;
  height: number;
  depth: number;
}

export const createReplicadBox = async (params: ReplicadBoxParams): Promise<any> => {
  await initReplicad();
  const { width, height, depth } = params;

  const { draw } = await import('replicad');

  const boxSketch = draw()
    .movePointerTo([0, 0])
    .lineTo([width, 0])
    .lineTo([width, height])
    .lineTo([0, height])
    .close()
    .sketchOnPlane()
    .extrude(depth);

  return boxSketch;
};

export const convertReplicadToThreeGeometry = (shape: any): THREE.BufferGeometry => {
  try {
    const mesh = shape.mesh({ tolerance: 0.1, angularTolerance: 30 });
    if (!mesh.vertices || !mesh.triangles) throw new Error('Invalid mesh data');

    const vertices: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < mesh.vertices.length; i++) vertices.push(mesh.vertices[i]);
    for (let i = 0; i < mesh.triangles.length; i++) indices.push(mesh.triangles[i]);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return geometry;
  } catch (error) {
    console.error('convertReplicadToThreeGeometry failed:', error);
    throw error;
  }
};

export const performBooleanCut = async (
  baseShape: any,
  cuttingShape: any,
  _basePosition?: [number, number, number],
  cuttingPosition?: [number, number, number],
  _baseRotation?: [number, number, number],
  cuttingRotation?: [number, number, number],
  _baseScale?: [number, number, number],
  cuttingScale?: [number, number, number],
): Promise<any> => {
  await initReplicad();


  try {
    let transformedCutting = cuttingShape;

    if (cuttingScale && (cuttingScale[0] !== 1 || cuttingScale[1] !== 1 || cuttingScale[2] !== 1)) {
      transformedCutting = transformedCutting.scale(cuttingScale[0], cuttingScale[1], cuttingScale[2]);
    }

    if (cuttingRotation && (cuttingRotation[0] !== 0 || cuttingRotation[1] !== 0 || cuttingRotation[2] !== 0)) {
      if (cuttingRotation[0] !== 0) transformedCutting = transformedCutting.rotate(cuttingRotation[0] * (180 / Math.PI), [0, 0, 0], [1, 0, 0]);
      if (cuttingRotation[1] !== 0) transformedCutting = transformedCutting.rotate(cuttingRotation[1] * (180 / Math.PI), [0, 0, 0], [0, 1, 0]);
      if (cuttingRotation[2] !== 0) transformedCutting = transformedCutting.rotate(cuttingRotation[2] * (180 / Math.PI), [0, 0, 0], [0, 0, 1]);
    }

    if (cuttingPosition && (cuttingPosition[0] !== 0 || cuttingPosition[1] !== 0 || cuttingPosition[2] !== 0)) {
      transformedCutting = transformedCutting.translate(cuttingPosition[0], cuttingPosition[1], cuttingPosition[2]);
    }

    const result = baseShape.cut(transformedCutting);
    return result;
  } catch (error) {
    console.error('Boolean cut failed:', error);
    throw error;
  }
};

export const createPanelFromVirtualFace = async (
  vertices: [number, number, number][],
  normal: [number, number, number],
  panelThickness: number,
  planeExpand: number = 0
): Promise<any> => {
  await initReplicad();

  const { draw, Plane } = await import('replicad');

  const n = new THREE.Vector3(...normal).normalize();

  // up: normale EN DİK dünya ekseni (en küçük |bileşen|). Eski "dominant
  // bileşen" seçimi 45° gibi iki bileşenin eşit olduğu normallerde dejenere
  // cross üretip u/v tabanını bozuyordu (dönmüş panel kesimi -45° civarı hiç
  // çalışmıyordu — kök buydu). En dik eksen her yönelimde sağlam taban verir.
  const anx = Math.abs(n.x), any_ = Math.abs(n.y), anz = Math.abs(n.z);
  let up: THREE.Vector3;
  if (anx <= any_ && anx <= anz) up = new THREE.Vector3(1, 0, 0);
  else if (any_ <= anx && any_ <= anz) up = new THREE.Vector3(0, 1, 0);
  else up = new THREE.Vector3(0, 0, 1);
  const uAxis = new THREE.Vector3().crossVectors(n, up).normalize();
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();

  const v3s = vertices.map(v => new THREE.Vector3(v[0], v[1], v[2]));
  const center = new THREE.Vector3();
  v3s.forEach(v => center.add(v));
  center.divideScalar(v3s.length);

  let projected: [number, number][] = v3s.map(v => {
    const d = new THREE.Vector3().subVectors(v, center);
    return [d.dot(uAxis), d.dot(vAxis)] as [number, number];
  });

  // Düzlem-içi büyütme: döndürülmüş panelde slab'ı kübü aşacak kadar genişletir;
  // sonrasında (ters döndürülmüş) parent-küp kesişimi paneli açıya göre tam
  // duvara kadar kırpar (grow & shrink to fit).
  //
  // ÖNEMLİ: Köşeleri tek tek dışarı itmek, başka panelin açtığı ÇENTİKLİ/konkav
  // sanal yüzeyde çokgeni kendine katlar ve dev/bozuk katı üretir. Bunun yerine
  // sanal yüzeyin SINIR DİKDÖRTGENİNİ büyütüp onu kullanırız — her zaman konveks,
  // asla kendine katlanmaz. Çentikler zaten küp kesişimi + kardeş kesimiyle
  // yeniden oluşur.
  if (planeExpand > 0) {
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [pu, pv] of projected) {
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    minU -= planeExpand; maxU += planeExpand;
    minV -= planeExpand; maxV += planeExpand;
    projected = [[minU, minV], [maxU, minV], [maxU, maxV], [minU, maxV]];
  }

  // ÇİFT KÖŞE TEMİZLİĞİ: Sanal yüzey çokgeni Sutherland-Hodgman kırpmadan
  // (subtractPolygon/clipSH) gelir; eğik ayak izi kenarı yüz köşesinin tam
  // üstünden geçtiğinde kırpıcı kesişim noktasını mevcut köşeyle BİREBİR AYNI
  // üretip ikisini de çıktıya basar. draw().lineTo(aynı nokta) sıfır-uzunluklu
  // kenarda OCC'nin NUMERİK WASM exception fırlatmasına yol açar ("Auto panel
  // creation failed: 19365648" sınıfı) → panel hiç üretilmez. Ardışık çiftler
  // (wrap-around: son=ilk dahil) burada ayıklanır; harness doğrulaması:
  // yalnız BİREBİR çift tetikler, 1e-7 fark OCC'de sorunsuzdur.
  const DUP_TOL = 1e-4;
  const cleaned: [number, number][] = [];
  for (const p of projected) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < DUP_TOL) continue;
    cleaned.push(p);
  }
  while (cleaned.length >= 2) {
    const f = cleaned[0], l = cleaned[cleaned.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < DUP_TOL) cleaned.pop(); else break;
  }
  if (cleaned.length < 3) {
    console.warn('[YAGO][ÜRETİM] createPanelFromVirtualFace: dejenere çokgen (temizlik sonrası <3 köşe), panel atlandı. hamKöşeN=', vertices.length);
    return null;
  }
  projected = cleaned;

  // Ensure CCW winding — replicad treats CW polygons as holes
  let signedArea = 0;
  for (let i = 0; i < projected.length; i++) {
    const j = (i + 1) % projected.length;
    signedArea += projected[i][0] * projected[j][1] - projected[j][0] * projected[i][1];
  }
  // SIFIR-ALAN KAPISI: kırpma artığı kıymık bölge OCC'ye gitmeden elenir.
  if (Math.abs(signedArea) / 2 < 1e-3) {
    console.warn('[YAGO][ÜRETİM] createPanelFromVirtualFace: sıfır-alan çokgen, panel atlandı. alan=', Math.abs(signedArea) / 2);
    return null;
  }
  if (signedArea < 0) {
    projected = projected.slice().reverse();
  }

  let sketch = draw().movePointerTo(projected[0]);
  for (let i = 1; i < projected.length; i++) {
    sketch = sketch.lineTo(projected[i]);
  }
  const closed = sketch.close();

  const plane = new Plane(
    [center.x, center.y, center.z],
    [uAxis.x, uAxis.y, uAxis.z],
    [n.x, n.y, n.z]
  );

  const sketched = closed.sketchOnPlane(plane);
  const panel = sketched.extrude(-panelThickness);

  return panel;
};
