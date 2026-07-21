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
export const createPanelFromParentFaces = async (
  parentShape: any,
  normal: [number, number, number],
  planePoint: [number, number, number],
  panelThickness: number,
  seedPoint?: [number, number, number],
  contourVertices?: [number, number, number][]
): Promise<any | null> => {
  await initReplicad();
  const { basicFaceExtrusion, Vector } = await import('replicad');

  const n = new THREE.Vector3(...normal).normalize();
  const PLANE_TOL = 0.5;
  const seed = seedPoint ?? planePoint;

  // 1) Collect eligible coplanar faces
  const eligible: any[] = [];
  try {
    for (const f of parentShape.faces) {
      try {
        if (f.geomType !== 'PLANE') continue;
        const c = f.center;
        const fn = f.normalAt(c);
        const dot = fn.x * n.x + fn.y * n.y + fn.z * n.z;
        if (dot < 0.99) continue;
        const dist =
          (c.x - planePoint[0]) * n.x +
          (c.y - planePoint[1]) * n.y +
          (c.z - planePoint[2]) * n.z;
        if (Math.abs(dist) > PLANE_TOL) continue;
        eligible.push(f);
      } catch { /* skip broken face */ }
    }
  } catch (err) {
    console.error('createPanelFromParentFaces face scan failed:', err);
    return null;
  }
  if (eligible.length === 0) return null;

  // 2D projection helpers for contour point-in-polygon test
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  const uAxis = az >= ax && az >= ay ? new THREE.Vector3(1, 0, 0)
    : ax >= ay ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();
  uAxis.crossVectors(vAxis, n).normalize();
  const project2D = (p: [number, number, number]) => ({
    x: uAxis.x * p[0] + uAxis.y * p[1] + uAxis.z * p[2],
    y: vAxis.x * p[0] + vAxis.y * p[1] + vAxis.z * p[2],
  });
  const pointInPoly = (px: number, py: number, poly: Array<{ x: number; y: number }>): boolean => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi))
        inside = !inside;
    }
    return inside;
  };

  // 2) PRIMARY PATH: select OCC faces whose mesh centroid falls inside the
  //    highlight contour polygon. This guarantees panel = highlight.
  let selected: Set<number> | null = null;
  if (contourVertices && contourVertices.length >= 3) {
    const poly = contourVertices.map(project2D);
    selected = new Set<number>();
    for (let i = 0; i < eligible.length; i++) {
      try {
        const fm = eligible[i].mesh({ tolerance: 1.0, angularTolerance: 15 });
        if (!fm.vertices || fm.vertices.length < 3) continue;
        let sx = 0, sy = 0, sz = 0, nv = 0;
        for (let j = 0; j < fm.vertices.length; j += 3) {
          sx += fm.vertices[j]; sy += fm.vertices[j + 1]; sz += fm.vertices[j + 2]; nv++;
        }
        if (nv === 0) continue;
        const proj = project2D([sx / nv, sy / nv, sz / nv]);
        if (pointInPoly(proj.x, proj.y, poly)) selected.add(i);
      } catch { /* skip unmeshable face */ }
    }
    if (selected.size === 0) selected = null;
  }

  // 3) FALLBACK: seed + BFS (old behavior)
  if (selected === null) {
    const vertexKeys = (f: any): Set<string> => {
      const keys = new Set<string>();
      try {
        for (const e of f.edges) {
          for (const p of [e.startPoint, e.endPoint]) {
            if (!p) continue;
            keys.add(`${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`);
          }
        }
      } catch {}
      return keys;
    };
    const keySets = eligible.map(vertexKeys);
    const share = (a: Set<string>, b: Set<string>): boolean => {
      for (const k of a) if (b.has(k)) return true;
      return false;
    };
    let seedIdx = 0, bestD = Infinity;
    for (let i = 0; i < eligible.length; i++) {
      let minPtDist = Infinity;
      try {
        const fm = eligible[i].mesh({ tolerance: 1.0, angularTolerance: 15 });
        if (fm.vertices && fm.vertices.length >= 3) {
          for (let j = 0; j < fm.vertices.length; j += 3) {
            const dx = fm.vertices[j] - seed[0];
            const dy = fm.vertices[j + 1] - seed[1];
            const dz = fm.vertices[j + 2] - seed[2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < minPtDist) minPtDist = d;
          }
        }
      } catch {}
      if (!isFinite(minPtDist)) {
        const c = eligible[i].center;
        minPtDist = Math.hypot(c.x - seed[0], c.y - seed[1], c.z - seed[2]);
      }
      if (minPtDist < bestD) { bestD = minPtDist; seedIdx = i; }
    }
    selected = new Set<number>([seedIdx]);
    const stack = [seedIdx];
    while (stack.length) {
      const ii = stack.pop()!;
      for (let j = 0; j < eligible.length; j++) {
        if (selected.has(j)) continue;
        if (share(keySets[ii], keySets[j])) { selected.add(j); stack.push(j); }
      }
    }
  }

  // 4) Extrude selected faces and fuse
  const solids: any[] = [];
  for (const i of selected) {
    try {
      solids.push(
        basicFaceExtrusion(
          eligible[i],
          new Vector([-n.x * panelThickness, -n.y * panelThickness, -n.z * panelThickness])
        )
      );
    } catch { /* skip individual face failure */ }
  }
  if (solids.length === 0) return null;

  let out = solids[0];
  for (let i = 1; i < solids.length; i++) {
    try {
      out = await performBooleanUnion(out, solids[i]);
    } catch (err) {
      console.error('createPanelFromParentFaces union başarısız, parça atlandı:', err);
    }
  }
  return out;
};

