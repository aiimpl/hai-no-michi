// Startup and render loop. Physics runs at a fixed 1/240 s step, rendering on rAF.
import * as THREE from 'three';
import { loadTerrain, terrainGLSL, terrainUniforms, buildClipmap } from './terrain.js';
import { Vehicle } from './vehicle.js';
import { ChaseCam } from './cam.js';
import { loadCar, tex } from './car.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Input } from './input.js';
import { Shadows, patchShadow } from './shadows.js';
import { loadForest, noiseGLSL } from './forest.js';
import { loadGroundCover } from './groundcover.js';
import { makeSky } from './sky.js';
import { Post } from './post.js';
import { makeLake } from './lake.js';
import { Splash } from './splash.js';
import { makeGeothermal } from './geothermal.js';
import { loadProps } from './props.js';
import { makeFarRange } from './farrange.js';
import { shadowGLSL } from './shadows.js';
import { makeHUD } from './hud.js';
import { Sound } from './audio.js';
import { makeScript } from './script.js';

const W = 1350, H = 1080;          // reference frame size (5:4)
const Q = new URLSearchParams(location.search);
const RENDER = Q.has('render');   // recording: fixed time per frame, rendered at 2x resolution
const PR = RENDER ? 2 : 1;
const DT = 1 / 240;

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(PR);   // 1x for interactive play; recording renders at 2x and downsamples
renderer.setSize(W, H, false);
renderer.toneMapping = THREE.NoToneMapping;   // tone mapping happens in post.js

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, W / H, 0.3, 14000);

const T = await loadTerrain();
const TU = terrainUniforms(T);

// Sun: low 17:42 light. Azimuth puts it slightly left of straight ahead at the start of the road
const SUN_EL = THREE.MathUtils.degToRad(17), SUN_AZ = THREE.MathUtils.degToRad(-35);
const sunDir = new THREE.Vector3(Math.cos(SUN_EL) * Math.sin(SUN_AZ), Math.sin(SUN_EL), Math.cos(SUN_EL) * Math.cos(SUN_AZ));

const SUN_COLOR = new THREE.Color(1.0, 0.84, 0.64), SUN_I = 6.0;
const sunLight = new THREE.DirectionalLight(SUN_COLOR, SUN_I);
sunLight.position.copy(sunDir).multiplyScalar(100);
scene.add(sunLight, sunLight.target);
const hemi = new THREE.HemisphereLight(new THREE.Color(0.62, 0.66, 0.72), new THREE.Color(0.3, 0.24, 0.16), 0.3);
scene.add(hemi);
const shadows = new Shadows(renderer, sunDir);
const patch = (m) => patchShadow(m, shadows, sunDir);
const U = { uTime: { value: 0 }, uSunColor: { value: SUN_COLOR.clone().multiplyScalar(SUN_I) } };

// Sky: afternoon with breaks in the clouds (sky.js). The distance fades into the horizon haze color
const skyO = makeSky(sunDir, U.uSunColor.value, { uTime: U.uTime });
const sky = skyO.mesh;
scene.add(sky);
scene.fog = new THREE.FogExp2(new THREE.Color(0.5, 0.56, 0.62), 0.00055);

