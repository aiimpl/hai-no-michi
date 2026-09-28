// Simplified physics for a 6-wheel expedition truck. Fixed timestep, so identical input gives an identical run (for reproducible recordings).
// The body is a single rigid body. Each of the 6 wheels raycasts along the body's down axis to the ground, is supported by a spring + damper,
// and produces longitudinal/lateral tire forces at the contact point. Front axle steers; all-wheel drive.
import * as THREE from 'three';

// Dimensions derived from a 6-wheel boxy SUV (5.9 m long, 2.1 m wide, 3.9 t, one front axle + two rear axles)
export const SPEC = {
  mass: 3900,
  size: [2.1, 1.9, 5.9],          // box used for inertia (width, height, length)
  axles: [1.6, -0.6, -1.95],      // matches AXLES in bake/car.py     // axle positions fore/aft (from CoM, forward is +)
  steerAxles: [1, 0, 0],          // steering share (front axle only)
  track: 0.93,                    // wheel lateral offset (from CoM)
  mountY: -0.2,                   // spring mount height (from CoM)
  wheelR: 0.58,
  rest: 0.45, travel: 0.34,       // spring rest length and travel
  k: 52000, c: 5200,              // spring rate, damping (per wheel)
  mu: 0.95, rollRes: 0.014,
  power: 240e3, maxForce: 33000,  // power and drive force cap (all wheels combined)
  boost: 1.5,
  brake: 36000,
  drag: 1.6,                      // aero drag 0.5·ρ·Cd·A
  vmax: 62, vmaxBoost: 78,       // top speed (km/h); drive is tapered over the last 4 km/h
  antiRoll: 30000,                // anti-roll bar (force against left/right compression difference)
  latLift: 0.65,                  // height where lateral force is applied (contact point 0 .. spring mount 1); resists rollover
  // Water: submersion is measured at the body's 8 corners. Buoyancy comes from the body volume (~15 m³) and drains away as it floods
  hull: [[-1.0, -0.55, 2.7], [1.0, -0.55, 2.7], [-1.0, -0.55, -2.7], [1.0, -0.55, -2.7],
         [-0.95, 1.05, 0.9], [0.95, 1.05, 0.9], [-0.95, 1.05, -2.6], [0.95, 1.05, -2.6]],
  buoyVol: 15, floodTime: 6.5, waterDrag: 3800, waterDrag2: 520,
  steerMax: 0.6, steerAt60: 0.16, steerRate: 1.9,
};

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _r = new THREE.Vector3();
const _f = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion();
const _m = new THREE.Matrix3(), _fw = new THREE.Vector3(), _sd = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Vehicle {
  constructor(terrain, spec = SPEC) {
    this.T = terrain; this.S = spec;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion(); this.ang = new THREE.Vector3();
    const [w, h, l] = spec.size, m = spec.mass;
    this.invI = new THREE.Vector3(12 / (m * (h * h + l * l)), 12 / (m * (w * w + l * l)), 12 / (m * (w * w + h * h)));
    this.wheels = [];
    for (let a = 0; a < 3; a++) for (const side of [-1, 1]) {
      this.wheels.push({ axle: a, local: new THREE.Vector3(side * spec.track, spec.mountY, spec.axles[a]),
        comp: 0, prevComp: 0, spin: 0, steer: 0, contact: false, load: 0, slip: 0 });
    }
    this.steer = 0; this.speed = 0;
    this.waterY = -1e9; this.lakeR = 430; this.flood = 0; this.sub = 0; this.stall = 0; this.dead = false; this.sunkT = 0;
    this.hullWet = spec.hull.map(() => 0);
    this.input = { throttle: 0, brake: 0, steer: 0, boost: 0 };
  }

  resetWater() { this.flood = 0; this.stall = 0; this.dead = false; this.sunkT = 0; this.hullWet.fill(0); }
  place(x, z, heading) {
    const y = this.T.height(x, z) + this.S.wheelR + this.S.rest - this.S.mountY - 0.12;
    this.pos.set(x, y, z); this.vel.set(0, 0, 0); this.ang.set(0, 0, 0);
    this.quat.setFromAxisAngle(UP, heading);
  }

  // Multiply by the body's world-space inverse inertia
  applyInvI(v) {
    _q.copy(this.quat).invert(); v.applyQuaternion(_q);
    v.multiply(this.invI); return v.applyQuaternion(this.quat);
  }

  step(dt) {
    const S = this.S, T = this.T, inp = this.input;
    const force = _f.set(0, -9.81 * S.mass, 0);
    const torque = new THREE.Vector3();
    _fw.set(0, 0, 1).applyQuaternion(this.quat);
    const upB = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    const vf = this.vel.dot(_fw);
    this.speed = vf;

    // Steering: less lock at higher speed; input is smoothed
    const kmh = Math.abs(vf) * 3.6;
    const lim = S.steerMax + (S.steerAt60 - S.steerMax) * Math.min(kmh / 60, 1);
    const target = inp.steer * lim;
    this.steer += Math.max(-S.steerRate * dt, Math.min(S.steerRate * dt, target - this.steer));

    // Drive force: constant-power curve (capped at low speed). Reverse is slow
    const P = S.power * (inp.boost ? S.boost : 1);
    let drive = 0;
    if (inp.throttle > 0) {
      const vmax = (inp.boost ? S.vmaxBoost : S.vmax) / 3.6;
      drive = Math.min(S.maxForce * (inp.boost ? 1.15 : 1), P / Math.max(Math.abs(vf), 1)) * inp.throttle;
      drive *= Math.min(Math.max((vmax - vf) / (4 / 3.6), 0), 1);
    }
    if (inp.throttle < 0) drive = vf > 1 ? 0 : -S.maxForce * 0.35 * -inp.throttle;
    const braking = (inp.throttle < 0 && vf > 1) ? 1 : inp.brake;
    if (this.dead) drive = 0;              // engine flooded and stalled

    let nContact = 0;
    for (const w of this.wheels) {
      w.steer = this.steer * S.steerAxles[w.axle];
      const mount = _w.copy(w.local).applyQuaternion(this.quat).add(this.pos);
      // Find the ground along the body's down axis (assumes small tilt; recovers the along-axis length from the vertical gap)
      const g = T.height(mount.x, mount.z);
      const cosUp = Math.max(upB.y, 0.3);
      const dist = (mount.y - g) / cosUp - S.wheelR;
      w.prevComp = w.comp;
      w.comp = Math.min(Math.max(S.rest - dist, 0), S.travel + 0.2);
      w.contact = dist < S.rest;
      if (!w.contact) { w.load = 0; w.slip = 0; continue; }
      nContact++;
      T.normal(mount.x, mount.z, _n);
      const cp = _r.copy(upB).multiplyScalar(-(dist + S.wheelR)).add(mount);   // contact point
      const rel = cp.clone().sub(this.pos);
      const pv = _v.copy(this.ang).cross(rel).add(this.vel);                   // contact point velocity

      // Spring: compression + damping. Bottoming out is caught by a stiff bump stop
      const compVel = (w.comp - w.prevComp) / dt;
      let N = S.k * w.comp + S.c * compVel;
      if (w.comp > S.travel) N += S.k * 6 * (w.comp - S.travel);
      const mate = this.wheels[this.wheels.indexOf(w) ^ 1];       // opposite wheel on the same axle (compression from the previous step)
      N += S.antiRoll * (w.comp - mate.comp);
      N = Math.max(N, 0);
      w.load = N;
      const Fs = _n.clone().multiplyScalar(N);

      // Project the tire heading (including steering) onto the ground plane
      const fwd = new THREE.Vector3(Math.sin(w.steer), 0, Math.cos(w.steer)).applyQuaternion(this.quat);
      fwd.addScaledVector(_n, -fwd.dot(_n)).normalize();
      const side = _sd.copy(_n).cross(fwd).normalize();
      const vLong = pv.dot(fwd), vLat = pv.dot(side);

      // Longitudinal: drive, braking, rolling resistance. Lateral: saturates with tanh of slip speed
      // the lake bed is mud and gives no grip
      const muN = S.mu * N * (mount.y < this.waterY && Math.hypot(mount.x, mount.z) < this.lakeR ? 0.3 : 1);
      let Fx = drive / 6;
      Fx -= braking * S.brake / 6 * Math.tanh(vLong / 0.4);
      Fx -= S.rollRes * N * Math.tanh(vLong / 0.5);
      let Fy = -muN * Math.tanh(vLat / 0.35);
      // Friction circle: scale down when the combined force exceeds μN
      const tot = Math.hypot(Fx, Fy);
      if (tot > muN) { Fx *= muN / tot; Fy *= muN / tot; }
      w.slip = Math.abs(vLat) + Math.max(0, Math.abs(Fx) - muN * 0.9) * 1e-4;

      const F = Fs.addScaledVector(fwd, Fx).addScaledVector(side, Fy);
      force.add(F);
      torque.add(rel.clone().cross(Fs.copy(_n).multiplyScalar(N).addScaledVector(fwd, Fx)));
      // Apply only the lateral force a bit higher up (a fix to resist rollover)
      const relL = _v.copy(upB).multiplyScalar((dist + S.wheelR) * S.latLift).add(rel);
      torque.add(relL.cross(side.clone().multiplyScalar(Fy)));
      w.spin += vLong / S.wheelR * dt;
    }

    // Water: buoyancy per submerged corner (reduced by flooding), plus overall water drag. Splash when crossing the surface downward
    let sub = 0;
    // Only inside the lake circle is water (the Jigokudani floor is below lake level but dry)
    const WY = Math.hypot(this.pos.x, this.pos.z) < this.lakeR ? this.waterY : -1e9;
    S.hull.forEach((h, i) => {
      const wp = _w.set(h[0], h[1], h[2]).applyQuaternion(this.quat).add(this.pos);
      const d = WY - wp.y;
      const k = Math.min(Math.max(d / 0.8, 0), 1);
      if (k > 0) {
        // the front (engine bay) is heavier and sinks first
        const front = h[2] > 0 ? 0.7 : 1.0;
        const Fb = 1000 * 9.81 * S.buoyVol / 8 * k * (1 - this.flood) * front;
        const rel = wp.clone().sub(this.pos);
        force.y += Fb;
        torque.add(rel.cross(new THREE.Vector3(0, Fb, 0)));
        const pv = this.ang.clone().cross(rel).add(this.vel);
        if (this.hullWet[i] === 0 && pv.y < -1.0) this.onSplash?.(wp.clone(), -pv.y, this.vel.length());
      }
      this.hullWet[i] = k;
      sub += k / 8;
    });
    this.sub = sub;
    if (sub > 0) {
      // Righting moment: the deeper it sits, the more the body's up is pulled back to world up (like a ship with its center of buoyancy above the CoM)
      const upNow = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
      const right = upNow.clone().cross(new THREE.Vector3(0, 1, 0));
      torque.addScaledVector(right, 9.81 * S.mass * 1.4 * Math.min(sub * 2, 1));
      const v = this.vel.length();
      force.addScaledVector(this.vel, -(S.waterDrag + S.waterDrag2 * v) * sub);
      this.ang.multiplyScalar(1 - Math.min(5.0 * sub * dt, 0.5));
      this.flood = Math.min(1, this.flood + dt * sub / S.floodTime);
    } else this.flood = Math.max(0, this.flood - dt / 40);
    // Engine stalls when nearly half submerged; restarts 2 s after leaving the water
    this.stall = sub > 0.4 ? this.stall + dt : Math.max(0, this.stall - dt * 0.5);
    if (this.stall > 0.8) this.dead = true;
    if (this.dead && sub === 0 && this.stall === 0) this.dead = false;
    // Once fully sunk for 3 s, return to the road
    this.sunkT = (this.flood > 0.9 && sub > 0.7) ? this.sunkT + dt : 0;
    if (this.sunkT > 3) { this.sunkT = 0; this.onSunk?.(); }

    // aero drag
    const sp = this.vel.length();
    force.addScaledVector(this.vel, -S.drag * sp);
    // Integrate (semi-implicit Euler)
    this.vel.addScaledVector(force, dt / S.mass);
    this.ang.add(this.applyInvI(torque.multiplyScalar(dt)));
    this.ang.multiplyScalar(nContact ? 0.9995 : 0.9999);
    this.pos.addScaledVector(this.vel, dt);
    const a = this.ang.length();
    if (a > 1e-9) { _q.setFromAxisAngle(_v.copy(this.ang).divideScalar(a), a * dt); this.quat.premultiply(_q).normalize(); }

    // After 2 s upside down, right it and place it back on the road
    this.flipT = upB.y < 0.35 ? (this.flipT || 0) + dt : 0;
    if (this.flipT > 2) { this.flipT = 0; this.onFlip?.(); }

    // Collision: push the body circle (radius 2.4 m) out of obstacle circles (trunks, buildings) and cancel the velocity into them
    if (this.obstacles) {
      for (const o of this.obstacles(this.pos)) {
        const dx = this.pos.x - o.x, dz = this.pos.z - o.z, d = Math.hypot(dx, dz), m = o.r + 2.4;
        if (d < m && d > 1e-4) {
          const nx = dx / d, nz = dz / d;
          this.pos.x += nx * (m - d); this.pos.z += nz * (m - d);
          const vn = this.vel.x * nx + this.vel.z * nz;
          if (vn < 0) { this.vel.x -= nx * vn * 1.3; this.vel.z -= nz * vn * 1.3; this.ang.multiplyScalar(0.8); }
        }
      }
    }

    // Push the body back out if it sinks into the ground (safety net for rollovers)
    const gy = T.height(this.pos.x, this.pos.z) + 0.6;
    if (this.pos.y < gy) { this.pos.y = gy; if (this.vel.y < 0) this.vel.y *= -0.1; }
  }

  // For rendering: each wheel's center (below the spring mount)
  wheelWorld(w, out) {
    const dist = this.S.rest - w.comp;
    return out.set(w.local.x, w.local.y - dist, w.local.z).applyQuaternion(this.quat).add(this.pos);
  }
  heading() { _fw.set(0, 0, 1).applyQuaternion(this.quat); return Math.atan2(_fw.x, _fw.z); }
}
