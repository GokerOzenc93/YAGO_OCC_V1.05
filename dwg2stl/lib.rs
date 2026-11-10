//! dwg2stl — DWG / DXF içindeki 3B geometriyi üçgen ağına (ikili STL) çevirir. Tarayıcıda WASM olarak çalışır.
//!
//! NEDEN VAR (Goker, Kas 2026): aksesuar (ayak vb.) modelleri elde yalnız DWG olarak var; uygulama STL / STEP alıyordu.
//! DWG'deki 3B katılar (3DSOLID / BODY / SURFACE) ACIS B-rep verisidir: dosyayı OKUMAK yetmez, yüzeyleri ÜÇGENLEMEK gerekir.
//!
//! KATMANLAR
//!  1) Okuma: `acadrust` (MPL-2.0; DWG R13–R2018 + DXF) → varlıklar + ACIS kayıtları (SAT metni / SAB ikilisi çözülmüş).
//!  2) Kenar örnekleme: her `edge` TEK kez örneklenir (doğru / elips yayı / spline) — iki komşu yüz AYNI noktaları kullanır,
//!     bu yüzden yüzler arasında çatlak olmaz.
//!  3) Yüz üçgenleme: sınır halkaları yüzeyin (u,v) uzayına taşınır, periyodik yüzeylerde (silindir, koni, küre, torus,
//!     kapalı NURBS) açılır; "dolanan" halkalar bant, kutup / tepe doğal sınır olur; kısıtlı Delaunay + kenar-tabanlı inceltme.
//!  4) Gövde: köşeler kaynatılır, yüz yönleri komşuluktan tutarlı hale getirilir, dönüşüm (ACIS transform + blok ekleri) uygulanır.
//!  5) ACIS olmayan ağlar (3DFACE, POLYFACE / POLYGON MESH, MESH) doğrudan eklenir.
//!
//! Desteklenen yüzeyler: plane, cone (silindir dahil, eliptik dahil), sphere, torus, spline (acadrust'ın çözdüğü NURBS ağı).
//! Çözülemeyen yüz: sınırından düzlemsel yama ile kapatılır ve raporda `approx` olarak sayılır (delik bırakılmaz).

use acadrust::entities::acis::{SabReader, SatDocument, SatIntCurve, SatRecord, SatSplineSurface, Sense};
use acadrust::entities::{AcisData, EntityType};
use acadrust::CadDocument;
use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

pub type V3 = [f64; 3];
const TAU: f64 = 2.0 * PI;

/* ───────────────────────────── Vektör ───────────────────────────── */
#[inline] fn add(a: V3, b: V3) -> V3 { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
#[inline] fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
#[inline] fn mul(a: V3, s: f64) -> V3 { [a[0] * s, a[1] * s, a[2] * s] }
#[inline] fn dot(a: V3, b: V3) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
#[inline] fn cross(a: V3, b: V3) -> V3 { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
#[inline] fn len(a: V3) -> f64 { dot(a, a).sqrt() }
#[inline] fn dist(a: V3, b: V3) -> f64 { len(sub(a, b)) }
#[inline] fn mid(a: V3, b: V3) -> V3 { mul(add(a, b), 0.5) }
fn unit(a: V3) -> V3 { let l = len(a); if l > 1e-300 { mul(a, 1.0 / l) } else { [0.0, 0.0, 0.0] } }
/// `n`'ye dik herhangi bir birim vektör.
fn any_perp(n: V3) -> V3 {
    let t = if n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    unit(cross(n, t))
}
fn finite(p: V3) -> bool { p.iter().all(|c| c.is_finite()) }

/// Afin dönüşüm: `m` sütunları = eksenlerin görüntüleri.
#[derive(Clone, Copy, Debug)]
pub struct Xf { m: [V3; 3], t: V3 }
impl Xf {
    pub fn id() -> Self { Xf { m: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], t: [0.0; 3] } }
    pub fn apply(&self, p: V3) -> V3 { add(self.t, add(add(mul(self.m[0], p[0]), mul(self.m[1], p[1])), mul(self.m[2], p[2]))) }
    fn dir(&self, p: V3) -> V3 { add(add(mul(self.m[0], p[0]), mul(self.m[1], p[1])), mul(self.m[2], p[2])) }
    /// self ∘ inner (önce `inner`).
    fn then(&self, inner: &Xf) -> Xf { Xf { m: [self.dir(inner.m[0]), self.dir(inner.m[1]), self.dir(inner.m[2])], t: self.apply(inner.t) } }
    fn det(&self) -> f64 { dot(self.m[0], cross(self.m[1], self.m[2])) }
    fn is_finite(&self) -> bool { self.m.iter().all(|c| finite(*c)) && finite(self.t) && self.det().abs() > 1e-12 }
}

/* ───────────────────────────── NURBS ───────────────────────────── */
fn find_span(n_ctrl: usize, deg: usize, t: f64, knots: &[f64]) -> usize {
    if t >= knots[n_ctrl] { return n_ctrl - 1; }
    if t <= knots[deg] { return deg; }
    let (mut lo, mut hi) = (deg, n_ctrl);
    while hi - lo > 1 { let m = (lo + hi) / 2; if t < knots[m] { hi = m } else { lo = m } }
    lo
}
/// Sıfır olmayan `deg + 1` taban fonksiyonu (The NURBS Book A2.2).
fn basis(span: usize, t: f64, deg: usize, knots: &[f64]) -> Vec<f64> {
    let mut n = vec![0.0; deg + 1];
    let (mut left, mut right) = (vec![0.0; deg + 1], vec![0.0; deg + 1]);
    n[0] = 1.0;
    for j in 1..=deg {
        left[j] = t - knots[span + 1 - j];
        right[j] = knots[span + j] - t;
        let mut saved = 0.0;
        for r in 0..j {
            let den = right[r + 1] + left[j - r];
            let tmp = if den.abs() > 1e-300 { n[r] / den } else { 0.0 };
            n[r] = saved + right[r + 1] * tmp;
            saved = left[j - r] * tmp;
        }
        n[j] = saved;
    }
    n
}
fn wrap_into(t: f64, lo: f64, hi: f64) -> f64 { let p = hi - lo; if p <= 0.0 { lo } else { lo + (t - lo).rem_euclid(p) } }

struct NCurve { deg: usize, knots: Vec<f64>, ctrl: Vec<[f64; 4]>, closed: bool }
impl NCurve {
    fn new(deg: usize, knots: Vec<f64>, ctrl: Vec<[f64; 4]>, closed_hint: bool) -> Option<Self> {
        if deg == 0 || ctrl.len() <= deg || knots.len() != ctrl.len() + deg + 1 { return None; }
        if knots.windows(2).any(|w| w[1] < w[0]) || !ctrl.iter().all(|c| c.iter().all(|x| x.is_finite())) { return None; }
        let mut c = NCurve { deg, knots, ctrl, closed: false };
        let (lo, hi) = c.domain();
        if !(hi > lo) { return None; }
        let (a, b) = (c.eval(lo), c.eval(hi));
        let scale = c.ctrl.iter().fold(0.0f64, |m, p| m.max(len([p[0], p[1], p[2]]) / p[3].abs().max(1e-12))).max(1e-9);
        c.closed = closed_hint && dist(a, b) < 1e-6 * scale.max(1.0) || dist(a, b) < 1e-9 * scale.max(1.0);
        Some(c)
    }
    fn domain(&self) -> (f64, f64) { (self.knots[self.deg], self.knots[self.ctrl.len()]) }
    fn eval(&self, t: f64) -> V3 {
        let (lo, hi) = self.domain();
        let t = if self.closed { wrap_into(t, lo, hi) } else { t.clamp(lo, hi) };
        let s = find_span(self.ctrl.len(), self.deg, t, &self.knots);
        let b = basis(s, t, self.deg, &self.knots);
        let mut h = [0.0; 4];
        for (j, bj) in b.iter().enumerate() { let c = self.ctrl[s - self.deg + j]; for k in 0..4 { h[k] += bj * c[k]; } }
        let w = if h[3].abs() > 1e-12 { h[3] } else { 1.0 };
        [h[0] / w, h[1] / w, h[2] / w]
    }
    /// `p`'ye en yakın parametre (kaba tarama + altın oran).
    fn project(&self, p: V3) -> f64 {
        let (lo, hi) = self.domain();
        let n = (self.ctrl.len() * 8).clamp(48, 2000);
        let (mut best, mut bd) = (0usize, f64::MAX);
        for i in 0..=n { let d = dist(self.eval(lo + (hi - lo) * i as f64 / n as f64), p); if d < bd { bd = d; best = i; } }
        let step = (hi - lo) / n as f64;
        let (mut a, mut b) = ((lo + step * best as f64 - step).max(lo), (lo + step * best as f64 + step).min(hi));
        let g = 0.618_033_988_749_894_9;
        for _ in 0..48 {
            let (x1, x2) = (b - g * (b - a), a + g * (b - a));
            if dist(self.eval(x1), p) < dist(self.eval(x2), p) { b = x2 } else { a = x1 }
        }
        0.5 * (a + b)
    }
}

struct NSurf {
    du: usize, dv: usize, ku: Vec<f64>, kv: Vec<f64>, nu: usize, nv: usize, ctrl: Vec<[f64; 4]>,
    /// Kontrol ağı sırası: true → u içte (indeks = v·nu + u).
    u_fast: bool, per_u: bool, per_v: bool,
}
impl NSurf {
    fn dom_u(&self) -> (f64, f64) { (self.ku[self.du], self.ku[self.nu]) }
    fn dom_v(&self) -> (f64, f64) { (self.kv[self.dv], self.kv[self.nv]) }
    fn at(&self, iu: usize, iv: usize) -> [f64; 4] { if self.u_fast { self.ctrl[iv * self.nu + iu] } else { self.ctrl[iu * self.nv + iv] } }
    fn eval(&self, u: f64, v: f64) -> V3 {
        let ((ul, uh), (vl, vh)) = (self.dom_u(), self.dom_v());
        let u = if self.per_u { wrap_into(u, ul, uh) } else { u.clamp(ul, uh) };
        let v = if self.per_v { wrap_into(v, vl, vh) } else { v.clamp(vl, vh) };
        let (su, sv) = (find_span(self.nu, self.du, u, &self.ku), find_span(self.nv, self.dv, v, &self.kv));
        let (bu, bv) = (basis(su, u, self.du, &self.ku), basis(sv, v, self.dv, &self.kv));
        let mut h = [0.0; 4];
        for (j, bj) in bv.iter().enumerate() {
            for (i, bi) in bu.iter().enumerate() {
                let c = self.at(su - self.du + i, sv - self.dv + j);
                let w = bi * bj;
                for k in 0..4 { h[k] += w * c[k]; }
            }
        }
        let w = if h[3].abs() > 1e-12 { h[3] } else { 1.0 };
        [h[0] / w, h[1] / w, h[2] / w]
    }
    fn partials(&self, u: f64, v: f64) -> (V3, V3) {
        let ((ul, uh), (vl, vh)) = (self.dom_u(), self.dom_v());
        let (hu, hv) = ((uh - ul) * 1e-5, (vh - vl) * 1e-5);
        // Tek taraflı fark: alan sınırında da geçerli kalsın
        let (u0, u1) = if self.per_u { (u - hu, u + hu) } else { ((u - hu).max(ul), (u + hu).min(uh)) };
        let (v0, v1) = if self.per_v { (v - hv, v + hv) } else { ((v - hv).max(vl), (v + hv).min(vh)) };
        (mul(sub(self.eval(u1, v), self.eval(u0, v)), 1.0 / (u1 - u0).max(1e-300)), mul(sub(self.eval(u, v1), self.eval(u, v0)), 1.0 / (v1 - v0).max(1e-300)))
    }
    fn normal(&self, u: f64, v: f64) -> V3 {
        let (a, b) = self.partials(u, v);
        let n = cross(a, b);
        if len(n) > 1e-12 * (len(a) * len(b)).max(1e-300) && len(n) > 0.0 { return unit(n); }
        // Tekil noktada (kutup) hafif içeri kaydır
        let ((ul, uh), (vl, vh)) = (self.dom_u(), self.dom_v());
        let (uc, vc) = (u + ((ul + uh) * 0.5 - u) * 1e-3, v + ((vl + vh) * 0.5 - v) * 1e-3);
        let (a, b) = self.partials(uc, vc);
        unit(cross(a, b))
    }
    fn grid_seed(&self, p: V3, n: usize) -> (f64, f64) {
        let ((ul, uh), (vl, vh)) = (self.dom_u(), self.dom_v());
        let (mut best, mut bd) = ((ul, vl), f64::MAX);
        for i in 0..=n { for j in 0..=n {
            let (u, v) = (ul + (uh - ul) * i as f64 / n as f64, vl + (vh - vl) * j as f64 / n as f64);
            let d = dist(self.eval(u, v), p);
            if d < bd { bd = d; best = (u, v); }
        } }
        best
    }
    fn newton(&self, p: V3, mut u: f64, mut v: f64) -> (f64, f64, f64) {
        let ((ul, uh), (vl, vh)) = (self.dom_u(), self.dom_v());
        for _ in 0..40 {
            let r = sub(self.eval(u, v), p);
            let (a, b) = self.partials(u, v);
            let (aa, ab, bb, ar, br) = (dot(a, a), dot(a, b), dot(b, b), dot(a, r), dot(b, r));
            let det = aa * bb - ab * ab;
            let (du, dv) = if det.abs() > 1e-14 * (aa * bb).max(1e-300) { ((-ar * bb + br * ab) / det, (-br * aa + ar * ab) / det) }
                else if aa > bb { (-ar / aa.max(1e-300), 0.0) } else { (0.0, -br / bb.max(1e-300)) };
            // Adımı alanın bir kısmıyla sınırla (ıraksamaya karşı)
            let du = du.clamp(-(uh - ul) * 0.25, (uh - ul) * 0.25);
            let dv = dv.clamp(-(vh - vl) * 0.25, (vh - vl) * 0.25);
            u += du; v += dv;
            if !self.per_u { u = u.clamp(ul, uh); }
            if !self.per_v { v = v.clamp(vl, vh); }
            if du.abs() < (uh - ul) * 1e-12 && dv.abs() < (vh - vl) * 1e-12 { break; }
        }
        (u, v, dist(self.eval(u, v), p))
    }
    fn invert(&self, p: V3, hint: Option<(f64, f64)>, tol: f64) -> (f64, f64) {
        if let Some((hu, hv)) = hint {
            let (u, v, d) = self.newton(p, hu, hv);
            if d < tol { return (u, v); }
        }
        let (mut best, mut bd) = ((0.0, 0.0), f64::MAX);
        for n in [16usize, 48] {
            let (su, sv) = self.grid_seed(p, n);
            let (u, v, d) = self.newton(p, su, sv);
            if d < bd { bd = d; best = (u, v); }
            if bd < tol { break; }
        }
        best
    }
}

