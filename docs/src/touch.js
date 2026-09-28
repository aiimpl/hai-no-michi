// Touch controls for phones and tablets.
//  Left half: a floating thumb stick that appears where the thumb lands. Up/down is throttle/reverse, left/right is steering.
//  Right half: drag to look around (fed into the same drag accumulator the mouse uses).
//  Buttons on the right: boost (hold), view, recover, night. They send the same key codes as the keyboard, so every
//  handler that listens for keys keeps working.
export class TouchControls {
  constructor(root, input) {
    this.input = input;
    this.stick = { id: null, x0: 0, y0: 0, x: 0, y: 0 };
    this.look = { id: null, x: 0, y: 0 };
    const el = this.el = document.createElement('div');
    el.className = 'touch';
    el.innerHTML = `
      <div class="pad"><div class="ring"></div><div class="knob"></div></div>
      <div class="btns">
        <button data-k="ShiftLeft" data-hold="1">BOOST</button>
        <button data-k="KeyV">VIEW</button>
        <button data-k="KeyR">RESET</button>
        <button data-k="KeyN">NIGHT</button>
      </div>
      <div class="hint">Left thumb to drive · right side to look</div>`;
    root.appendChild(el);
    this.pad = el.querySelector('.pad'); this.ring = el.querySelector('.ring'); this.knob = el.querySelector('.knob');
    const zone = root;
    zone.addEventListener('touchstart', (e) => this.start(e), { passive: false });
    zone.addEventListener('touchmove', (e) => this.move(e), { passive: false });
    zone.addEventListener('touchend', (e) => this.end(e));
    zone.addEventListener('touchcancel', (e) => this.end(e));
    for (const b of el.querySelectorAll('button')) {
      const code = b.dataset.k, hold = b.dataset.hold;
      const down = (e) => { e.preventDefault(); e.stopPropagation(); b.classList.add('on');
        if (hold) input.keys.add(code); else dispatchEvent(new KeyboardEvent('keydown', { code })); };
      const up = (e) => { e.preventDefault(); e.stopPropagation(); b.classList.remove('on'); if (hold) input.keys.delete(code); };
      b.addEventListener('touchstart', down, { passive: false });
      b.addEventListener('touchend', up); b.addEventListener('touchcancel', up);
    }
    // First touch also unlocks audio (WebAudio needs a user gesture)
    addEventListener('touchstart', () => dispatchEvent(new PointerEvent('pointerdown')), { once: true });
    // The input reads the stick every frame
    const apply = input.apply.bind(input);
    input.apply = (inp) => {
      apply(inp);
      if (this.stick.id === null) return;
      const dx = this.stick.x - this.stick.x0, dy = this.stick.y - this.stick.y0, R = 60;
      const sx = Math.max(-1, Math.min(1, dx / R)), sy = Math.max(-1, Math.min(1, dy / R));
      const dead = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      inp.steer = -dead(sx);
      inp.throttle = -dead(sy);
    };
  }
  start(e) {
    for (const t of e.changedTouches) {
      if (t.target.closest && t.target.closest('button')) continue;
      const left = t.clientX < innerWidth * 0.5;
      if (left && this.stick.id === null) {
        this.stick = { id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY };
        this.pad.style.left = `${t.clientX}px`; this.pad.style.top = `${t.clientY}px`;
        this.pad.classList.add('on'); this.el.querySelector('.hint').classList.add('gone');
        this.draw();
      } else if (!left && this.look.id === null) {
        this.look = { id: t.identifier, x: t.clientX, y: t.clientY };
        this.input.drag.active = true;
      }
    }
    e.preventDefault();
  }
  move(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === this.stick.id) { this.stick.x = t.clientX; this.stick.y = t.clientY; this.draw(); }
      if (t.identifier === this.look.id) {
        this.input.drag.dx += (t.clientX - this.look.x) * 1.4; this.input.drag.dy += (t.clientY - this.look.y) * 1.4;
        this.look.x = t.clientX; this.look.y = t.clientY;
      }
    }
    e.preventDefault();
  }
  end(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === this.stick.id) { this.stick.id = null; this.pad.classList.remove('on'); }
      if (t.identifier === this.look.id) { this.look.id = null; this.input.drag.active = false; }
    }
  }
  draw() {
    const R = 60, dx = this.stick.x - this.stick.x0, dy = this.stick.y - this.stick.y0, l = Math.hypot(dx, dy), k = l > R ? R / l : 1;
    this.knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
  }
}
