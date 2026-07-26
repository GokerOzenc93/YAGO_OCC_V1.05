import { setOC } from 'replicad';
import initOpenCascade from 'opencascade.js';
import * as THREE from 'three';
import type { SubtractedGeometry } from '../store';

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

export interface ReplicadCylinderParams {
  radius: number;
  height: number;
}

export interface ReplicadSphereParams {
  radius: number;
}

export const createReplicadBox = async (params: ReplicadBoxParams): Promise<any> => {
  const oc = await initReplicad();
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

export const createReplicadCylinder = async (params: ReplicadCylinderParams): Promise<any> => {
  const oc = await initReplicad();
  const { radius, height } = params;

  const { drawCircle } = await import('replicad');
  const cylinder = drawCircle(radius)
    .sketchOnPlane()
    .extrude(height)
    .translate(radius, radius, 0);

  return cylinder;
};

export const createReplicadSphere = async (params: ReplicadSphereParams): Promise<any> => {
  const oc = await initReplicad();
  const { radius } = params;

  const { drawCircle } = await import('replicad');
  const sphere = drawCircle(radius)
    .sketchOnPlane()
    .revolve()
    .translate(radius, radius, radius);

  return sphere;
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

export const createBoxGeometry = async (
  width: number,
  height: number,
  depth: number
): Promise<THREE.BufferGeometry> => {
  const shape = await createReplicadBox({ width, height, depth });
  return convertReplicadToThreeGeometry(shape);
};

export const createCylinderGeometry = async (
  radius: number,
  height: number
): Promise<THREE.BufferGeometry> => {
  const shape = await createReplicadCylinder({ radius, height });
  return convertReplicadToThreeGeometry(shape);
};

export const createSphereGeometry = async (
  radius: number
): Promise<THREE.BufferGeometry> => {
  const shape = await createReplicadSphere({ radius });
  return convertReplicadToThreeGeometry(shape);
};

export const performBooleanCut = async (
  baseShape: any,
  cuttingShape: any,
  basePosition?: [number, number, number],
  cuttingPosition?: [number, number, number],
  baseRotation?: [number, number, number],
  cuttingRotation?: [number, number, number],
  baseScale?: [number, number, number],
  cuttingScale?: [number, number, number],
  baseSize?: [number, number, number],
  cuttingSize?: [number, number, number]
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

export const performBooleanUnion = async (
  shape1: any,
  shape2: any
): Promise<any> => {
  await initReplicad();
  try {
    return shape1.fuse(shape2);
  } catch (error) {
    console.error('Boolean union failed:', error);
    throw error;
  }
};

export const performBooleanIntersection = async (
  shape1: any,
  shape2: any
): Promise<any> => {
  await initReplicad();
  try {
    return shape1.intersect(shape2);
  } catch (error) {
    console.error('Boolean intersection failed:', error);
    throw error;
  }
};

/**
 * "Ana yüze eşitle" panelini parent katının GERÇEK yüz geometrisinden üretir.
 * VF düzlemindeki (aynı yönde normal, düzleme mesafe ~0) planar yüzlerden,
 * seedPoint'e en yakın yüzün KENAR/KÖŞE PAYLAŞAN BAĞLANTILI BİLEŞENİ alınır,
 * -normal yönünde kalınlık kadar extrude edilip birleştirilir.
 *
 * Slab ∩ parent yaklaşımının aksine, düzlemin ALTINDA kalan sığ cep/girinti
 * tabanları (derinlik < panel kalınlığı) dahil edilmez — cebin altında ince
 * dilim (sliver) kalmaz. Girintili/L-şekilli yüz şekli OCC'nin kendi yüz
 * topolojisinden birebir gelir; ışın veya kontur takibi gerekmez.
 *
 * BAĞLANTILI BİLEŞEN KURALI: Aynı düzlemde birden çok AYRIK yüz varsa (ör.
 * çentiğin böldüğü iki kanat, aynı yüzeyde yan yana iki panel bölgesi) bunlar
 * ASLA tek panelde birleştirilmez — yalnızca seedPoint'in bulunduğu fiziksel
 * olarak bitişik parça alınır. Aksi halde küp büyüyünce eş-düzleme gelen iki
 * panel birbirinin içine geçiyordu.
 *
 * Uygun yüz bulunamazsa null döner; çağıran intersection fallback'ine düşer.
 */
// [MOTOR TEMİZLİĞİ] createPanelFromParentFaces kaldırıldı: yeni PanelEngine tam-yüz modeli
// yerine K5 (bölge=vurgu) kullanır; bu yol ölü koddu.

// [MOTOR TEMİZLİĞİ] keepSolidNearestPoint kaldırıldı: yeni PanelEngine tam-yüz modeli
// yerine K5 (bölge=vurgu) kullanır; bu yol ölü koddu.

export const createPanelFromFace = async (
  replicadShape: any,
  faceNormal: [number, number, number],
  faceCenter: [number, number, number],
  panelThickness: number,
  constraintGeometry?: any
): Promise<any> => {
  await initReplicad();

  try {
    const faces = replicadShape.faces;
    interface FaceCandidate { face: any; dot: number; center: [number, number, number] | null; }
    const candidates: FaceCandidate[] = [];

    for (let i = 0; i < faces.length; i++) {
      const face = faces[i];
      try {
        const normalVec = face.normalAt(0.5, 0.5);
        const normal = [normalVec.x, normalVec.y, normalVec.z];
        const dot = normal[0] * faceNormal[0] + normal[1] * faceNormal[1] + normal[2] * faceNormal[2];
        if (dot > 0.7) {
          let center: [number, number, number] | null = null;
          try {
            const faceMesh = face.mesh({ tolerance: 0.5, angularTolerance: 30 });
            if (faceMesh.vertices && faceMesh.vertices.length >= 3) {
              let sx = 0, sy = 0, sz = 0;
              const nv = faceMesh.vertices.length / 3;
              for (let j = 0; j < faceMesh.vertices.length; j += 3) {
                sx += faceMesh.vertices[j]; sy += faceMesh.vertices[j + 1]; sz += faceMesh.vertices[j + 2];
              }
              center = [sx / nv, sy / nv, sz / nv];
            }
          } catch { /* skip */ }
          candidates.push({ face, dot, center });
        }
      } catch { /* skip face */ }
    }

    if (candidates.length === 0) return null;

    let matchingFace = candidates[0].face;
    if (candidates.length > 1) {
      let bestDist = Infinity;
      for (const candidate of candidates) {
        if (candidate.center) {
          const dist = Math.sqrt(
            (candidate.center[0] - faceCenter[0]) ** 2 +
            (candidate.center[1] - faceCenter[1]) ** 2 +
            (candidate.center[2] - faceCenter[2]) ** 2
          );
          if (dist < bestDist) { bestDist = dist; matchingFace = candidate.face; }
        }
      }
    }

    const normalVec = matchingFace.normalAt(0.5, 0.5);
    const extrusionDirection = [-normalVec.x, -normalVec.y, -normalVec.z];
    const oc = await initReplicad();
    const vec = new oc.gp_Vec_4(
      extrusionDirection[0] * panelThickness,
      extrusionDirection[1] * panelThickness,
      extrusionDirection[2] * panelThickness
    );
    const prismBuilder = new oc.BRepPrimAPI_MakePrism_1(matchingFace.wrapped, vec, false, true);
    prismBuilder.Build(new oc.Message_ProgressRange_1());
    const solid = prismBuilder.Shape();
    const { cast } = await import('replicad');
    let panel = cast(solid);

    if (constraintGeometry) {
      try { panel = await performBooleanIntersection(panel, constraintGeometry); }
      catch (error) { console.error('Constraint intersection failed:', error); }
    }
    return panel;
  } catch (error) {
    console.error('createPanelFromFace failed:', error);
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

  let up: THREE.Vector3;
  if (Math.abs(n.y) > Math.abs(n.x) && Math.abs(n.y) > Math.abs(n.z)) {
    up = new THREE.Vector3(1, 0, 0);
  } else {
    up = new THREE.Vector3(0, 1, 0);
  }
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

export const applyParentSubtractors = async (
  panelShape: any,
  subtractionGeometries: SubtractedGeometry[]
): Promise<any> => {
  if (!subtractionGeometries || subtractionGeometries.length === 0) return panelShape;

  await initReplicad();

  let result = panelShape;

  for (const sub of subtractionGeometries) {
    if (!sub.parameters) continue;

    const w = parseFloat(sub.parameters.width);
    const h = parseFloat(sub.parameters.height);
    const d = parseFloat(sub.parameters.depth);
    if (isNaN(w) || isNaN(h) || isNaN(d) || w <= 0 || h <= 0 || d <= 0) continue;

    try {
      const margin = 0.5;
      const cuttingBox = await createReplicadBox({ width: w + margin, height: h + margin, depth: d + margin });
      result = await performBooleanCut(
        result,
        cuttingBox,
        undefined,
        sub.relativeOffset,
        undefined,
        sub.relativeRotation,
        undefined,
        sub.scale
      );
    } catch (err) {
      console.error('Failed to apply subtractor to panel:', err);
    }
  }

  return result;
};