/* ───────────────────────────── ACIS kayıt yardımcıları ───────────────────────────── */
fn rec(d: &SatDocument, i: i32) -> Option<&SatRecord> { if i < 0 { None } else { d.record(i as usize) } }
/// Kayıttaki işaretçiler sırayla (−1 = boş). İlk işaretçi her zaman "sentinel / pattern" alanıdır.
fn ptrs(r: &SatRecord) -> Vec<i32> { r.tokens.iter().filter_map(|t| t.as_pointer()).map(|p| p.0).collect() }
fn ptr(r: &SatRecord, n: usize) -> i32 { r.tokens.iter().filter_map(|t| t.as_pointer()).nth(n).map(|p| p.0).unwrap_or(-1) }
/// Sayısal alanlar düz sırada (SAB'de üçlü paketlenmiş konumlar açılır; işaretçi ve anahtar sözcükler atlanır).
fn nums(r: &SatRecord) -> Vec<f64> {
    let mut out = Vec::new();
    for t in &r.tokens {
        if t.as_pointer().is_some() { continue; }
        if let Some((c, n)) = t.coordinate_components() { out.extend_from_slice(&c[..n]); continue; }
        if t.as_ident().is_some() { continue; }
        if let Some(f) = t.as_float() { out.push(f); }
    }
    out
}
fn v3(n: &[f64], i: usize) -> V3 { [n.get(i).copied().unwrap_or(0.0), n.get(i + 1).copied().unwrap_or(0.0), n.get(i + 2).copied().unwrap_or(0.0)] }
/// `n`. işaretçiden SONRAKİ yön alanı (forward / reversed; 4.0 öncesi 0 / 1). Bulunamazsa false.
fn reversed_after_ptr(r: &SatRecord, n: usize) -> bool {
    let mut seen = 0usize;
    for (i, t) in r.tokens.iter().enumerate() {
        if t.as_pointer().is_some() {
            if seen == n { return r.token_sense(i + 1) == Sense::Reversed; }
            seen += 1;
        }
    }
    false
}
fn is_type(r: &SatRecord, base: &str) -> bool { r.entity_type == base || r.entity_type.ends_with(&format!("-{base}")) }

/* ───────────────────────────── Yüzeyler ───────────────────────────── */
enum Surf {
    Plane { o: V3, x: V3, y: V3, n: V3 },
    /// Koni / silindir: P = c + h·a + (r0 + h·tan)·(cosθ·m + sinθ·ratio·b); u = θ, v = h.
    Cone { c: V3, a: V3, m: V3, b: V3, r0: f64, ratio: f64, tan: f64, nsign: f64 },
    /// Küre: u = boylam, v = enlem.
    Sphere { c: V3, r: f64, x: V3, w: V3, z: V3, nsign: f64 },
    /// Torus: u = ana eksen açısı, v = tüp açısı.
    Torus { c: V3, n: V3, x: V3, w: V3, rr: f64, r: f64, nsign: f64 },
    Nurbs { s: Box<NSurf>, nsign: f64, scale: (f64, f64) },
}
impl Surf {
    fn eval(&self, u: f64, v: f64) -> V3 {
        match self {
            Surf::Plane { o, x, y, .. } => add(*o, add(mul(*x, u), mul(*y, v))),
            Surf::Cone { c, a, m, b, r0, ratio, tan, .. } => {
                let r = r0 + v * tan;
                add(add(*c, mul(*a, v)), add(mul(*m, r * u.cos()), mul(*b, r * ratio * u.sin())))
            }
            Surf::Sphere { c, r, x, w, z, .. } => {
                let (cv, sv) = (v.cos(), v.sin());
                add(*c, add(add(mul(*x, r * cv * u.cos()), mul(*w, r * cv * u.sin())), mul(*z, r * sv)))
            }
            Surf::Torus { c, n, x, w, rr, r, .. } => {
                let q = rr + r * v.cos();
                add(*c, add(add(mul(*x, q * u.cos()), mul(*w, q * u.sin())), mul(*n, r * v.sin())))
            }
            Surf::Nurbs { s, .. } => s.eval(u, v),
        }
    }
    /// ACIS yüzey normali (yüzün `reversed` bayrağı ayrıca uygulanır).
    fn normal(&self, u: f64, v: f64) -> V3 {
        match self {
            Surf::Plane { n, .. } => *n,
            Surf::Cone { a, m, b, ratio, tan, nsign, .. } => {
                let dth = add(mul(*m, -u.sin()), mul(*b, ratio * u.cos()));
                let dh = add(*a, add(mul(*m, tan * u.cos()), mul(*b, tan * ratio * u.sin())));
                mul(unit(cross(dth, dh)), *nsign)
            }
            Surf::Sphere { x, w, z, nsign, .. } => {
                let (cv, sv) = (v.cos(), v.sin());
                mul(unit(add(add(mul(*x, cv * u.cos()), mul(*w, cv * u.sin())), mul(*z, sv))), *nsign)
            }
            Surf::Torus { n, x, w, nsign, .. } => {
                let (cv, sv) = (v.cos(), v.sin());
                mul(unit(add(add(mul(*x, cv * u.cos()), mul(*w, cv * u.sin())), mul(*n, sv))), *nsign)
            }
            Surf::Nurbs { s, nsign, .. } => mul(s.normal(u, v), *nsign),
        }
    }
    /// Nokta → (u, v, tekil mi). Tekil = u belirsiz (koni tepesi / küre kutbu).
    fn invert(&self, p: V3, hint: Option<(f64, f64)>, tol: f64) -> (f64, f64, bool) {
        match self {
            Surf::Plane { o, x, y, .. } => { let d = sub(p, *o); (dot(d, *x), dot(d, *y), false) }
            Surf::Cone { c, a, m, b, ratio, .. } => {
                let d = sub(p, *c);
                let h = dot(d, *a);
                let (px, py) = (dot(d, *m), dot(d, *b) / ratio);
                let sing = (px * px + py * py).sqrt() < tol * 0.5;
                (py.atan2(px), h, sing)
            }
            Surf::Sphere { c, r, x, w, z, .. } => {
                let d = sub(p, *c);
                let (px, py, pz) = (dot(d, *x), dot(d, *w), dot(d, *z));
                let rho = (px * px + py * py).sqrt();
                let sgn = if *r < 0.0 { -1.0 } else { 1.0 };
                // r < 0 ise parametrizasyon eval ile tutarlı kalsın: P = c + r·(...)
                ((py * sgn).atan2(px * sgn), (pz * sgn).atan2(rho), rho < tol * 0.5)
            }
            Surf::Torus { c, n, x, w, rr, r, .. } => {
                let d = sub(p, *c);
                let (px, py, pz) = (dot(d, *x), dot(d, *w), dot(d, *n));
                let rho = (px * px + py * py).sqrt();
                let sgn = if *r < 0.0 { -1.0 } else { 1.0 };
                (py.atan2(px), (pz * sgn).atan2((rho - rr) * sgn), false)
            }
            Surf::Nurbs { s, .. } => { let (u, v) = s.invert(p, hint, tol); (u, v, false) }
        }
    }
    fn period(&self, axis: usize) -> Option<f64> {
        match (self, axis) {
            (Surf::Cone { .. }, 0) | (Surf::Sphere { .. }, 0) | (Surf::Torus { .. }, _) => Some(TAU),
            (Surf::Nurbs { s, .. }, 0) if s.per_u => { let (l, h) = s.dom_u(); Some(h - l) }
            (Surf::Nurbs { s, .. }, 1) if s.per_v => { let (l, h) = s.dom_v(); Some(h - l) }
            _ => None,
        }
    }
    /// Üçgenleme için (u,v) → yaklaşık mm ölçeği.
    fn uv_scale(&self, r_hint: f64) -> (f64, f64) {
        match self {
            Surf::Plane { .. } => (1.0, 1.0),
            Surf::Cone { r0, .. } => (r_hint.max(r0.abs() * 0.05).max(1e-9), 1.0),
            Surf::Sphere { r, .. } => (r.abs(), r.abs()),
            Surf::Torus { rr, r, .. } => ((rr.abs() + r.abs()).max(1e-9), r.abs().max(1e-9)),
            Surf::Nurbs { scale, .. } => *scale,
        }
    }
    /// `axis` yönünde dolanan bir halkanın `side` tarafındaki DOĞAL sınır (tepe / kutup / alan ucu) — karşı koordinat değeri.
    fn natural(&self, axis: usize, side: f64, from: f64) -> Option<f64> {
        match (self, axis) {
            (Surf::Cone { r0, tan, .. }, 0) => {
                if tan.abs() < 1e-12 { return None; }
                let apex = -r0 / tan;
                ((apex - from) * side > 0.0).then_some(apex)
            }
            (Surf::Sphere { .. }, 0) => Some(side * PI / 2.0),
            (Surf::Nurbs { s, .. }, 0) if !s.per_v => { let (l, h) = s.dom_v(); Some(if side > 0.0 { h } else { l }) }
            (Surf::Nurbs { s, .. }, 1) if !s.per_u => { let (l, h) = s.dom_u(); Some(if side > 0.0 { h } else { l }) }
            _ => None,
        }
    }
    /// Halkasız yüz için tam alan [u0, u1, v0, v1] (yalnız her yönde kapalı / sınırlı yüzeyler).
    fn full_domain(&self) -> Option<[f64; 4]> {
        match self {
            Surf::Sphere { .. } => Some([0.0, TAU, -PI / 2.0, PI / 2.0]),
            Surf::Torus { .. } => Some([0.0, TAU, 0.0, TAU]),
            Surf::Nurbs { s, .. } => { let ((ul, uh), (vl, vh)) = (s.dom_u(), s.dom_v()); Some([ul, uh, vl, vh]) }
            _ => None,
        }
    }
    /// Yüz İÇİNE serpilecek ızgaranın (u, v) adımı; None = o yönde iç nokta gerekmez (doğrusal yön: silindir doğrultmanı vb.).
    /// İç nokta olmadan üçgenleyici yalnız sınır köşelerini bağlar: küre / torus / serbest yüzeyde yüzü kesen dev üçgenler çıkar.
    fn grid_steps(&self, tol: f64) -> (Option<f64>, Option<f64>) {
        match self {
            Surf::Plane { .. } | Surf::Cone { .. } => (None, None),
            Surf::Sphere { r, .. } => { let a = arc_step(tol, *r); (Some(a), Some(a)) }
            Surf::Torus { rr, r, .. } => (Some(arc_step(tol, rr.abs() + r.abs())), Some(arc_step(tol, *r))),
            Surf::Nurbs { s, .. } => {
                let ((ul, uh), (vl, vh)) = (s.dom_u(), s.dom_v());
                // Yön boyunca kaç parça: orta nokta sapması `tol` altına inene kadar ikiye katla (en çok 64)
                let need = |along_u: bool| -> Option<f64> {
                    let (lo, hi, deg, n) = if along_u { (ul, uh, s.du, s.nu) } else { (vl, vh, s.dv, s.nv) };
                    if deg == 1 && n == 2 { return None; }
                    let at = |t: f64, c: f64| if along_u { s.eval(t, c) } else { s.eval(c, t) };
                    let (cl, ch) = if along_u { (vl, vh) } else { (ul, uh) };
                    let mut k = 2usize;
                    while k < 64 {
                        let mut worst = 0.0f64;
                        for ci in 0..5 {
                            let c = cl + (ch - cl) * ci as f64 / 4.0;
                            for i in 0..k {
                                let (t0, t1) = (lo + (hi - lo) * i as f64 / k as f64, lo + (hi - lo) * (i + 1) as f64 / k as f64);
                                let (a, b, m) = (at(t0, c), at(t1, c), at((t0 + t1) * 0.5, c));
                                let sag = dist(m, mid(a, b));
                                let l = dist(a, m) + dist(m, b);
                                if sag > tol && sag > l * (STEP_MIN / 4.0).tan() * 0.5 || sag > l * (STEP_MAX / 4.0).tan() * 0.5 { worst = worst.max(sag); }
                            }
                        }
                        if worst == 0.0 { break; }
                        k *= 2;
                    }
                    (k > 2 || deg > 1).then_some((hi - lo) / k as f64)
                };
                (need(true), need(false))
            }
        }
    }
    /// (u,v) tekil mi: bu noktada periyodik koordinat anlamsız (koni tepesi → u; küre kutbu → u).
    fn singular(&self, uv: [f64; 2], tol: f64) -> bool {
        match self {
            Surf::Cone { r0, tan, .. } => (r0 + uv[1] * tan).abs() < tol * 0.5,
            Surf::Sphere { r, .. } => (uv[1].cos() * r).abs() < tol * 0.5,
            _ => false,
        }
    }
    fn closed_both(&self) -> bool { matches!(self, Surf::Sphere { .. } | Surf::Torus { .. }) || matches!(self, Surf::Nurbs { s, .. } if s.per_u && s.per_v) }
}