// Terrain: inject clipmap height, normals and surface shading into the standard material
function terrainMat(step) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, TU);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${terrainGLSL}\nattribute float aDip; varying vec3 vWP;`)
      .replace('#include <beginnormal_vertex>', `vec3 wp0 = (modelMatrix * vec4(position, 1.0)).xyz;\nvec3 objectNormal = tN(wp0.xz);`)
      .replace('#include <begin_vertex>', `vec3 transformed = position; transformed.y = tH(wp0.xz) - aDip;
        transformed.y -= smoothstep(1000.0, 1022.0, max(abs(wp0.x), abs(wp0.z))) * 400.0;   // outside the map, drop below the distant mountain range
        vWP = vec3(wp0.x, transformed.y, wp0.z);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${terrainGLSL}\n${noiseGLSL}\nvarying vec3 vWP;`)
      .replace('#include <normal_fragment_begin>', `float faceDirection = 1.0;
        vec3 normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
        vec3 nonPerturbedNormal = normal;`)
      .replace('#include <color_fragment>', `
        // Ground: black volcanic ash. Large-scale variation, patches of dry ash, fine grain. Roads are packed ash with ruts, shores are sand, cliffs are rock
        vec3 wN = tN(vWP.xz);
        vec4 rfd = roadField(vWP.xz);
        vec2 ruv = rfd.xy;
        float geo = rfd.w;
        float geoWet = 0.0;
        vec2 P = vWP.xz;
        float slope = wN.y;
        // fade fine detail once it gets small on screen (prevents distant shimmer)
        float px = length(fwidth(P));
        float aF = 1.0 - smoothstep(0.08, 0.3, px), aG = 1.0 - smoothstep(0.03, 0.09, px);
        float big = ffbm(P * 0.012), mid = ffbm(P * 0.09 + 7.0);
        float fine = mix(0.5, fnoise(P * 3.1), aF), grain = mix(0.5, fnoise(P * 11.0), aG);
        float patchy = smoothstep(0.48, 0.62, ffbm(P * 0.21 + big * 2.0));
        vec3 ash = mix(vec3(0.022, 0.021, 0.019), vec3(0.034, 0.031, 0.027), big);
        ash = mix(ash, vec3(0.058, 0.052, 0.045), patchy * 0.8);                  // dry, whitish ash
        ash = mix(ash, vec3(0.03, 0.036, 0.02), smoothstep(0.55, 0.75, mid) * 0.5); // hint of moss green
        ash *= 0.82 + 0.3 * fine + 0.12 * grain;
        vec3 col = ash;
        // Steep slopes: dark jointed lava. Vertical fractures, layer bands, and ash settled on top
        float strata = ffbm(vec2(dot(P, vec2(0.7, 0.7)) * 0.08, vWP.y * 0.9));
        float joint = smoothstep(0.08, 0.0, abs(fract(ffbm(P * 0.15) * 6.0) - 0.5) - 0.42);
        vec3 rock = mix(vec3(0.028, 0.026, 0.024), vec3(0.06, 0.056, 0.05), strata) * (1.0 - 0.45 * joint) * (0.85 + 0.3 * fine);
        col = mix(col, rock, smoothstep(0.8, 0.5, slope) * 0.9);
        // Jigokudani: white crust, sulfur yellow around the vents, rust-red streaks, wet grey mud in the low spots
        if (geo > 0.01) {
          float crustN = ffbm(P * 0.18 + 31.0), sulN = ffbm(P * 0.5 + 7.0), ironN = ffbm(P * 0.11 + 3.0), tone = ffbm(P * 0.04 + 13.0);
          // Crust: off-white to ochre-grey. Grain and color variation so it doesn't read as a flat surface
          vec3 crust = mix(vec3(0.11, 0.105, 0.095), vec3(0.2, 0.19, 0.165), smoothstep(0.3, 0.75, crustN));
          crust = mix(crust, crust * vec3(1.1, 1.0, 0.78), smoothstep(0.4, 0.7, tone));
          crust *= 0.72 + 0.35 * fine + 0.18 * grain;
          vec3 g = mix(col, crust, smoothstep(0.1, 0.5, geo));
          // Sulfur: small deposits where venting is strongest (the valley core)
          float sul = smoothstep(0.7, 0.84, sulN + grain * 0.08) * smoothstep(0.55, 0.95, geo);
          g = mix(g, vec3(0.3, 0.24, 0.045) * (0.7 + 0.5 * fine), sul * 0.85);
          g = mix(g, vec3(0.13, 0.055, 0.02) * (0.8 + 0.4 * fine), smoothstep(0.64, 0.8, ironN) * 0.55 * geo);
          float wetM = smoothstep(0.5, 0.2, ffbm(P * 0.12 + 9.0)) * smoothstep(0.5, 0.9, geo);
          g = mix(g, vec3(0.07, 0.07, 0.068), wetM * 0.8);
          col = mix(col, g, smoothstep(0.02, 0.3, geo));
          geoWet = wetM * 0.8;
        }
        // Outer rim and outer slopes: forest canopy, rocky ridges, gully scree, high meadows, split by curvature (ridge vs. gully), slope and height.
        // From afar the ground color itself must read as forest, so canopy mottling and gap shadows are painted here
        float rr = length(P);
        float mtn = smoothstep(430.0, 560.0, rr) * (1.0 - smoothstep(0.02, 0.2, geo));
        float curv = 0.0, curvL = 0.0; vec2 crownG = vec2(0.0); float forestK = 0.0;
        if (mtn > 0.001) {
          float h0 = vWP.y;
          curv = (tH(P + vec2(9.0, 0.0)) + tH(P - vec2(9.0, 0.0)) + tH(P + vec2(0.0, 9.0)) + tH(P - vec2(0.0, 9.0)) - 4.0 * h0) / 81.0;
          curvL = (tH(P + vec2(40.0, 0.0)) + tH(P - vec2(40.0, 0.0)) + tH(P + vec2(0.0, 40.0)) + tH(P - vec2(0.0, 40.0)) - 4.0 * h0) / 1600.0;
          float ridgeK = smoothstep(0.004, 0.03, -curv - curvL * 2.0);          // ridge (convex)
          float gully = smoothstep(0.004, 0.03, curv + curvL * 2.0);           // gully (concave)
          float steepK = smoothstep(0.5, 0.36, slope);             // rock only where steeper than 60 deg
          float highK = smoothstep(250.0, 310.0, h0 + 40.0 * (ffbm(P * 0.01) - 0.5) - curvL * 1500.0);
          // Canopy: two scales of mottling. Gaps are dark; sunlit clumps slightly yellow-green
          vec4 cf = crownField(P, 4.2 / max(px, 1e-3));
          // Canopy: dark blue-green treetops, near-black shadow in the gaps. Averages to dark green in the distance
          // Forest floor: dark soil and leaf litter under the trees (the trees themselves are drawn by the placed instances)
          vec3 canopy = mix(vec3(0.006, 0.007, 0.005), vec3(0.012, 0.015, 0.008), ffbm(P * 0.2)) * (0.8 + 0.3 * fine);
          canopy = mix(canopy, canopy * vec3(1.6, 1.35, 0.9), smoothstep(0.64, 0.82, ffbm(P * 0.02 + 17.0)) * 0.6);   // brighter bands where broadleaf trees mix in
          // Rock: layer bands and joints. Appears on ridges and steep ground
          float strataM = ffbm(vec2(dot(P, vec2(0.6, 0.8)) * 0.05, h0 * 0.35));
          float jointM = smoothstep(0.62, 0.72, fnoise(vec2(dot(P, vec2(0.8, -0.6)) * 0.35, h0 * 0.08)));   // vertical fractures
          vec3 rockM = mix(vec3(0.028, 0.027, 0.025), vec3(0.065, 0.062, 0.056), strataM) * (1.0 - 0.5 * jointM) * (0.8 + 0.35 * fine);
          // Scree: fans of bright crushed rock below gullies
          vec3 scree = mix(vec3(0.06, 0.058, 0.055), vec3(0.1, 0.096, 0.09), fine) * (0.85 + 0.25 * grain);
          // High meadows: late-summer yellow-green and dry straw
          vec3 meadow = mix(vec3(0.05, 0.06, 0.022), vec3(0.1, 0.095, 0.04), ffbm(P * 0.05 + 51.0)) * (0.85 + 0.3 * fine);
          crownG = cf.yz; forestK = 1.0 - clamp((steepK * 0.85 + ridgeK * (0.1 + 0.8 * highK) + highK * 0.6), 0.0, 1.0);
          vec3 m = canopy;
          m = mix(m, meadow, highK * (1.0 - gully * 0.7));
          float rockAmt = clamp(steepK * 0.85 + ridgeK * 0.8 * highK, 0.0, 1.0) * smoothstep(0.35, 0.55, ffbm(P * 0.04 + 5.0) + steepK * 0.4);
          m = mix(m, rockM, rockAmt);
          m = mix(m, scree, gully * steepK * 0.6);
          col = mix(col, m, mtn);
        }
        // Shore: sand and pumice within 2.5 m of the waterline, darker and wetter closer to the water
        float beach = smoothstep(2.8, 0.4, vWP.y) * smoothstep(-2.0, 0.1, vWP.y);
        vec3 sand = mix(vec3(0.16, 0.14, 0.115), vec3(0.24, 0.22, 0.19), fine) * mix(0.55, 1.0, smoothstep(0.0, 0.6, vWP.y));
        col = mix(col, sand, beach);
        // Road: packed ash. Two straight ruts at the car's wheel positions (±0.93 m from center, 0.5 m wide).
        // Inside the ruts are tread marks: two rows offset by half a pitch, running diagonally (34-lug tire, 3.64 m circumference).
        // Arc length wraps every 64 m, so the lug spacing is 0.10667 m, which divides 64 m evenly
        float road = 1.0 - smoothstep(3.0, 5.2 + 1.2 * mid, abs(ruv.x) + (fine - 0.5) * 0.8);
        float rut = 0.0, lug = 0.0;
        float fwY = max(fwidth(ruv.y), 1e-4);
        for (int k = 0; k < 2; k++) {
          float c = k == 0 ? -0.93 : 0.93;
          float dd = ruv.x - c;
          float inT = 1.0 - smoothstep(0.2, 0.28, abs(dd));
          rut = max(rut, inT);
          float row = dd > 0.0 ? 0.5 : 0.0;
          float ph = ruv.y / 0.10667 + row + abs(dd) * 1.2 * (dd > 0.0 ? 1.0 : -1.0);
          float g = abs(fract(ph) - 0.5);
          float aa = fwY / 0.10667 * 1.5;
          float l = 1.0 - smoothstep(0.22 - aa, 0.22 + aa, g);
          lug = max(lug, l * inT * (1.0 - smoothstep(0.02, 0.06, fwY)));
        }
        vec3 rc = mix(vec3(0.05, 0.045, 0.038), vec3(0.075, 0.066, 0.055), patchy * 0.7 + fine * 0.3);
        rc = mix(rc, vec3(0.034, 0.031, 0.027), rut * 0.75);             // ruts: compacted and darker
        rc = mix(rc, vec3(0.024, 0.022, 0.019), lug * 0.6);              // tread marks: deeper still
        col = mix(col, rc, road);
        diffuseColor.rgb = col;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.35, geoWet);')
      .replace('#include <normal_fragment_maps>', `
        // Fine relief: perturb the normal using grain and rut grooves as height
        { float hh = (fnoise(vWP.xz * 3.1) * 0.6 * aF + fnoise(vWP.xz * 11.0) * 0.25 * aG) - (rut * 0.8 + lug * 0.35) * road * aF
            + mtn * (fnoise(vWP.xz * 0.45 + 9.0) * 6.0 + fnoise(vWP.xz * 1.3) * 2.0) * (1.0 - smoothstep(0.5, 0.75, slope) * 0.6);   // canopy relief
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec3 grad = sign(det) * (dFdx(hh) * r1 + dFdy(hh) * r2) * 0.05;
          normal = normalize(abs(det) * normal - grad);
          // Canopy: tilt the normal by the rounded crown surface (each tree brighter on the sunny side, darker on the shadow side)
          if (false) {
            vec3 cw = normalize(vec3(crownG.x, 0.0, crownG.y) * 1.3 * forestK * mtn + wN);
            normal = normalize((viewMatrix * vec4(cw, 0.0)).xyz);
          } }`);
  };
  m.customProgramCacheKey = () => 'terrain';
  return patch(m);
}
const terrain = buildClipmap(terrainMat);
scene.add(terrain);
// Distant mountain range (beyond the map)
const far = await makeFarRange('data/', null, noiseGLSL);
scene.add(far.mesh);


