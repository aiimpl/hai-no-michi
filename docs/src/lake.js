// Lake surface: calm water (wind drift, ripples, reflections, glints).
// Reflection is the world rendered upside down at half resolution. Underwater, the world's color and depth rendered
// beforehand without the water (captured by post.js) are refracted by the ripples and absorbed/scattered by water thickness, so sunken cars and shallow beds show through.
// When the car enters the water it raises a foam rim around the body and spreading ripples along its wake. Looking up from underwater
// shows a bright window onto the sky (critical angle 48.6 deg) with total internal reflection outside it.
import * as THREE from 'three';
import { skyGLSL } from './sky.js';
import { terrainGLSL } from './terrain.js';

export const TRAIL = 24;           // number of ripple sources (points the car passed)

const common = /* glsl */`
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
float fbm5(vec2 p){ float s = 0., a = 0.5; for (int i = 0; i < 5; i++){ s += a * vn(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
`;

const vert = /* glsl */`
varying vec3 vW; varying vec4 vClip; varying float vDepth;
void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vec4 mv = viewMatrix * w; vDepth = -mv.z;
  vClip = projectionMatrix * mv; gl_Position = vClip; }`;

const frag = /* glsl */`
uniform float uTime;
${common}
${skyGLSL}
${terrainGLSL}
uniform sampler2D uRefl; uniform vec2 uReflTexel; uniform sampler2D uRefr;
uniform vec2 uWind; uniform vec3 uSunIrr; uniform float uWaterY;
uniform vec3 uFogColor; uniform float uFogDensity;
uniform vec3 uCarP; uniform vec2 uCarF; uniform float uCarSub; uniform float uCarV;
uniform vec4 uTrail[${TRAIL}];      // x, z, elapsed seconds, strength
varying vec3 vW; varying vec4 vClip; varying float vDepth;
//__SHADOW__
float gustAt(vec2 p){
  float band = smoothstep(0.35, 0.75, fbm5(p * 0.012 + uWind * uTime * 0.02 + vec2(3.1, 7.7)));
  float calm = 0.08 + 0.06 * fbm5(p * 0.02 + uTime * 0.01);
  return clamp(calm + 0.8 * band, 0., 1.);
}
vec3 rippleSlope(vec2 p, float fw, float g){
  vec2 s = vec2(0.); float unres = 0.;
  for (int i = 0; i < 40; i++){
    float fi = float(i);
    float lam = 2.2 * pow(0.88, fi) * (0.8 + 0.4 * hash12(vec2(fi, 9.1)));
    float ang = (hash12(vec2(fi, 3.1)) - 0.5) * 1.8;
    vec2 d = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * uWind;
    float k = 6.2831853 / lam;
    float om = sqrt(9.81 * k + 0.074 / 1000. * k * k * k);
    float stp = 0.07 * (0.5 + hash12(vec2(fi, 7.7))) * mix(0.25, 1., smoothstep(0.6, 0.05, lam));
    float amp = stp / k * mix(0.1, 1., g);
    float filt = smoothstep(fw * 3., fw * 8., lam);
    float ph = k * dot(d, p) - om * uTime + hash12(vec2(fi, 1.3)) * 6.2831;
    s += d * amp * k * cos(ph) * filt;
    unres += pow(amp * k, 2.) * 0.5 * (1. - filt);
  }
  return vec3(s, unres);
}
float glints(vec2 p, vec2 need, float fw, float sigma, float rate){
  float acc = 0.;
  for (int l = 0; l < 2; l++){
    float cs = max(l == 0 ? 0.03 : 0.08, fw * 1.2);
    vec2 q = p / cs + float(l) * 17.3;
    vec2 id = floor(q), f = fract(q);
    vec3 h0 = hash32(id);
    float tt = uTime * rate + h0.z * 7.;
    vec3 hr = hash32(id + floor(tt) * 1.618);
    float r = sqrt(-2. * log(max(hr.x, 1e-4)));
    vec2 sl = r * vec2(cos(6.2831 * hr.y), sin(6.2831 * hr.y)) * sigma;
    float hit = exp(-dot(sl - need, sl - need) / (0.06 * 0.06));
    vec2 c = h0.xy * 0.6 + 0.2;
    float r2 = max(0.012, pow(0.5 * fw / cs, 2.));
    acc += hit * exp(-dot(f - c, f - c) / r2) * 0.012 / r2 * sin(3.14159 * fract(tt)) * 2.2;
  }
  return acc;
}
// Car-made waves: rings spreading from passed points (slope and foam) plus a foam rim around the body
vec3 carWaves(vec2 xz, out float foam){
  vec2 g = vec2(0.0); foam = 0.0;
  for (int i = 0; i < ${TRAIL}; i++){
    vec4 tr = uTrail[i];
    if (tr.w <= 0.0) continue;
    vec2 d = xz - tr.xy; float r = length(d) + 1e-3;
    float R = 1.2 + tr.z * 2.4;                               // ring radius (expands at about 2.4 m/s)
    float fade = tr.w * exp(-tr.z * 0.9) / (1.0 + R * 0.25);
    float x = r - R;
    float w = exp(-x * x / 0.6);
    g += d / r * (-2.0 * x / 0.6) * w * cos(x * 3.5) * 0.08 * fade;
    foam += w * fade * 0.5 * smoothstep(3.0, 0.0, tr.z);
  }
  // Foam around the body footprint (oriented rectangle): only while the car is submerged
  vec2 f = normalize(uCarF), sd = vec2(-f.y, f.x);
  vec2 q = xz - uCarP.xz; vec2 lq = vec2(dot(q, sd), dot(q, f));
  vec2 bx = abs(lq) - vec2(1.15, 3.0);
  float sdf = length(max(bx, 0.0)) + min(max(bx.x, bx.y), 0.0);
  float edge = exp(-max(sdf, 0.0) * 1.6) * smoothstep(-0.6, 0.0, sdf);
  float bow = smoothstep(4.5, 0.0, length(lq - vec2(0.0, 3.0))) * min(uCarV / 6.0, 1.0);   // bow wave
  foam += (edge * (0.55 + 0.45 * vn(xz * 4.0 + uTime * 2.0)) + bow * 0.6) * uCarSub;
  return vec3(g, 0.0);
}
void main(){
  vec2 p = vec2(vW.x, -vW.z);
  vec3 V = normalize(cameraPosition - vW);
  float dist = length(cameraPosition - vW);
  float fw = max(length(fwidth(p)), 1e-4);
  bool under = cameraPosition.y < uWaterY;
  float g = gustAt(p);
  vec3 rp = rippleSlope(p, fw, g);
  float foam;
  vec3 cw = carWaves(vW.xz, foam);
  vec2 grad = rp.xy + vec2(cw.x, -cw.y);
  vec3 N = normalize(vec3(-grad.x, 1., grad.y));
  vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
  // Underwater color: the refracted world below, absorbed by water thickness and scattered toward blue-green
  vec2 ro = vec2(grad.x, grad.y * 0.6) * 0.06 / max(dist * 0.02, 0.3);
  vec4 refr = texture2D(uRefr, suv + ro);
  if (refr.a < vDepth) refr = texture2D(uRefr, suv);          // don't refract objects in front of the water surface
  float thick = max(refr.a - vDepth, 0.0);
  vec3 ext = exp(-thick * vec3(0.9, 0.3, 0.24));
  float lightK = clamp(length(uSunIrr) / 5.0, 0.03, 1.0);               // underwater scattering dims at night too
  vec3 inscat = vec3(0.006, 0.034, 0.036) * (0.4 + 0.9 * max(uSunDirW.y, 0.0)) * lightK;
  // Even shallow water gets tinted (so the bed doesn't read as dry land); deeper goes darker blue-green
  vec3 below = refr.rgb * ext * mix(vec3(1.0), vec3(0.62, 0.9, 0.92), smoothstep(0.0, 0.6, thick)) + inscat * (1.0 - exp(-thick * 0.45));
  if (under) {
    // Looking up from underwater: inside the critical angle, refracted sky and shore; outside, total internal reflection (dark blue-green)
    vec3 Vu = -V;                                             // upward view ray
    float c = Vu.y;
    float win = smoothstep(0.62, 0.7, c + (grad.x + grad.y) * 0.3);
    vec3 skyv = skyCol(normalize(vec3(Vu.x, max(Vu.y, 0.05) * 1.6, Vu.z)), true);
    vec3 tir = vec3(0.004, 0.022, 0.026);
    vec3 col = mix(tir, skyv * 0.8, win);
    col += vec3(0.9) * foam * 0.3;
    float fd = 1.0 - exp(-dist * 0.05);
    col = mix(col, vec3(0.008, 0.045, 0.05), fd);
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  float NV = max(dot(N, V), 1e-3);
  float F = 0.02 + 0.98 * pow(1. - NV, 5.);
  vec2 off = vec2(grad.x, grad.y * 0.6) * 90. / max(dist, 4.);
  vec3 refl = texture2D(uRefl, suv + off * uReflTexel * 60.).rgb;
  vec3 R = reflect(-V, N); R.y = abs(R.y);
  refl = mix(refl, skyCol(R, false), smoothstep(0.02, 0.12, length(grad)) * 0.35);
  vec3 col = below * (1. - F) + refl * F;
  // Glints and the sun's glitter path
  vec3 L = uSunDirW, Hh = normalize(L + V);
  vec2 need = vec2(-Hh.x / Hh.y, Hh.z / Hh.y) - grad;
  float sig = sqrt(0.0004 + rp.z) + 0.02 * g;
  float gl = glints(p + vec2(0., uTime * 0.1), need, fw, sig, 1.6);
  float Fs = 0.02 + 0.98 * pow(1. - max(dot(V, Hh), 0.), 5.);
  float shd = sunShadowAt(vW, vec3(0.0, 1.0, 0.0));
  col += uSunIrr * 40.0 * Fs * gl * 0.35 * smoothstep(0.02, 0.2, g) * shd;
  float pdf = exp(-dot(need, need) / (2. * sig * sig)) / (6.2831 * sig * sig);
  float mask = NV / (NV + 0.06);
  col += uSunIrr * Fs * pdf / (4. * NV * pow(Hh.y, 4.)) * mask * smoothstep(10., 120., dist) * shd;
  // Foam: shore wash (where the water is thin) and around the car. White in sun, bluish-white in shade
  float shore = smoothstep(0.35, 0.0, thick) * (0.4 + 0.6 * vn(p * 3.0 + uTime * 0.3));
  float fo = clamp(foam * (0.6 + 0.8 * vn(p * 6.0 - uTime * 1.3)), 0.0, 1.0);
  vec3 foamCol = vec3(0.55, 0.58, 0.58) * (0.35 + 0.65 * shd) * (0.5 + max(uSunDirW.y, 0.0)) * lightK;
  col = mix(col, foamCol, clamp(shore * 0.35 + smoothstep(0.2, 0.8, fo) * 0.85, 0.0, 1.0));
  float fd = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
  col = mix(col, uFogColor, fd);
  gl_FragColor = vec4(col, 1.0);
}`;

