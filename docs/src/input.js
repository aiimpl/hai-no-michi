// Keyboard and drag. forced is a hook for injecting input externally, for testing and recording
export class Input {
  constructor(el) {
    this.keys = new Set(); this.forced = {};
    this.drag = { dx: 0, dy: 0, active: false };
    addEventListener('keydown', (e) => { this.keys.add(e.code); if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    el.addEventListener('pointerdown', (e) => { this.drag.active = true; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', () => { this.drag.active = false; });
    el.addEventListener('pointermove', (e) => { if (this.drag.active) { this.drag.dx += e.movementX; this.drag.dy += e.movementY; } });
    this.steerSm = 0;
  }
  down(...c) { return c.some((k) => this.keys.has(k)); }
  apply(inp) {
    const f = this.forced;
    const fwd = this.down('KeyW', 'ArrowUp'), back = this.down('KeyS', 'ArrowDown');
    const l = this.down('KeyA', 'ArrowLeft'), r = this.down('KeyD', 'ArrowRight');
    inp.throttle = f.throttle ?? ((fwd ? 1 : 0) - (back ? 1 : 0));
    inp.steer = f.steer ?? ((l ? 1 : 0) - (r ? 1 : 0));
    inp.brake = f.brake ?? (this.down('Space') ? 1 : 0);
    inp.boost = f.boost ?? (this.down('ShiftLeft', 'ShiftRight') ? 1 : 0);
  }
  takeDrag() { const d = [this.drag.dx, this.drag.dy]; this.drag.dx = this.drag.dy = 0; return d; }
}