// Car: modeled and baked in Blender
const car = new Vehicle(T);
const carV = await loadCar('data/', car, patch, renderer.capabilities.getMaxAnisotropy());
scene.add(carV.group);
for (const w of carV.wheels) scene.add(w);

// Environment for reflections: PMREM built from a sphere rendered with sky only
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
// The PMREM camera only sees 0.1-100 m, so the sky sphere is shrunk to 80 m (the sky shader only uses direction)
const envSky = new THREE.Mesh(sky.geometry, sky.material); envSky.scale.setScalar(0.01);
envScene.add(envSky);
// Ground: dark ash and forest color (bounce light from below)
const envGround = new THREE.Mesh(new THREE.CircleGeometry(75, 32).rotateX(-Math.PI / 2).translate(0, -1.5, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.035, 0.038, 0.03) }));
envScene.add(envGround);
scene.environment = pmrem.fromScene(envScene, 0.02).texture;
// Reflection strength: keep ground and foliage subdued (so sky blue doesn't leak too far into shadows)
scene.traverse((o) => { if (o.material && o.material.isMeshStandardMaterial && o.material !== carV.paint) o.material.envMapIntensity = 0.8; });

// Forest
const envU = {
  uHemiSky: { value: new THREE.Color(0.62, 0.66, 0.72).multiplyScalar(0.3) }, uHemiGround: { value: new THREE.Color(0.3, 0.24, 0.16).multiplyScalar(0.3) },
  uEnvAmb: { value: new THREE.Vector3(0.1, 0.11, 0.12) }, uFogColor: { value: scene.fog.color }, uFogDensity: { value: scene.fog.density },
};
const forest = await loadForest('data/', U, patch, shadows, envU);
scene.add(forest.group);

