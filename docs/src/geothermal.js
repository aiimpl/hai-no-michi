// Jigokudani: milky hot pools (yellow sinter at the rim, popping bubbles, sky reflection) and steam rising from fumaroles.
// Steam is soft point sprites that drift with the wind, spread and fade. Bright when backlit.
import * as THREE from 'three';
import { skyGLSL } from './sky.js';

const poolFrag = /* glsl */`
uniform float uTime; uniform float uR;
${skyGLSL}
varying vec3 vW; varying vec2 vL;
float h1(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  float r = length(vL) / uR;                          // 0 center -> 1 rim
  vec3 V = normalize(cameraPosition - vW);
  // Bubbles: rings that expand and vanish at a few points
  vec2 g = vec2(0.0); float ring = 0.0;
  for (int i = 0; i < 7; i++){
    float fi = float(i);
    vec2 c = (vec2(h1(vec2(fi, uR)), h1(vec2(uR, fi))) - 0.5) * uR * 1.2;
    float ph = fract(uTime * (0.35 + h1(vec2(fi * 3.1, 1.0)) * 0.5) + h1(vec2(fi, 9.0)));
    float d = length(vL - c), R0 = ph * (0.5 + 0.6 * uR * 0.15);
    float w = exp(-pow((d - R0) / 0.08, 2.0)) * (1.0 - ph);
    ring += w;
    g += (vL - c) / max(d, 1e-3) * w * 0.25;
  }
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 R = reflect(-V, N); R.y = abs(R.y);
  // Water color: deep milky blue-green at the center, shallow and whitish toward the rim, sulfur yellow at the outer edge
  vec3 deep = vec3(0.05, 0.23, 0.26), milky = vec3(0.24, 0.38, 0.36), rim = vec3(0.42, 0.36, 0.12);
  vec3 body = mix(deep, milky, smoothstep(0.3, 0.85, r));
  body = mix(body, rim, smoothstep(0.86, 0.98, r));
  body *= 0.6 + 0.8 * max(uSunDirW.y, 0.0);
  vec3 col = body * (1.0 - F) + skyCol(R, false) * F;
  col += vec3(0.4) * ring * 0.25;
  float a = 1.0 - smoothstep(0.96, 1.0, r);
  gl_FragColor = vec4(col, a);
}`;

const SMAX = 5000;
export function makeGeothermal(meta, skyU, U) {
  const group = new THREE.Group();
  // Hot pools
  for (const [x, y, z, r] of meta.pools) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r * 1.02, 48).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: Object.assign({ uR: { value: r } }, skyU, U), transparent: true, depthWrite: true,
      vertexShader: 'varying vec3 vW; varying vec2 vL; void main(){ vL = position.xz; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: poolFrag,
    }));
    m.position.set(x, y, z); m.renderOrder = 2;
    group.add(m);
  }
  // Steam particles
  const pos = new Float32Array(SMAX * 3), vel = new Float32Array(SMAX * 3), life = new Float32Array(SMAX), age = new Float32Array(SMAX), sz = new Float32Array(SMAX);
  const g = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(new Float32Array(SMAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const aSize = new THREE.BufferAttribute(new Float32Array(SMAX), 1).setUsage(THREE.DynamicDrawUsage);
  const aAlpha = new THREE.BufferAttribute(new Float32Array(SMAX), 1).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', aPos); g.setAttribute('aSize', aSize); g.setAttribute('aAlpha', aAlpha);
  const su = { uSunCol: U.uSunColor, uSunView: { value: new THREE.Vector3() }, uAmb: { value: new THREE.Color(0.2, 0.21, 0.22) }, uH: { value: 1080 } };
  const steam = new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: su, transparent: true, depthWrite: false,
    vertexShader: /* glsl */`
      attribute float aSize, aAlpha; uniform float uH; varying float vA; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uH * projectionMatrix[1][1] / max(-mv.z, 0.5) * 0.5; vA = aAlpha; vV = normalize(mv.xyz); }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunCol, uSunView, uAmb; varying float vA; varying vec3 vV;
      void main(){
        vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q);
        if (r > 1.0) discard;
        float a = pow(1.0 - r, 1.6) * vA;
        float fwd = pow(max(dot(vV, uSunView), 0.0), 6.0);        // brighter when backlit
        vec3 c = uAmb * 1.6 + uSunCol * (0.05 + 0.25 * fwd);
        gl_FragColor = vec4(c, a);
      }`,
  }));
  steam.frustumCulled = false;
  group.add(steam);
  let n = 0;
  const wind = new THREE.Vector2(0.8, 0.35);
  function emit(v) {
    const i = n; n = (n + 1) % SMAX;
    pos[i * 3] = v[0] + (Math.random() - 0.5) * 0.8; pos[i * 3 + 1] = v[1] + 0.3; pos[i * 3 + 2] = v[2] + (Math.random() - 0.5) * 0.8;
    vel[i * 3] = (Math.random() - 0.5) * 0.3; vel[i * 3 + 1] = 1.8 + Math.random() * 1.4 * v[3]; vel[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
    life[i] = 7 + Math.random() * 6; age[i] = 0; sz[i] = 0.5 + Math.random() * 0.6;
  }
  let acc = 0;
  function update(dt, camera) {
    const near = camera.position.distanceTo(new THREE.Vector3(meta.jigoku[0], 0, -meta.jigoku[1])) < 700;
    steam.visible = near;
    if (!near) return;
    acc += dt;
    while (acc > 0.02) {
      acc -= 0.02;
      for (const v of meta.vents) if (Math.random() < v[3] * 0.6) emit(v);
    }
    for (let i = 0; i < SMAX; i++) {
      if (life[i] <= 0) { aAlpha.array[i] = 0; continue; }
      age[i] += dt;
      const u = age[i] / life[i];
      if (u >= 1) { life[i] = 0; aAlpha.array[i] = 0; continue; }
      // slows as it rises, carried by the wind
      vel[i * 3 + 1] = Math.max(0.35, vel[i * 3 + 1] * (1 - dt * 0.2));
      // wind plus slow, rolling turbulence
      const tq = age[i] * 0.7 + i;
      vel[i * 3] += (wind.x * 0.8 * u + Math.sin(tq) * 0.25 - vel[i * 3]) * dt * 0.5;
      vel[i * 3 + 2] += (-wind.y * 0.8 * u + Math.cos(tq * 1.3) * 0.25 - vel[i * 3 + 2]) * dt * 0.5;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      aPos.array[i * 3] = pos[i * 3]; aPos.array[i * 3 + 1] = pos[i * 3 + 1]; aPos.array[i * 3 + 2] = pos[i * 3 + 2];
      aSize.array[i] = sz[i] * (1 + u * 9.0);
      aAlpha.array[i] = Math.min(1, u * 2.5) ** 2 * Math.pow(1 - u, 1.4) * 0.07;   // faint at the source, more visible as it spreads
    }
    aPos.needsUpdate = aSize.needsUpdate = aAlpha.needsUpdate = true;
    su.uSunView.value.copy(skyU.uSunDirW.value).transformDirection(camera.matrixWorldInverse);
  }
  return { group, update, steamU: su };
}