fn make_surface(d: &SatDocument, r: &SatRecord, probe: &[V3]) -> Result<Surf, String> {
    let n = nums(r);
    if is_type(r, "plane-surface") {
        let nrm = unit(v3(&n, 3));
        if len(nrm) < 0.5 { return Err("plane without normal".into()); }
        let mut x = v3(&n, 6);
        x = sub(x, mul(nrm, dot(x, nrm)));
        let x = if len(x) < 1e-9 { any_perp(nrm) } else { unit(x) };
        return Ok(Surf::Plane { o: v3(&n, 0), x, y: cross(nrm, x), n: nrm });
    }
    if is_type(r, "cone-surface") {
        if n.len() < 12 { return Err("short cone record".into()); }
        let a = unit(v3(&n, 3));
        let mv = v3(&n, 6);
        let r0 = len(mv);
        if len(a) < 0.5 || r0 < 1e-12 { return Err("degenerate cone".into()); }
        let m = unit(sub(mv, mul(a, dot(mv, a))));
        let (ratio, sin, cos) = (if n[9].abs() > 1e-9 { n[9] } else { 1.0 }, n[10], n[11]);
        let tan0 = if cos.abs() > 1e-12 { sin / cos } else { 0.0 };
        let mk = |tan: f64| Surf::Cone { c: v3(&n, 0), a, m, b: cross(a, m), r0, ratio, tan, nsign: if cos < 0.0 { -1.0 } else { 1.0 } };
        // İşaret kuralı sürümler arasında oynuyor: sınır noktalarına en iyi oturan eğim seçilir.
        let resid = |s: &Surf| probe.iter().map(|p| { let (u, v, _) = s.invert(*p, None, 0.0); dist(s.eval(u, v), *p) }).fold(0.0f64, f64::max);
        let (s1, s2) = (mk(tan0), mk(-tan0));
        return Ok(if tan0 != 0.0 && resid(&s2) < resid(&s1) * 0.5 { s2 } else { s1 });
    }
    if is_type(r, "sphere-surface") {
        if n.len() < 4 { return Err("short sphere record".into()); }
        let mut z = unit(v3(&n, 7));
        if n.len() < 10 || len(z) < 0.5 { z = [0.0, 0.0, 1.0]; }
        let mut x = if n.len() >= 7 { v3(&n, 4) } else { [1.0, 0.0, 0.0] };
        x = sub(x, mul(z, dot(x, z)));
        let x = if len(x) < 1e-9 { any_perp(z) } else { unit(x) };
        let rad = n[3];
        if rad.abs() < 1e-12 { return Err("zero-radius sphere".into()); }
        return Ok(Surf::Sphere { c: v3(&n, 0), r: rad.abs(), x, w: cross(z, x), z, nsign: if rad < 0.0 { -1.0 } else { 1.0 } });
    }
    if is_type(r, "torus-surface") {
        if n.len() < 8 { return Err("short torus record".into()); }
        let nn = unit(v3(&n, 3));
        let mut x = if n.len() >= 11 { v3(&n, 8) } else { [0.0; 3] };
        x = sub(x, mul(nn, dot(x, nn)));
        let x = if len(x) < 1e-9 { any_perp(nn) } else { unit(x) };
        let (rr, rm) = (n[6], n[7]);
        if rm.abs() < 1e-12 { return Err("zero-radius torus".into()); }
        return Ok(Surf::Torus { c: v3(&n, 0), n: nn, x, w: cross(nn, x), rr, r: rm.abs(), nsign: if rm < 0.0 { -1.0 } else { 1.0 } });
    }
    if let Some(sp) = SatSplineSurface::from_record(r) {
        let b = sp.bspline(d).ok_or_else(|| format!("{}: no control net", spline_kind(d, &sp)))?;
        let (nu, nv) = (b.control_count_u, b.control_count_v);
        if nu <= b.degree_u || nv <= b.degree_v || b.control_points.len() < nu * nv || b.u_knots.len() != nu + b.degree_u + 1 || b.v_knots.len() != nv + b.degree_v + 1 {
            return Err("spline surface: inconsistent control net".into());
        }
        let closed = |c: &Option<String>| matches!(c.as_deref(), Some("periodic") | Some("closed"));
        let build = |u_fast: bool| {
            let mut s = NSurf { du: b.degree_u, dv: b.degree_v, ku: b.u_knots.clone(), kv: b.v_knots.clone(), nu, nv, ctrl: b.control_points[..nu * nv].to_vec(), u_fast, per_u: false, per_v: false };
            // Kapalılık geometriden doğrulanır (bayrak tek başına güvenilir değil)
            let ((ul, uh), (vl, vh)) = (s.dom_u(), s.dom_v());
            let ext = s.ctrl.iter().fold(0.0f64, |m, p| m.max(len([p[0], p[1], p[2]]) / p[3].abs().max(1e-12))).max(1e-9);
            let gap_u = (0..=4).map(|i| { let v = vl + (vh - vl) * i as f64 / 4.0; dist(s.eval(ul, v), s.eval(uh, v)) }).fold(0.0f64, f64::max);
            let gap_v = (0..=4).map(|i| { let u = ul + (uh - ul) * i as f64 / 4.0; dist(s.eval(u, vl), s.eval(u, vh)) }).fold(0.0f64, f64::max);
            s.per_u = closed(&b.u_closure) && gap_u < 1e-5 * ext;
            s.per_v = closed(&b.v_closure) && gap_v < 1e-5 * ext;
            s
        };
        let fit = |s: &NSurf| -> f64 { probe.iter().map(|p| { let (u, v) = s.invert(*p, None, 1e-9); dist(s.eval(u, v), *p) }).fold(0.0f64, f64::max) };
        let mut s = build(true);
        if nu != nv || b.degree_u != b.degree_v {
            // Sıra belirsizse sınıra oturan seçilir (yalnız kare ağlarda iki okuma da "geçerli" görünür)
        } else if !probe.is_empty() {
            let alt = build(false);
            if fit(&alt) < fit(&s) * 0.25 { s = alt; }
        }
        let ((ul, uh), (vl, vh)) = (s.dom_u(), s.dom_v());
        let (um, vm) = ((ul + uh) * 0.5, (vl + vh) * 0.5);
        let lu = (0..8).map(|i| dist(s.eval(ul + (uh - ul) * i as f64 / 8.0, vm), s.eval(ul + (uh - ul) * (i + 1) as f64 / 8.0, vm))).sum::<f64>();
        let lv = (0..8).map(|i| dist(s.eval(um, vl + (vh - vl) * i as f64 / 8.0), s.eval(um, vl + (vh - vl) * (i + 1) as f64 / 8.0))).sum::<f64>();
        let scale = ((lu / (uh - ul)).max(1e-9), (lv / (vh - vl)).max(1e-9));
        return Ok(Surf::Nurbs { s: Box::new(s), nsign: if sp.sense() == Sense::Reversed { -1.0 } else { 1.0 }, scale });
    }
    Err(format!("unsupported surface '{}'", r.entity_type))
}
fn spline_kind(d: &SatDocument, sp: &SatSplineSurface) -> String {
    sp.definition_tokens(d).and_then(|t| t.iter().filter_map(|x| x.as_ident()).find(|i| !matches!(*i, "{" | "forward" | "reversed" | "ref")).map(|s| s.to_string()))
        .unwrap_or_else(|| "spline".into())
}

/* ───────────────────────────── Bağlam + kenar örnekleme ───────────────────────────── */
/// Dönüşüm ayarı: `chord_rel` = kiriş sapması / model köşegeni.
#[derive(Clone, Copy, Debug)]
pub struct Options { pub chord_rel: f64 }
impl Default for Options { fn default() -> Self { Options { chord_rel: 0.001 } } }

const STEP_MIN: f64 = 5.0 * PI / 180.0;
const STEP_MAX: f64 = 30.0 * PI / 180.0;

/// Yarıçapı `r` olan yay için açı adımı: kiriş sapması `tol`, [5°, 30°] arasında.
fn arc_step(tol: f64, r: f64) -> f64 {
    let r = r.abs().max(1e-12);
    let a = if tol >= r { STEP_MAX } else { 2.0 * (1.0 - tol / r).acos() };
    a.clamp(STEP_MIN, STEP_MAX)
}
struct Ctx<'a> { d: &'a SatDocument, tol: f64, edges: HashMap<i32, Vec<V3>>, notes: Vec<String> }
impl<'a> Ctx<'a> {
    fn step(&self, r: f64) -> f64 { arc_step(self.tol, r) }
    fn vertex_pos(&self, vi: i32) -> Option<V3> {
        let v = rec(self.d, vi)?;
        let p = rec(self.d, *ptrs(v).last()?)?;
        let n = nums(p);
        (n.len() >= 3).then(|| v3(&n, 0)).filter(|q| finite(*q))
    }
    fn note(&mut self, s: String) { if self.notes.len() < 40 && !self.notes.contains(&s) { self.notes.push(s); } }

    /// Kenarın başlangıç → bitiş köşesi yönünde örneklenmiş çoklu doğrusu (önbellekli; uçlar köşe konumlarına sabitlenir).
    fn edge_polyline(&mut self, ei: i32) -> Result<Vec<V3>, String> {
        if let Some(p) = self.edges.get(&ei) { return Ok(p.clone()); }
        let e = rec(self.d, ei).ok_or("missing edge")?;
        let ep = ptrs(e);
        if ep.len() < 5 { return Err("short edge record".into()); }
        let (a, b) = (self.vertex_pos(ep[1]), self.vertex_pos(ep[2]));
        let rev = reversed_after_ptr(e, 4);
        let same_vertex = ep[1] == ep[2];
        let curve = rec(self.d, ep[4]);
        let pts = match curve {
            None => { let p = a.or(b).ok_or("edge without vertices")?; vec![p] }   // tepe (dejenere kenar)
            Some(c) if is_type(c, "straight-curve") => {
                let (a, b) = (a.ok_or("edge without start vertex")?, b.ok_or("edge without end vertex")?);
                vec![a, b]
            }
            Some(c) if is_type(c, "ellipse-curve") => {
                let n = nums(c);
                let (cen, nrm, mv) = (v3(&n, 0), unit(v3(&n, 3)), v3(&n, 6));
                let ratio = n.get(9).copied().filter(|r| r.abs() > 1e-9).unwrap_or(1.0);
                let rmaj = len(mv);
                if rmaj < 1e-12 || len(nrm) < 0.5 { return Err("degenerate ellipse".into()); }
                let m = unit(mv);
                let w = cross(nrm, m);
                let ang = |p: V3| { let d = sub(p, cen); (dot(d, w) / ratio).atan2(dot(d, m)) };
                let at = |t: f64| add(cen, add(mul(m, rmaj * t.cos()), mul(w, rmaj * ratio * t.sin())));
                let full = same_vertex || matches!((a, b), (Some(p), Some(q)) if dist(p, q) < 1e-7 * rmaj.max(1.0)) || a.is_none() || b.is_none();
                let t0 = a.or(b).map(ang).unwrap_or(0.0);
                let dir = if rev { -1.0 } else { 1.0 };
                let sweep = if full { TAU } else {
                    let t1 = ang(b.unwrap());
                    let mut s = (t1 - t0) * dir;
                    s = s.rem_euclid(TAU);
                    if s < 1e-9 { TAU } else { s }
                };
                let k = ((sweep / self.step(rmaj)).ceil() as usize).clamp(1, 720);
                let mut v: Vec<V3> = (0..=k).map(|i| at(t0 + dir * sweep * i as f64 / k as f64)).collect();
                if let Some(p) = a { v[0] = p; }
                if let Some(q) = if full { a.or(b) } else { b } { v[k] = q; }
                v
            }
            Some(c) => {
                let ic = SatIntCurve::from_record(c).and_then(|ic| {
                    let (deg, knots, ctrl) = ic.bspline_in(self.d)?;
                    let closed = ic.is_closed_in(self.d);
                    Some((NCurve::new(deg, knots, ctrl, closed)?, c.token_sense(1) == Sense::Reversed))
                });
                match (ic, a, b) {
                    (Some((nc, crev)), Some(a), Some(b)) => {
                        let (lo, hi) = nc.domain();
                        let (mut t0, mut t1) = (nc.project(a), nc.project(b));
                        let down = rev ^ crev;   // köşeden köşeye giderken parametre azalıyor mu
                        if nc.closed {
                            let per = hi - lo;
                            if same_vertex || dist(a, b) < 1e-9 * (1.0 + len(a)) { t1 = if down { t0 - per } else { t0 + per }; }
                            else if !down && t1 <= t0 { t1 += per } else if down && t1 >= t0 { t1 -= per }
                        } else if same_vertex { t0 = if down { hi } else { lo }; t1 = if down { lo } else { hi }; }
                        let spans = nc.knots.windows(2).filter(|w| w[1] > w[0] && w[1] > t0.min(t1) && w[0] < t0.max(t1)).count().max(1);
                        let k = (spans * (nc.deg.max(2)) * 4).clamp(8, 400);
                        let mut v: Vec<V3> = (0..=k).map(|i| nc.eval(t0 + (t1 - t0) * i as f64 / k as f64)).collect();
                        v[0] = a; v[k] = b;
                        // Spline ucu köşeden uzaksa (yanlış çözülmüş eğri) doğruya düş
                        let chord = dist(a, b).max(self.tol);
                        if dist(nc.eval(t0), a) > chord * 0.05 + self.tol * 4.0 || dist(nc.eval(t1), b) > chord * 0.05 + self.tol * 4.0 {
                            self.note(format!("edge curve '{}' does not meet its vertices — straight segment used", c.entity_type));
                            vec![a, b]
                        } else { simplify(&v, self.tol * 0.5) }
                    }
                    (_, Some(a), Some(b)) => {
                        self.note(format!("edge curve '{}' not decoded — straight segment used", c.entity_type));
                        vec![a, b]
                    }
                    _ => return Err("edge without vertices".into()),
                }
            }
        };
        if !pts.iter().all(|p| finite(*p)) { return Err("non-finite edge".into()); }
        self.edges.insert(ei, pts.clone());
        Ok(pts)
    }
}
/// Douglas–Peucker (uçlar korunur).
fn simplify(p: &[V3], tol: f64) -> Vec<V3> {
    if p.len() < 3 { return p.to_vec(); }
    let mut keep = vec![false; p.len()];
    keep[0] = true; keep[p.len() - 1] = true;
    let mut stack = vec![(0usize, p.len() - 1)];
    while let Some((i, j)) = stack.pop() {
        if j <= i + 1 { continue; }
        let (a, b) = (p[i], p[j]);
        let ab = sub(b, a);
        let l2 = dot(ab, ab);
        let (mut md, mut mk) = (-1.0, i);
        for k in i + 1..j {
            let d = if l2 < 1e-300 { dist(p[k], a) } else { let t = (dot(sub(p[k], a), ab) / l2).clamp(0.0, 1.0); dist(p[k], add(a, mul(ab, t))) };
            if d > md { md = d; mk = k; }
        }
        // Kapalı eğride (a ≈ b) en az bir ara nokta kalsın
        if md > tol || l2 < 1e-300 { keep[mk] = true; stack.push((i, mk)); stack.push((mk, j)); }
    }
    p.iter().zip(keep).filter(|(_, k)| *k).map(|(q, _)| *q).collect()
}