/**
 * Çok parçalı (compound) bir katıdan yalnızca verilen noktaya en yakın SOLID
 * parçayı tutar; tek parçaysa katıyı olduğu gibi döndürür.
 *
 * "Ana yüze eşitle" panelini kardeş panel kesimi İKİYE BÖLDÜĞÜNDE (ör. dikey
 * bölme panelin ortasından geçer), kardeşin ÖTE tarafındaki parça kullanıcının
 * seçmediği bölgedir ve panelde kalmamalıdır ("bir yerlerde ince panel
 * kalıyor" hatasının kök nedeni). Nokta, panelin ORİJİNAL (eşitleme öncesi)
 * VF merkezi olmalıdır — kullanıcının tıkladığı bölgeyi temsil eder.
 * Mesafe, parça AABB'sine clamp mesafesidir (nokta parçanın içindeyse 0).
 */
export const keepSolidNearestPoint = async (
  shape: any,
  point: [number, number, number],
  inwardDir?: [number, number, number]
): Promise<any> => {
  try {
    const { getOC, Solid, makeBaseBox } = await import('replicad');
    const oc = getOC();
    const parts: any[] = [];
    const exp = new oc.TopExp_Explorer_2(
      shape.wrapped,
      oc.TopAbs_ShapeEnum.TopAbs_SOLID,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE
    );
    while (exp.More()) {
      parts.push(new Solid(oc.TopoDS.Solid_1(exp.Current())));
      exp.Next();
    }
    exp.delete();
    if (parts.length <= 1) return shape;

    // Prob noktası: yüzeydeki tıklama, panel normali boyunca 2mm İÇERİ
    // itilir — nokta kesin tek parçanın hacmindedir.
    const pp: [number, number, number] = inwardDir
      ? [point[0] - inwardDir[0] * 2, point[1] - inwardDir[1] * 2, point[2] - inwardDir[2] * 2]
      : point;

    const clampDist = (p: any): number => {
      const bb = p.boundingBox.bounds;
      const dx = Math.max(bb[0][0] - pp[0], 0, pp[0] - bb[1][0]);
      const dy = Math.max(bb[0][1] - pp[1], 0, pp[1] - bb[1][1]);
      const dz = Math.max(bb[0][2] - pp[2], 0, pp[2] - bb[1][2]);
      return Math.hypot(dx, dy, dz);
    };
    // EĞİK KESİM BELİRSİZLİĞİ: dönmüş kardeş paneli çaprazlama kestiğinde
    // parçaların AABB'leri ÖRTÜŞÜR ve tıklama noktası birden çok kutunun
    // içinde kalır (mesafe=0 beraberliği) — AABB testi yanlış parçayı
    // seçebilir ("açılı panelin boşluğuna tıkladım, panel alta yerleşti").
    // Beraberlikte GERÇEK katı-içi test yapılır: prob noktasında 2mm küp,
    // hangi parçanın hacmiyle kesişiyorsa o parça kazanır.
    const zero = parts.filter(p => clampDist(p) < 1e-6);
    if (zero.length > 1) {
      for (const p of zero) {
        try {
          const probe = makeBaseBox(2, 2, 2).translate([pp[0] - 1, pp[1] - 1, pp[2] - 1]);
          const hit = probe.intersect(p.clone());
          const bb = hit.boundingBox.bounds;
          if (isFinite(bb[0][0]) && bb[1][0] - bb[0][0] > 1e-6) return p.clone();
        } catch { /* prob başarısızsa sıradaki parçaya bak */ }
      }
    }

    let bestPart: any = null;
    let bestDist = Infinity;
    for (const p of parts) {
      const d = clampDist(p);
      if (d < bestDist) { bestDist = d; bestPart = p; }
    }
    // Klon şart: alt-shape parent compound'a bağlı; bağımsız kopya döndürülür.
    return bestPart ? bestPart.clone() : shape;
  } catch (err) {
    console.error('keepSolidNearestPoint başarısız, katı olduğu gibi bırakıldı:', err);
    return shape;
  }
};

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

  // Ensure CCW winding — replicad treats CW polygons as holes
  let signedArea = 0;
  for (let i = 0; i < projected.length; i++) {
    const j = (i + 1) % projected.length;
    signedArea += projected[i][0] * projected[j][1] - projected[j][0] * projected[i][1];
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
