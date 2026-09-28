// Place the scenery props (bake/props.py): the cape shrine (torii, main hall, stone lanterns), the lakeside pier, boathouse and boat,
// the sulfur hut and boardwalk to a hot pool at Jigokudani, the pass hut and Jizo statue. Positions are derived from the terrain and roads.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { tex } from './car.js';

const rad = (d) => d * Math.PI / 180;
// Blender (x, y) -> three.js (x, -y)
const b2t = (x, y) => new THREE.Vector3(x, 0, -y);

export async function loadProps(base, T, patch) {
  const tl = new THREE.TextureLoader();
  const [map, orm, g] = await Promise.all([tex(tl, base + 'props_base.webp', true), tex(tl, base + 'props_orm.webp', false),
    new GLTFLoader().loadAsync(base + 'props.glb')]);
  const mat = patch(new THREE.MeshStandardMaterial({ map, aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1 }));
  const geo = {}; g.scene.traverse((c) => { if (c.isMesh) geo[c.name] = c.geometry; });
  const group = new THREE.Group(), circles = [], movers = [];
  // Place: p is the three.js position (y taken from the terrain), face is the point the front (+Z) turns toward
  function put(name, p, face, { dy = 0, ground = true, r = 0 } = {}) {
    const m = new THREE.Mesh(geo[name], mat);
    m.castShadow = true; m.receiveShadow = true;
    m.position.copy(p); if (ground) m.position.y = T.height(p.x, p.z) + dy;
    m.rotation.y = Math.atan2(face.x - p.x, face.z - p.z);
    group.add(m);
    if (r) circles.push({ x: p.x, z: p.z, r });
    return m;
  }
  const M = T.meta;
  // Cape shrine: the torii stands in the shallows facing the lake; the main hall faces the torii from the top of the cape
  const th = rad(M.cape.th), P = (r, side = 0) => b2t(r * Math.cos(th) - side * Math.sin(th), r * Math.sin(th) + side * Math.cos(th));
  const center = new THREE.Vector3(0, 0, 0);
  const sites = {};
  const torii = put('torii', P(M.cape.torii), center, { dy: 0 });
  sites.torii = torii.position;
  torii.position.y = Math.min(T.height(torii.position.x, torii.position.z), M.water - 0.4);
  sites.honden = put('honden', P(M.cape.r1 + 12), P(M.cape.torii), { dy: 0.05, r: 3.2 }).position;
  for (const s of [-2.6, 2.6]) put('toro', P(M.cape.r1 + 4, s), P(M.cape.r1 + 4, s * 2), { r: 0.6 });
  // Water's edge on the lakeside road: pier into the lake, boathouse and boat
  const shore = T.roads.list[T.roads.byName.shore];
  const sp = shore.pts.find((q) => q.s > 290 && q.y < 2.2) || shore.pts[Math.floor(shore.pts.length * 0.8)];
  const sv = new THREE.Vector3(sp.x, 0, sp.z), inward = sv.clone().multiplyScalar(-1).normalize();
  // Walk from the road toward the lake center; the pier's base goes where the water is 0.4 m deep
  let k = 4; while (k < 60 && T.height(sv.x + inward.x * k, sv.z + inward.z * k) > M.water - 0.4) k += 0.5;
  const pierO = sv.clone().addScaledVector(inward, k - 1.5);
  const pier = put('pier', pierO, pierO.clone().add(inward), { ground: false });
  pier.position.y = M.water + 0.05;
  const side = new THREE.Vector3(-inward.z, 0, inward.x);
  const bh = put('boathouse', pierO.clone().addScaledVector(side, 7).addScaledVector(inward, 2), pierO.clone().addScaledVector(side, 7).addScaledVector(inward, 10), { ground: false });
  bh.position.y = M.water + 0.1;
  const boat = put('boat', pierO.clone().addScaledVector(inward, 12).addScaledVector(side, 1.8), pierO.clone().addScaledVector(inward, 30).addScaledVector(side, 3), { ground: false });
  boat.position.y = M.water - 0.18;
  movers.push((t) => { boat.position.y = M.water - 0.18 + Math.sin(t * 1.1) * 0.03; boat.rotation.z = Math.sin(t * 0.8) * 0.035; boat.rotation.x = Math.sin(t * 0.6 + 1) * 0.02; });
  // Jigokudani: sulfur hut near the end of the road, boardwalk to the largest hot pool
  const jig = T.roads.list[T.roads.byName.jigoku];
  const jend = jig.pts[jig.pts.length - 1], jmid = jig.pts[Math.floor(jig.pts.length * 0.62)];
  // Sulfur hut: 14 m off the road (away from the valley center). Search for a spot at least 10 m from every road and clear of the pools
  const jc0 = new THREE.Vector3(M.jigoku[0], 0, -M.jigoku[1]);
  let shackP = null;
  for (const frac of [0.62, 0.55, 0.7, 0.45, 0.8]) {
    const q = jig.pts[Math.floor(jig.pts.length * frac)];
    const out = new THREE.Vector3(q.x - jc0.x, 0, q.z - jc0.z).normalize();
    for (const dd of [14, 18, 22]) {
      const c = new THREE.Vector3(q.x, 0, q.z).addScaledVector(out, dd);
      const nr = T.roads.nearest(c.x, c.z);
      const wet = M.pools.some((p) => Math.hypot(p[0] - c.x, p[2] - c.z) < p[3] + 5);
      if (nr.d > 10 && !wet) { shackP = c; break; }
    }
    if (shackP) break;
  }
  shackP = shackP || new THREE.Vector3(jmid.x, 0, jmid.z).addScaledVector(new THREE.Vector3(jmid.x - jc0.x, 0, jmid.z - jc0.z).normalize(), 20);
  sites.shack = put('shack', shackP, new THREE.Vector3(jmid.x, 0, jmid.z), { r: 3.2 }).position;
  const big = M.pools.reduce((a, b) => (b[3] > a[3] ? b : a));
  const bp = new THREE.Vector3(big[0], 0, big[2]);
  sites.pool = new THREE.Vector3(big[0], big[1], big[2]);
  const from = T.roads.nearest(bp.x, bp.z, T.roads.byName.jigoku);
  const a = new THREE.Vector3(from.x, 0, from.z), dir = bp.clone().sub(a);
  const L = dir.length() - big[3] * 0.6; dir.normalize();
  for (let d = 4.5; d < L; d += 2) {
    const q = a.clone().addScaledVector(dir, d);
    const seg = put('boardwalk', q, q.clone().add(dir), { dy: 0.05 });
    seg.position.y = Math.max(T.height(q.x, q.z), big[1] - 0.2) + 0.05;
  }
  void jend;
  // Pass: mountain hut beside the road, Jizo at the highest point (only if the pass road exists)
  const ps = T.roads.list[T.roads.byName.pass];
  if (ps) {
  const top = ps.pts.reduce((p, q) => (q.y > p.y ? q : p));
  const pt = T.roads.at(T.roads.byName.pass, top.s - 60);
  const hutP = new THREE.Vector3(pt.x - pt.tz * 11, 0, pt.z + pt.tx * 11);
  sites.hut = put('hut', hutP, new THREE.Vector3(pt.x, 0, pt.z), { dy: -0.3, r: 4.5 }).position;
  const jz = T.roads.at(T.roads.byName.pass, top.s);
  sites.jizo = put('jizo', new THREE.Vector3(jz.x + jz.tz * 5.2, 0, jz.z - jz.tx * 5.2), new THREE.Vector3(jz.x, 0, jz.z), { dy: -0.05, r: 0.5 }).position;
  sites.passTop = top;
  }
  // Signpost at the fork: stands on the outside of the rim road (opposite the branch), with the top board pointing down the branch
  for (const name of ['shore', 'jigoku', 'pass']) {
    const R = T.roads.list[T.roads.byName[name]];
    if (!R) continue;
    const a = R.pts[0], b = R.pts[Math.min(12, R.pts.length - 1)];
    const rim = T.roads.nearest(a.x, a.z, 0);
    const out = new THREE.Vector3(a.x - b.x, 0, a.z - b.z).normalize();
    const p = new THREE.Vector3(a.x, 0, a.z).addScaledVector(out, 6.5).addScaledVector(new THREE.Vector3(rim.tx, 0, rim.tz), 5);
    // the board extends along +X in Blender -> also +X in three. Align +X with the branch direction
    const m = put('signpost', p, p.clone().add(new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x)), { r: 0.4 });
    void m;
  }
  const update = (t) => movers.forEach((f) => f(t));
  return { group, circles, update, meshes: group.children, sites };
}