// Observatory: front (annex side) faces the road
const obsPos = new THREE.Vector3(T.meta.obs[0], T.meta.obs[2] - 0.2, -T.meta.obs[1]);
const obs = await (async () => {
  const tl = new THREE.TextureLoader();
  const [map, orm, emit, g] = await Promise.all([tex(tl, 'data/obs_base.webp', true), tex(tl, 'data/obs_orm.webp', false),
    tex(tl, 'data/obs_emit.webp', true), new GLTFLoader().loadAsync('data/observatory.glb')]);
  const m = patch(new THREE.MeshStandardMaterial({ map, aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1,
    emissiveMap: emit, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 3.0 }));
  let geo = null; g.scene.traverse((c) => { if (c.isMesh) geo = c.geometry; });
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.copy(obsPos);
  mesh.rotation.y = Math.atan2(-obsPos.x, -obsPos.z);
  return mesh;
})();
scene.add(obs);
// Scenery props (shrine, pier, sulfur hut, mountain hut, jizo statues)
const props = await loadProps('data/', T, patch);
scene.add(props.group);
// Collision circles: base, annex and tower (from the observatory position), plus nearby tree trunks
const obsCircles = (() => {
  const c = [], q = new THREE.Quaternion().setFromEuler(obs.rotation);
  const at = (bx, by, r) => { const v = new THREE.Vector3(bx, 0, -by).applyQuaternion(q).add(obsPos); c.push({ x: v.x, z: v.z, r }); };
  at(0, 0, 15.2);
  for (let k = -2; k <= 2; k++) at(6 + k * 4, -19.5, 3.2);
  at(-22.5, 4, 2.6);
  return c;
})();

// Ground cover: ferns, grass, stones
const ground = await loadGroundCover('data/', U, patch, T, forest.color);
scene.add(ground.group);

// Static shadows: forest (mid-LOD form) and coarse terrain, rendered once from the sun
for (const s of forest.shadowSets) { shadows.addCaster(s.L, { alphaMap: forest.color }); shadows.addCaster(s.T); }
for (const m of forest.snags) shadows.addCaster(m);
for (const m of ground.shadowCasters()) shadows.addCaster(m);
shadows.addCaster(obs);
for (const m of props.meshes) shadows.addCaster(m);
{
  const S = 2100, n = 526, g = new THREE.PlaneGeometry(S, S, n - 1, n - 1).rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, T.height(p.getX(i), p.getZ(i)) - 0.3);
  g.computeVertexNormals();
  shadows.addCaster(new THREE.Mesh(g));
}
shadows.renderStatic(new THREE.Vector3(0, 30, 0));
// Car shadow: body and wheels every frame
for (const m of [...carV.group.children.filter((c) => c.isMesh), ...carV.wheels]) shadows.addCaster(m, { car: true });