/* ───────────────────────────── Yüz üçgenleme ───────────────────────────── */
/// (u,v) halkası köşesi: `p` gerçek sınır noktası ise 3B konumu (komşu yüzle AYNI nokta), yapay ise None.
#[derive(Clone, Copy)]
struct RV { uv: [f64; 2], p: Option<V3>, real_next: bool }
struct UvLoop { pts: Vec<RV>, w: [i32; 2] }
struct Poly { outer: Vec<RV>, holes: Vec<Vec<RV>> }

fn area2(pts: &[RV], sc: (f64, f64)) -> f64 {
    let n = pts.len();
    (0..n).map(|i| { let (a, b) = (pts[i].uv, pts[(i + 1) % n].uv); (a[0] * b[1] - b[0] * a[1]) * sc.0 * sc.1 }).sum::<f64>() * 0.5
}
fn inside(q: [f64; 2], ring: &[RV]) -> bool {
    let n = ring.len();
    let mut c = false;
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (ring[i].uv, ring[j].uv);
        if (a[1] > q[1]) != (b[1] > q[1]) && q[0] < (b[0] - a[0]) * (q[1] - a[1]) / (b[1] - a[1]) + a[0] { c = !c; }
        j = i;
    }
    c
}
fn shifted(pts: &[RV], du: f64, dv: f64) -> Vec<RV> { pts.iter().map(|r| RV { uv: [r.uv[0] + du, r.uv[1] + dv], ..*r }).collect() }

/// 3B halkayı (u,v)'ye taşır: periyodik yönlerde süreklilik için açar, tekil noktaları (tepe / kutup) iki köşeye böler.
fn map_loop(surf: &Surf, ring: &[V3], tol: f64) -> Option<UvLoop> {
    let n = ring.len();
    let mut raw: Vec<(f64, f64, bool)> = Vec::with_capacity(n);
    let mut hint = None;
    for p in ring {
        let (u, v, s) = surf.invert(*p, hint, tol);
        if !u.is_finite() || !v.is_finite() { return None; }
        hint = Some((u, v));
        raw.push((u, v, s));
    }
    let start = raw.iter().position(|r| !r.2)?;   // tekil olmayan bir noktadan başla
    let (pu, pv) = (surf.period(0), surf.period(1));
    let mut pts: Vec<RV> = Vec::with_capacity(n + 2);
    let near = |x: f64, to: f64, per: Option<f64>| match per { Some(p) => x + p * ((to - x) / p).round(), None => x };
    for k in 0..n {
        let i = (start + k) % n;
        let (u, v, s) = raw[i];
        let prev = pts.last().map(|r: &RV| r.uv);
        if s {
            // Tekil nokta: u'yu önceki ve sonraki tekil-olmayan noktadan al → (u_önce, v) ve (u_sonra, v)
            let pu0 = prev.map(|q| q[0]).unwrap_or(u);
            let vv = prev.map(|q| near(v, q[1], pv)).unwrap_or(v);
            pts.push(RV { uv: [pu0, vv], p: Some(ring[i]), real_next: true });
            let mut j = (i + 1) % n;
            let mut guard = 0;
            while raw[j].2 && guard < n { j = (j + 1) % n; guard += 1; }
            let un = near(raw[j].0, pu0, pu);
            if (un - pu0).abs() > 1e-12 { pts.push(RV { uv: [un, vv], p: Some(ring[i]), real_next: true }); }
        } else {
            let (uu, vv) = match prev { Some(q) => (near(u, q[0], pu), near(v, q[1], pv)), None => (u, v) };
            pts.push(RV { uv: [uu, vv], p: Some(ring[i]), real_next: true });
        }
    }
    let (first, last) = (pts[0].uv, pts[pts.len() - 1].uv);
    let wind = |a: usize, per: Option<f64>| per.map(|p| { let close = first[a] + p * ((last[a] - first[a]) / p).round(); ((close - first[a]) / p).round() as i32 }).unwrap_or(0);
    Some(UvLoop { pts, w: [wind(0, pu), wind(1, pv)] })
}

/// `axis` yönünde tam tur atan halkayı `s` indeksinden başlatıp +axis yönünde n+1 nokta olarak döndürür (son = ilk + periyot).
fn rotated(l: &[RV], s: usize, axis: usize, per: f64) -> Vec<RV> {
    let n = l.len();
    let mut out = Vec::with_capacity(n + 1);
    for k in 0..=n {
        let i = (s + k) % n;
        let mut r = l[i];
        if s + k >= n { r.uv[axis] += per; }
        out.push(r);
    }
    out
}

enum Bound { Loop(usize), Natural(f64) }

/// Dolanan halkalardan bant çokgenleri kurar. `axis` = dolanma yönü (0 = u, 1 = v).
#[allow(clippy::too_many_arguments)]
fn build_bands(surf: &Surf, mut wl: Vec<UvLoop>, plain: Vec<UvLoop>, axis: usize, hsign: f64, sing: &[f64], notes: &mut Vec<String>) -> Result<Vec<Poly>, String> {
    let per = surf.period(axis).ok_or("winding loop on a non-periodic surface")?;
    let cross_ax = 1 - axis;
    let pb = surf.period(cross_ax);
    // Hepsi +axis yönünde dolaşsın; yüzün hangi yanda kaldığını not et (+1 → karşı koordinatın artan yanı)
    let mut side: Vec<f64> = Vec::new();
    for l in wl.iter_mut() {
        let w = l.w[axis];
        if w.abs() != 1 { return Err("loop winds more than once".into()); }
        if w < 0 { l.pts.reverse(); }
        side.push(hsign * w as f64 * if axis == 0 { 1.0 } else { -1.0 });
    }
    let mean = |l: &UvLoop| l.pts.iter().map(|r| r.uv[cross_ax]).sum::<f64>() / l.pts.len() as f64;
    let mut order: Vec<usize> = (0..wl.len()).collect();
    let bm: Vec<f64> = wl.iter().map(mean).collect();
    order.sort_by(|a, b| bm[*a].total_cmp(&bm[*b]));
    // (alt, üst, üst halkaya eklenecek karşı kaydırma)
    let mut pairs: Vec<(Bound, Bound, f64)> = Vec::new();
    if wl.len() == 2 && pb.is_none() {
        pairs.push((Bound::Loop(order[0]), Bound::Loop(order[1]), 0.0));
    } else if wl.len() == 1 && pb.is_none() {
        let b0 = bm[0];
        let (up, dn) = (surf.natural(axis, 1.0, b0), surf.natural(axis, -1.0, b0));
        let s = if let Some(sb) = sing.first() { (sb - b0).signum() } else {
            match (up, dn) { (Some(_), None) => 1.0, (None, Some(_)) => -1.0, (Some(_), Some(_)) => side[0], (None, None) => return Err("single winding loop on an unbounded surface".into()) }
        };
        let nat = sing.first().copied().or(if s > 0.0 { up } else { dn }).ok_or("no natural boundary on the face side")?;
        if s > 0.0 { pairs.push((Bound::Loop(0), Bound::Natural(nat), 0.0)); } else { pairs.push((Bound::Natural(nat), Bound::Loop(0), 0.0)); }
    } else {
        let k = order.len();
        let mut used = vec![false; k];
        for oi in 0..k {
            let i = order[oi];
            if used[oi] || side[i] <= 0.0 { continue; }
            used[oi] = true;
            // Üstündeki ilk halka üst sınır olmalı (karşı yön periyodikse sarılarak)
            let (nj, shift) = if oi + 1 < k { (Some(oi + 1), 0.0) } else if let (Some(p), true) = (pb, k > 1) { (Some(0), p) } else { (None, 0.0) };
            match nj {
                Some(oj) if !used[oj] && side[order[oj]] < 0.0 => { used[oj] = true; pairs.push((Bound::Loop(i), Bound::Loop(order[oj]), shift)); }
                _ => { let nat = surf.natural(axis, 1.0, bm[i]).ok_or("open band: no upper boundary")?; pairs.push((Bound::Loop(i), Bound::Natural(nat), 0.0)); }
            }
        }
        for oi in 0..k {
            if used[oi] { continue; }
            let i = order[oi];
            let nat = surf.natural(axis, -1.0, bm[i]).ok_or("open band: no lower boundary")?;
            pairs.push((Bound::Natural(nat), Bound::Loop(i), 0.0));
        }
    }
    let put = |a: f64, b: f64| if axis == 0 { [a, b] } else { [b, a] };
    let mut polys: Vec<Poly> = Vec::new();
    for (lo, hi, hi_shift) in &pairs {
        let base = match (lo, hi) { (Bound::Loop(i), _) => *i, (_, Bound::Loop(i)) => *i, _ => unreachable!() };
        let nb = wl[base].pts.len();
        // Dikiş yeri adayları: düz halkaları (delikleri) kesmeyen tercih edilir
        let cands: Vec<usize> = if plain.is_empty() { vec![0] } else { (0..8).map(|k| k * nb / 8).collect::<HashSet<_>>().into_iter().collect() };
        let mut best: Option<(usize, Poly)> = None;
        for s in cands {
            let base_seq = rotated(&wl[base].pts, s, axis, per);
            let a0 = base_seq[0].uv[axis];
            let other_seq = |idx: usize, extra: f64| -> Vec<RV> {
                let l = &wl[idx].pts;
                let t = (0..l.len()).min_by(|x, y| {
                    let f = |i: usize| { let d = l[i].uv[axis] - a0; (d - per * (d / per).round()).abs() };
                    f(*x).total_cmp(&f(*y))
                }).unwrap();
                let mut seq = rotated(l, t, axis, per);
                let k = ((a0 - seq[0].uv[axis]) / per).round() * per;
                for r in seq.iter_mut() { r.uv[axis] += k; r.uv[cross_ax] += extra; }
                seq
            };
            let natural_seq = |b: f64| -> Vec<RV> { base_seq.iter().map(|r| RV { uv: put(r.uv[axis], b), p: None, real_next: false }).collect() };
            let mut lower = match lo { Bound::Loop(i) => if *i == base { base_seq.clone() } else { other_seq(*i, 0.0) }, Bound::Natural(b) => natural_seq(*b) };
            let mut upper = match hi { Bound::Loop(i) => if *i == base { base_seq.clone() } else { other_seq(*i, *hi_shift) }, Bound::Natural(b) => natural_seq(*b) };
            // Karşı yön periyodikse üst halka altın ÜSTÜNDE olsun
            if let (Some(p), Bound::Loop(_), Bound::Loop(_)) = (pb, lo, hi) {
                let (ml, mu) = (lower.iter().map(|r| r.uv[cross_ax]).sum::<f64>() / lower.len() as f64, upper.iter().map(|r| r.uv[cross_ax]).sum::<f64>() / upper.len() as f64);
                if mu <= ml { for r in upper.iter_mut() { r.uv[cross_ax] += p * ((ml - mu) / p).floor() + p; } }
            }
            let (nl, nu) = (lower.len(), upper.len());
            lower[nl - 1].real_next = false;            // dikiş (yukarı)
            upper.reverse();
            for k in 0..nu - 1 { upper[k].real_next = matches!(hi, Bound::Loop(_)); }
            upper[nu - 1].real_next = false;            // dikiş (aşağı)
            if matches!(lo, Bound::Natural(_)) { for r in lower.iter_mut() { r.real_next = false; } }
            let mut outer = lower;
            outer.extend(upper);
            let mut poly = Poly { outer, holes: Vec::new() };
            let mut placed = 0usize;
            for h in &plain {
                'shift: for ka in [0.0, 1.0, -1.0, 2.0, -2.0] {
                    for kb in if pb.is_some() { vec![0.0, 1.0, -1.0] } else { vec![0.0] } {
                        let (da, db) = (ka * per, kb * pb.unwrap_or(0.0));
                        let hs = if axis == 0 { shifted(&h.pts, da, db) } else { shifted(&h.pts, db, da) };
                        if hs.iter().all(|r| inside(r.uv, &poly.outer)) { poly.holes.push(hs); placed += 1; break 'shift; }
                    }
                }
            }
            if best.as_ref().map(|b| placed > b.0).unwrap_or(true) { let done = placed == plain.len(); best = Some((placed, poly)); if done { break; } }
        }
        polys.push(best.unwrap().1);
    }
    let placed: usize = polys.iter().map(|p| p.holes.len()).sum();
    if placed < plain.len() { notes.push(format!("{} inner loop(s) could not be placed on a periodic face", plain.len() - placed)); }
    Ok(polys)
}

