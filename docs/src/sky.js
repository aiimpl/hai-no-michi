// Sky: afternoon with breaks in the clouds. Hazy bright horizon, blue zenith, a halo around the sun.
// Clouds are a layer at 1500 m altitude (fbm sampled at the ray-plane intersection). Sun-side edges glow, undersides are dark.
// The same function drives the sky dome, the lake reflection and the environment reflection (PMREM).
import * as THREE from 'three';
import { noiseGLSL } from './forest.js';

export const skyGLSL = /* glsl */`
uniform vec3 uSunDirW; uniform vec3 uSunCol; uniform float uCloudT; uniform float uCover; uniform float uNight; uniform float uDusk;
${noiseGLSL}
float cfbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 6; i++){ v += a * fnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.1; a *= 0.5; } return v; }
vec3 skyBase(vec3 d){
  float h = max(d.y, 0.0);
  // Dusk (uDusk): zenith deepens to blue; the horizon turns orange toward the sun and pale pink opposite (the belt above Earth's shadow)
  vec3 zen = mix(vec3(0.16, 0.32, 0.62), vec3(0.07, 0.13, 0.32), uDusk);
  vec2 hs = normalize(uSunDirW.xz + 1e-4), hd = normalize(d.xz + 1e-4);
  float toward = dot(hs, hd) * 0.5 + 0.5;
  vec3 horDusk = mix(vec3(0.36, 0.3, 0.36), vec3(1.05, 0.5, 0.2), pow(toward, 2.2));
  vec3 hor = mix(vec3(0.62, 0.66, 0.68), horDusk, uDusk);
  vec3 c = mix(hor, zen, pow(h, mix(0.45, 0.32, uDusk)));
  float mu = max(dot(d, uSunDirW), 0.0);
  c += uSunCol * (pow(mu, 6.0) * mix(0.12, 0.1, uDusk) + pow(mu, 48.0) * 0.25 + pow(mu, 600.0) * 1.2);  // brightness around the sun (haze)
  c = mix(c, vec3(0.5, 0.52, 0.52), smoothstep(0.0, -0.1, d.y));           // below the horizon
  return c * 1.6;
}
// Clouds: color and coverage in direction d
vec4 clouds(vec3 d){
  if (d.y < 0.01) return vec4(0.0);
  float t = 1500.0 / d.y;
  vec2 p = d.xz * t * 0.00042 + vec2(uCloudT * 0.004, uCloudT * 0.0015);
  vec2 w = vec2(cfbm(p * 0.7 + 5.0), cfbm(p * 0.7 + 9.0));
  float n = cfbm(p + w * 1.1);
  float cov = smoothstep(1.0 - uCover - 0.08, 1.0 - uCover + 0.22, n);
  // Thickness: shade by the density sampled slightly toward the sun (thick parts go dark)
  vec2 sp = uSunDirW.xz * 0.06;
  float n2 = cfbm(p + w * 1.1 + sp);
  float shade = clamp(0.5 + (n - n2) * 5.0, 0.0, 1.0);
  float mu = max(dot(d, uSunDirW), 0.0);
  // Dusk clouds: sunlit edges go orange to crimson, shadows turn purplish
  vec3 lit = mix(vec3(1.0, 0.96, 0.9), vec3(1.2, 0.55, 0.3), uDusk) * (1.1 + 1.6 * pow(mu, 8.0) * (1.0 - cov * 0.6));
  vec3 dark = mix(vec3(0.34, 0.37, 0.42), vec3(0.2, 0.15, 0.22), uDusk);
  vec3 c = mix(dark, lit, shade * 0.75 + 0.2 * (1.0 - cov));
  // thin clouds near the sun glow at the edges
  c += uSunCol * pow(mu, 20.0) * (1.0 - cov) * 1.5;
  float fade = smoothstep(0.02, 0.18, d.y);                                // dissolve into haze near the horizon
  return vec4(c * 1.5, cov * fade);
}
vec3 skyCol(vec3 d, bool disc){
  vec3 c = skyBase(d);
  vec4 cl = clouds(d);
  // Night (uNight 0..1, continuous): dark navy sky, stars, clouds as shadows slightly brighter than the sky
  vec3 nsky = mix(vec3(0.006, 0.009, 0.018), vec3(0.002, 0.003, 0.008), pow(max(d.y, 0.0), 0.5));
  vec2 sp = d.xz / max(d.y + 0.2, 0.05) * 90.0;
  float st = step(0.9965, fhash(floor(sp))) * smoothstep(0.05, 0.3, d.y) * (1.0 - cl.a);
  float twinkle = 0.6 + 0.4 * sin(uCloudT * 3.0 + fhash(floor(sp) + 7.0) * 40.0);
  vec3 nightC = nsky + vec3(st) * 0.6 * twinkle + cl.a * vec3(0.012, 0.014, 0.02);
  if (uNight > 0.999) return nightC;
  if (disc) {
    float mu = dot(d, uSunDirW);
    c += uSunCol * smoothstep(0.99985, 0.99993, mu) * 60.0 * (1.0 - cl.a * 0.9);
  }
  c = mix(c, cl.rgb, cl.a);
  c = mix(c, nightC, uNight);
  // strip negatives, NaNs and huge values so the half-float reflection maps don't break
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  return clamp(c, 0.0, 400.0);
}
`;

export function makeSky(sunDir, sunCol, U) {
  const uniforms = Object.assign({
    uSunDirW: { value: sunDir }, uSunCol: { value: sunCol }, uCloudT: { value: 0 }, uCover: { value: 0.46 }, uNight: { value: 0 }, uDusk: { value: 0 },
  }, U);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, uniforms,
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }',
    fragmentShader: `${skyGLSL}\nvarying vec3 vD; void main(){ gl_FragColor = vec4(skyCol(normalize(vD), true), 1.0); }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(8000, 48, 24), mat);
  mesh.frustumCulled = false; mesh.renderOrder = -1;
  return { mesh, uniforms };
}