// Start: the rim road's east edge, heading counterclockwise
// Place on a road: at arc length s on road ri, aligned with the road direction
function placeAt(ri, s, dir = 1) { const p = T.roads.at(ri, s); car.place(p.x, p.z, Math.atan2(p.tx, p.tz) + (dir < 0 ? Math.PI : 0)); }
function startAt(deg) {       // rim road, by bearing (degrees)
  const t = THREE.MathUtils.degToRad(deg), n = T.roads.nearest(330 * Math.cos(t), -330 * Math.sin(t), 0);
  placeAt(0, n.s);
}
function placeOnRoad() {      // snap to the nearest road, keeping the side we're facing as forward
  const n = T.roads.nearest(car.pos.x, car.pos.z);
  const h = car.heading(), fwd = Math.sin(h) * n.tx + Math.cos(h) * n.tz >= 0;
  const p = T.roads.at(n.road, n.s);
  car.place(p.x, p.z, Math.atan2(p.tx, p.tz) + (fwd ? 0 : Math.PI));
}
startAt(334);
car.onFlip = () => placeOnRoad();
car.obstacles = (p) => {
  const out = [];
  if (p.distanceTo(obsPos) < 60) out.push(...obsCircles);
  for (const c of props.circles) if (Math.hypot(c.x - p.x, c.z - p.z) < 30) out.push(c);
  const F = forest.inst;
  for (const i of forest.near(p.x, p.z, 10)) out.push({ x: F.x[i], z: F.z[i], r: 0.28 * F.s[i] * (F.k[i] === 2 ? 0.5 : 1) });
  return out;
};

const post = new Post(renderer, W * PR, H * PR);

// Lake: reflection renders the world flipped vertically at half resolution (lake.js)
const rtRefl = new THREE.WebGLRenderTarget(W * PR / 2, H * PR / 2, { type: THREE.HalfFloatType, depthBuffer: true });
const lake = makeLake(T, rtRefl, post.refr, U, skyO.uniforms, TU, Object.assign({ uSunDirW: { value: sunDir } }, shadows.uniforms),
  { uFogColor: { value: scene.fog.color }, uFogDensity: { value: scene.fog.density } }, shadowGLSL);
const world = new THREE.Group();
for (const c of [...scene.children]) world.add(c);
scene.add(world);
// Water surface and splashes are composited after the world below is rendered and captured (post.js overlay)
const waterScene = new THREE.Scene();
waterScene.add(lake.mesh);
const splash = new Splash(T.meta.water, (x, z, s) => lake.ripple(x, z, s));
splash.uniforms.uH.value = H * PR;
waterScene.add(splash.points);
// Jigokudani: hot pools go into the world; steam is composited afterward like the water surface
const geoth = makeGeothermal(T.meta, skyO.uniforms, U);
const steamPts = geoth.group.children.find((c) => c.isPoints);
geoth.group.remove(steamPts); waterScene.add(steamPts);
world.add(geoth.group);
geoth.steamU.uH.value = H * PR;
shadows.uniforms.uWaterYS.value = T.meta.water;
car.waterY = T.meta.water;
car.onSplash = (pt, vy, v) => { if (vy > 1.2) { splash.burst(pt, vy, v); sound.splash?.(Math.min(vy / 6, 1.5)); } };
const recover = () => { placeOnRoad(); car.resetWater(); cam.snap(car); };
car.onSunk = recover;
addEventListener('keydown', (e) => { if (e.code === 'KeyR') recover(); });
// Underwater haze (when the camera goes below the water surface)
const fogAir = { color: scene.fog.color.clone(), density: scene.fog.density };
let under = 0;
function setUnder(u) {
  if (u === under) return;
  under = u;
  if (u) { scene.fog.color.setRGB(0.008, 0.045, 0.05); scene.fog.density = 0.032; }
  else { scene.fog.color.copy(fogAir.color); scene.fog.density = fogAir.density; }
  envU.uFogDensity.value = scene.fog.density;
  sound.setUnder?.(u);
}
const clipUnder = new THREE.Plane(new THREE.Vector3(0, -1, 0), T.meta.water);
const lakeSphere = new THREE.Sphere(new THREE.Vector3(0, T.meta.water, 0), 430);
const _fr = new THREE.Frustum(), _pm = new THREE.Matrix4();
function renderReflection() {
  _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); _fr.setFromProjectionMatrix(_pm);
  if (!_fr.intersectsSphere(lakeSphere)) return;
  world.scale.y = -1; world.updateMatrixWorld(true);
  shadows.uniforms.uMirror.value = -1;
  lake.mesh.visible = false; ground.group.visible = false;
  renderer.clippingPlanes = [clipUnder];
  renderer.setRenderTarget(rtRefl); renderer.render(scene, camera);
  renderer.clippingPlanes = [];
  world.scale.y = 1; world.updateMatrixWorld(true);
  shadows.uniforms.uMirror.value = 1;
  lake.mesh.visible = true; ground.group.visible = true;
}
let EXPOSURE = 1.0;
const input = new Input(canvas);
const cam = new ChaseCam(camera, T);
cam.snap(car);
addEventListener('keydown', (e) => { if (e.code === 'KeyV') cam.toggle(); });

// On-screen text
const hud = makeHUD(document.getElementById('hud'));
const OBS = new THREE.Vector3(T.meta.obs[0], T.meta.obs[2], -T.meta.obs[1]);
addEventListener('keydown', (e) => { if (e.code === 'KeyP') document.getElementById('hud').classList.toggle('hide'); });

// Audio: starts on the first user input (browser autoplay policy)
const sound = new Sound();
const startSound = () => sound.start();
addEventListener('keydown', startSound, { once: true });
addEventListener('pointerdown', startSound, { once: true });

