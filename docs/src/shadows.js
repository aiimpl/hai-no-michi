// Sun shadows: bypass three's shadow system and use two custom depth maps.
//  Static map: the sun and trees don't move, so the whole caldera (2300 m square, 8192²) is drawn once at startup.
//             This gives the long tree shadows of a low evening sun (about 5x tree height) at almost no cost
//  Car map: only the 24 m around the car, redrawn every frame
// Both are comparison depth textures (hardware 2x2 filtering), sampled 3x3 to soften.
import * as THREE from 'three';

function depthTarget(res) {
  const rt = new THREE.WebGLRenderTarget(res, res, { depthBuffer: true, stencilBuffer: false });
  const d = new THREE.DepthTexture(res, res, THREE.UnsignedIntType);
  d.compareFunction = THREE.LessEqualCompare;
  d.magFilter = d.minFilter = THREE.LinearFilter;
  rt.depthTexture = d;
  return rt;
}

export class Shadows {
  constructor(renderer, sunDir, { size = 2300, res = 8192, carSize = 24, carRes = 1024 } = {}) {
    this.r = renderer; this.sun = sunDir;          // keep a reference to the sun direction (it changes with time of day)
    this.sunRT = depthTarget(res); this.carRT = depthTarget(carRes);
    const h = size / 2, c = carSize / 2;
    this.sunCam = new THREE.OrthographicCamera(-h, h, h, -h, 10, 4000);
    this.carCam = new THREE.OrthographicCamera(-c, c, c, -c, 10, 400);
    this.sunScene = new THREE.Scene(); this.carScene = new THREE.Scene();
    this.uniforms = {
      uSunSM: { value: this.sunRT.depthTexture }, uSunVP: { value: new THREE.Matrix4() }, uSunTexel: { value: 1 / res },
      uCarSM: { value: this.carRT.depthTexture }, uCarVP: { value: new THREE.Matrix4() }, uCarTexel: { value: 1 / carRes },
      uShadowOn: { value: 1 }, uSunView: { value: new THREE.Vector3() }, uMirror: { value: 1 },
      uWaterYS: { value: -1e9 }, uTimeS: { value: 0 },
    };
    this.depthMat = new THREE.MeshDepthMaterial();
  }
  aim(cam, center, dist) {
    cam.position.copy(center).addScaledVector(this.sun, dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(center);
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  }
  // Add stand-ins for the shadow casters (same shape and position, depth-only material) to the shadow scene
  addCaster(mesh, { car = false, alphaMap = null } = {}) {
    const mat = alphaMap ? new THREE.MeshDepthMaterial({ map: alphaMap, alphaTest: 0.5, side: THREE.DoubleSide }) : this.depthMat;
    const p = mesh.isInstancedMesh ? new THREE.InstancedMesh(mesh.geometry, mat, mesh.count) : new THREE.Mesh(mesh.geometry, mat);
    if (mesh.isInstancedMesh) { p.instanceMatrix = mesh.instanceMatrix; p.count = mesh.count; }
    p.matrixAutoUpdate = false; p.frustumCulled = false;
    p.userData.src = mesh;
    (car ? this.carScene : this.sunScene).add(p);
    return p;
  }
  sync(scene) {
    for (const p of scene.children) {
      const s = p.userData.src; if (!s) continue;
      p.matrix.copy(s.matrixWorld); p.matrixWorld.copy(s.matrixWorld);
      if (s.isInstancedMesh) p.count = s.count;
      p.visible = s.visible;
    }
  }
  renderStatic(center) {
    this.aim(this.sunCam, center, 2000);
    this.sync(this.sunScene);
    this._draw(this.sunRT, this.sunScene, this.sunCam);
    this.uniforms.uSunVP.value.multiplyMatrices(this.sunCam.projectionMatrix, this.sunCam.matrixWorldInverse);
  }
  renderCar(center) {
    // Snap the center to the map's texel grid on the two axes perpendicular to the light (keeps shadow edges from shimmering)
    this.aim(this.carCam, center, 200);
    const t = 24 / 1024, c = center.clone();
    const e = this.carCam.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]), up = new THREE.Vector3(e[4], e[5], e[6]);
    const r = right.dot(c), u = up.dot(c);
    c.addScaledVector(right, Math.round(r / t) * t - r).addScaledVector(up, Math.round(u / t) * t - u);
    this.aim(this.carCam, c, 200);
    this.sync(this.carScene);
    this._draw(this.carRT, this.carScene, this.carCam);
    this.uniforms.uCarVP.value.multiplyMatrices(this.carCam.projectionMatrix, this.carCam.matrixWorldInverse);
  }
  _draw(rt, scene, cam) {
    const r = this.r, prev = r.getRenderTarget(), ac = r.autoClear;
    r.setRenderTarget(rt); r.autoClear = true; r.clear(true, true, false);
    r.render(scene, cam);
    r.setRenderTarget(prev); r.autoClear = ac;
  }
  updateView(camera) {
    this.uniforms.uSunView.value.copy(this.sun).transformDirection(camera.matrixWorldInverse);
  }
}