/// Dolanan halka yokken: dış sınır + delikler (periyodik yüzeyde halkalar birbirine göre kaydırılır).
fn build_plain(surf: &Surf, plain: Vec<UvLoop>, hsign: f64, sc: (f64, f64), tol: f64, notes: &mut Vec<String>) -> Result<Vec<Poly>, String> {
    let (pu, pv) = (surf.period(0), surf.period(1));
    let shifts = |f: &mut dyn FnMut(f64, f64) -> bool| {
        for ka in if pu.is_some() { vec![0.0, 1.0, -1.0, 2.0, -2.0] } else { vec![0.0] } {
            for kb in if pv.is_some() { vec![0.0, 1.0, -1.0, 2.0, -2.0] } else { vec![0.0] } {
                if f(ka * pu.unwrap_or(0.0), kb * pv.unwrap_or(0.0)) { return true; }
            }
        }
        false
    };
    let areas: Vec<f64> = plain.iter().map(|l| area2(&l.pts, sc)).collect();
    let closed = surf.closed_both();
    let mut outers: Vec<usize> = Vec::new();
    if closed { for (i, a) in areas.iter().enumerate() { if a * hsign > 0.0 { outers.push(i); } } }
    else if !plain.is_empty() { outers.push((0..plain.len()).max_by(|a, b| areas[*a].abs().total_cmp(&areas[*b].abs())).unwrap()); }
    let mut polys: Vec<Poly> = Vec::new();
    if outers.is_empty() {
        // Kapalı yüzeyin tamamı (eksi delikler): dikişi deliklerden uzak bir yere koy
        let dom = surf.full_domain().filter(|_| closed || plain.is_empty()).ok_or("face has no outer boundary")?;
        let mut best: Option<(usize, Poly)> = None;
        for k in 0..8 {
            let (u0, v0) = (dom[0] + (dom[1] - dom[0]) * k as f64 / 8.0, if pv.is_some() { dom[2] + (dom[3] - dom[2]) * k as f64 / 8.0 } else { dom[2] });
            let (u1, v1) = (u0 + (dom[1] - dom[0]), v0 + (dom[3] - dom[2]));
            let mut outer: Vec<RV> = Vec::new();
            let (gu, gv) = surf.grid_steps(tol);
            let (su, sv) = (gu.map(|g| (((u1 - u0) / g).ceil() as usize).clamp(1, 400)).unwrap_or(1), gv.map(|g| (((v1 - v0) / g).ceil() as usize).clamp(1, 400)).unwrap_or(1));
            let mut edge = |a: [f64; 2], b: [f64; 2], seg: usize| for i in 0..seg { let t = i as f64 / seg as f64; outer.push(RV { uv: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], p: None, real_next: false }); };
            edge([u0, v0], [u1, v0], su); edge([u1, v0], [u1, v1], sv); edge([u1, v1], [u0, v1], su); edge([u0, v1], [u0, v0], sv);
            let mut poly = Poly { outer, holes: Vec::new() };
            for h in &plain {
                shifts(&mut |du, dv| { let hs = shifted(&h.pts, du, dv); if hs.iter().all(|r| inside(r.uv, &poly.outer)) { poly.holes.push(hs); true } else { false } });
            }
            let placed = poly.holes.len();
            if best.as_ref().map(|b| placed > b.0).unwrap_or(true) { best = Some((placed, poly)); if placed == plain.len() { break; } }
            if plain.is_empty() { break; }
        }
        let (placed, poly) = best.unwrap();
        if placed < plain.len() { notes.push(format!("{} hole(s) cross the seam of a closed face", plain.len() - placed)); }
        polys.push(poly);
        return Ok(polys);
    }
    for &o in &outers { polys.push(Poly { outer: plain[o].pts.clone(), holes: Vec::new() }); }
    let mut lost = 0usize;
    for (i, h) in plain.iter().enumerate() {
        if outers.contains(&i) { continue; }
        let mut ok = false;
        for poly in polys.iter_mut() {
            if shifts(&mut |du, dv| { let hs = shifted(&h.pts, du, dv); if inside(hs[0].uv, &poly.outer) { poly.holes.push(hs); true } else { false } }) { ok = true; break; }
        }
        if !ok { lost += 1; }
    }
    if lost > 0 { notes.push(format!("{lost} inner loop(s) lie outside their face boundary")); }
    Ok(polys)
}

fn seg_dist2(q: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (q[0] - a[0] - dx * t).powi(2) + (q[1] - a[1] - dy * t).powi(2)
}
fn in_ring(q: [f64; 2], ring: &[[f64; 2]]) -> bool {
    let n = ring.len();
    let mut c = false;
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > q[1]) != (b[1] > q[1]) && q[0] < (b[0] - a[0]) * (q[1] - a[1]) / (b[1] - a[1]) + a[0] { c = !c; }
        j = i;
    }
    c
}
/// Kısıtlı Delaunay üçgenleme: `rings[0]` dış sınır, diğerleri delik. Dönüş: halkaların ardışık köşe sırasına göre indeks üçlüleri.
/// earcut KULLANILMAZ: doğrusal köşeleri atar; (u,v)'de silindir çemberleri düz çizgidir → komşu yüzle ortak noktalar kaybolur (çatlak).
fn triangulate(rings: &[Vec<[f64; 2]>], extra: &[[f64; 2]]) -> Result<Vec<[usize; 3]>, String> {
    use spade::{ConstrainedDelaunayTriangulation, Point2, Triangulation};
    let mut cdt = ConstrainedDelaunayTriangulation::<Point2<f64>>::new();
    let mut handles = Vec::new();
    let mut first_of: HashMap<usize, usize> = HashMap::new();   // spade köşe indeksi → ilk global indeks
    for ring in rings {
        for q in ring {
            // spade çok küçük (≈1e-43 altı) sıfır-olmayan değerleri reddeder: gürültüyü sıfıra yuvarla
            let z = |x: f64| if x.abs() < 1e-30 { 0.0 } else { x };
            let h = cdt.insert(Point2::new(z(q[0]), z(q[1]))).map_err(|e| format!("triangulation: {e:?}"))?;
            first_of.entry(h.index()).or_insert(handles.len());
            handles.push(h);
        }
    }
    for q in extra {
        let h = cdt.insert(Point2::new(q[0], q[1])).map_err(|e| format!("triangulation: {e:?}"))?;
        first_of.entry(h.index()).or_insert(handles.len());
        handles.push(h);
    }
    let mut base = 0usize;
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            let (a, b) = (handles[base + i], handles[base + (i + 1) % n]);
            if a != b && cdt.can_add_constraint(a, b) { cdt.add_constraint(a, b); }
        }
        base += n;
    }
    let mut out = Vec::new();
    for f in cdt.inner_faces() {
        let v = f.vertices();
        let c = [(v[0].position().x + v[1].position().x + v[2].position().x) / 3.0, (v[0].position().y + v[1].position().y + v[2].position().y) / 3.0];
        if !in_ring(c, &rings[0]) || rings[1..].iter().any(|h| in_ring(c, h)) { continue; }
        out.push([first_of[&v[0].fix().index()], first_of[&v[1].fix().index()], first_of[&v[2].fix().index()]]);
    }
    Ok(out)
}

/// Aynı u ya da v'de olması gereken köşeleri (çember = (u,v)'de düz çizgi) TAM eşitler: 1e-15'lik gürültü çizgiyi
/// kırık gösterir, üçgenleyici de üç ardışık sınır noktasından iğne üçgen üretir (3B'de gerçek alanı olan yanlış üçgen).
fn snap_axes(rings: &mut [Vec<[f64; 2]>]) {
    for ax in 0..2 {
        let mut vals: Vec<f64> = rings.iter().flatten().map(|q| q[ax]).collect();
        if vals.is_empty() { continue; }
        vals.sort_by(|a, b| a.total_cmp(b));
        let eps = (vals[vals.len() - 1] - vals[0]).abs().max(1e-300) * 1e-9;
        let mut reps: Vec<f64> = Vec::new();
        for v in &vals { if reps.last().map(|r| v - r > eps).unwrap_or(true) { reps.push(*v); } }
        for q in rings.iter_mut().flatten() {
            let i = reps.partition_point(|r| *r <= q[ax]).saturating_sub(1);
            q[ax] = reps[i];
        }
    }
}
/// (u,v)'de alanı sıfıra yakın (üç köşesi doğrusal) üçgenleri, uzun kenarını komşusuyla çevirerek giderir.
fn fix_slivers(tris: &mut Vec<[usize; 3]>, pts: &[[f64; 2]]) {
    let d2 = |a: usize, b: usize| (pts[a][0] - pts[b][0]).powi(2) + (pts[a][1] - pts[b][1]).powi(2);
    for _ in 0..8 {
        let mut changed = false;
        let mut i = 0;
        while i < tris.len() {
            let t = tris[i];
            let area = ((pts[t[1]][0] - pts[t[0]][0]) * (pts[t[2]][1] - pts[t[0]][1]) - (pts[t[2]][0] - pts[t[0]][0]) * (pts[t[1]][1] - pts[t[0]][1])).abs();
            let k = (0..3).max_by(|x, y| d2(t[*x], t[(*x + 1) % 3]).total_cmp(&d2(t[*y], t[(*y + 1) % 3]))).unwrap();
            let (a, c, b) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);   // a–c uzun kenar, b ortada
            if area > 1e-10 * d2(a, c) { i += 1; continue; }
            let nb = (0..tris.len()).find(|j| *j != i && tris[*j].contains(&a) && tris[*j].contains(&c));
            match nb {
                Some(j) => {
                    let q = *tris[j].iter().find(|v| **v != a && **v != c).unwrap();
                    tris[i] = [a, b, q];
                    tris[j] = [b, c, q];
                }
                None => { tris.swap_remove(i); }
            }
            changed = true;
            i += 1;
        }
        if !changed { break; }
    }
}