// Day/night and lights: N for night (sun off, moonlight), L for headlights, H for high beams
const MODE = { night: false, lights: false, high: false };
// Time of day: light, sky, haze, exposure and lamps are all derived continuously from sun elevation el and azimuth az (degrees).
// After sunset the same light rig is re-aimed at the moon (the swap happens when light is near 0, so there's no pop).
// When the sun moves, the static shadow map is redrawn too.
const TOD = { el: 17, az: -35, dirty: true };
let envDirty = true;
// Rebuild the reflection environment. Building it mid-update yields an empty environment, so always call right before rendering
const envCubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
const envCubeCam = new THREE.CubeCamera(0.1, 200, envCubeRT);
envScene.add(envCubeCam);
let envPM = null;
function refreshEnv() {
  if (!envDirty) return;
  // Render the sky into a small cube, then convert it to a blurred reflection map (PMREM)
  const prev = renderer.getRenderTarget(), ac = renderer.autoClear;
  renderer.autoClear = true;
  envCubeCam.update(renderer, envScene);
  renderer.setRenderTarget(prev); renderer.autoClear = ac;
  const next = pmrem.fromCubemap(envCubeRT.texture, envPM || undefined);
  envPM = next;
  scene.environment = next.texture;
  envDirty = false;
}
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
const sm = THREE.MathUtils.smoothstep;
let lastShadowDir = new THREE.Vector3(), lastEnv = { dusk: -1, night: -1 };
function setTOD(el, az, { force = false, exp = 1 } = {}) {
  TOD.el = el; TOD.az = az;
  const up = sm(el, -2.5, 3.5), dusk = 1 - sm(el, 3, 15), night = 1 - sm(el, -8, -3);
  const moon = el < -1.5;
  const lel = THREE.MathUtils.degToRad(moon ? 38 : Math.max(el, 0.4)), laz = THREE.MathUtils.degToRad(moon ? az + 150 : az);
  sunDir.set(Math.cos(lel) * Math.sin(laz), Math.sin(lel), Math.cos(lel) * Math.cos(laz));
  sunLight.position.copy(sunDir).multiplyScalar(100);
  // Sun color: warm white by day, shifting through orange to crimson as it lowers (longer path through the atmosphere)
  _c1.setRGB(1.0, 0.84, 0.64).lerp(_c2.setRGB(1.0, 0.42, 0.14), dusk ** 1.4);
  const sunI = SUN_I * up * (1 - 0.35 * dusk), moonI = 0.55 * night;
  const MOON = _c2.setRGB(0.55, 0.66, 1.0);
  const col = moon ? MOON.clone() : _c1.clone(), I = moon ? moonI : sunI;
  sunLight.color.copy(col); sunLight.intensity = I;
  U.uSunColor.value.copy(col).multiplyScalar(I);
  // Sky light: daytime blue -> purplish grey at dusk -> navy at night
  const skyDay = new THREE.Color(0.62, 0.66, 0.72), skyDusk = new THREE.Color(0.5, 0.42, 0.52), skyNight = new THREE.Color(0.1, 0.13, 0.22);
  hemi.color.copy(skyDay).lerp(skyDusk, dusk).lerp(skyNight, night);
  hemi.groundColor.setRGB(0.3, 0.24, 0.16).lerp(new THREE.Color(0.18, 0.12, 0.1), dusk).lerp(new THREE.Color(0.02, 0.02, 0.03), night);
  hemi.intensity = THREE.MathUtils.lerp(THREE.MathUtils.lerp(0.3, 0.42, dusk), 0.55, night);
  envU.uHemiSky.value.copy(hemi.color).multiplyScalar(hemi.intensity); envU.uHemiGround.value.copy(hemi.groundColor).multiplyScalar(hemi.intensity);
  skyO.uniforms.uNight.value = night; skyO.uniforms.uDusk.value = dusk * (1 - night);
  // Haze: grey by day, tinted by the sun at dusk, dark navy at night
  fogAir.color.setRGB(0.5, 0.56, 0.62).lerp(new THREE.Color(0.5, 0.34, 0.26), dusk * 0.8).lerp(new THREE.Color(0.012, 0.014, 0.02), night);
  if (!under) scene.fog.color.copy(fogAir.color);
  EXPOSURE = THREE.MathUtils.lerp(THREE.MathUtils.lerp(1.0, 1.25, dusk), 2.2, night) * exp;
  // Lamps: switch on when it gets dark (L for manual). Observatory and hut windows brighten toward night
  const on = MODE.lights || night > 0.35;
  for (const h of carV.heads) { h.intensity = on ? (MODE.high ? 900 : 380) * Math.max(0.5, night) : 0; h.angle = MODE.high ? 0.32 : 0.46; h.distance = MODE.high ? 140 : 70; }
  carV.paint.emissiveIntensity = on ? 5.0 : 2.5;
  obs.material.emissiveIntensity = 3.0 + 9.0 * night;
  // Shadows: redraw when the light direction moves by 0.1 deg or more
  if (force || sunDir.angleTo(lastShadowDir) > 0.0017) { shadows.renderStatic(new THREE.Vector3(0, 30, 0)); lastShadowDir.copy(sunDir); }
  // Reflection environment: rebuild when the sky color changes
  if (force || Math.abs(dusk - lastEnv.dusk) > 0.03 || Math.abs(night - lastEnv.night) > 0.03) {
    envDirty = true;                                       // rebuild right before rendering (refreshEnv)
    lastEnv = { dusk, night };
  }
  const hh = 17 + (17 - el) / 4.2 * 0.33;              // displayed clock time (approximate)
  const hm = Math.max(0, Math.floor(hh)), mm = Math.floor((hh - hm) * 60);
  hud.setWeather(night > 0.5 ? 'CLEAR NIGHT' : dusk > 0.5 ? 'SUNSET' : 'BROKEN CLOUD AFTERNOON',
    night > 0.9 ? '21:40' : `${hm}:${String(mm).padStart(2, '0')}`);
  hud.setButton('time', night > 0.5);
}
function applyMode() { setTOD(MODE.night ? -14 : 17, TOD.az, { force: true }); }
addEventListener('keydown', (e) => {
  if (e.code === 'KeyN') { MODE.night = !MODE.night; applyMode(); }
  if (e.code === 'KeyL') { MODE.lights = !MODE.lights; applyMode(); }
  if (e.code === 'KeyH') { MODE.high = !MODE.high; applyMode(); }
});
hud.onButton((k) => {
  if (k === 'time') { MODE.night = !MODE.night; applyMode(); }
  if (k === 'music') { sound.start(); sound.music = !sound.music; hud.setButton('music', sound.music); }
  if (k === 'shot') document.getElementById('hud').classList.toggle('hide');
});

