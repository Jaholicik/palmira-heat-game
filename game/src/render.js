// Drawing only: the world's state and the current screen in, pixels out. The world is painted
// through a camera that follows the player (with speed look-ahead and a slight zoom-out at
// driving speed), culled to the viewport; a light pass lays the day/night grade, headlight
// cones and neon over it; HUD, minimap and the menu screens are painted in screen space.
// Decoration draws from a private fixed-seed stream and a pure hash, never the world's stream.
import {
  BEACH_X, CITY_H, CITY_W, COLS, FONT, PALETTE, PITCH, ROAD, ROWS, TITLE_CLOCK, WATER_X,
  WORLD_W, roadX, roadY,
} from './config.js';
import { createDecoRandom, hash2 } from './random.js';
import { districtAt } from './city.js';

export const SCREEN_TITLE = 'title';
export const SCREEN_PLAY = 'play';
export const SCREEN_PAUSED = 'paused';
export const SCREEN_OVER = 'over';
export const SCREEN_HELP = 'help';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The light at an hour: darkness 0..1 and sunset warmth 0..1. */
export function skyAt(hour) {
  let darkness;
  if (hour < 4.5) darkness = 1;
  else if (hour < 7.5) darkness = 1 - smoothstep(4.5, 7.5, hour) * 0.92;
  else if (hour < 16.5) darkness = 0.08;
  else if (hour < 19.8) darkness = 0.08 + smoothstep(16.5, 19.8, hour) * 0.72;
  else if (hour < 21) darkness = 0.8 + smoothstep(19.8, 21, hour) * 0.2;
  else darkness = 1;
  let warmth = 0;
  if (hour >= 16.8 && hour <= 20) warmth = Math.sin(((hour - 16.8) / 3.2) * Math.PI);
  if (hour >= 5.4 && hour < 7.6) warmth = Math.sin(((hour - 5.4) / 2.2) * Math.PI) * 0.5;
  return { darkness, warmth };
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const view = { w: 1280, h: 800 };
  let cam = { x: 0, y: 0, scale: 1 };
  const deco = createDecoRandom();
  const clouds = [];
  for (let i = 0; i < 15; i += 1) clouds.push({ x: deco() * WORLD_W, y: deco() * CITY_H, r: 180 + deco() * 260 });
  const speckles = [];
  for (let i = 0; i < 240; i += 1) speckles.push({ x: BEACH_X + deco() * (WATER_X - BEACH_X), y: deco() * CITY_H });
  const sparkles = [];
  for (let i = 0; i < 130; i += 1) sparkles.push({ x: WATER_X + deco() * (WORLD_W - WATER_X), y: deco() * CITY_H, p: deco() * TAU });

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    view.w = Math.round(window.innerWidth * ratio);
    view.h = Math.round(window.innerHeight * ratio);
    canvas.width = view.w;
    canvas.height = view.h;
  }
  window.addEventListener('resize', resize);
  resize();

  const fonts = new Map();
  function font(size, weight = '') {
    const key = `${weight}${size}`;
    if (!fonts.has(key)) fonts.set(key, `${weight} ${size}px ${FONT}`);
    return fonts.get(key);
  }
  function text(value, x, y, size, color, align = 'left', weight = '') {
    ctx.font = font(size, weight);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(value, x, y);
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function computeCamera(state, screen) {
    const p = state.player;
    let cx;
    let cy;
    let zoom;
    if (screen === SCREEN_TITLE) {
      cx = state.titleAnchor.x + Math.sin(state.t * 0.07) * 36;
      cy = state.titleAnchor.y + Math.cos(state.t * 0.05) * 22;
      zoom = 1.03;
    } else {
      const vx = p.car ? Math.cos(p.car.angle) * p.car.speed : p.vx;
      const vy = p.car ? Math.sin(p.car.angle) * p.car.speed : p.vy;
      cx = p.x + clamp(vx * 0.42, -130, 130);
      cy = p.y + clamp(vy * 0.42, -130, 130);
      zoom = p.car ? 1 - Math.min(0.16, (Math.abs(p.car.speed) / p.car.spec.topSpeed) * 0.16) : 1;
    }
    if (state.shake > 0.2) {
      cx += Math.sin(state.t * 91) * state.shake * 0.7;
      cy += Math.cos(state.t * 83) * state.shake * 0.7;
    }
    const scale = (view.h / 800) * zoom;
    return { x: cx, y: cy, scale };
  }

  function screenToWorld(cssX, cssY) {
    const ratio = view.w / (canvas.clientWidth || view.w);
    const dx = cssX * ratio;
    const dy = cssY * (view.h / (canvas.clientHeight || view.h));
    return {
      x: cam.x + (dx - view.w / 2) / cam.scale,
      y: cam.y + (dy - view.h / 2) / cam.scale,
    };
  }

  // ------------------------------------------------------------------ world pass
  function drawWorld(state, screen) {
    const city = state.city;
    const hour = screen === SCREEN_TITLE ? TITLE_CLOCK : state.clock;
    const sky = skyAt(hour);
    const left = cam.x - view.w / 2 / cam.scale - 60;
    const right = cam.x + view.w / 2 / cam.scale + 60;
    const top = cam.y - view.h / 2 / cam.scale - 60;
    const bottom = cam.y + view.h / 2 / cam.scale + 60;
    const inView = (x, y, w, h) => x + w >= left && x <= right && y + h >= top && y <= bottom;

    ctx.fillStyle = PALETTE.backdrop;
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.setTransform(cam.scale, 0, 0, cam.scale, view.w / 2 - cam.x * cam.scale, view.h / 2 - cam.y * cam.scale);

    // Land base, beach and bay.
    ctx.fillStyle = PALETTE.block;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.fillStyle = PALETTE.sand;
    ctx.fillRect(BEACH_X, top, WATER_X - BEACH_X, bottom - top);
    ctx.fillStyle = PALETTE.sandWet;
    ctx.fillRect(WATER_X - 14, top, 14, bottom - top);
    for (const s of speckles) if (inView(s.x, s.y, 3, 3)) { ctx.fillStyle = '#c8ab72'; ctx.fillRect(s.x, s.y, 3, 2); }
    const waterGrad = ctx.createLinearGradient(WATER_X, 0, WORLD_W, 0);
    waterGrad.addColorStop(0, PALETTE.water);
    waterGrad.addColorStop(1, PALETTE.waterDeep);
    ctx.fillStyle = waterGrad;
    ctx.fillRect(WATER_X, top, WORLD_W - WATER_X, bottom - top);
    // Animated foam along the waterline.
    ctx.fillStyle = PALETTE.foam;
    for (let y = Math.floor(top / 26) * 26; y < bottom; y += 26) {
      const off = Math.sin(state.t * 1.7 + y * 0.045) * 5;
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(state.t * 2.3 + y * 0.11);
      ctx.fillRect(WATER_X - 3 + off, y, 9, 3);
    }
    ctx.globalAlpha = 1;
    for (const sp of sparkles) {
      if (!inView(sp.x, sp.y, 4, 4)) continue;
      const tw = 0.5 + 0.5 * Math.sin(state.t * 2 + sp.p);
      ctx.fillStyle = `rgba(220,245,255,${0.12 + tw * 0.25})`;
      ctx.fillRect(sp.x, sp.y, 4, 2);
    }

    // Roads: asphalt strips, then markings.
    ctx.fillStyle = PALETTE.asphalt;
    for (let c = 0; c <= COLS; c += 1) ctx.fillRect(roadX(c) - ROAD / 2, top, ROAD, bottom - top);
    for (let r = 0; r <= ROWS; r += 1) ctx.fillRect(left < CITY_W ? left : left, roadY(r) - ROAD / 2, Math.min(right, CITY_W + ROAD / 2) - left, ROAD);
    ctx.fillStyle = PALETTE.asphaltDark;
    for (let c = 0; c <= COLS; c += 1) for (let r = 0; r <= ROWS; r += 1) {
      ctx.fillRect(roadX(c) - ROAD / 2, roadY(r) - ROAD / 2, ROAD, ROAD);
    }
    // Sidewalk blocks.
    ctx.fillStyle = PALETTE.sidewalk;
    for (let c = 0; c < COLS; c += 1) {
      for (let r = 0; r < ROWS; r += 1) {
        const x = c * PITCH + ROAD;
        const y = r * PITCH + ROAD;
        if (inView(x, y, PITCH - ROAD, PITCH - ROAD)) ctx.fillRect(x, y, PITCH - ROAD, PITCH - ROAD);
      }
    }
    for (const park of city.parks) {
      ctx.fillStyle = park.lot ? '#4c4f55' : PALETTE.park;
      ctx.fillRect(park.x, park.y, park.w, park.h);
    }
    // Lane dashes, avenue centrelines, crosswalks and stop lines.
    ctx.fillStyle = PALETTE.lane;
    for (let c = 0; c <= COLS; c += 1) {
      for (const off of [-24, 24]) {
        for (let y = Math.floor(top / 44) * 44; y < bottom; y += 44) ctx.fillRect(roadX(c) + off - 1.5, y, 3, 24);
      }
    }
    for (let r = 0; r <= ROWS; r += 1) {
      for (const off of [-24, 24]) {
        for (let x = Math.floor(left / 44) * 44; x < Math.min(right, CITY_W); x += 44) ctx.fillRect(x, roadY(r) + off - 1.5, 24, 3);
      }
    }
    ctx.fillStyle = PALETTE.centre;
    for (let c = 0; c <= COLS; c += 3) ctx.fillRect(roadX(c) - 2, top, 4, bottom - top);
    for (let r = 0; r <= ROWS; r += 3) ctx.fillRect(left, roadY(r) - 2, Math.min(right, CITY_W) - left, 4);
    ctx.fillStyle = 'rgba(232,228,218,0.75)';
    for (let c = 0; c <= COLS; c += 1) {
      for (let r = 0; r <= ROWS; r += 1) {
        const x = roadX(c);
        const y = roadY(r);
        if (!inView(x - ROAD / 2, y - ROAD / 2, ROAD, ROAD)) continue;
        for (let i = -2; i <= 2; i += 1) {
          ctx.fillRect(x + i * 16 - 5, y - ROAD / 2 + 4, 10, 18);
          ctx.fillRect(x + i * 16 - 5, y + ROAD / 2 - 22, 10, 18);
        }
        ctx.fillRect(x - ROAD / 2 + 8, y - 8, 20, 4);
      }
    }

    // Pier, containers, crates, benches, lamps.
    const pier = city.pier;
    ctx.fillStyle = '#8a6f4d';
    ctx.fillRect(pier.x, pier.y, pier.w, pier.h);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (let x = pier.x + 14; x < pier.x + pier.w; x += 22) ctx.fillRect(x, pier.y, 3, pier.h);
    ctx.fillStyle = '#6d573c';
    ctx.fillRect(pier.x, pier.y + pier.h - 5, pier.w, 5);
    for (const ct of city.containers) {
      ctx.fillStyle = ct.color;
      ctx.fillRect(ct.x, ct.y, ct.w, ct.h);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      for (let x = ct.x + 8; x < ct.x + ct.w - 4; x += 12) ctx.fillRect(x, ct.y + 2, 3, ct.h - 4);
    }
    for (const cr of city.crates) {
      ctx.fillStyle = '#a5804f';
      ctx.fillRect(cr.x, cr.y, cr.w, cr.h);
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.strokeRect(cr.x + 1, cr.y + 1, cr.w - 2, cr.h - 2);
    }
    ctx.fillStyle = '#5d4a33';
    for (const b of city.benches) if (inView(b.x, b.y, 14, 6)) ctx.fillRect(b.x, b.y, 14, 6);
    for (const lamp of city.lamps) {
      if (!inView(lamp.x, lamp.y, 6, 6)) continue;
      ctx.fillStyle = '#3c4048';
      ctx.fillRect(lamp.x - 2, lamp.y - 2, 4, 4);
    }

    // Skid marks under everything that moves.
    ctx.fillStyle = 'rgba(20,20,22,0.5)';
    for (const sk of state.skids) {
      ctx.globalAlpha = clamp(sk.life / 16, 0, 1) * 0.55;
      ctx.fillRect(sk.x - 3, sk.y - 3, 6, 6);
    }
    ctx.globalAlpha = 1;

    // Boats bobbing at anchor.
    for (const boat of city.boats) {
      if (!inView(boat.x - 30, boat.y - 16, 60, 32)) continue;
      const bobY = Math.sin(state.t * 1.3 + boat.phase) * 2.2;
      ctx.save();
      ctx.translate(boat.x, boat.y + bobY);
      ctx.rotate(boat.angle + Math.sin(state.t * 0.9 + boat.phase) * 0.03);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(2, 4, 26, 10, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = boat.color;
      ctx.beginPath(); ctx.ellipse(0, 0, 25, 9, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#eef1f5';
      ctx.fillRect(-6, -4, 13, 8);
      ctx.restore();
    }

    // Buildings: soft shadow, walls, roof, windows, rooftop clutter, shop signs.
    for (const b of city.buildings) {
      if (!inView(b.x - 14, b.y - 14, b.w + 30, b.h + 30)) continue;
      const lift = 4 + b.grade * 5;
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(b.x + lift * 0.9, b.y + lift * 0.9, b.w, b.h);
      ctx.fillStyle = shade(b.facade, -18);
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = b.roof;
      ctx.fillRect(b.x + 3, b.y - lift, b.w - 6, b.h - 3);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(b.x + 9, b.y - lift + 6, b.w - 18, b.h - 16);
      // Rooftop props.
      ctx.fillStyle = '#7d838e';
      for (let i = 0; i < b.ac; i += 1) {
        const ax = b.x + 12 + hash2(b.id, 40 + i) * (b.w - 34);
        const ay = b.y - lift + 10 + hash2(b.id, 60 + i) * (b.h - 34);
        ctx.fillRect(ax, ay, 13, 10);
      }
      if (b.tower) {
        const tx = b.x + b.w - 24;
        const ty = b.y - lift + 12;
        ctx.fillStyle = '#6d573c';
        ctx.beginPath(); ctx.arc(tx, ty, 8, 0, TAU); ctx.fill();
        ctx.fillStyle = '#86694a';
        ctx.beginPath(); ctx.arc(tx, ty, 5.5, 0, TAU); ctx.fill();
      }
      // Windows on the south wall band; some glow once the light goes.
      const cols = Math.max(2, Math.floor(b.w / 17));
      const night = sky.darkness;
      for (let i = 0; i < cols; i += 1) {
        const wx = b.x + 7 + i * ((b.w - 14) / cols);
        const lit = hash2(b.id, i) < night * 0.62;
        ctx.fillStyle = lit ? '#ffd98a' : 'rgba(24,30,40,0.85)';
        ctx.fillRect(wx, b.y + b.h - lift - 3, 8, lift + 1);
      }
      // Storefront: awning stripes and a sign band with the business name.
      if (b.shop) {
        if (b.awning) {
          for (let i = 0; i < 6; i += 1) {
            ctx.fillStyle = i % 2 ? b.awning : '#e8e4da';
            ctx.fillRect(b.x + 4 + i * ((b.w - 8) / 6), b.y + b.h - 3, (b.w - 8) / 6, 5);
          }
        }
        const special = b.special !== null;
        ctx.fillStyle = special ? '#22304a' : 'rgba(18,20,26,0.88)';
        const label = b.shop;
        ctx.font = font(10, '700');
        const tw = Math.min(b.w - 8, ctx.measureText(label).width + 12);
        ctx.fillRect(b.x + (b.w - tw) / 2, b.y + b.h - lift - 17, tw, 13);
        text(label, b.x + b.w / 2, b.y + b.h - lift - 7, 10, special ? '#ffd76a' : '#f0ead8', 'center', '700');
      }
    }

    // Respray bay marking.
    const bay = city.specials.respray.bay;
    ctx.strokeStyle = '#39d0ba';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(bay.x, bay.y, bay.w, bay.h);
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    // Palms: shadow, trunk, swaying fronds.
    for (const palm of city.palms) {
      if (!inView(palm.x - 30, palm.y - 30, 60, 60)) continue;
      const sway = Math.sin(state.t * 1.1 + palm.phase) * 2.4;
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.ellipse(palm.x + 7, palm.y + 8, 15 * palm.s, 6, 0.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#7a5c38';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(palm.x, palm.y);
      ctx.quadraticCurveTo(palm.x + sway * 0.5, palm.y - 8, palm.x + sway, palm.y - 13);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#3f7d3a';
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * TAU + palm.phase;
        ctx.beginPath();
        ctx.moveTo(palm.x + sway, palm.y - 13);
        ctx.quadraticCurveTo(
          palm.x + sway + Math.cos(a) * 10, palm.y - 15 + Math.sin(a) * 4,
          palm.x + sway + Math.cos(a) * 17, palm.y - 9 + Math.sin(a) * 8,
        );
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }

    // Pickups.
    for (const pk of state.pickups) {
      if (!pk.active || !inView(pk.x - 16, pk.y - 16, 32, 32)) continue;
      const bob = Math.sin(state.t * 3 + pk.phase) * 3;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(pk.x, pk.y + 8, 10, 4, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = pk.kind === 'health' ? '#eef1f5' : '#31597f';
      roundRect(pk.x - 10, pk.y - 10 + bob, 20, 20, 5);
      ctx.fill();
      ctx.fillStyle = pk.kind === 'health' ? '#c9453c' : '#ffd76a';
      if (pk.kind === 'health') {
        ctx.fillRect(pk.x - 2.5, pk.y - 7 + bob, 5, 14);
        ctx.fillRect(pk.x - 7, pk.y - 2.5 + bob, 14, 5);
      } else {
        ctx.beginPath();
        ctx.arc(pk.x, pk.y + bob, 5, 0, TAU);
        ctx.fill();
      }
    }

    drawCars(state, sky);
    drawPeople(state, sky);

    // Particles on top of the actors.
    for (const pt of state.particles) {
      ctx.globalAlpha = clamp(pt.life / pt.maxLife, 0, 1);
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
    }
    ctx.globalAlpha = 1;

    // Cloud shadows drifting over the whole city.
    ctx.fillStyle = 'rgba(10,12,20,0.10)';
    for (const cloud of clouds) {
      const cx = ((cloud.x + state.t * 11) % (WORLD_W + 700)) - 350;
      if (!inView(cx - cloud.r, cloud.y - cloud.r * 0.5, cloud.r * 2, cloud.r)) continue;
      ctx.beginPath();
      ctx.ellipse(cx, cloud.y, cloud.r, cloud.r * 0.52, 0, 0, TAU);
      ctx.fill();
    }

    // Grade: sunset warmth, then the night.
    if (sky.warmth > 0.02) {
      ctx.fillStyle = `rgba(255,116,38,${sky.warmth * 0.16})`;
      ctx.fillRect(left, top, right - left, bottom - top);
    }
    if (sky.darkness > 0.04) {
      ctx.fillStyle = `rgba(8,10,34,${sky.darkness * 0.52})`;
      ctx.fillRect(left, top, right - left, bottom - top);
      drawLights(state, sky);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function shade(hex, amt) {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = clamp(((n >> 16) & 255) + amt, 0, 255);
    const g = clamp(((n >> 8) & 255) + amt, 0, 255);
    const b = clamp((n & 255) + amt, 0, 255);
    return `rgb(${r},${g},${b})`;
  }

  function drawCars(state, sky) {
    for (const car of state.cars) {
      const spec = car.spec;
      if (car.x < cam.x - view.w / 2 / cam.scale - 90 || car.x > cam.x + view.w / 2 / cam.scale + 90
        || car.y < cam.y - view.h / 2 / cam.scale - 90 || car.y > cam.y + view.h / 2 / cam.scale + 90) continue;
      ctx.save();
      ctx.translate(car.x, car.y);
      // Soft shadow, then the hull in its own heading.
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.beginPath(); ctx.ellipse(4, 6, spec.len * 0.52, spec.wid * 0.58, car.angle, 0, TAU); ctx.fill();
      ctx.rotate(car.angle);
      const L = spec.len;
      const W = spec.wid;
      // Wheels; the front pair turns with the steering.
      ctx.fillStyle = '#15161a';
      const wy = W / 2 - 1;
      const wx = L * 0.31;
      for (const [x, y, front] of [[wx, -wy, 1], [wx, wy, 1], [-wx, -wy, 0], [-wx, wy, 0]]) {
        ctx.save();
        ctx.translate(x, y);
        if (front) ctx.rotate(car.steerVis * 0.42);
        ctx.fillRect(-5, -2.5, 10, 5);
        ctx.restore();
      }
      // Metallic body: a two-stop gradient along the hull.
      const grad = ctx.createLinearGradient(-L / 2, 0, L / 2, 0);
      grad.addColorStop(0, shade(car.color, -26));
      grad.addColorStop(0.45, shade(car.color, 22));
      grad.addColorStop(1, shade(car.color, -12));
      ctx.fillStyle = car.health <= 0 ? '#3a3a3e' : grad;
      roundRect(-L / 2, -W / 2, L, W, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();
      // Glass canopy.
      ctx.fillStyle = 'rgba(16,22,30,0.92)';
      roundRect(-L * 0.16, -W * 0.36, L * 0.34, W * 0.72, 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(140,190,225,0.35)';
      roundRect(L * 0.02, -W * 0.36, L * 0.14, W * 0.72, 3);
      ctx.fill();
      // Hood and trunk shading.
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(L * 0.24, -W * 0.4, L * 0.2, W * 0.8);
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      ctx.fillRect(-L * 0.46, -W * 0.4, L * 0.16, W * 0.8);
      if (car.type === 'taxi') {
        ctx.fillStyle = '#1d1d20';
        for (let i = 0; i < 4; i += 1) for (let j = 0; j < 2; j += 1) {
          if ((i + j) % 2 === 0) ctx.fillRect(-L * 0.42 + i * 5, -W * 0.44 + j * 5, 5, 5);
        }
        ctx.fillStyle = '#f5d13c';
        ctx.fillRect(-5, -5, 10, 10);
        text('TAXI', 0, 3, 6, '#1d1d20', 'center', '800');
      }
      if (car.type === 'sport') {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillRect(-L * 0.1, -2.5, L * 0.52, 5);
        ctx.fillStyle = '#22242a';
        ctx.fillRect(-L / 2 - 1, -W * 0.42, 4, W * 0.84);
      }
      if (car.type === 'van') {
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        for (let i = 0; i < 3; i += 1) {
          ctx.beginPath();
          ctx.moveTo(-L * 0.3 + i * L * 0.22, -W / 2 + 2);
          ctx.lineTo(-L * 0.3 + i * L * 0.22, W / 2 - 2);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        for (let i = 0; i < 5; i += 1) ctx.fillRect(-L * 0.44 + i * 9, -W / 2 + 2, 2, 2);
        if (car.special === 'bastion') {
          text('BANCO PALMA', 0, 3, 7, 'rgba(255,215,106,0.9)', 'center', '800');
        }
      }
      if (car.type === 'police') {
        ctx.fillStyle = '#22304a';
        ctx.fillRect(-L * 0.05, -W / 2, L * 0.16, W);
        text('PD', L * 0.03, 3.5, 8, '#eef1f5', 'center', '800');
        // Light bar: red and blue halves trading flashes.
        const flash = Math.sin(state.t * 11 + car.sirenPhase) > 0;
        ctx.fillStyle = flash ? '#ff4b3e' : '#7a1610';
        ctx.fillRect(-6, -W * 0.3, 6, W * 0.28);
        ctx.fillStyle = flash ? '#274b8f' : '#3e8bff';
        ctx.fillRect(0, -W * 0.3, 6, W * 0.28);
        ctx.fillStyle = '#2b2e35';
        ctx.fillRect(-6, W * 0.02, 12, W * 0.28 - 1);
      }
      // Headlights and brake lights.
      ctx.fillStyle = '#ffeeb8';
      ctx.fillRect(L / 2 - 2, -W * 0.34, 2.5, 4);
      ctx.fillRect(L / 2 - 2, W * 0.34 - 4, 2.5, 4);
      ctx.fillStyle = car.brakeVis > 0.3 ? '#ff3524' : '#8f1d14';
      ctx.fillRect(-L / 2, -W * 0.34, 2.5, 4);
      ctx.fillRect(-L / 2, W * 0.34 - 4, 2.5, 4);
      if (car.health <= 0) {
        ctx.fillStyle = 'rgba(12,12,14,0.45)';
        roundRect(-L / 2, -W / 2, L, W, 6);
        ctx.fill();
        const puffs = 2 + Math.floor(hash2(car.id, 7) * 2);
        for (let i = 0; i < puffs; i += 1) {
          const ph = hash2(car.id, 20 + i);
          const rise = ((state.t * 14 + ph * 40) % 26);
          ctx.fillStyle = `rgba(120,120,125,${0.35 * (1 - rise / 26)})`;
          ctx.beginPath();
          ctx.arc(L * 0.3 + ph * 6, -rise * 0.4, 3 + rise * 0.22, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  function drawPerson(x, y, angle, shirt, pants, phase, opts = {}) {
    const bob = Math.sin(phase) * 1.6;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(x + 2, y + 3, 8, 4.5, 0, 0, TAU); ctx.fill();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    if (opts.down) {
      ctx.fillStyle = pants;
      ctx.fillRect(-4, -3, 15, 6);
      ctx.fillStyle = shirt;
      ctx.fillRect(-13, -4.5, 11, 9);
      ctx.fillStyle = opts.skin || '#d9a066';
      ctx.beginPath(); ctx.arc(-16, 0, 4, 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = pants;
      ctx.fillRect(-3 + bob * 0.4, -5, 6, 3.4);
      ctx.fillRect(-3 - bob * 0.4, 1.6, 6, 3.4);
      ctx.fillStyle = shirt;
      ctx.beginPath(); ctx.arc(0, 0, 6.4, 0, TAU); ctx.fill();
      ctx.fillStyle = opts.skin || '#d9a066';
      ctx.beginPath(); ctx.arc(1.6, 0, 3.6, 0, TAU); ctx.fill();
      if (opts.hail) {
        ctx.strokeStyle = shirt;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(2, -4);
        ctx.lineTo(9, -11);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      if (opts.cap) {
        ctx.fillStyle = opts.cap;
        ctx.beginPath(); ctx.arc(1.6, 0, 3.8, Math.PI * 0.6, Math.PI * 1.9); ctx.fill();
      }
      if (opts.gun) {
        ctx.fillStyle = '#1c1e24';
        ctx.fillRect(4, -1.2, 10, 2.4);
      }
    }
    ctx.restore();
  }

  function drawPeople(state, sky) {
    const p = state.player;
    for (const ped of state.peds) {
      if (ped.inCar) continue;
      if (ped.x < cam.x - view.w / 2 / cam.scale - 40 || ped.x > cam.x + view.w / 2 / cam.scale + 40
        || ped.y < cam.y - view.h / 2 / cam.scale - 40 || ped.y > cam.y + view.h / 2 / cam.scale + 40) continue;
      if (ped.state === 'down') {
        ctx.globalAlpha = ped.downTimer < 1.5 ? clamp(ped.downTimer / 1.5, 0, 1) : 1;
        drawPerson(ped.x, ped.y, ped.angle, ped.shirt, ped.pants, 0, { down: true });
        ctx.globalAlpha = 1;
      } else {
        drawPerson(ped.x, ped.y, ped.angle, ped.shirt, ped.pants, ped.walkPhase, { hail: ped.state === 'hail' });
        if (ped.state === 'hail') {
          const bounce = Math.abs(Math.sin(state.t * 5)) * 6;
          text('!', ped.x, ped.y - 20 - bounce, 15, '#39c2d7', 'center', '800');
        }
      }
    }
    for (const o of state.officers) {
      if (o.dead) ctx.globalAlpha = clamp(1 - o.fade / 2.5, 0, 1);
      drawPerson(o.x, o.y, o.angle, '#22304a', '#1a2334', o.walkPhase, { down: o.dead, cap: '#16233c', gun: !o.dead });
      ctx.globalAlpha = 1;
    }
    if (!p.car && !state.over) {
      drawPerson(p.x, p.y, p.angle, '#e8e4da', '#31435c', p.walkPhase, { gun: true, skin: '#c98a54' });
      if (p.hurtTimer > 0) {
        ctx.fillStyle = `rgba(229,83,75,${p.hurtTimer * 1.4})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, TAU); ctx.fill();
      }
    }
  }

  function drawLights(state, sky) {
    ctx.globalCompositeOperation = 'lighter';
    const t = state.t;
    for (const car of state.cars) {
      if (car.x < cam.x - view.w / 2 / cam.scale - 200 || car.x > cam.x + view.w / 2 / cam.scale + 200
        || car.y < cam.y - view.h / 2 / cam.scale - 200 || car.y > cam.y + view.h / 2 / cam.scale + 200) continue;
      // Headlight cones.
      const hx = car.x + Math.cos(car.angle) * car.spec.len * 0.5;
      const hy = car.y + Math.sin(car.angle) * car.spec.len * 0.5;
      const grad = ctx.createRadialGradient(hx, hy, 4, hx, hy, 95);
      grad.addColorStop(0, 'rgba(255,238,180,0.20)');
      grad.addColorStop(1, 'rgba(255,238,180,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.arc(hx, hy, 95, car.angle - 0.36, car.angle + 0.36);
      ctx.closePath();
      ctx.fill();
      if (car.type === 'police' && car.driver === 'police' && car.health > 0) {
        const flash = Math.sin(t * 11 + car.sirenPhase) > 0;
        const glow = ctx.createRadialGradient(car.x, car.y, 2, car.x, car.y, 54);
        const col = flash ? '255,70,50' : '60,130,255';
        glow.addColorStop(0, `rgba(${col},0.30)`);
        glow.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(car.x, car.y, 54, 0, TAU); ctx.fill();
      }
      if (car.brakeVis > 0.3) {
        ctx.fillStyle = 'rgba(255,60,40,0.18)';
        ctx.beginPath();
        ctx.arc(car.x - Math.cos(car.angle) * car.spec.len * 0.5, car.y - Math.sin(car.angle) * car.spec.len * 0.5, 15, 0, TAU);
        ctx.fill();
      }
    }
    // Neon signs and street lamps bloom in the dark.
    for (const b of state.city.buildings) {
      if (!b.shop) continue;
      if (b.x < cam.x - view.w / 2 / cam.scale - 60 || b.x > cam.x + view.w / 2 / cam.scale + 60
        || b.y < cam.y - view.h / 2 / cam.scale - 60 || b.y > cam.y + view.h / 2 / cam.scale + 60) continue;
      const hue = hash2(b.id, 99);
      const col = hue < 0.33 ? '255,110,180' : hue < 0.66 ? '80,220,255' : '255,190,80';
      ctx.fillStyle = `rgba(${col},${0.10 + sky.darkness * 0.10})`;
      ctx.fillRect(b.x + 4, b.y + b.h - 20, b.w - 8, 16);
    }
    for (const lamp of state.city.lamps) {
      if (lamp.x < cam.x - view.w / 2 / cam.scale - 40 || lamp.x > cam.x + view.w / 2 / cam.scale + 40
        || lamp.y < cam.y - view.h / 2 / cam.scale - 40 || lamp.y > cam.y + view.h / 2 / cam.scale + 40) continue;
      const g = ctx.createRadialGradient(lamp.x, lamp.y, 1, lamp.x, lamp.y, 30);
      g.addColorStop(0, 'rgba(255,220,150,0.20)');
      g.addColorStop(1, 'rgba(255,220,150,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(lamp.x, lamp.y, 30, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------------ HUD & screens
  function frosted(x, y, w, h, r = 12) {
    ctx.fillStyle = 'rgba(13,16,22,0.58)';
    roundRect(x, y, w, h, r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.stroke();
  }

  function wrapText(value, maxWidth, size) {
    ctx.font = font(size);
    const words = value.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  function project(x, y) {
    return {
      x: (x - cam.x) * cam.scale + view.w / 2,
      y: (y - cam.y) * cam.scale + view.h / 2,
    };
  }

  function drawMarker(state, marker, color, label) {
    if (!marker) return;
    const s = project(marker.x, marker.y);
    const cx = clamp(s.x, 30, view.w - 30);
    const cy = clamp(s.y, 30, view.h - 30);
    const offscreen = cx !== s.x || cy !== s.y;
    ctx.save();
    ctx.translate(cx, cy);
    if (offscreen) ctx.rotate(Math.atan2(s.y - cy, s.x - cx) + Math.PI / 2);
    const bob = offscreen ? 0 : Math.sin(state.t * 4) * 4;
    ctx.translate(0, bob - 14);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 12);
    ctx.lineTo(-9, -4);
    ctx.lineTo(9, -4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, -8, 6, 0, TAU);
    ctx.fill();
    ctx.restore();
    if (label) text(label, cx, cy - 34 + (offscreen ? 0 : Math.sin(state.t * 4) * 4), 11, color, 'center', '700');
  }

  function drawMinimap(state) {
    const w = 218;
    const h = 150;
    const x = view.w - w - 16;
    const y = 16;
    frosted(x, y, w, h, 10);
    const mx = (wx) => x + 6 + (wx / WORLD_W) * (w - 12);
    const my = (wy) => y + 6 + (wy / CITY_H) * (h - 12);
    ctx.fillStyle = PALETTE.waterDeep;
    ctx.fillRect(mx(WATER_X), my(0), mx(WORLD_W) - mx(WATER_X), my(CITY_H) - my(0));
    ctx.fillStyle = PALETTE.sand;
    ctx.fillRect(mx(BEACH_X), my(0), mx(WATER_X) - mx(BEACH_X), my(CITY_H) - my(0));
    ctx.strokeStyle = 'rgba(230,230,220,0.35)';
    ctx.beginPath();
    for (let c = 0; c <= COLS; c += 1) { ctx.moveTo(mx(roadX(c)), my(0)); ctx.lineTo(mx(roadX(c)), my(CITY_H)); }
    for (let r = 0; r <= ROWS; r += 1) { ctx.moveTo(mx(0), my(roadY(r))); ctx.lineTo(mx(CITY_W), my(roadY(r))); }
    ctx.stroke();
    const dot = (wx, wy, color, size = 3) => { ctx.fillStyle = color; ctx.fillRect(mx(wx) - size / 2, my(wy) - size / 2, size, size); };
    dot(state.city.specials.pd.door.x, state.city.specials.pd.door.y, '#5b8cff', 4);
    dot(state.city.specials.hospital.door.x, state.city.specials.hospital.door.y, '#ff7a70', 4);
    const bay = state.city.specials.respray.bay;
    dot(bay.x + bay.w / 2, bay.y + bay.h / 2, '#39d0ba', 4);
    if (state.marker) dot(state.marker.x, state.marker.y, PALETTE.gold, 5);
    if (state.taxiMarker) dot(state.taxiMarker.x, state.taxiMarker.y, '#39c2d7', 5);
    if (state.stars > 0) {
      const flash = Math.sin(state.t * 9) > 0;
      for (const car of state.cars) {
        if (car.driver === 'police' && car.health > 0) dot(car.x, car.y, flash ? '#ff5040' : '#3e8bff', 3.5);
      }
    }
    // Player arrow.
    const p = state.player;
    ctx.save();
    ctx.translate(mx(p.x), my(p.y));
    ctx.rotate(p.angle);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, -4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    text('PALMIRA', x + 10, y + h - 8, 9, PALETTE.muted, 'left', '700');
  }

  function drawHud(state, ui) {
    const p = state.player;
    ctx.textBaseline = 'alphabetic';
    // Cash, clock, district.
    frosted(16, 16, 168, 58);
    text(`$${Math.floor(state.cash).toLocaleString('en-US')}`, 28, 46, 24, PALETTE.gold, 'left', '800');
    const hh = Math.floor(state.clock);
    const mm = Math.floor((state.clock - hh) * 60);
    text(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ${districtLabel(state)}`, 28, 66, 11.5, PALETTE.muted, 'left', '600');

    drawMinimap(state);
    // Wanted stars under the minimap.
    let stars = '';
    for (let i = 0; i < 5; i += 1) stars += i < state.stars ? '★' : '☆';
    text(stars, view.w - 20, 190, 21, state.stars > 0 ? PALETTE.gold : 'rgba(255,255,255,0.25)', 'right', '800');

    // Objective banner, top centre.
    if (state.banner) {
      ctx.font = font(15, '700');
      const tw = ctx.measureText(state.banner.title).width;
      ctx.font = font(12.5);
      const sw = ctx.measureText(state.banner.sub).width;
      let distText = '';
      if (state.marker) distText = ` · ${Math.round(Math.hypot(state.marker.x - p.x, state.marker.y - p.y) / 10)}m`;
      const w = Math.max(tw, sw + ctx.measureText(distText).width) + 36;
      const x = (view.w - w) / 2;
      frosted(x, 16, w, 52);
      text(state.banner.title, view.w / 2, 38, 15, '#ffffff', 'center', '700');
      text(state.banner.sub + distText, view.w / 2, 58, 12.5, PALETTE.gold, 'center', '600');
    }
    drawMarker(state, state.marker, PALETTE.gold, 'OBJECTIVE');
    drawMarker(state, state.taxiMarker, '#39c2d7', 'TAXI');

    // Health and armor, bottom left.
    const bx = 16;
    const by = view.h - 64;
    frosted(bx, by, 208, 48);
    bar(bx + 52, by + 10, 142, 10, p.health / 100, p.health > 30 ? '#63c74d' : PALETTE.danger, 'HP');
    bar(bx + 52, by + 28, 142, 10, p.armor / 100, '#5bc0de', 'ARMOR');
    function bar(x, y, w, h, frac, color, label) {
      text(label, bx + 10, y + h - 1, 10, PALETTE.muted, 'left', '700');
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      roundRect(x, y, w, h, 5);
      ctx.fill();
      if (frac > 0) {
        ctx.fillStyle = color;
        roundRect(x, y, Math.max(6, w * clamp(frac, 0, 1)), h, 5);
        ctx.fill();
      }
    }

    // Car panel + radio pill, bottom right.
    if (p.car) {
      const label = `${p.car.spec.name} · ${Math.round(Math.abs(p.car.speed) * 0.32)} km/h`;
      ctx.font = font(13, '700');
      const w = ctx.measureText(label).width + 28;
      frosted(view.w - w - 16, view.h - 46, w, 30);
      text(label, view.w - w - 2, view.h - 26, 13, '#ffffff', 'left', '700');
      const dmg = 1 - p.car.health / p.car.spec.health;
      if (dmg > 0.25) text(`damage ${Math.round(dmg * 100)}%`, view.w - 18, view.h - 56, 11, PALETTE.danger, 'right', '700');
    }
    if (state.radio) {
      const label = `RADIO · ${state.radio.name}`;
      ctx.font = font(11.5, '700');
      const w = ctx.measureText(label).width + 24;
      const x = (view.w - w) / 2;
      ctx.fillStyle = 'rgba(20,16,30,0.72)';
      roundRect(x, view.h - 108, w, 24, 12);
      ctx.fill();
      text(label, view.w / 2, view.h - 92, 11.5, '#d9b8ff', 'center', '700');
    }

    // Bust meter, bottom centre.
    if (state.bust > 0.01) {
      const w = 264;
      const x = (view.w - w) / 2;
      const y = view.h - 76;
      frosted(x, y, w, 30);
      ctx.fillStyle = PALETTE.danger;
      roundRect(x + 6, y + 15, (w - 12) * state.bust, 8, 4);
      ctx.fill();
      text(state.bust > 0.7 && Math.sin(state.t * 10) > 0 ? 'BUSTED' : 'THEY ARE ON YOU — MOVE!', view.w / 2, y + 12, 10.5, '#ffb3a3', 'center', '800');
    }

    // Faro's phone popup, bottom centre-left.
    const popup = state.popups[0];
    if (popup) {
      const lines = wrapText(popup.text, 268, 12.5).slice(0, 3);
      const h = 44 + lines.length * 16;
      const x = 16;
      const y = view.h - 64 - h - 10;
      ctx.fillStyle = 'rgba(10,12,16,0.88)';
      roundRect(x, y, 300, h, 14);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.stroke();
      ctx.fillStyle = '#2b2f38';
      roundRect(x + 128, y + 5, 44, 5, 2.5);
      ctx.fill();
      text(popup.from.toUpperCase(), x + 14, y + 26, 11, '#39d0ba', 'left', '800');
      ctx.fillStyle = '#eef1f5';
      lines.forEach((line, i) => text(line, x + 14, y + 44 + i * 16, 12.5, '#eef1f5', 'left'));
    }

    // Hurt vignette.
    if (p.hurtTimer > 0 || p.health < 30) {
      const a = p.hurtTimer > 0 ? p.hurtTimer * 1.1 : 0.14 + 0.08 * Math.sin(state.t * 5);
      const grad = ctx.createRadialGradient(view.w / 2, view.h / 2, view.h * 0.32, view.w / 2, view.h / 2, view.h * 0.72);
      grad.addColorStop(0, 'rgba(160,10,10,0)');
      grad.addColorStop(1, `rgba(160,10,10,${clamp(a, 0, 0.5)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, view.w, view.h);
    }
    if (ui.mouse && !p.car) {
      const mx = ui.mouse.x * (view.w / (canvas.clientWidth || view.w));
      const my = ui.mouse.y * (view.h / (canvas.clientHeight || view.h));
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.arc(mx, my, 9, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(mx - 1, my - 1, 2, 2);
    }
    text('WASD move · F car · mouse aim · Esc pause', view.w / 2, view.h - 8, 10.5, 'rgba(255,255,255,0.35)', 'center');
  }

  function districtLabel(state) {
    return districtAt(state.player.x, state.player.y);
  }

  function drawMenuPanel(title, subtitle, items, index, footer) {
    ctx.fillStyle = 'rgba(6,8,12,0.42)';
    ctx.fillRect(0, 0, view.w, view.h);
    const cx = view.w / 2;
    let y = view.h * 0.30;
    const grad = ctx.createLinearGradient(cx - 320, 0, cx + 320, 0);
    grad.addColorStop(0, '#ffb35c');
    grad.addColorStop(0.5, '#ff7847');
    grad.addColorStop(1, '#ff4e7a');
    ctx.fillStyle = grad;
    ctx.font = font(76, '800');
    ctx.textAlign = 'center';
    ctx.fillText(title, cx, y);
    text(subtitle, cx, y + 34, 16, '#ffe9d0', 'center', '600');
    y += 92;
    items.forEach((item, i) => {
      const selected = i === index;
      if (selected) {
        ctx.fillStyle = 'rgba(255,180,80,0.16)';
        roundRect(cx - 170, y - 24, 340, 36, 9);
        ctx.fill();
      }
      text(item, cx, y + 2, 19, selected ? '#ffd76a' : 'rgba(255,255,255,0.75)', 'center', '700');
      y += 46;
    });
    if (footer) text(footer, cx, view.h - 26, 12, 'rgba(255,255,255,0.55)', 'center');
  }

  function drawOver(state) {
    const busted = state.over === 'busted';
    ctx.fillStyle = busted ? 'rgba(40,6,6,0.45)' : 'rgba(10,4,4,0.62)';
    ctx.fillRect(0, 0, view.w, view.h);
    const cx = view.w / 2;
    const cy = view.h * 0.42;
    if (busted) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.06);
      ctx.strokeStyle = '#ff5040';
      ctx.lineWidth = 5;
      roundRect(-210, -58, 420, 106, 10);
      ctx.stroke();
      text('BUSTED', 0, 22, 72, '#ff5040', 'center', '800');
      ctx.restore();
      text(`Fine $${state.overInfo.fine} — released outside Palmira PD`, cx, cy + 104, 16, '#ffd9d0', 'center', '600');
    } else {
      text('W A S T E D', cx, cy, 68, '#c22f24', 'center', '800');
      text(`Hospital bill $${state.overInfo.fine} — St. Azure patched you up`, cx, cy + 56, 16, '#ffd9d0', 'center', '600');
    }
    if (state.overTimer > 0.7) text('Press Enter', cx, cy + 148, 15, 'rgba(255,255,255,0.8)', 'center', '700');
  }

  function drawHelp() {
    ctx.fillStyle = 'rgba(6,8,12,0.66)';
    ctx.fillRect(0, 0, view.w, view.h);
    const lines = [
      'WASD / arrows — move and drive',
      'Shift — run on foot',
      'F or E — enter / exit any car (that is stealing)',
      'Mouse — aim · mouse held or Space — fire',
      'Stars are trouble: break line of sight to cool off,',
      'or get a respray at Shine & Go when nobody watches.',
      'Stop for hailing pedestrians to run taxi fares.',
      'Esc — back',
    ];
    const w = 520;
    const h = 90 + lines.length * 26;
    const x = (view.w - w) / 2;
    const y = (view.h - h) / 2;
    frosted(x, y, w, h, 16);
    text('HOW TO PLAY', view.w / 2, y + 44, 24, '#ffffff', 'center', '800');
    lines.forEach((line, i) => text(line, view.w / 2, y + 86 + i * 26, 14.5, '#cfd6e4', 'center'));
  }

  /** Paint one frame: the world, then the HUD or the panel for the screen the game is on. */
  function draw(state, screen, ui = {}) {
    cam = computeCamera(state, screen);
    drawWorld(state, screen);
    if (screen === SCREEN_PLAY || screen === SCREEN_PAUSED) drawHud(state, ui);
    if (screen === SCREEN_TITLE) {
      drawMenuPanel('PALMIRA HEAT', 'Five jobs for Faro. One city that never sleeps.', ui.items || ['New Game', 'How to Play'], ui.menuIndex || 0,
        'Enter / click — choose · WASD drive · F enter car · M mute');
    } else if (screen === SCREEN_PAUSED) {
      ctx.fillStyle = 'rgba(6,8,12,0.5)';
      ctx.fillRect(0, 0, view.w, view.h);
      const items = ui.items || ['Resume', 'Save Game', 'Restart Story', 'Quit to Title'];
      const cx = view.w / 2;
      let y = view.h * 0.36;
      text('PAUSED', cx, y, 40, '#ffffff', 'center', '800');
      y += 56;
      items.forEach((item, i) => {
        if (i === (ui.menuIndex || 0)) {
          ctx.fillStyle = 'rgba(255,180,80,0.16)';
          roundRect(cx - 150, y - 23, 300, 34, 9);
          ctx.fill();
        }
        text(item, cx, y, 18, i === (ui.menuIndex || 0) ? '#ffd76a' : 'rgba(255,255,255,0.75)', 'center', '700');
        y += 44;
      });
    } else if (screen === SCREEN_OVER) {
      drawOver(state);
    } else if (screen === SCREEN_HELP) {
      drawHelp();
    }
  }

  return { draw, screenToWorld };
}
