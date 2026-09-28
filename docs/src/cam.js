// Chase camera. Looks down from behind and above, following the heading with lag. Drag to orbit; on release it eases back.
// V switches to a low side view.
import * as THREE from 'three';

const VIEWS = [
  { dist: 33, pitch: 0.47, fov: 58, lookY: 0.4, lead: 8 },   // high behind, looking down (default)
  { dist: 21, pitch: 0.13, fov: 40, lookY: 1.6, lead: 0 },   // low side
];

export class ChaseCam {
  constructor(camera, terrain) {
    this.c = camera; this.T = terrain;
    this.yaw = 0; this.orbit = 0; this.orbitP = 0; this.view = 0; this.side = 0;
    this.pos = new THREE.Vector3(); this.look = new THREE.Vector3();
  }
  target(car) {
    const v = VIEWS[this.view];
    const yaw = this.yaw + this.orbit + (this.view === 1 ? -Math.PI * 0.5 : 0);
    const pitch = THREE.MathUtils.clamp(v.pitch + this.orbitP, 0.02, 1.35);
    const look = car.pos.clone(); look.y += v.lookY;
    look.x += Math.sin(this.yaw) * v.lead; look.z += Math.cos(this.yaw) * v.lead;
    const off = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(v.dist);
    return { p: look.clone().add(off), look, fov: v.fov };
  }
  snap(car) { this.yaw = car.heading(); const t = this.target(car); this.pos.copy(t.p); this.look.copy(t.look); this.apply(t.fov); }
  toggle() { this.view = (this.view + 1) % VIEWS.length; }
  update(dt, car, input) {
    // Free camera (recording script): use the position, target and FOV as given
    if (this.free) {
      this.pos.copy(this.free.pos); this.look.copy(this.free.look);
      this.c.position.copy(this.pos); this.c.lookAt(this.look);
      if (this.free.roll) this.c.rotateZ(this.free.roll);
      if (this.c.fov !== this.free.fov) { this.c.fov = this.free.fov; this.c.updateProjectionMatrix(); }
      return;
    }
    if (this.scripted) { this.orbit = this.scripted.orbit; this.orbitP = this.scripted.orbitP; }
    const [dx, dy] = this.scripted ? [0, 0] : input.takeDrag();
    if (dx || dy) { this.orbit -= dx * 0.005; this.orbitP += dy * 0.004; this.idle = 0; } else this.idle = (this.idle || 0) + dt;
    if (!this.scripted && !input.drag.active && this.idle > 1.5) { const k = 1 - Math.exp(-dt * 0.8); this.orbit -= this.orbit * k; this.orbitP -= this.orbitP * k; }
    // turn toward the car's heading with lag (no follow while stopped)
    const h = car.heading();
    let d = h - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * (1 - Math.exp(-dt * 2.2 * Math.min(Math.abs(car.speed) / 3, 1)));
    const t = this.target(car);
    const kp = 1 - Math.exp(-dt * 6), kl = 1 - Math.exp(-dt * 10);
    this.pos.lerp(t.p, kp); this.look.lerp(t.look, kl);
    // keep it above the ground
    const g = this.T.height(this.pos.x, this.pos.z) + 1.2;
    if (this.pos.y < g) this.pos.y = g;
    this.apply(t.fov);
  }
  apply(fov) {
    this.c.position.copy(this.pos); this.c.lookAt(this.look);
    if (this.c.fov !== fov) { this.c.fov += (fov - this.c.fov) * 0.1; this.c.updateProjectionMatrix(); }
  }
}