let forestStats = null;
let acc = 0, last = performance.now(), frames = 0, fpsT = 0, fps = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  input.apply(car.input);
  if (auto) autopilot(car.input);
  acc += dt;
  while (acc >= DT) { car.step(DT); acc -= DT; }
  update(dt);
  refreshEnv();
  renderReflection();
  post.render(scene, camera, { exposure: EXPOSURE, t: U.uTime.value, overlay: waterScene, under });
  frames++; fpsT += dt; if (fpsT > 1) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  requestAnimationFrame(frame);
}

const _p = new THREE.Vector3();
function update(dt) {
  carV.update(car);
  lake.update(dt, car);
  if (car.sub > 0.05 && car.pos.y < T.meta.water && Math.hypot(car.pos.x, car.pos.z) < 430) splash.bubbles(car.pos, car.flood * 1.5 + car.sub * 0.8, dt);
  splash.update(dt, U.uTime.value);
  geoth.update(dt, camera);
  props.update(U.uTime.value);
  far.update();
  geoth.steamU.uAmb.value.copy(hemi.color).multiplyScalar(hemi.intensity);
  shadows.uniforms.uTimeS.value = U.uTime.value;
  carV.setWet(car, dt);
  cam.update(dt, car, input);
  setUnder(camera.position.y < T.meta.water - 0.05 && Math.hypot(camera.position.x, camera.position.z) < 430 ? 1 : 0);
  splash.uniforms.uSunCol.value.copy(U.uSunColor.value); splash.uniforms.uAmb.value.copy(hemi.color).multiplyScalar(hemi.intensity);
  terrain.userData.follow(camera.position);
  sky.position.copy(camera.position);
  if (!RENDER) U.uTime.value += dt;
  skyO.uniforms.uCloudT.value = U.uTime.value;
  forestStats = forest.update(camera);
  ground.update(camera);
  shadows.renderCar(car.pos);
  shadows.updateView(camera);
  // Bearing: north (Blender +Y = three -Z) is 0 deg, clockwise
  const hd = (THREE.MathUtils.radToDeg(Math.atan2(Math.sin(car.heading()), -Math.cos(car.heading()))) + 360) % 360;
  const rn = T.roads.nearest(car.pos.x, car.pos.z);
  const zone = rn.d < 40 ? T.roads.zone(rn.road, rn.s) : null;
  const near = car.pos.distanceTo(OBS) < 120;
  hud.update({ kmh: car.speed * 3.6, heading: hd, zone, status: car.dead ? 'ENGINE FLOODED · R TO RECOVER' : near ? 'BEACON 1420 MHZ' : 'ENGINE WARM', t: U.uTime.value });
  const rough = car.wheels.reduce((a, w) => a + Math.abs(w.comp - w.prevComp), 0) * 40;
  sound.update(dt, { kmh: car.speed * 3.6, throttle: car.dead ? 0 : car.input.throttle, rough: Math.min(rough, 1), dead: car.dead, sub: car.sub });
}