/// Çokgeni (u,v)'de üçgenler, eğri yüzeyde kenar-tabanlı inceltir, 3B üçgen döndürür.
fn tess_poly(surf: &Surf, poly: &Poly, sc: (f64, f64), tol: f64, face_rev: bool, out: &mut Vec<[V3; 3]>) -> Result<(), String> {
    let mut uv: Vec<[f64; 2]> = Vec::new();
    let mut p3: Vec<V3> = Vec::new();
    let mut scaled: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut fixed: HashSet<(usize, usize)> = HashSet::new();
    if poly.outer.len() < 3 { return Err("degenerate boundary".into()); }
    for ring in std::iter::once(&poly.outer).chain(poly.holes.iter().filter(|h| h.len() >= 3)) {
        let base = uv.len();
        let n = ring.len();
        let mut sr = Vec::with_capacity(n);
        for (i, r) in ring.iter().enumerate() {
            uv.push(r.uv);
            p3.push(r.p.unwrap_or_else(|| surf.eval(r.uv[0], r.uv[1])));
            sr.push([r.uv[0] * sc.0, r.uv[1] * sc.1]);
            if r.real_next { let (a, b) = (base + i, base + (i + 1) % n); fixed.insert((a.min(b), a.max(b))); }
        }
        scaled.push(sr);
    }
    snap_axes(&mut scaled);
    // İç ızgara noktaları (eğri yönlerde): sınıra çok yakın olanlar atılır
    let mut extra: Vec<[f64; 2]> = Vec::new();
    let (gu, gv) = surf.grid_steps(tol);
    if gu.is_some() || gv.is_some() {
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for q in scaled[0].iter() { for k in 0..2 { lo[k] = lo[k].min(q[k]); hi[k] = hi[k].max(q[k]); } }
        let cells = |ax: usize, g: Option<f64>| -> usize { match g { Some(st) => (((hi[ax] - lo[ax]) / (st * if ax == 0 { sc.0 } else { sc.1 })).ceil() as usize).clamp(1, 400), None => 1 } };
        let (nu, nv) = (cells(0, gu), cells(1, gv));
        if nu * nv <= 60_000 {
            let (du, dv) = ((hi[0] - lo[0]) / nu as f64, (hi[1] - lo[1]) / nv as f64);
            // Bir yönde ızgara yoksa o yönde tek sıra (ortada) yerine hiç nokta koyma: yalnız sınır yeter
            let us: Vec<f64> = if gu.is_some() { (1..nu).map(|i| lo[0] + du * i as f64).collect() } else { Vec::new() };
            let vs: Vec<f64> = if gv.is_some() { (1..nv).map(|j| lo[1] + dv * j as f64).collect() } else { Vec::new() };
            let us = if us.is_empty() && !vs.is_empty() { (0..=nu.max(1)).map(|i| lo[0] + (hi[0] - lo[0]) * i as f64 / nu.max(1) as f64).collect() } else { us };
            let vs = if vs.is_empty() && !us.is_empty() && gv.is_none() { (0..=1).map(|j| lo[1] + (hi[1] - lo[1]) * j as f64).collect::<Vec<_>>() } else { vs };
            let near2 = (du.min(dv) * 0.35).powi(2).max(1e-300);
            for u in &us { for v in &vs {
                let q = [*u, *v];
                if !in_ring(q, &scaled[0]) || scaled[1..].iter().any(|h| in_ring(q, h)) { continue; }
                if scaled.iter().any(|r| { let n = r.len(); (0..n).any(|i| seg_dist2(q, r[i], r[(i + 1) % n]) < near2) }) { continue; }
                extra.push(q);
            } }
        }
    }
    for q in &extra { let w = [q[0] / sc.0, q[1] / sc.1]; uv.push(w); p3.push(surf.eval(w[0], w[1])); }
    let flat: Vec<[f64; 2]> = scaled.iter().flatten().copied().chain(extra.iter().copied()).collect();
    let mut tris = triangulate(&scaled, &extra)?;
    fix_slivers(&mut tris, &flat);
    if tris.is_empty() { return Err("triangulation produced no triangles".into()); }
    // TEKİL köşeler (tepe / kutup): (u,v)'de ayrı noktalar ama 3B'de TEK nokta. Hepsi tek temsilciye bağlanır; yoksa aynı
    // 3B kenar (X → kutup) her kopya için ayrı bölünür ve dikiş üzerinde üst üste binen üçgenler oluşur.
    let mut canon: Vec<usize> = (0..uv.len()).collect();
    let mut poles: Vec<(f64, usize)> = Vec::new();
    for i in 0..uv.len() {
        if !surf.singular(uv[i], tol) { continue; }
        match poles.iter().find(|(v, _)| (v - uv[i][1]).abs() < 1e-9 * (1.0 + v.abs())) {
            Some((_, rep)) => canon[i] = *rep,
            None => poles.push((uv[i][1], i)),
        }
    }
    if !poles.is_empty() {
        for t in tris.iter_mut() { for k in 0..3 { t[k] = canon[t[k]]; } }
        tris.retain(|t| t[0] != t[1] && t[1] != t[2] && t[0] != t[2]);
    }
    if !matches!(surf, Surf::Plane { .. }) {
        // Eşik 2.2·tol: ızgara hücresinin KÖŞEGENİ kenarının ~2 katı sapar; daha sıkı eşik her hücreyi boşuna böler.
        // Kenar-tabanlı inceltme: karar yalnız kenara bağlı → komşu üçgenler aynı bölünür (yüz içinde çatlak olmaz)
        let (r_lo, r_hi) = ((STEP_MIN / 4.0).tan() * 0.5, (STEP_MAX * 1.2 / 4.0).tan() * 0.5);
        for _pass in 0..7 {
            let mut split: HashMap<(usize, usize), Option<usize>> = HashMap::new();
            let mut any = false;
            for t in &tris {
                for k in 0..3 {
                    let (a, b) = (t[k], t[(k + 1) % 3]);
                    let key = (a.min(b), a.max(b));
                    if split.contains_key(&key) { continue; }
                    let mut res = None;
                    if !fixed.contains(&key) {
                        // Tekil uçta (tepe / kutup) u anlamsız: orta nokta karşı ucun u'sunda alınır → kenar meridyen / doğrultman olur
                        let (sa, sb) = (surf.singular(uv[a], tol), surf.singular(uv[b], tol));
                        let mu = if sa && !sb { uv[b][0] } else if sb && !sa { uv[a][0] } else { (uv[a][0] + uv[b][0]) * 0.5 };
                        let m = [mu, (uv[a][1] + uv[b][1]) * 0.5];
                        let pm = surf.eval(m[0], m[1]);
                        let sag = dist(pm, mid(p3[a], p3[b]));
                        // Kiriş uzunluğu yerine (u,v) orta noktasına giden yol: dikiş kenarlarında uçlar 3B'de çakışabilir
                        let l = dist(p3[a], pm) + dist(pm, p3[b]);
                        if sag > l * r_lo && (sag > tol * 2.2 || sag > l * r_hi) && finite(pm) {
                            uv.push(m); p3.push(pm);
                            res = Some(uv.len() - 1);
                            any = true;
                        }
                    }
                    split.insert(key, res);
                }
            }
            if !any { break; }
            let mut next: Vec<[usize; 3]> = Vec::with_capacity(tris.len() * 2);
            for t in &tris {
                let m: Vec<Option<usize>> = (0..3).map(|k| { let (a, b) = (t[k], t[(k + 1) % 3]); split[&(a.min(b), a.max(b))] }).collect();
                match (m[0], m[1], m[2]) {
                    (None, None, None) => next.push(*t),
                    (Some(a), Some(b), Some(c)) => { next.push([t[0], a, c]); next.push([a, t[1], b]); next.push([c, b, t[2]]); next.push([a, b, c]); }
                    _ => {
                        // Tek veya iki kenar bölünmüş: köşeleri döndürerek tek kalıba indir
                        let cnt = m.iter().filter(|x| x.is_some()).count();
                        if cnt == 1 {
                            let k = m.iter().position(|x| x.is_some()).unwrap();
                            let (a, b, c, mm) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3], m[k].unwrap());
                            next.push([a, mm, c]); next.push([mm, b, c]);
                        } else {
                            let k = m.iter().position(|x| x.is_none()).unwrap();   // bölünmeyen kenar: a → b
                            let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                            let (mbc, mca) = (m[(k + 1) % 3].unwrap(), m[(k + 2) % 3].unwrap());
                            next.push([c, mca, mbc]);
                            if dist(p3[a], p3[mbc]) < dist(p3[b], p3[mca]) { next.push([a, b, mbc]); next.push([a, mbc, mca]); }
                            else { next.push([a, b, mca]); next.push([b, mbc, mca]); }
                        }
                    }
                }
            }
            tris = next;
            if tris.len() > 400_000 { break; }
        }
    }
    let fs = if face_rev { -1.0 } else { 1.0 };
    for t in &tris {
        let (a, b, c) = (p3[t[0]], p3[t[1]], p3[t[2]]);
        let nrm = cross(sub(b, a), sub(c, a));
        let l = len(nrm);
        if !(l > 1e-14 * (1.0 + dist(a, b) * dist(a, c))) || !finite(nrm) { continue; }   // dejenere (kutup / dikiş)
        // Ağırlık merkezi: tekil köşelerin (tepe / kutup) u'su sayılmaz
        let us: Vec<f64> = t.iter().filter(|i| !surf.singular(uv[**i], tol)).map(|i| uv[*i][0]).collect();
        let cu0 = if us.is_empty() { uv[t[0]][0] } else { us.iter().sum::<f64>() / us.len() as f64 };
        let cu = [cu0, (uv[t[0]][1] + uv[t[1]][1] + uv[t[2]][1]) / 3.0];
        let want = mul(surf.normal(cu[0], cu[1]), fs);
        if dot(nrm, want) < 0.0 { out.push([a, c, b]); } else { out.push([a, b, c]); }
    }
    Ok(())
}

struct FaceOut { tris: Vec<[V3; 3]>, approx: bool, why: Option<String> }
/// Yüz çift taraflı mı (levha / yüzey gövdesi): iki yüzü de çizilsin diye üçgenler iki yönde yazılır.
fn double_sided(f: &SatRecord) -> bool { f.tokens.iter().any(|t| t.as_ident() == Some("double")) }

/// Bir ACIS yüzünü üçgenler. Çözülemezse sınırından düzlemsel yama (approx).
fn tess_face(cx: &mut Ctx, f: &SatRecord) -> FaceOut {
    // Halkalar (3B)
    let fp = ptrs(f);
    let mut rings: Vec<Vec<V3>> = Vec::new();
    let mut sing_pts: Vec<V3> = Vec::new();
    let mut li = fp.get(2).copied().unwrap_or(-1);
    let mut guard = 0;
    while let Some(l) = rec(cx.d, li) {
        guard += 1;
        if guard > 100_000 { break; }
        match loop_polyline(cx, ptr(l, 2)) {
            Ok(r) if r.len() >= 3 => rings.push(r),
            Ok(r) if r.len() == 1 => sing_pts.push(r[0]),
            Ok(_) => {}
            Err(e) => return FaceOut { tris: Vec::new(), approx: true, why: Some(e) },
        }
        li = ptr(l, 1);
    }
    let face_rev = reversed_after_ptr(f, 5);
    if debug() && std::env::var("D2S_FACE").ok().and_then(|v| v.parse::<i32>().ok()) == Some(f.index) {
        for r in &rings { eprintln!("    ring {} pts: {}", r.len(), r.iter().map(|p| format!("({:.3} {:.3} {:.3})", p[0], p[1], p[2])).collect::<Vec<_>>().join(" ")); }
    }
    let res = (|| -> Result<Vec<[V3; 3]>, String> {
        let sr = rec(cx.d, fp.get(5).copied().unwrap_or(-1)).ok_or("face without surface")?;
        let probe: Vec<V3> = rings.iter().flat_map(|r| r.iter().step_by((r.len() / 6).max(1)).copied()).take(24).collect();
        let surf = make_surface(cx.d, sr, &probe)?;
        let hsign = match &surf {
            Surf::Plane { .. } => 1.0,
            Surf::Cone { nsign, .. } | Surf::Sphere { nsign, .. } | Surf::Torus { nsign, .. } | Surf::Nurbs { nsign, .. } => *nsign,
        } * if face_rev { -1.0 } else { 1.0 };
        let mut loops: Vec<UvLoop> = Vec::new();
        let mut worst = 0.0f64;
        for r in &rings {
            let l = map_loop(&surf, r, cx.tol).ok_or("boundary could not be mapped onto the surface")?;
            for q in &l.pts { if let Some(p) = q.p { worst = worst.max(dist(surf.eval(q.uv[0], q.uv[1]), p)); } }
            loops.push(l);
        }
        if worst > cx.tol * 25.0 { return Err(format!("boundary is off its surface by {worst:.3}")); }
        // Yarıçap ipucu (koni u ölçeği): sınır noktalarının eksene uzaklığı
        let r_hint = match &surf {
            Surf::Cone { c, a, .. } => rings.iter().flatten().map(|p| { let d = sub(*p, *c); len(sub(d, mul(*a, dot(d, *a)))) }).fold(0.0f64, f64::max),
            _ => 1.0,
        };
        let sc = surf.uv_scale(r_hint);
        let sing: Vec<[f64; 2]> = sing_pts.iter().map(|p| { let (u, v, _) = surf.invert(*p, None, cx.tol); [u, v] }).collect();
        let (mut wu, mut wv, mut plain) = (Vec::new(), Vec::new(), Vec::new());
        for l in loops {
            match (l.w[0] != 0, l.w[1] != 0) { (false, false) => plain.push(l), (true, false) => wu.push(l), (false, true) => wv.push(l), _ => return Err("loop winds in both directions".into()) }
        }
        let mut notes = Vec::new();
        let polys = if !wu.is_empty() && !wv.is_empty() { return Err("loops wind in different directions".into()) }
            else if !wu.is_empty() { build_bands(&surf, wu, plain, 0, hsign, &sing.iter().map(|s| s[1]).collect::<Vec<_>>(), &mut notes)? }
            else if !wv.is_empty() { build_bands(&surf, wv, plain, 1, hsign, &sing.iter().map(|s| s[0]).collect::<Vec<_>>(), &mut notes)? }
            else { build_plain(&surf, plain, hsign, sc, cx.tol, &mut notes)? };
        for n in notes { cx.note(n); }
        if debug() && std::env::var("D2S_FACE").ok().and_then(|v| v.parse::<i32>().ok()) == Some(f.index) {
            for (k, p) in polys.iter().enumerate() {
                eprintln!("    poly {k}: outer {} pts, {} holes, hsign {hsign}", p.outer.len(), p.holes.len());
                for r in &p.outer { eprintln!("      {:.5} {:.5} {}", r.uv[0], r.uv[1], if r.real_next { "real" } else { "seam" }); }
                for h in &p.holes { eprintln!("      hole {} pts: {:?}", h.len(), h.iter().map(|r| (format!("{:.3}", r.uv[0]), format!("{:.3}", r.uv[1]))).collect::<Vec<_>>()); }
            }
        }
        let mut out = Vec::new();
        for p in &polys { tess_poly(&surf, p, sc, cx.tol, face_rev, &mut out)?; }
        if out.is_empty() { return Err("no triangles".into()); }
        Ok(out)
    })();
    match res {
        Ok(tris) => FaceOut { tris, approx: false, why: None },
        Err(e) => {
            // Yedek: sınırı en uygun düzlemde kapat (delik bırakmaktan iyidir)
            let mut tris = Vec::new();
            patch_planar(&rings, &mut tris);
            FaceOut { tris, approx: true, why: Some(e) }
        }
    }
}

/// Bir halkanın coedge'lerini dolaşıp kapalı 3B çoklu doğru verir (son nokta tekrarlanmaz).
fn loop_polyline(cx: &mut Ctx, first: i32) -> Result<Vec<V3>, String> {
    let mut segs: Vec<Vec<V3>> = Vec::new();
    let mut ci = first;
    let mut guard = 0;
    while let Some(c) = rec(cx.d, ci) {
        guard += 1;
        if guard > 200_000 { return Err("runaway loop".into()); }
        let cp = ptrs(c);
        if cp.len() < 5 { return Err("short coedge record".into()); }
        let mut pl = cx.edge_polyline(cp[4])?;
        if reversed_after_ptr(c, 4) { pl.reverse(); }
        segs.push(pl);
        ci = cp[1];
        if ci == first || ci < 0 { break; }
    }
    let n = segs.len();
    if n == 0 { return Ok(Vec::new()); }
    // Yön bayrağı okunamadıysa süreklilikten düzelt
    let eps = cx.tol * 1e-3;
    if n >= 3 {
        let (f, s) = (&segs[0], &segs[1]);
        let d_keep = dist(*f.last().unwrap(), s[0]).min(dist(*f.last().unwrap(), *s.last().unwrap()));
        let d_flip = dist(f[0], s[0]).min(dist(f[0], *s.last().unwrap()));
        if d_flip + eps < d_keep { segs[0].reverse(); }
    }
    for k in 1..n {
        let end = *segs[k - 1].last().unwrap();
        if dist(end, *segs[k].last().unwrap()) + eps < dist(end, segs[k][0]) { segs[k].reverse(); }
    }
    let mut ring: Vec<V3> = Vec::new();
    for s in &segs {
        let m = if s.len() > 1 { s.len() - 1 } else { 1 };
        for p in &s[..m] { if ring.last().map(|q| dist(*q, *p) > 0.0).unwrap_or(true) { ring.push(*p); } }
    }
    while ring.len() > 1 && dist(ring[0], *ring.last().unwrap()) == 0.0 { ring.pop(); }
    Ok(ring)
}

