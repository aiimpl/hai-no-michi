// On-screen text: title top-left, weather/time/heading top-center, buttons top-right, place name and speed bottom-left, key hints at the bottom.
// The place name switches on entering a road zone (zones in terrain.json).
const ICON = {
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><g stroke-linecap="round">' +
    [0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<line x1="12" y1="4.2" x2="12" y2="6.2" transform="rotate(${a} 12 12)"/>`).join('') + '</g></svg>',
  shot: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6.5" class="fill"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9.5 16.5V6.5l8-1.6v10" fill="none"/><circle cx="7.6" cy="16.6" r="2" class="fill"/><circle cx="15.6" cy="15" r="2" class="fill"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.6"/><path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M6.7 17.3l1.4-1.4M15.9 8.1l1.4-1.4"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="8" height="8" rx="1" class="fill"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M7 7l6 5-6 5z M13 7l6 5-6 5z" class="fill"/><rect x="19" y="7" width="1.6" height="10" class="fill"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M7.5 14l4.5-4.5 4.5 4.5" fill="none"/></svg>',
};

export function makeHUD(root) {
  let pendingZ = null;
  root.innerHTML = `
    <div class="tl"><span class="logo"></span><b>HAI NO MICHI</b><i>the Ash Road</i></div>
    <div class="tc"><div class="wx"><span class="dot"></span><span class="wxt">BROKEN CLOUD AFTERNOON</span><span class="sl">/</span><span class="clock">17:20</span></div>
      <div class="compass"><span>W</span><span class="tick"></span><b class="hd">000°</b><span class="tick"></span><span>E</span></div></div>
    <div class="tr"><button data-k="time">${ICON.sun}</button><button data-k="shot">${ICON.shot}</button>
      <button data-k="music" class="on">${ICON.note}</button><button data-k="set">${ICON.gear}</button></div>
    <div class="tr2"><button class="sq">${ICON.stop}</button><button class="sq">${ICON.next}</button><button class="sq">${ICON.up}</button></div>
    <div class="bl"><div class="ex">ON THE RIM ROAD</div><div class="zone"><div class="zn"></div><div class="zs"></div></div>
      <div class="spd"><b class="kmh">0</b><i>KM/H</i><span class="st"><span class="dot"></span><span class="stt">ENGINE WARM</span></span></div></div>
    <div class="keys">${[['W', 'S', 'drive'], ['A', 'D', 'steer'], ['⇧', '', 'boost'], ['', '', 'drag to look'], ['V', '', 'view'],
      ['N', '', 'night'], ['L', '', 'lights'], ['H', '', 'beam'], ['R', '', 'recover'], ['P', '', 'photo']]
      .map(([a, b, t]) => `<span class="k">${a ? `<kbd>${a}</kbd>` : ''}${b ? `<kbd>${b}</kbd>` : ''}<em>${t}</em></span>`).join('')}</div>
    <div class="br">PHOTO MODE <kbd>P</kbd></div>`;
  const $ = (s) => root.querySelector(s);
  const el = { ex: $('.ex'), kmh: $('.kmh'), hd: $('.hd'), zone: $('.zone'), zn: $('.zn'), zs: $('.zs'), stt: $('.stt'), clock: $('.clock') };
  // Place-name crossfade driven by render time (not CSS animation, so recordings stay in sync)
  let cur = null, shown = null, switchT = -1e9;
  function update({ kmh, heading, zone, status, t }) {
    el.kmh.textContent = Math.round(Math.abs(kmh));
    el.hd.textContent = String(Math.round(heading) % 360).padStart(3, '0') + '°';
    const z = zone ? zone.name : cur;
    if (z && z !== cur) { switchT = cur === null ? t - 10 : t; cur = z; if (zone) pendingZ = zone; }
    const dt = t - switchT;
    let op;
    if (dt < 0.65 && shown !== null) op = 1 - dt / 0.65;
    else {
      if (shown !== cur && pendingZ) { shown = cur; el.zn.textContent = pendingZ.name; el.zs.textContent = pendingZ.sub; if (pendingZ.title) el.ex.textContent = pendingZ.title; }
      op = Math.min(1, Math.max(0, (dt - 0.65) / 0.9));
    }
    const e = op * op * (3 - 2 * op);
    el.zone.style.opacity = e; el.zone.style.transform = `translateY(${(1 - e) * 6}px)`;
    if (status && el.stt.textContent !== status) el.stt.textContent = status;
  }
  const buttons = root.querySelectorAll('button[data-k]');
  let cb = null;
  buttons.forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); cb?.(b.dataset.k); }));
  const setButton = (k, on) => root.querySelector(`button[data-k="${k}"]`)?.classList.toggle('on', on);
  const setWeather = (t, c) => { root.querySelector('.wxt').textContent = t; el.clock.textContent = c; };
  return { update, root, buttons, onButton: (f) => { cb = f; }, setButton, setWeather };
}