export const shadowGLSL = /* glsl */`
uniform highp sampler2DShadow uSunSM; uniform mat4 uSunVP; uniform float uSunTexel;
uniform highp sampler2DShadow uCarSM; uniform mat4 uCarVP; uniform float uCarTexel;
uniform float uShadowOn; uniform vec3 uSunView; uniform float uWaterYS; uniform float uTimeS;
// Caustics on the lake bed: warp coordinates with waves, brighten the thin lines where a sum of sines is near 0
float caustic(vec2 p, float t){
  vec2 q = p * 0.85; float c = 0.0;
  for (int i = 0; i < 3; i++){
    q += vec2(sin(q.y * 1.7 + t * 0.9), cos(q.x * 1.5 - t * 0.8)) * 0.55;
    float s = sin(q.x) + sin(q.y);
    c += 1.0 / (1.0 + 40.0 * s * s);
  }
  return c * 0.6;
}
float smLookup(highp sampler2DShadow m, mat4 vp, vec3 wp, float texel, float bias){
  vec4 p = vp * vec4(wp, 1.0);
  vec3 c = p.xyz / p.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float z = c.z - bias, s = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) s += texture(m, vec3(c.xy + vec2(i, j) * texel * 1.2, z));
  return s / 9.0;
}
float sunShadowAt(vec3 wp, vec3 wn){
  if (uShadowOn < 0.5) return 1.0;
  float ndl = dot(wn, uSunDirW);
  vec3 off = wn * (0.35 + 0.35 * (1.0 - abs(ndl)));
  float a = smLookup(uSunSM, uSunVP, wp + off, uSunTexel, 0.00012);
  float b = smLookup(uCarSM, uCarVP, wp + wn * 0.04, uCarTexel, 0.0004);
  return min(a, b);
}
`;

// Inject shadows into the standard materials. Chains onBeforeCompile, so it can be called after other injections
export function patchShadow(material, shadows, sunDirW) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    prev?.call(material, sh, r);
    Object.assign(sh.uniforms, shadows.uniforms, { uSunDirW: { value: sunDirW } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShW; varying vec3 vShN; uniform float uMirror;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        { vec4 swp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            swp = instanceMatrix * swp;
          #endif
          vShW = (modelMatrix * swp).xyz;
          vShN = normalize(inverseTransformDirection(transformedNormal, viewMatrix));
          vShW.y *= uMirror; vShN.y *= uMirror; }   // in the reflection (flipped vertically), sample shadows at the original coordinates`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vShW; varying vec3 vShN; uniform vec3 uSunDirW;\n${shadowGLSL}`)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
        float shadowF = sunShadowAt(vShW, normalize(vShN));
        // Underwater: sunlight fades with depth and caustics play on the bed
        float uwD = length(vShW.xz) < 430.0 ? uWaterYS - vShW.y : -1.0;   // only inside the lake circle
        float uwAtt = uwD > 0.0 ? exp(-uwD * 0.22) : 1.0;
        shadowF *= uwAtt;
        reflectedLight.directDiffuse *= shadowF; reflectedLight.directSpecular *= shadowF;
        #if NUM_DIR_LIGHTS > 0
          if (uwD > 0.0) reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color
            * caustic(vShW.xz, uTimeS) * max(dot(normalize(vShN), uSunDirW), 0.0) * shadowF * 0.45 * smoothstep(0.0, 0.4, uwD);
        #endif`);
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => (key ? key() : '') + '|sh';
  return material;
}