/// Halkaları en uygun düzleme izdüşürüp üçgenler.
fn patch_planar(rings: &[Vec<V3>], out: &mut Vec<[V3; 3]>) {
    let Some(big) = rings.iter().max_by_key(|r| r.len()) else { return };
    if big.len() < 3 { return; }
    let c = mul(big.iter().fold([0.0; 3], |a, p| add(a, *p)), 1.0 / big.len() as f64);
    let mut n = [0.0; 3];
    for i in 0..big.len() { n = add(n, cross(sub(big[i], c), sub(big[(i + 1) % big.len()], c))); }
    if len(n) < 1e-300 { return; }
    let n = unit(n);
    let x = any_perp(n);
    let y = cross(n, x);
    let mut pts = Vec::new();
    let mut flat: Vec<Vec<[f64; 2]>> = Vec::new();
    for r in std::iter::once(big).chain(rings.iter().filter(|r| !std::ptr::eq(*r, big))) {
        if r.len() < 3 { continue; }
        flat.push(r.iter().map(|p| { let d = sub(*p, c); [dot(d, x), dot(d, y)] }).collect());
        pts.extend(r.iter().copied());
    }
    if let Ok(idx) = triangulate(&flat, &[]) { for t in idx { out.push([pts[t[0]], pts[t[1]], pts[t[2]]]); } }
}

/* ───────────────────────────── Gövde ───────────────────────────── */
fn debug() -> bool { std::env::var("D2S_DEBUG").is_ok() }
#[derive(Default, Debug, Clone)]
pub struct Report {
    /// $INSUNITS (0 birimsiz, 1 inç, 4 mm, 5 cm, 6 m …).
    pub units: i32,
    pub solids: usize,
    pub faces: usize,
    /// Tam çözülemeyip sınırından yamalanan yüz sayısı.
    pub approx_faces: usize,
    pub meshes: usize,
    pub triangles: usize,
    pub notes: Vec<String>,
}

/// ACIS gövdesinin dönüşümü: world = scale·(p·M) + T (satır vektörü).
fn body_xf(d: &SatDocument) -> Xf {
    let (m, t, s) = d.placement();
    let x = Xf { m: [mul(m[0], s), mul(m[1], s), mul(m[2], s)], t };
    if x.is_finite() { x } else { Xf::id() }
}

/// Bir ACIS belgesindeki tüm yüzleri üçgenler; yönleri komşuluktan tutarlı kılar. Dönüş: gövde-yerel üçgenler.
/// `min_tol` (gövde-yerel birim): çizimin TAMAMINA göre alt sınır — büyük bir montajdaki küçük parça (vida başı vb.) kendi
/// boyuna göre aşırı ince üçgenlenmesin.
pub fn tess_acis(d: &SatDocument, opt: &Options, rep: &mut Report, sheet: bool, min_tol: f64) -> Vec<[V3; 3]> {
    // Model ölçeği: nokta kayıtlarının kutusu
    let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
    for r in &d.records {
        if is_type(r, "point") { let n = nums(r); if n.len() >= 3 { for k in 0..3 { if n[k].is_finite() { lo[k] = lo[k].min(n[k]); hi[k] = hi[k].max(n[k]); } } } }
    }
    let mut diag = if lo[0] <= hi[0] { dist(lo, hi) } else { 0.0 };
    // Köşesiz gövde (tam küre / torus): ölçek yüzey yarıçapından
    for r in &d.records {
        let n = nums(r);
        if is_type(r, "sphere-surface") && n.len() >= 4 { diag = diag.max(n[3].abs() * 3.4); }
        if is_type(r, "torus-surface") && n.len() >= 8 { diag = diag.max((n[6].abs() + n[7].abs()) * 2.8); }
    }
    let diag = if diag > 1e-9 { diag } else { 100.0 };
    let mut cx = Ctx { d, tol: (diag * opt.chord_rel).max(min_tol), edges: HashMap::new(), notes: Vec::new() };
    let mut faces: Vec<Vec<[V3; 3]>> = Vec::new();
    let mut both: Vec<bool> = Vec::new();
    for r in &d.records {
        if !is_type(r, "face") { continue; }
        let fo = tess_face(&mut cx, r);
        rep.faces += 1;
        if debug() {
            let (_, _, _, open, bad) = mesh_stats(&fo.tris);
            let st = rec(d, ptr(r, 5)).map(|s| s.entity_type.clone()).unwrap_or_default();
            eprintln!("  face #{} {} rev={} tris={} boundary_edges={} bad={} approx={} {}", r.index, st, reversed_after_ptr(r, 5), fo.tris.len(), open, bad, fo.approx, fo.why.clone().unwrap_or_default());
        }
        if fo.approx {
            rep.approx_faces += 1;
            if let Some(w) = fo.why { cx.note(format!("face patched: {w}")); }
        }
        if !fo.tris.is_empty() { faces.push(fo.tris); both.push(double_sided(r)); }
    }
    for n in cx.notes.drain(..) { if rep.notes.len() < 40 && !rep.notes.contains(&n) { rep.notes.push(n); } }
    orient_faces(&mut faces, diag);
    let mut out: Vec<[V3; 3]> = Vec::new();
    for (f, b) in faces.into_iter().zip(both) {
        if b && !sheet { out.extend(f.iter().map(|t| [t[0], t[2], t[1]])); }
        out.extend(f);
    }
    out
}

/// Yüz yönlerini paylaşılan kenarlardan yayarak tutarlı kılar; bileşen yönünü alan-ağırlıklı çoğunluk (ACIS kuralı) belirler.
fn orient_faces(faces: &mut [Vec<[V3; 3]>], diag: f64) {
    let q = (diag * 1e-7).max(1e-12);
    let mut ids: HashMap<[i64; 3], u32> = HashMap::new();
    let mut vid = |p: V3| -> u32 { let k = [(p[0] / q).round() as i64, (p[1] / q).round() as i64, (p[2] / q).round() as i64]; let n = ids.len() as u32; *ids.entry(k).or_insert(n) };
    // yönsüz kenar → (yüz, yön) listesi
    let mut edges: HashMap<(u32, u32), Vec<(usize, bool)>> = HashMap::new();
    let mut area = vec![0.0f64; faces.len()];
    for (fi, f) in faces.iter().enumerate() {
        for t in f {
            let v = [vid(t[0]), vid(t[1]), vid(t[2])];
            area[fi] += len(cross(sub(t[1], t[0]), sub(t[2], t[0])));
            for k in 0..3 { let (a, b) = (v[k], v[(k + 1) % 3]); if a != b { edges.entry((a.min(b), a.max(b))).or_default().push((fi, a < b)); } }
        }
    }
    // Komşuluk: iki FARKLI yüzün paylaştığı kenar; aynı yönde geçiyorlarsa biri ters
    let mut adj: Vec<Vec<(usize, bool)>> = vec![Vec::new(); faces.len()];
    for uses in edges.values() {
        if uses.len() != 2 || uses[0].0 == uses[1].0 { continue; }
        let flip = uses[0].1 == uses[1].1;
        adj[uses[0].0].push((uses[1].0, flip));
        adj[uses[1].0].push((uses[0].0, flip));
    }
    let mut state: Vec<Option<bool>> = vec![None; faces.len()];
    for s in 0..faces.len() {
        if state[s].is_some() { continue; }
        state[s] = Some(false);
        let mut comp = vec![s];
        let mut stack = vec![s];
        while let Some(i) = stack.pop() {
            let fi = state[i].unwrap();
            for &(j, flip) in &adj[i] {
                if state[j].is_none() { state[j] = Some(fi ^ flip); comp.push(j); stack.push(j); }
            }
        }
        // Çoğunluk ters çıktıysa bileşeni çevir (azınlık = yönü yanlış okunan yüzler)
        let (flipped, total): (f64, f64) = comp.iter().fold((0.0, 0.0), |a, &i| (a.0 + if state[i].unwrap() { area[i] } else { 0.0 }, a.1 + area[i]));
        if flipped > total * 0.5 { for &i in &comp { state[i] = Some(!state[i].unwrap()); } }
    }
    for (fi, f) in faces.iter_mut().enumerate() { if state[fi] == Some(true) { for t in f.iter_mut() { t.swap(1, 2); } } }
}

/* ───────────────────────────── Belge ───────────────────────────── */
/// İki geçiş: önce varlıklar toplanır (ACIS gövdeleri ayrıştırılır, ağlar doğrudan yazılır), çizimin toplam kutusu bulunur;
/// sonra gövdeler üçgenlenir. Toplam kutu, küçük parçaların alt tolerans sınırını verir.
struct Collector<'a> { doc: &'a CadDocument, opt: Options, rep: Report, tris: Vec<[V3; 3]>, jobs: Vec<(Xf, SatDocument, bool)> }
impl<'a> Collector<'a> {
    fn push(&mut self, xf: &Xf, t: [V3; 3]) {
        let (a, b, c) = (xf.apply(t[0]), xf.apply(t[1]), xf.apply(t[2]));
        if !(finite(a) && finite(b) && finite(c)) { return; }
        if xf.det() < 0.0 { self.tris.push([a, c, b]); } else { self.tris.push([a, b, c]); }
    }
    fn acis(&mut self, xf: &Xf, data: &AcisData, sheet: bool) {
        let Some(d) = data.parse() else { self.note("a solid has no readable ACIS data".into()); return };
        let x = xf.then(&body_xf(&d));
        self.jobs.push((x, d, sheet));
    }
    /// Toplanan gövdeleri üçgenler.
    fn run_jobs(&mut self) {
        // Çizimin kutusu: gövde köşe noktaları (dönüşümlü) + doğrudan yazılmış ağ üçgenleri
        let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
        let mut grow = |p: V3| if finite(p) { for k in 0..3 { lo[k] = lo[k].min(p[k]); hi[k] = hi[k].max(p[k]); } };
        for t in &self.tris { for p in t { grow(*p); } }
        for (x, d, _) in &self.jobs {
            for r in &d.records { if is_type(r, "point") { let n = nums(r); if n.len() >= 3 { grow(x.apply(v3(&n, 0))); } } }
        }
        let world = if lo[0] <= hi[0] { dist(lo, hi) } else { 0.0 };
        let jobs = std::mem::take(&mut self.jobs);
        for (k, (x, d, sheet)) in jobs.into_iter().enumerate() {
            if debug() {
                eprintln!("solid {k}");
                if let Some(want) = std::env::var("D2S_SOLID").ok().and_then(|v| v.parse::<usize>().ok()) {
                    if want != k { continue; }
                    if let Ok(path) = std::env::var("D2S_DUMP") { std::fs::write(path, d.to_sat_string()).ok(); }
                }
            }
            // Dünya toleransının dörtte biri, gövdenin yerel birimine çevrilmiş (ölçek = det^(1/3))
            let min_tol = world * self.opt.chord_rel * 0.25 / x.det().abs().cbrt().max(1e-12);
            let local = tess_acis(&d, &self.opt, &mut self.rep, sheet, min_tol);
            if debug() { let (lo, hi, vol, open, bad) = mesh_stats(&local); eprintln!("  => tris={} box {:.2?}..{:.2?} vol={:.3} open={} bad={}", local.len(), lo, hi, vol, open, bad); }
            if local.is_empty() { continue; }
            self.rep.solids += 1;
            // Yüzey varlığı (açık levha): tek taraflı kayıtlı olsa da iki yüzü de çizilsin
            for t in local { if sheet { self.push(&x, [t[0], t[2], t[1]]); } self.push(&x, t); }
        }
    }
    fn note(&mut self, s: String) { if self.rep.notes.len() < 40 && !self.rep.notes.contains(&s) { self.rep.notes.push(s); } }
    fn poly(&mut self, xf: &Xf, pts: &[V3]) {
        if pts.len() < 3 { return; }
        for i in 1..pts.len() - 1 {
            let t = [pts[0], pts[i], pts[i + 1]];
            // Ağ varlıklarında (3DFACE / POLYFACE …) sarım yönü güvenilmez: iki yüz de yazılır
            if len(cross(sub(t[1], t[0]), sub(t[2], t[0]))) > 0.0 { self.push(xf, t); self.push(xf, [t[0], t[2], t[1]]); }
        }
    }
    fn entity(&mut self, xf: &Xf, e: &EntityType, depth: usize) {
        if e.common().invisible { return; }
        let p = |v: acadrust::types::Vector3| -> V3 { [v.x, v.y, v.z] };
        match e {
            EntityType::Solid3D(s) => self.acis(xf, &s.acis_data, false),
            EntityType::Body(s) => self.acis(xf, &s.acis_data, false),
            EntityType::Surface(s) => self.acis(xf, &s.acis_data, true),
            EntityType::Face3D(f) => { self.rep.meshes += 1; self.poly(xf, &[p(f.first_corner), p(f.second_corner), p(f.third_corner), p(f.fourth_corner)]); }
            EntityType::Mesh(m) => {
                self.rep.meshes += 1;
                for f in &m.faces {
                    let pts: Vec<V3> = f.vertices.iter().filter_map(|i| m.vertices.get(*i)).map(|v| p(*v)).collect();
                    self.poly(xf, &pts);
                }
            }
            EntityType::PolyfaceMesh(m) => {
                self.rep.meshes += 1;
                for f in &m.faces {
                    let pts: Vec<V3> = [f.index1, f.index2, f.index3, f.index4].iter().filter(|i| **i != 0)
                        .filter_map(|i| m.vertices.get(i.unsigned_abs() as usize - 1)).map(|v| p(v.location)).collect();
                    self.poly(xf, &pts);
                }
            }
            EntityType::PolygonMesh(m) => {
                self.rep.meshes += 1;
                let (mm, nn) = (m.m_vertex_count.max(0) as usize, m.n_vertex_count.max(0) as usize);
                if mm >= 2 && nn >= 2 && m.vertices.len() >= mm * nn {
                    let at = |i: usize, j: usize| p(m.vertices[(i % mm) * nn + (j % nn)].location);
                    for i in 0..if m.is_closed_m() { mm } else { mm - 1 } {
                        for j in 0..if m.is_closed_n() { nn } else { nn - 1 } { self.poly(xf, &[at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]); }
                    }
                }
            }
            EntityType::Insert(ins) if depth < 12 => {
                let Some(br) = self.doc.block_records.get(&ins.block_name) else { return };
                let t = ins.get_transform();
                let v = |x: f64, y: f64, z: f64| p(t.apply(acadrust::types::Vector3::new(x, y, z)));
                let o = v(0.0, 0.0, 0.0);
                let ix = Xf { m: [sub(v(1.0, 0.0, 0.0), o), sub(v(0.0, 1.0, 0.0), o), sub(v(0.0, 0.0, 1.0), o)], t: o };
                let b = p(br.base_point);
                let base = Xf { m: Xf::id().m, t: [-b[0], -b[1], -b[2]] };
                let x = xf.then(&ix).then(&base);
                if !x.is_finite() { return; }
                let handles = br.entity_handles.clone();
                for h in handles { if let Some(c) = self.doc.get_entity(h) { self.entity(&x, c, depth + 1); } }
            }
            _ => {}
        }
    }
}