export function makeLake(T, reflTarget, refrTarget, U, skyU, TU, shadowU, fogU, shadowGLSL) {
  const trail = Array.from({ length: TRAIL }, () => new THREE.Vector4(0, 0, 99, 0));
  const uniforms = Object.assign({}, U, skyU, TU, shadowU, fogU, {
    uRefl: { value: reflTarget.texture }, uRefr: { value: refrTarget.texture },
    uReflTexel: { value: new THREE.Vector2(1 / reflTarget.width, 1 / reflTarget.height) },
    uWind: { value: new THREE.Vector2(0.8, 0.6).normalize() },
    uSunIrr: { value: skyU.uSunCol.value },
    uWaterY: { value: T.meta.water },
    uCarP: { value: new THREE.Vector3() }, uCarF: { value: new THREE.Vector2(0, 1) }, uCarSub: { value: 0 }, uCarV: { value: 0 },
    uTrail: { value: trail },
  });
  const geo = new THREE.CircleGeometry(430, 96).rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag.replace('//__SHADOW__', shadowGLSL),
    uniforms, side: THREE.DoubleSide, depthWrite: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = T.meta.water;
  // Leave the car's wake as ripple sources (every 0.18 s, only while submerged)
  let acc = 0, head = 0;
  function update(dt, car) {
    for (const t of trail) t.z += dt;
    const u = uniforms;
    u.uCarP.value.copy(car.pos);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quat);
    u.uCarF.value.set(f.x, f.z);
    u.uCarSub.value += (Math.min(car.sub * 3, 1) - u.uCarSub.value) * Math.min(dt * 6, 1);
    u.uCarV.value = car.vel.length();
    acc += dt;
    if (car.sub > 0.02 && car.pos.y > T.meta.water - 2.2 && acc > 0.18) {
      acc = 0;
      trail[head].set(car.pos.x, car.pos.z, 0, Math.min(0.35 + car.vel.length() / 6, 1.6));
      head = (head + 1) % TRAIL;
    }
  }
  function ripple(x, z, s) { trail[head].set(x, z, 0, s); head = (head + 1) % TRAIL; }
  return { mesh, uniforms, update, ripple };
}
