// Car visuals: load the glb and baked textures exported from Blender (bake/car.py),
// and drive the body, glass and six wheels from the physics state.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const _q = new THREE.Quaternion(), _qs = new THREE.Quaternion(), _p = new THREE.Vector3();
const AX_Y = new THREE.Vector3(0, 1, 0), AX_X = new THREE.Vector3(1, 0, 0);

export async function tex(loader, url, srgb) {
  const t = await loader.loadAsync(url);
  t.flipY = false;                        // match the glTF UV convention
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

export async function loadCar(base, vehicle, setupMaterial, maxAniso = 8) {
  const tl = new THREE.TextureLoader();
  const [map, orm, emit, gltf] = await Promise.all([
    tex(tl, base + 'car_base.webp', true), tex(tl, base + 'car_orm.webp', false), tex(tl, base + 'car_emit.webp', true),
    new GLTFLoader().loadAsync(base + 'car.glb'),
  ]);
  for (const t of [map, orm, emit]) t.anisotropy = maxAniso;
  const paint = new THREE.MeshStandardMaterial({
    map, aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1,
    emissiveMap: emit, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 2.5, aoMapIntensity: 1,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x050607, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.2,
  });
  // Wetness: below the submerged height (car space) the paint turns darker and glossier, then slowly dries
  const wetU = { uWet: { value: 0 }, uWetH: { value: -9 } };
  paint.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, wetU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vLocalY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocalY = position.y;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLocalY; uniform float uWet, uWetH;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float wetM = uWet * smoothstep(uWetH + 0.08, uWetH - 0.08, vLocalY);
        diffuseColor.rgb *= mix(1.0, 0.55, wetM);
        roughnessFactor *= mix(1.0, 0.3, wetM);`);
  };
  paint.customProgramCacheKey = () => 'carpaint';
  setupMaterial?.(paint); setupMaterial?.(glass);

  const find = (n) => { let o = null; gltf.scene.traverse((c) => { if (c.isMesh && c.name.startsWith(n)) o = c; }); return o; };
  const bodyM = find('body'), glassM = find('glass'), wheelM = find('wheel');
  const group = new THREE.Group();
  const body = new THREE.Mesh(bodyM.geometry, paint);
  const win = new THREE.Mesh(glassM.geometry, glass);
  for (const m of [body, win]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }

  const wheels = vehicle.wheels.map((w) => {
    const m = new THREE.Mesh(wheelM.geometry, paint);
    m.castShadow = true; m.receiveShadow = true;
    m.scale.x = w.local.x > 0 ? 1 : -1;     // one wheel mesh with its outside at +X, mirrored for the right side
    return m;
  });

  // Headlights (at night and with H) and taillight glow
  const heads = [-1, 1].map((s) => {
    const l = new THREE.SpotLight(0xffe2b8, 0, 70, 0.42, 0.55, 1.6);
    l.position.set(s * 0.72, 1.26 - 1.107, 2.7);
    l.target.position.set(s * 0.72, -0.6, 14);
    group.add(l, l.target);
    return l;
  });

  function update(v) {
    group.position.copy(v.pos); group.quaternion.copy(v.quat);
    v.wheels.forEach((w, i) => {
      const m = wheels[i];
      v.wheelWorld(w, _p); m.position.copy(_p);
      _q.setFromAxisAngle(AX_Y, w.steer);
      _qs.setFromAxisAngle(AX_X, w.spin);   // rolling forward moves the top forward (same for the mirrored right side)
      m.quaternion.copy(v.quat).multiply(_q).multiply(_qs);
    });
  }

  let wetH = -9;
  function setWet(v, dt) {
    // Convert the water height to car space and remember the highest submersion
    const inv = v.quat.clone().invert();
    const lw = new THREE.Vector3(0, v.waterY, 0).sub(v.pos).applyQuaternion(inv).y;
    if (v.sub > 0) { wetH = Math.max(wetH, lw); wetU.uWet.value = 1; }
    else wetU.uWet.value = Math.max(0, wetU.uWet.value - dt / 25);
    if (wetU.uWet.value === 0) wetH = -9;
    wetU.uWetH.value = wetH;
  }
  return { group, wheels, heads, paint, glass, update, setWet };
}