fn read_document(bytes: &[u8]) -> Result<CadDocument, String> {
    use std::io::Cursor;
    if bytes.len() >= 6 && &bytes[..2] == b"AC" && bytes[2..6].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'.') {
        acadrust::io::dwg::DwgReader::from_stream(Cursor::new(bytes.to_vec())).read().map_err(|e| format!("DWG could not be read: {e}"))
    } else {
        acadrust::io::dxf::DxfReader::from_reader(Cursor::new(bytes.to_vec())).and_then(|r| r.read()).map_err(|e| format!("DXF could not be read: {e}"))
    }
}

/// DWG / DXF baytları → (ikili STL, rapor). Hata: okunamadı ya da 3B geometri yok.
pub fn convert(bytes: &[u8], opt: &Options) -> Result<(Vec<u8>, Report), String> {
    let doc = read_document(bytes)?;
    let mut c = Collector { doc: &doc, opt: *opt, rep: Report { units: doc.header.insertion_units as i32, ..Report::default() }, tris: Vec::new(), jobs: Vec::new() };
    let id = Xf::id();
    let model: Vec<&EntityType> = doc.model_space_entities().collect();
    for e in &model { c.entity(&id, e, 0); }
    if c.tris.is_empty() && c.jobs.is_empty() {
        // Model uzayı boşsa: blok tanımlarında kalmış geometri (yerleştirilmemiş bloklar)
        for e in doc.entities() { if !matches!(e, EntityType::Insert(_)) { c.entity(&id, e, 0); } }
        if !(c.tris.is_empty() && c.jobs.is_empty()) { c.note("model space is empty — geometry taken from block definitions".into()); }
    }
    c.run_jobs();
    if c.tris.is_empty() {
        let kinds = doc.entities().filter(|e| matches!(e, EntityType::Region(_))).count();
        return Err(if kinds > 0 { "The drawing has only 2D regions — no 3D solids or meshes".into() } else { "The drawing has no 3D solids or meshes (only 2D geometry)".into() });
    }
    c.rep.triangles = c.tris.len();
    Ok((write_stl(&c.tris), c.rep))
}

/// Tek ACIS belgesi (SAT metni / SAB) → üçgenler (test + CLI).
pub fn convert_acis(bytes: &[u8], opt: &Options) -> Result<(Vec<[V3; 3]>, Report), String> {
    let d = if bytes.starts_with(b"ACIS BinaryFile") || bytes.starts_with(b"ASM BinaryFile") { SabReader::read(bytes).map_err(|e| format!("SAB: {e:?}"))? }
        else { SatDocument::parse(&String::from_utf8_lossy(bytes)).map_err(|e| format!("SAT: {e}"))? };
    let mut rep = Report::default();
    let local = tess_acis(&d, opt, &mut rep, false, 0.0);
    let x = body_xf(&d);
    let tris: Vec<[V3; 3]> = local.into_iter().map(|t| { let (a, b, c) = (x.apply(t[0]), x.apply(t[1]), x.apply(t[2])); if x.det() < 0.0 { [a, c, b] } else { [a, b, c] } }).collect();
    rep.solids = 1; rep.triangles = tris.len();
    Ok((tris, rep))
}

pub fn write_stl(tris: &[[V3; 3]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(84 + tris.len() * 50);
    let mut head = [0u8; 80];
    head[..17].copy_from_slice(b"dwg2stl (YAGO)   ");
    out.extend_from_slice(&head);
    out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
    for t in tris {
        let n = unit(cross(sub(t[1], t[0]), sub(t[2], t[0])));
        for v in [n, t[0], t[1], t[2]] { for c in v { out.extend_from_slice(&(c as f32).to_le_bytes()); } }
        out.extend_from_slice(&[0, 0]);
    }
    out
}

/// Ağ ölçümleri (test): kutu, işaretli hacim, açık kenar ve çok-katlı kenar sayısı.
pub fn mesh_stats(tris: &[[V3; 3]]) -> (V3, V3, f64, usize, usize) {
    let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
    for t in tris { for p in t { for k in 0..3 { lo[k] = lo[k].min(p[k]); hi[k] = hi[k].max(p[k]); } } }
    let q = (dist(lo, hi) * 1e-7).max(1e-12);
    let mut ids: HashMap<[i64; 3], u32> = HashMap::new();
    let mut edges: HashMap<(u32, u32), (i32, i32)> = HashMap::new();
    let mut vol = 0.0;
    for t in tris {
        vol += dot(sub(t[0], lo), cross(sub(t[1], lo), sub(t[2], lo))) / 6.0;
        let v: Vec<u32> = t.iter().map(|p| { let k = [(p[0] / q).round() as i64, (p[1] / q).round() as i64, (p[2] / q).round() as i64]; let n = ids.len() as u32; *ids.entry(k).or_insert(n) }).collect();
        for k in 0..3 { let (a, b) = (v[k], v[(k + 1) % 3]); if a != b { let e = edges.entry((a.min(b), a.max(b))).or_insert((0, 0)); if a < b { e.0 += 1 } else { e.1 += 1 } } }
    }
    let open = edges.values().filter(|e| e.0 + e.1 == 1).count();
    let bad = edges.values().filter(|e| e.0 + e.1 != 1 && (e.0 != 1 || e.1 != 1)).count();
    (lo, hi, vol, open, bad)
}

/* ───────────────────────────── WASM arayüzü ───────────────────────────── */
// Çağrı: p = d2s_alloc(n) → baytları yaz → r = d2s_convert(p, n, chord_rel) → r: [ok, veri_ptr, veri_len, json_ptr, json_len] (u32 ×5).
// ok = 1 → veri = ikili STL; ok = 0 → veri boş, json.error dolu. Bellek modül örneğiyle birlikte atılır (her dönüşüm yeni örnek).
#[no_mangle]
pub extern "C" fn d2s_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}
fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for ch in s.chars() { match ch { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), c if (c as u32) < 0x20 => o.push(' '), c => o.push(c) } }
    o.push('"');
    o
}
pub fn report_json(rep: &Report, error: Option<&str>) -> String {
    format!("{{\"units\":{},\"solids\":{},\"faces\":{},\"approxFaces\":{},\"meshes\":{},\"triangles\":{},\"notes\":[{}],\"error\":{}}}",
        rep.units, rep.solids, rep.faces, rep.approx_faces, rep.meshes, rep.triangles,
        rep.notes.iter().map(|n| json_str(n)).collect::<Vec<_>>().join(","), error.map(json_str).unwrap_or_else(|| "null".into()))
}
/// # Safety
/// `ptr` / `len`, `d2s_alloc` ile ayrılmış ve doldurulmuş bir arabelleği göstermelidir.
#[no_mangle]
pub unsafe extern "C" fn d2s_convert(ptr: *const u8, len: usize, chord_rel: f64) -> *const u32 {
    let bytes = std::slice::from_raw_parts(ptr, len);
    let opt = Options { chord_rel: if chord_rel > 0.0 && chord_rel < 0.1 { chord_rel } else { Options::default().chord_rel } };
    let (ok, data, json) = match convert(bytes, &opt) {
        Ok((stl, rep)) => (1u32, stl, report_json(&rep, None)),
        Err(e) => (0u32, Vec::new(), report_json(&Report::default(), Some(&e))),
    };
    let json = json.into_bytes();
    let out = vec![ok, data.as_ptr() as u32, data.len() as u32, json.as_ptr() as u32, json.len() as u32];
    let p = out.as_ptr();
    std::mem::forget(data); std::mem::forget(json); std::mem::forget(out);
    p
}

/* ───────────────────────────── Sınama (cargo test) ─────────────────────────────
   `cargo test --release`                         → ilkel katılar: kapalı ağ + analitik hacim.
   `D2S_FILES="a.dwg;b.sat" cargo test --release convert_files -- --nocapture`
                                                  → verilen dosyaları çevirir, rapor + ağ ölçümü yazar
                                                    (D2S_OUT=klasör → STL'leri de yazar; D2S_DEBUG=1 yüz yüz döküm). */
#[cfg(test)]
mod tests {
    use super::*;
    use acadrust::entities::acis::primitives::*;

    fn check(name: &str, sat: String, exact: f64, rel: f64) {
        let (tris, rep) = convert_acis(sat.as_bytes(), &Options { chord_rel: 0.0005 }).expect(name);
        let (lo, hi, vol, open, bad) = mesh_stats(&tris);
        println!("{name}: tris={} approx={} box {lo:.2?}..{hi:.2?} vol={vol:.3} exact={exact:.3} open={open} bad={bad} notes={:?}", tris.len(), rep.approx_faces, rep.notes);
        assert_eq!(rep.approx_faces, 0, "{name}: patched faces");
        assert_eq!((open, bad), (0, 0), "{name}: not watertight");
        assert!((vol - exact).abs() < exact * rel, "{name}: volume {vol} vs {exact}");
    }

    #[test]
    fn primitives() {
        check("box", build_box([0.0; 3], 40.0, 30.0, 20.0).to_sat_string(), 24000.0, 1e-9);
        check("wedge", build_wedge([0.0; 3], 40.0, 30.0, 20.0).to_sat_string(), 12000.0, 1e-9);
        check("pyramid", build_pyramid([0.0; 3], 30.0, 20.0).to_sat_string(), 30.0 * 30.0 * 20.0 / 3.0, 1e-9);
        check("cylinder", build_cylinder([5.0, 6.0, 7.0], 10.0, 50.0).to_sat_string(), PI * 100.0 * 50.0, 0.01);
        check("cone", build_cone([0.0; 3], 10.0, 30.0).to_sat_string(), PI * 100.0 * 30.0 / 3.0, 0.01);
        check("sphere", build_sphere([1.0, 2.0, 3.0], 25.0).to_sat_string(), 4.0 / 3.0 * PI * 25.0f64.powi(3), 0.02);
        check("torus", build_torus([0.0; 3], 40.0, 8.0).to_sat_string(), 2.0 * PI * PI * 40.0 * 64.0, 0.02);
    }

    fn read_stl(b: &[u8]) -> Vec<[V3; 3]> {
        let n = u32::from_le_bytes([b[80], b[81], b[82], b[83]]) as usize;
        let f = |o: usize| f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as f64;
        (0..n).map(|i| { let o = 84 + i * 50 + 12; [[f(o), f(o + 4), f(o + 8)], [f(o + 12), f(o + 16), f(o + 20)], [f(o + 24), f(o + 28), f(o + 32)]] }).collect()
    }

    /// Dosya çevirici (geliştirme): .dwg / .dxf tam hat, .sat / .sab tek ACIS gövdesi.
    #[test]
    fn convert_files() {
        let Ok(list) = std::env::var("D2S_FILES") else { return };
        let opt = Options { chord_rel: std::env::var("D2S_TOL").ok().and_then(|s| s.parse().ok()).unwrap_or(Options::default().chord_rel) };
        let out_dir = std::env::var("D2S_OUT").ok();
        for f in list.split(';').filter(|s| !s.is_empty()) {
            let bytes = std::fs::read(f).expect(f);
            let ext = f.rsplit('.').next().unwrap_or("").to_lowercase();
            let t0 = std::time::Instant::now();
            let res = if ext == "sat" || ext == "sab" { convert_acis(&bytes, &opt).map(|(t, r)| (write_stl(&t), t, r)) }
                else { convert(&bytes, &opt).map(|(s, r)| { let t = read_stl(&s); (s, t, r) }) };
            match res {
                Ok((stl, tris, rep)) => {
                    let (lo, hi, vol, open, bad) = mesh_stats(&tris);
                    println!("{f}: units={} solids={} faces={} approx={} meshes={} tris={} | box {:.3} {:.3} {:.3} .. {:.3} {:.3} {:.3} | vol {:.4} | open {} bad {} | {} ms",
                        rep.units, rep.solids, rep.faces, rep.approx_faces, rep.meshes, rep.triangles, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], vol, open, bad, t0.elapsed().as_millis());
                    for n in &rep.notes { println!("    note: {n}"); }
                    if let Some(d) = &out_dir {
                        let name = std::path::Path::new(f).file_stem().and_then(|s| s.to_str()).unwrap_or("out");
                        std::fs::create_dir_all(d).ok();
                        std::fs::write(format!("{d}/{name}.stl"), stl).ok();
                    }
                }
                Err(e) => println!("{f}: ERROR {e}"),
            }
        }
    }
}
