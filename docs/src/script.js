// Recording script (30 s): open on forest and water, then the car drives in. The camera never goes underwater.
//  0-12 s  Lake: skimming a still lake that mirrors the forest and the outer rim. The car comes along the shore road and stops at the shrine on the cape
// 12-20 s  Jigokudani: the low sun glows through the steam. The car threads between dead standing trees
// 20-30 s  Rise and pull back off the torii: the sun sets behind the outer rim, the sky goes from orange to deep blue. The parked car's headlights, and stars
// The camera is free, not tied to the car (position, target and FOV are functions of time).
import * as THREE from 'three';

export const DURATION = 30;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const azOf = (from, to) => Math.atan2(to.x - from.x, to.z - from.z) * 180 / Math.PI;

export function makeScript(T, sites) {
  const roads = T.roads, M = T.meta;
  const R = (name) => roads.byName[name];
  const center = V(0, M.water, 0);

  // ---- 1. Forest on the lakeshore ----
  // Where the inner (lake-side) slope below the rim road is gentlest. The camera sits at the water's edge below the road
  const rim = R('rim');
  let best = null;
  for (let s = 0; s < roads.list[rim].length; s += 20) {
    const p = roads.at(rim, s), toC = V(-p.x, 0, -p.z).normalize();
    const q = V(p.x, 0, p.z).addScaledVector(toC, 60);
    const drop = T.height(p.x, p.z) - T.height(q.x, q.z);
    if (!best || drop < best.drop) best = { s, drop };
  }
  const fS = best.s;
  const f0 = roads.at(rim, fS);
  const fIn = V(-f0.x, 0, -f0.z).normalize();
  let k = 10; while (k < 120 && T.height(f0.x + fIn.x * k, f0.z + fIn.z * k) > M.water + 0.3) k += 1;
  const fCamW = V(f0.x, 0, f0.z).addScaledVector(fIn, k + 6); fCamW.y = M.water + 0.6;
  const fCamR = V(f0.x, 0, f0.z).addScaledVector(fIn, 9).addScaledVector(V(f0.tx, 0, f0.tz), -4);
  fCamR.y = T.height(fCamR.x, fCamR.z) + 1.4;
  const fSunAz = azOf(fCamW, V(f0.x, 0, f0.z)) + 55;

  // ---- 2. Lakeside road and torii ----
  const tor = sites.torii.clone();
  const sh = R('shore');
  const shoreEnd = roads.list[sh].length;
  const sp = roads.at(sh, shoreEnd - 70);
  const sOut = V(-sp.x, 0, -sp.z).normalize();
  let kk = 4; while (kk < 60 && T.height(sp.x + sOut.x * kk, sp.z + sOut.z * kk) > M.water - 0.2) kk += 1;
  const sCam0 = V(sp.x, 0, sp.z).addScaledVector(sOut, kk + 4).addScaledVector(V(sp.tx, 0, sp.tz), -18); sCam0.y = M.water + 1.3;
  const sCam1 = V(sp.x, 0, sp.z).addScaledVector(sOut, kk + 3).addScaledVector(V(sp.tx, 0, sp.tz), 6); sCam1.y = M.water + 1.1;
  const tSunAz = azOf(sCam1, tor);

  // ---- 3. Jigokudani ----
  const jc = M.vents.reduce((a, v) => a.add(V(v[0], v[1], v[2])), V(0, 0, 0)).multiplyScalar(1 / M.vents.length);
  const jr = R('jigoku');
  const jn = roads.nearest(jc.x, jc.z, jr);
  const jSunAz = azOf(V(roads.at(jr, jn.s - 40).x, 0, roads.at(jr, jn.s - 40).z), jc);

  // ---- 4. Pull back from above the rim ----
  const eS = fS + 380;
  const e0 = roads.at(rim, eS);
  const eOut = V(e0.x, 0, e0.z).normalize();
  const eSunAz = azOf(V(e0.x, 0, e0.z), center) + 20;

  // Beach: the beach stretch of the lakeside road. The camera skims the water 12 m offshore, looking along the beach toward the oncoming car
  // (forest and beach on one side, the lake and the mirrored outer rim on the other)
  const bS = shoreEnd - 100, bp = roads.at(sh, bS);
  const bOut = V(-bp.x, 0, -bp.z).normalize();
  let bk = 4; while (bk < 80 && T.height(bp.x + bOut.x * bk, bp.z + bOut.z * bk) > M.water - 0.3) bk += 1;
  const bCam0 = V(bp.x, 0, bp.z).addScaledVector(bOut, bk + 10); bCam0.y = M.water + 0.9;
  const bCam1 = bCam0.clone().addScaledVector(bOut, 6); bCam1.y = M.water + 1.6;
  const bFrom = roads.at(sh, 275);
  const bLook = V(bFrom.x, 0, bFrom.z).addScaledVector(bOut, 25); bLook.y = M.water + 7;
  const bSunAz = azOf(bCam0, bLook) + 35;
  // Finale: from 34 m off the torii, rise while looking at the cape, the outer rim and the sky. The sun sets behind the rim
  const cIn = tor.clone().setY(0).multiplyScalar(-1).normalize();
  const cCam0 = tor.clone().addScaledVector(cIn, 34); cCam0.y = M.water + 1.1;
  const cSunAz = azOf(cCam0, tor);

  const SCENES = [
    { t0: 0, t1: 12, road: 'shore', s0: 272, dir: 1, speed: [[0, 26], [8, 30], [11.2, 6], [12, 0]],   // starts just after the last switchback (260 m)
      tod: (t) => ({ el: 5.5 - 1.5 * ss(0, 12, t), az: bSunAz, exp: 1.45 }),
      cam: (t, car) => {
        const u = ss(0, 12, t);
        const pos = bCam0.clone().lerp(bCam1, u);
        // First look down the beach (where the car comes from), pan to follow as it approaches, then turn toward the torii on the cape once it passes
        const carL = car.pos.clone().add(V(0, 1.6, 0));
        const look = bLook.clone().lerp(carL, ss(3, 8, t)).lerp(tor.clone().add(V(0, 3, 0)), 0.6 * ss(9, 12, t));
        return { pos, look, fov: THREE.MathUtils.lerp(44, 30, ss(2, 6, t) * (1 - ss(8.5, 11, t))) };
      } },
    { t0: 12, t1: 20, road: 'jigoku', s0: jn.s - 95, dir: 1, speed: [[12, 18], [20, 14]],
      tod: () => ({ el: 6.0, az: jSunAz, exp: 1.6 }),
      cam: (t, car) => {
        const u = ss(12, 20, t);
        const f = V(0, 0, 1).applyQuaternion(car.quat); f.y = 0; f.normalize();
        const sd = V(-f.z, 0, f.x);
        const pos = car.pos.clone().addScaledVector(f, -13 + 3 * u).addScaledVector(sd, -(3.5 + 4 * u)); pos.y = car.pos.y + 4.5 - 2.2 * u;
        const look = car.pos.clone().addScaledVector(f, 16).lerp(jc, 0.25); look.y = car.pos.y + 2.2;
        return { pos, look, fov: 48 };
      } },
    { t0: 20, t1: 30, road: 'shore', s0: shoreEnd - 14, dir: 1, speed: [[20, 0], [30, 0]],
      tod: (t) => ({ el: THREE.MathUtils.lerp(2.0, -6.5, ss(20.5, 29, t)), az: cSunAz, exp: 1.45 }),
      cam: (t) => {
        const u = ss(20, 30, t);
        const pos = cCam0.clone().addScaledVector(cIn, 45 * u); pos.y = M.water + 1.1 + 32 * u * u;
        const look = tor.clone().addScaledVector(cIn, -90 * u); look.y = M.water + 3.5 + 22 * u;
        return { pos, look, fov: THREE.MathUtils.lerp(40, 54, u) };
      } },
  ];

  function lerpTable(tab, t) {
    if (t <= tab[0][0]) return tab[0][1];
    for (let i = 1; i < tab.length; i++) if (t <= tab[i][0]) {
      const a = tab[i - 1], b = tab[i], u = (t - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * u * u * (3 - 2 * u);
    }
    return tab[tab.length - 1][1];
  }
  function plan(t) {
    const S = SCENES.find((s) => t < s.t1) || SCENES[SCENES.length - 1];
    return {
      scene: S, kmh: lerpTable(S.speed, t), road: S.road, dir: S.dir,
      offset: 0.3 * Math.sin(t * 0.7) + 0.15 * Math.sin(t * 1.9 + 1.3),
      offRoad: false, tod: S.tod(t),
    };
  }
  return { plan, SCENES };
}