// Autopilot (for testing): steer toward a point slightly ahead on the road centerline and hold a target speed
let auto = null;
function autopilot(inp) {
  // Steer toward a point slightly ahead on the centerline and hold the target speed. auto.road picks the road, auto.dir the direction (+1 = increasing arc length)
  const only = auto.road != null ? T.roads.byName[auto.road] : (auto._road ?? -1);
  const n = T.roads.nearest(car.pos.x, car.pos.z, only);
  auto._road = n.road;
  const h = car.heading();
  const dir = auto.dir ?? (Math.sin(h) * n.tx + Math.cos(h) * n.tz >= 0 ? 1 : -1);
  const ahead = 9 + Math.abs(car.speed) * 0.9;
  const p = T.roads.at(n.road, n.s + dir * ahead);
  const off = auto.offset || 0;
  const tx = p.x - p.tz * off * dir, tz = p.z + p.tx * off * dir;
  let d = Math.atan2(tx - car.pos.x, tz - car.pos.z) - h;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  inp.steer = THREE.MathUtils.clamp(d * 2.2, -1, 1);
  // Slow down for upcoming curves (max lateral 0.35 g). Curvature comes from the heading change 25 m and 50 m ahead
  let vcap = 99;
  for (const L of [15, 30, 50]) {
    const q = T.roads.at(n.road, n.s + dir * L);
    const dth = Math.abs(Math.atan2(q.tx * n.tz - q.tz * n.tx, q.tx * n.tx + q.tz * n.tz));
    const Rr = L / Math.max(dth, 1e-3);
    vcap = Math.min(vcap, Math.sqrt(0.35 * 9.81 * Rr) + L * 0.12);
  }
  const err = Math.min(auto.kmh / 3.6, vcap) - car.speed;
  inp.throttle = THREE.MathUtils.clamp(err * 0.5, -1, 1);
  inp.brake = 0; inp.boost = 0;
}

// Testing hook: read state and set input, position and camera
window.__dbg = {
  T, car, cam, camera, scene, renderer,
  state: () => ({ fps: +fps.toFixed(1), kmh: +(car.speed * 3.6).toFixed(1), pos: car.pos.toArray().map(v => +v.toFixed(2)),
    road: (({ road, s, v, d }) => ({ road, s: +s.toFixed(1), v: +v.toFixed(2), d: +d.toFixed(2) }))(T.roads.nearest(car.pos.x, car.pos.z)), wheels: car.wheels.map(w => +w.comp.toFixed(3)),
    tris: renderer.info.render.triangles, calls: renderer.info.render.calls, forest: forestStats }),
  drive: (o) => Object.assign(input.forced, o),
  startAt,
  auto: (o) => { auto = o; },
  placeAt: (name, s) => placeAt(T.roads.byName[name], s),
  carV, forest, shadows, hemi, sunLight, U, post, skyO, obs, MODE, applyMode, sound, lake, splash, recover, props,
  setTOD, sunDir, TOD, getExposure: () => EXPOSURE, getUnder: () => under, envU, geoth,
  setExposure: (e) => { EXPOSURE = e; },
};
// Recording: drive the car and camera according to the script (script.js)
let simT = 0;
let curScene = null;
const SCRIPT = makeScript(T, props.sites);
const plan = SCRIPT.plan;
// Place the car at the start of a shot and run it up to speed first (so the first frame of a cut isn't stationary)
function enterScene(S, p) {
  curScene = S;
  if (S.start) car.place(S.start.x, S.start.z, S.start.heading); else placeAt(T.roads.byName[S.road], S.s0, S.dir);
  car.resetWater();
  const h = car.heading(), v = p.kmh / 3.6;
  for (let i = 0; i < 360; i++) { car.step(DT); car.vel.x = 0; car.vel.z = 0; }
  car.vel.x = Math.sin(h) * v; car.vel.z = Math.cos(h) * v;
  lake.update(1, car);
  splash.clear();                                              // clear particles from the previous shot
  setTOD(p.tod.el, p.tod.az, { force: true, exp: p.tod.exp ?? 1 });
  envDirty = true;              // rebuild the environment right before rendering this frame (building it mid-cut yields an empty sky)
}
function scripted(dt) {
  const p = plan(simT);
  if (p.scene !== curScene) enterScene(p.scene, p);
  auto = { kmh: p.kmh, offset: p.offset, road: p.road, dir: p.dir };
  if (p.offRoad) { car.input.steer = 0; car.input.throttle = car.dead ? 0 : 1; car.input.brake = 0; car.input.boost = 0; }
  else autopilot(car.input);
  for (let i = 0; i < Math.round(dt / DT); i++) car.step(DT);
  simT += dt;
  const q = plan(simT);
  if (q.scene === curScene) setTOD(q.tod.el, q.tod.az, { exp: q.tod.exp ?? 1 });
  cam.free = curScene.cam(simT, car);
}
window.__renderAt = (f, fps = 30) => {
  const t = f / fps;
  while (simT < t - 1e-6) { scripted(1 / fps); U.uTime.value = simT; update(1 / fps); }
  refreshEnv();
  renderReflection();
  post.render(scene, camera, { exposure: EXPOSURE, t: simT, overlay: waterScene, under, thresh: 1.2 * Math.max(1, EXPOSURE) * 1.6 });
  const gl = renderer.getContext(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  return { t: +simT.toFixed(3), kmh: +(car.speed * 3.6).toFixed(1), road: T.roads.nearest(car.pos.x, car.pos.z).road, s: +T.roads.nearest(car.pos.x, car.pos.z).s.toFixed(1) };
};
if (RENDER) { enterScene(plan(0).scene, plan(0)); cam.free = curScene.cam(0, car); document.getElementById('hud').classList.add('cine'); }
// Render the car shadow map once up front (so the first frame doesn't sample an empty map)
update(0);
if (!RENDER) requestAnimationFrame(frame);
window.__ready = true;
