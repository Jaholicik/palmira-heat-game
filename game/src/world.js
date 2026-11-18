// The simulation: Palmira itself and everything that moves in it. No drawing and no browser
// here — the player on foot and in cars, traffic that drives the avenue grid, pedestrians on
// the sidewalks, the Palmira PD (units that chase and ram, officers who bail and shoot), the
// crime/heat model behind the wanted stars, busts, taxi fares, pickups, particles and skid
// marks. step() advances one fixed 1/60 s step and returns what happened as bit flags.
//
// Every random draw comes from the one seeded stream handed in at creation, and reset()
// replays that seed, so a seed always builds and plays the same city.
import {
  BUST, CAR_COLORS, CAR_TYPES, CITY_H, COLS, DAY_SECONDS, HEAT, PARKED_COUNT, PED_COUNT,
  PLAYER, RESPRAY_COST, RESPRAY_WATCH_RANGE, ROWS, START_CLOCK, TRAFFIC_COUNT, UNITS_PER_STAR,
  WASTED_FEE, WATER_X, WORLD_W, PITCH, ROAD, roadX, roadY,
} from './config.js';
import { districtAt, generateCity } from './city.js';
import { createRandom } from './random.js';
import { EVENT_MISSION, createMissionState, missionSetup, missionStep } from './missions.js';

export const EVENT_SHOT = 1;
export const EVENT_OFFICER_SHOT = 2;
export const EVENT_CRASH = 4;
export const EVENT_PICKUP = 8;
export const EVENT_CASH = 32;
export const EVENT_ENTER_CAR = 64;
export const EVENT_POPUP = 128;
export { EVENT_MISSION };

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function angDiff(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Line of sight between two points: false when a solid building blocks the segment. */
function losClear(city, index, ax, ay, bx, by) {
  const d = dist(ax, ay, bx, by);
  const steps = Math.max(1, Math.floor(d / 26));
  for (let i = 1; i < steps; i += 1) {
    const x = ax + ((bx - ax) * i) / steps;
    const y = ay + ((by - ay) * i) / steps;
    if (pointInSolid(city, index, x, y)) return false;
  }
  return true;
}

function pointInSolid(city, index, x, y) {
  const cell = 200;
  const key = Math.floor(x / cell) * 100000 + Math.floor(y / cell);
  const list = index.get(key);
  if (!list) return false;
  for (const s of list) if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return true;
  return false;
}

function buildIndex(city) {
  const cell = 200;
  const index = new Map();
  for (const s of city.solids) {
    const cx0 = Math.floor(s.x / cell);
    const cx1 = Math.floor((s.x + s.w) / cell);
    const cy0 = Math.floor(s.y / cell);
    const cy1 = Math.floor((s.y + s.h) / cell);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cy = cy0; cy <= cy1; cy += 1) {
        const key = cx * 100000 + cy;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(s);
      }
    }
  }
  return index;
}

/** Push a circle out of every solid AABB and palm trunk it overlaps; returns impact strength. */
function resolveCircle(city, index, pos, r) {
  let impact = 0;
  for (let iter = 0; iter < 3; iter += 1) {
    let pushed = false;
    const cell = 200;
    const cx0 = Math.floor((pos.x - r) / cell);
    const cx1 = Math.floor((pos.x + r) / cell);
    const cy0 = Math.floor((pos.y - r) / cell);
    const cy1 = Math.floor((pos.y + r) / cell);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cy = cy0; cy <= cy1; cy += 1) {
        const list = index.get(cx * 100000 + cy);
        if (!list) continue;
        for (const s of list) {
          const nx = clamp(pos.x, s.x, s.x + s.w);
          const ny = clamp(pos.y, s.y, s.y + s.h);
          const dx = pos.x - nx;
          const dy = pos.y - ny;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          if (d2 > 0.0001) {
            const d = Math.sqrt(d2);
            pos.x = nx + (dx / d) * r;
            pos.y = ny + (dy / d) * r;
          } else {
            // Centre inside the box: leave by the shallowest face.
            const left = pos.x - s.x;
            const right = s.x + s.w - pos.x;
            const top = pos.y - s.y;
            const bottom = s.y + s.h - pos.y;
            const min = Math.min(left, right, top, bottom);
            if (min === left) pos.x = s.x - r;
            else if (min === right) pos.x = s.x + s.w + r;
            else if (min === top) pos.y = s.y - r;
            else pos.y = s.y + s.h + r;
          }
          pushed = true;
          impact = 1;
        }
      }
    }
    for (const c of city.circles) {
      const d = dist(pos.x, pos.y, c.x, c.y);
      if (d < r + c.r && d > 0.001) {
        pos.x = c.x + ((pos.x - c.x) / d) * (r + c.r);
        pos.y = c.y + ((pos.y - c.y) / d) * (r + c.r);
        pushed = true;
        impact = 1;
      }
    }
    if (!pushed) break;
  }
  return impact;
}

export function createWorld(random, seed = 1) {
  let rng = random;
  let city = generateCity(rng);
  let index = buildIndex(city);

  const state = {
    t: 0,
    clock: START_CLOCK,
    city,
    player: null,
    cars: [],
    peds: [],
    officers: [],
    particles: [],
    skids: [],
    pickups: [],
    heat: 0,
    stars: 0,
    seenTimer: 99,
    bust: 0,
    cash: 250,
    over: null,
    overTimer: 0,
    overInfo: { fine: 0 },
    shake: 0,
    popups: [],
    radio: null,
    banner: null,
    marker: null,
    mission: createMissionState(),
    taxi: { phase: 'idle', ped: null, dest: null, cooldown: 6 },
    stats: { thefts: 0, knockdowns: 0, shots: 0, distance: 0, fares: 0, missionsDone: 0 },
    pendingSave: false,
    fx: 0,
    resprayArmed: true,
    gunfireTimer: 0,
    collisionCrimeGate: 0,
    pdGate: 0,
    titleAnchor: { x: WATER_X + 40, y: roadY(5) },
  };

  // ------------------------------------------------------------------ helpers the missions use
  function popup(from, text) {
    state.popups.push({ from, text, timer: 5.5 });
    if (state.popups.length > 2) state.popups.shift();
    state.fx |= EVENT_POPUP;
  }

  function addCash(n) {
    state.cash += n;
    state.fx |= EVENT_CASH;
  }

  function heatAtLeast(n) {
    if (state.heat < n) {
      state.heat = n;
      state.seenTimer = 0;
    }
  }

  function nearestParkingSpot(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const s of city.parkingSpots) {
      const d = dist(x, y, s.x, s.y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  let nextCarId = 1;
  function makeCar(type, x, y, angle, driver) {
    const spec = CAR_TYPES[type];
    const car = {
      id: nextCarId += 1,
      type, spec,
      x, y, angle,
      speed: 0, sx: 0, sy: 0,
      steerVis: 0, brakeVis: 0,
      color: type === 'police' ? '#e8eaf0' : type === 'taxi' ? '#e8b62a' : CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)],
      health: spec.health,
      driver,
      special: null,
      node: null, fromNode: null, stuck: 0, reverseTimer: 0,
      dmgGate: 0, sirenPhase: rng() * TAU,
      officer: null, dead: false,
    };
    state.cars.push(car);
    return car;
  }

  function spawnSpecialCar(type, special, spot) {
    // Clear whatever is parked on the spot, then place the mission car there.
    for (let i = state.cars.length - 1; i >= 0; i -= 1) {
      const c = state.cars[i];
      if (c.driver === 'parked' && dist(c.x, c.y, spot.x, spot.y) < 26) state.cars.splice(i, 1);
    }
    const car = makeCar(type, spot.x, spot.y, spot.angle, 'parked');
    deoverlap(car);
    car.special = special;
    if (special === 'comet') car.color = '#17b8a6';
    if (special === 'bastion') car.color = '#3a4149';
    return car;
  }

  const world = {
    state,
    reset,
    step,
    popup,
    addCash,
    heatAtLeast,
    nearestParkingSpot,
    spawnSpecialCar,
    saveData,
    applySave,
    respawnAfterOver,
    districtOf: districtAt,
  };

  // ------------------------------------------------------------------ spawning
  function spawnTraffic() {
    const types = ['sedan', 'hatch', 'taxi', 'sedan', 'hatch', 'van'];
    for (let i = 0; i < TRAFFIC_COUNT; i += 1) {
      const c = Math.floor(rng() * (COLS + 1));
      const r = Math.floor(rng() * (ROWS + 1));
      const car = makeCar(types[Math.floor(rng() * types.length)], roadX(c), roadY(r), 0, 'traffic');
      car.node = { c, r };
      car.fromNode = { c, r };
      pickNextNode(car);
      car.angle = Math.atan2(car.laneTarget.y - car.y, car.laneTarget.x - car.x);
    }
  }

  function spawnParked() {
    const spots = [...city.parkingSpots];
    for (let i = spots.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    const types = ['sedan', 'hatch', 'sedan', 'hatch', 'taxi', 'van'];
    let placed = 0;
    for (let i = 0; i < spots.length && placed < PARKED_COUNT; i += 1) {
      // A spot is only used if the hull is actually free there: curb spots can sit a hair
      // inside a building's collision skirts, and a car spawned wedged could never leave.
      const car = makeCar(types[Math.floor(rng() * types.length)], spots[i].x, spots[i].y, spots[i].angle, 'parked');
      if (!deoverlap(car)) {
        state.cars.splice(state.cars.indexOf(car), 1);
        continue;
      }
      placed += 1;
    }
  }

  /** Nudge a freshly placed car until its hull is clear of buildings; false if it cannot fit. */
  function deoverlap(car) {
    if (!hullBlocked(car, car.x, car.y, car.angle)) return true;
    const tries = [[0, 16], [0, -16], [16, 0], [-16, 0], [0, 30], [0, -30], [30, 0], [-30, 0]];
    for (const [dx, dy] of tries) {
      if (!hullBlocked(car, car.x + dx, car.y + dy, car.angle)) {
        car.x += dx;
        car.y += dy;
        return true;
      }
    }
    return false;
  }

  function spawnPeds() {
    for (let i = 0; i < PED_COUNT; i += 1) {
      const beach = i >= PED_COUNT - 6;
      const c = Math.floor(rng() * COLS);
      const r = Math.floor(rng() * ROWS);
      const rect = {
        x: c * PITCH + ROAD + 10, y: r * PITCH + ROAD + 10, w: PITCH - ROAD - 20, h: PITCH - ROAD - 20,
      };
      const ped = {
        x: 0, y: 0, angle: rng() * TAU,
        rect, s: rng() * 2 * (rect.w + rect.h), dir: rng() < 0.5 ? 1 : -1,
        speed: 52 + rng() * 22,
        state: 'walk', timer: 0, threat: null,
        beach, beachY: 200 + rng() * (CITY_H - 400), beachDir: rng() < 0.5 ? 1 : -1,
        shirt: CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)],
        pants: CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)],
        walkPhase: rng() * TAU,
        downTimer: 0, hail: false,
      };
      const pos = perimeterPoint(rect, ped.s);
      ped.x = beach ? WATER_X - 90 : pos.x;
      ped.y = beach ? ped.beachY : pos.y;
      state.peds.push(ped);
    }
  }

  function perimeterPoint(rect, s) {
    const per = 2 * (rect.w + rect.h);
    let d = ((s % per) + per) % per;
    if (d < rect.w) return { x: rect.x + d, y: rect.y };
    d -= rect.w;
    if (d < rect.h) return { x: rect.x + rect.w, y: rect.y + d };
    d -= rect.h;
    if (d < rect.w) return { x: rect.x + rect.w - d, y: rect.y + rect.h };
    d -= rect.w;
    return { x: rect.x, y: rect.y + rect.h - d };
  }

  function spawnPickups() {
    const pd = city.specials.pd;
    const hosp = city.specials.hospital;
    const spots = [
      { kind: 'health', x: hosp.door.x + 26, y: hosp.door.y + 30 },
      { kind: 'health', x: roadX(7) + 60, y: roadY(8) + 40 },
      { kind: 'health', x: roadX(11) - 55, y: roadY(3) - 45 },
      { kind: 'armor', x: pd.door.x + 26, y: pd.door.y - 34 },
      { kind: 'armor', x: city.pier.x + 150, y: city.pier.y + 23 },
    ];
    state.pickups = spots.map((s) => ({ ...s, active: true, timer: 0, phase: rng() * TAU }));
  }

  function reset() {
    rng = createRandom(seed);
    city = generateCity(rng);
    index = buildIndex(city);
    state.city = city;
    state.t = 0;
    state.clock = START_CLOCK;
    state.cars = [];
    state.peds = [];
    state.officers = [];
    state.particles = [];
    state.skids = [];
    state.heat = 0;
    state.stars = 0;
    state.seenTimer = 99;
    state.bust = 0;
    state.cash = 250;
    state.over = null;
    state.overTimer = 0;
    state.shake = 0;
    state.popups = [];
    state.radio = null;
    state.banner = null;
    state.marker = null;
    state.mission = createMissionState();
    state.taxi = { phase: 'idle', ped: null, dest: null, cooldown: 6 };
    state.stats = { thefts: 0, knockdowns: 0, shots: 0, distance: 0, fares: 0, missionsDone: 0 };
    state.pendingSave = false;
    state.fx = 0;
    state.resprayArmed = true;
    state.gunfireTimer = 0;
    state.collisionCrimeGate = 0;
    state.pdGate = 0;
    state.player = {
      x: roadX(COLS) - 30, y: roadY(8), angle: -Math.PI / 2,
      vx: 0, vy: 0, health: 100, armor: 0,
      car: null, walkPhase: 0, interactTimer: 0, fireTimer: 0, hurtTimer: 0,
    };
    spawnTraffic();
    spawnParked();
    spawnPeds();
    spawnPickups();
    state.taxiMarker = null;
    missionSetup(state, world);
  }

  // ------------------------------------------------------------------ traffic routing
  /** The lane point a car steers for while travelling from fromNode to node. */
  function lanePoint(car) {
    const a = { x: roadX(car.fromNode.c), y: roadY(car.fromNode.r) };
    const b = { x: roadX(car.node.c), y: roadY(car.node.r) };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // Right-hand traffic: the lane sits to the right of the direction of travel.
    const rx = -uy;
    const ry = ux;
    const t = clamp(((car.x - a.x) * ux + (car.y - a.y) * uy) / len, 0, 1);
    const ahead = Math.min(1, t + 110 / len);
    return {
      x: a.x + dx * ahead + rx * 23,
      y: a.y + dy * ahead + ry * 23,
      ux, uy, t,
    };
  }

  function pickNextNode(car) {
    const { c, r } = car.node;
    const options = [];
    if (c > 0) options.push({ c: c - 1, r });
    if (c < COLS) options.push({ c: c + 1, r });
    if (r > 0) options.push({ c, r: r - 1 });
    if (r < ROWS) options.push({ c, r: r + 1 });
    const fresh = options.filter((o) => !(o.c === car.fromNode.c && o.r === car.fromNode.r));
    const pool = fresh.length > 0 ? fresh : options;
    car.fromNode = { c, r };
    car.node = pool[Math.floor(rng() * pool.length)];
    car.laneTarget = lanePoint(car);
  }

  // ------------------------------------------------------------------ car physics
  function hullCircles(car, x, y, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const off = car.spec.len * 0.3;
    const r = car.spec.wid * 0.62;
    return [
      { x: x + cos * off, y: y + sin * off, r },
      { x: x - cos * off, y: y - sin * off, r },
    ];
  }

  function hullBlocked(car, x, y, angle) {
    for (const c of hullCircles(car, x, y, angle)) {
      if (city.isWater(c.x, c.y)) return true;
      const probe = { x: c.x, y: c.y };
      if (resolveCircle(city, index, probe, c.r) > 0) return true;
      if (probe.x !== c.x || probe.y !== c.y) return true;
    }
    return false;
  }

  /** Drive one car for a step. throttle -1..1, steer -1..1. Returns impact speed lost. */
  function driveCar(car, dt, throttle, steer, events) {
    const spec = car.spec;
    if (car.dmgGate > 0) car.dmgGate -= dt;
    car.steerVis += (steer - car.steerVis) * Math.min(1, dt * 10);
    const ratio = clamp(car.speed / spec.topSpeed, -1, 1);
    if (throttle > 0) car.speed += spec.accel * throttle * (1 - Math.max(0, ratio) * 0.5) * dt;
    else if (throttle < 0) {
      if (car.speed > 10) car.speed -= 430 * dt;
      else car.speed = Math.max(-115, car.speed + spec.accel * 0.55 * throttle * dt);
    }
    car.speed -= car.speed * 0.5 * dt;
    if (throttle === 0 && Math.abs(car.speed) < 4) car.speed = 0;
    car.speed = clamp(car.speed, -120, spec.topSpeed);
    car.brakeVis = throttle < 0 || (throttle === 0 && Math.abs(car.speed) > 30) ? 1 : Math.max(0, car.brakeVis - dt * 6);
    const turn = 2.55 * (1 - 0.38 * Math.abs(ratio)) * clamp(car.speed / 130, -1, 1);
    car.angle += steer * turn * dt;
    // Velocity is the heading times speed, blended by grip; collisions add a decaying slide.
    const wantX = Math.cos(car.angle) * car.speed;
    const wantY = Math.sin(car.angle) * car.speed;
    car.sx *= Math.max(0, 1 - 5.5 * dt);
    car.sy *= Math.max(0, 1 - 5.5 * dt);
    const vx = wantX + car.sx;
    const vy = wantY + car.sy;
    const before = Math.abs(car.speed);
    let impact = 0;
    const nx = car.x + vx * dt;
    const ny = car.y + vy * dt;
    if (!hullBlocked(car, nx, ny, car.angle)) {
      car.x = nx;
      car.y = ny;
    } else if (!hullBlocked(car, nx, car.y, car.angle)) {
      car.x = nx;
      impact = Math.abs(vy);
      car.sy = 0;
    } else if (!hullBlocked(car, car.x, ny, car.angle)) {
      car.y = ny;
      impact = Math.abs(vx);
      car.sx = 0;
    } else {
      impact = before;
    }
    if (impact > 30) {
      car.speed *= 0.45;
      hurtCar(car, (impact - 30) * 0.09, events);
      if (car.driver === 'player') hurtPlayer((impact - 170) * 0.045, events);
      state.shake = Math.min(9, state.shake + impact * 0.012);
      events.crash = Math.max(events.crash, impact);
    }
    car.x = clamp(car.x, 20, WORLD_W - 20);
    car.y = clamp(car.y, 20, CITY_H - 20);
    return impact;
  }

  function hurtCar(car, amount, events) {
    if (amount <= 0 || car.health <= 0) return;
    if (car.dmgGate > 0) return;
    car.dmgGate = 0.22;
    car.health -= amount;
    if (car.health <= 0) {
      car.health = 0;
      car.speed = 0;
      spawnParticles(car.x, car.y, 10, '#666', 60);
    }
  }

  function hurtPlayer(amount, events) {
    const p = state.player;
    if (amount <= 0 || state.over) return;
    // One hit per 0.3 s at most, and no single hit is a one-shot: sustained contact (a car
    // grinding against Rio, two officers firing together) must not delete him in a second.
    if (state.pdGate > 0) return;
    state.pdGate = 0.3;
    amount = Math.min(amount, 16);
    if (p.armor > 0) {
      const absorbed = Math.min(p.armor, amount * 0.7);
      p.armor -= absorbed;
      amount -= absorbed;
    }
    p.health -= amount;
    p.hurtTimer = 0.25;
    if (p.health <= 0) {
      p.health = 0;
      setOver('wasted');
    }
  }

  function setOver(kind) {
    if (state.over) return;
    state.over = kind;
    state.overTimer = 0;
    state.overInfo = { fine: kind === 'busted' ? BUST.fine : WASTED_FEE };
    state.fx |= EVENT_MISSION; // reused as the "big sting" cue for the audio layer
  }

  function respawnAfterOver() {
    const p = state.player;
    const fee = state.overInfo.fine || 0;
    state.cash = Math.max(0, state.cash - fee);
    const spot = state.over === 'busted' ? city.specials.pd.door : city.specials.hospital.door;
    if (p.car) {
      p.car.driver = 'parked';
      p.car = null;
    }
    p.x = spot.x;
    p.y = spot.y;
    p.vx = 0;
    p.vy = 0;
    p.health = 100;
    state.heat = 0;
    state.stars = 0;
    state.bust = 0;
    state.seenTimer = 99;
    // Units stand down: surviving police cars blend back into traffic.
    for (const car of state.cars) if (car.driver === 'police') car.driver = 'traffic';
    for (const o of state.officers) o.dead = true;
    state.over = null;
    state.overTimer = 0;
  }

  // ------------------------------------------------------------------ particles & skids
  function spawnParticles(x, y, n, color, speed) {
    for (let i = 0; i < n; i += 1) {
      if (state.particles.length > 420) return;
      const a = rng() * TAU;
      const v = (0.3 + rng() * 0.7) * speed;
      state.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 0.4 + rng() * 0.5, maxLife: 0.9, size: 1.5 + rng() * 2.5, color,
      });
    }
  }

  function stepParticles(dt) {
    for (let i = state.particles.length - 1; i >= 0; i -= 1) {
      const pt = state.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) { state.particles.splice(i, 1); continue; }
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= 1 - 2.4 * dt;
      pt.vy *= 1 - 2.4 * dt;
    }
    for (let i = state.skids.length - 1; i >= 0; i -= 1) {
      state.skids[i].life -= dt;
      if (state.skids[i].life <= 0) state.skids.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ crime & heat
  function commitCrime(amount, x, y) {
    let witnessed = false;
    for (const ped of state.peds) {
      if (ped.state === 'down' || ped.inCar) continue;
      if (dist(ped.x, ped.y, x, y) < HEAT.witnessRange && losClear(city, index, ped.x, ped.y, x, y)) { witnessed = true; break; }
    }
    if (!witnessed) {
      for (const car of state.cars) {
        if (car.driver === 'police' && dist(car.x, car.y, x, y) < HEAT.seenRange && losClear(city, index, car.x, car.y, x, y)) { witnessed = true; break; }
      }
    }
    if (!witnessed) {
      for (const o of state.officers) {
        if (!o.dead && dist(o.x, o.y, x, y) < HEAT.seenRange) { witnessed = true; break; }
      }
    }
    if (witnessed) {
      state.heat = Math.min(HEAT.max, state.heat + amount);
      state.seenTimer = 0;
    } else {
      state.heat = Math.min(HEAT.max, state.heat + Math.min(amount, HEAT.unwitnessedCap));
    }
  }

  function updateHeat(dt) {
    let seen = false;
    const p = state.player;
    for (const car of state.cars) {
      if (car.driver !== 'police') continue;
      if (dist(car.x, car.y, p.x, p.y) < HEAT.seenRange && losClear(city, index, car.x, car.y, p.x, p.y)) { seen = true; break; }
    }
    if (!seen) {
      for (const o of state.officers) {
        if (!o.dead && dist(o.x, o.y, p.x, p.y) < HEAT.seenRange) { seen = true; break; }
      }
    }
    if (seen) state.seenTimer = 0;
    else state.seenTimer += dt;
    if (state.collisionCrimeGate > 0) state.collisionCrimeGate -= dt;
    if (state.pdGate > 0) state.pdGate -= dt;
    if (state.seenTimer > HEAT.decayDelay && state.heat > 0) {
      state.heat = Math.max(0, state.heat - HEAT.decayRate * dt);
    }
    state.stars = state.heat <= 0 ? 0 : Math.min(5, Math.ceil(state.heat / HEAT.perStar));
    if (state.gunfireTimer > 0) state.gunfireTimer -= dt;
  }

  // ------------------------------------------------------------------ player
  function enterExitCar(fx) {
    const p = state.player;
    if (p.car) {
      const car = p.car;
      if (Math.abs(car.speed) > 95) return;
      const side = car.angle - Math.PI / 2;
      p.x = car.x + Math.cos(side) * (car.spec.wid / 2 + 15);
      p.y = car.y + Math.sin(side) * (car.spec.wid / 2 + 15);
      resolveCircle(city, index, p, PLAYER.radius);
      car.driver = 'parked';
      p.car = null;
      p.interactTimer = PLAYER.interactCooldown;
      return;
    }
    let best = null;
    let bestD = Infinity;
    for (const car of state.cars) {
      if (car.driver === 'police' || car.health <= 0) continue;
      const d = dist(p.x, p.y, car.x, car.y) - car.spec.len / 2;
      if (d < bestD) { bestD = d; best = car; }
    }
    if (!best || bestD > PLAYER.enterRange) return;
    if (best.driver === 'traffic') {
      // The driver bails out and runs.
      best.driver = 'parked';
      if (state.peds.length < 72) {
        state.peds.push({
          x: best.x + 20, y: best.y + 10, angle: 0, rect: state.peds[0].rect, s: 0, dir: 1,
          speed: 60, state: 'flee', timer: 2.2, threat: { x: p.x, y: p.y }, beach: false,
          beachY: 0, beachDir: 1, shirt: '#888', pants: '#555', walkPhase: 0, downTimer: 0, hail: false,
        });
      }
    }
    if (!best.stolen) {
      best.stolen = true;
      state.stats.thefts += 1;
      commitCrime(HEAT.theft, best.x, best.y);
    }
    best.driver = 'player';
    p.car = best;
    p.interactTimer = PLAYER.interactCooldown;
    state.radio = { name: RADIO_PICK(), timer: 3.6 };
    state.fx |= EVENT_ENTER_CAR;
  }

  function RADIO_PICK() {
    const stations = ['Palmira FM 103.7', 'Ola Suave 98.1', 'Neon Nights Radio', 'Radio Marea 88.5', 'Bajo Bass 106.3', 'Costa Classics'];
    return stations[Math.floor(rng() * stations.length)];
  }

  function updatePlayer(dt, ctl, fx) {
    const p = state.player;
    if (p.interactTimer > 0) p.interactTimer -= dt;
    if (p.fireTimer > 0) p.fireTimer -= dt;
    if (p.hurtTimer > 0) p.hurtTimer -= dt;
    if (ctl.interact && p.interactTimer <= 0) enterExitCar(fx);

    if (p.car) {
      const car = p.car;
      const throttle = -ctl.my;
      const steer = ctl.mx;
      driveCar(car, dt, throttle, steer, fx);
      p.x = car.x;
      p.y = car.y;
      p.angle = car.angle;
      state.stats.distance += Math.abs(car.speed) * dt;
      // Skid marks at speed under hard steering or a big slide.
      if (Math.abs(car.speed) > 150 && (Math.abs(steer) > 0.55 || Math.hypot(car.sx, car.sy) > 60)) {
        if (state.skids.length < 520) {
          const back = car.spec.len * 0.32;
          const sideOff = car.spec.wid * 0.42;
          for (const sgn of [-1, 1]) {
            state.skids.push({
              x: car.x - Math.cos(car.angle) * back + Math.cos(car.angle + Math.PI / 2) * sideOff * sgn,
              y: car.y - Math.sin(car.angle) * back + Math.sin(car.angle + Math.PI / 2) * sideOff * sgn,
              life: 16,
            });
          }
        }
      }
      if (car.health <= 0) {
        // The wreck gives up: Rio climbs out of the smoke.
        car.driver = 'parked';
        p.car = null;
        p.x += 26;
        resolveCircle(city, index, p, PLAYER.radius);
      }
      return;
    }

    // On foot.
    const mag = Math.hypot(ctl.mx, ctl.my);
    const speed = ctl.run ? PLAYER.runSpeed : PLAYER.walkSpeed;
    if (mag > 0.01) {
      const ux = ctl.mx / Math.max(1, mag);
      const uy = ctl.my / Math.max(1, mag);
      p.vx = ux * speed;
      p.vy = uy * speed;
      p.angle = Math.atan2(p.vy, p.vx);
      p.walkPhase += dt * speed * 0.055;
    } else {
      p.vx = 0;
      p.vy = 0;
    }
    const nx = p.x + p.vx * dt;
    const ny = p.y + p.vy * dt;
    if (!city.isWater(nx, p.y)) p.x = nx;
    if (!city.isWater(p.x, ny)) p.y = ny;
    resolveCircle(city, index, p, PLAYER.radius);
    p.x = clamp(p.x, 16, WORLD_W - 16);
    p.y = clamp(p.y, 16, CITY_H - 16);
    state.stats.distance += Math.hypot(p.vx, p.vy) * dt;

    if (ctl.fire) shoot(dt, ctl, fx);
  }

  function shoot(dt, ctl, fx) {
    const p = state.player;
    if (p.fireTimer > 0) return;
    p.fireTimer = 0.15;
    state.stats.shots += 1;
    state.fx |= EVENT_SHOT;
    state.shake = Math.min(9, state.shake + 0.7);
    const aimX = ctl.aimX !== undefined ? ctl.aimX : p.x + Math.cos(p.angle) * 100;
    const aimY = ctl.aimY !== undefined ? ctl.aimY : p.y + Math.sin(p.angle) * 100;
    const a = Math.atan2(aimY - p.y, aimX - p.x);
    p.angle = a;
    if (state.gunfireTimer <= 0) {
      commitCrime(HEAT.gunfire, p.x, p.y);
      state.gunfireTimer = HEAT.gunfireThrottle;
    }
    // Nearby pedestrians run from the noise.
    for (const ped of state.peds) {
      if (ped.state === 'walk' && dist(ped.x, ped.y, p.x, p.y) < 320) {
        ped.state = 'flee';
        ped.timer = 1.8;
        ped.threat = { x: p.x, y: p.y };
      }
    }
    // Muzzle flash + tracer.
    state.particles.push({
      x: p.x + Math.cos(a) * 16, y: p.y + Math.sin(a) * 16, vx: 0, vy: 0,
      life: 0.05, maxLife: 0.05, size: 7, color: '#ffd76a',
    });
    const range = 540;
    let hitX = p.x + Math.cos(a) * range;
    let hitY = p.y + Math.sin(a) * range;
    const steps = Math.floor(range / 12);
    let stopped = false;
    for (let i = 1; i <= steps && !stopped; i += 1) {
      const x = p.x + Math.cos(a) * i * 12;
      const y = p.y + Math.sin(a) * i * 12;
      if (pointInSolid(city, index, x, y)) { hitX = x; hitY = y; stopped = true; break; }
      for (const o of state.officers) {
        if (o.dead) continue;
        if (dist(o.x, o.y, x, y) < 13) {
          o.hp -= 1;
          spawnParticles(x, y, 4, '#c9453c', 50);
          if (o.hp <= 0) {
            o.dead = true;
            o.fade = 0;
            commitCrime(HEAT.officerDown, o.x, o.y);
            if (o.unit) { o.unit.officer = null; o.unit = null; }
          }
          hitX = x; hitY = y; stopped = true;
          break;
        }
      }
      if (stopped) break;
      for (const ped of state.peds) {
        if (ped.state === 'down' || ped.inCar) continue;
        if (dist(ped.x, ped.y, x, y) < 10) {
          ped.state = 'down';
          ped.downTimer = 6;
          state.stats.knockdowns += 1;
          commitCrime(HEAT.pedDown, ped.x, ped.y);
          hitX = x; hitY = y; stopped = true;
          break;
        }
      }
      if (stopped) break;
      for (const car of state.cars) {
        if (dist(car.x, car.y, x, y) < car.spec.len * 0.46) {
          car.health = Math.max(0, car.health - 2.5);
          spawnParticles(x, y, 3, '#f2c94c', 70);
          hitX = x; hitY = y; stopped = true;
          break;
        }
      }
    }
    state.particles.push({
      x: p.x + Math.cos(a) * 18, y: p.y + Math.sin(a) * 18,
      vx: Math.cos(a) * 2400, vy: Math.sin(a) * 2400,
      life: dist(p.x, p.y, hitX, hitY) / 2400, maxLife: 0.25, size: 2, color: '#ffe9a3',
    });
  }

  // ------------------------------------------------------------------ traffic AI
  function obstacleAhead(car, reach) {
    const hx = Math.cos(car.angle);
    const hy = Math.sin(car.angle);
    const px = car.x + hx * (car.spec.len / 2 + reach);
    const py = car.y + hy * (car.spec.len / 2 + reach);
    for (const other of state.cars) {
      if (other === car) continue;
      if (dist(other.x, other.y, px, py) < other.spec.len * 0.52) return other;
    }
    for (const ped of state.peds) {
      if (ped.state === 'down' || ped.inCar) continue;
      if (dist(ped.x, ped.y, px, py) < 22) return ped;
    }
    const p = state.player;
    if (!p.car && dist(p.x, p.y, px, py) < 22) return p;
    return null;
  }

  function updateTrafficCar(car, dt, fx) {
    if (car.health <= 0) { car.speed = 0; return; }
    // Recycle cars that drift too far from the action so the player's streets stay alive.
    if (dist(car.x, car.y, state.player.x, state.player.y) > 3050) {
      const c = Math.floor(rng() * (COLS + 1));
      const r = Math.floor(rng() * (ROWS + 1));
      car.x = roadX(c);
      car.y = roadY(r);
      car.node = { c, r };
      car.fromNode = { c, r };
      car.speed = 0;
      pickNextNode(car);
      car.angle = Math.atan2(car.laneTarget.y - car.y, car.laneTarget.x - car.x);
    }
    const target = lanePoint(car);
    if (target.t > 0.985) pickNextNode(car);
    const fresh = lanePoint(car);
    const desired = Math.atan2(fresh.y - car.y, fresh.x - car.x);
    const diff = angDiff(car.angle, desired);
    let steer = clamp(diff * 2.4, -1, 1);
    let throttle = Math.abs(diff) > 1.9 ? 0.25 : 1;
    if (car.reverseTimer > 0) {
      car.reverseTimer -= dt;
      throttle = -0.85;
      steer = -steer;
    } else if (obstacleAhead(car, 30)) {
      throttle = car.speed > 40 ? -1 : 0;
      car.stuck += dt;
      if (car.stuck > 3.2) { car.reverseTimer = 0.7; car.stuck = 0; }
    } else {
      car.stuck = 0;
    }
    driveCar(car, dt, throttle, steer, fx);
  }

  // ------------------------------------------------------------------ police
  let spawnCooldown = 0;

  function nearestNode(x, y) {
    return {
      c: clamp(Math.round((x - ROAD / 2) / PITCH), 0, COLS),
      r: clamp(Math.round((y - ROAD / 2) / PITCH), 0, ROWS),
    };
  }

  function spawnUnit() {
    const p = state.player;
    let node = null;
    for (let tries = 0; tries < 24; tries += 1) {
      const c = Math.floor(rng() * (COLS + 1));
      const r = Math.floor(rng() * (ROWS + 1));
      const d = dist(roadX(c), roadY(r), p.x, p.y);
      if (d > 540 && d < 820) { node = { c, r }; break; }
      if (node === null) node = { c, r };
    }
    const car = makeCar('police', roadX(node.c), roadY(node.r), 0, 'police');
    car.node = { ...node };
    car.fromNode = { ...node };
    policeNextNode(car);
    car.angle = Math.atan2(car.laneTarget.y - car.y, car.laneTarget.x - car.x);
  }

  function policeNextNode(car) {
    const p = state.player;
    const { c, r } = car.node;
    const options = [];
    if (c > 0) options.push({ c: c - 1, r });
    if (c < COLS) options.push({ c: c + 1, r });
    if (r > 0) options.push({ c, r: r - 1 });
    if (r < ROWS) options.push({ c, r: r + 1 });
    let best = options[0];
    let bestD = Infinity;
    for (const o of options) {
      const d = dist(roadX(o.c), roadY(o.r), p.x, p.y);
      if (d < bestD) { bestD = d; best = o; }
    }
    car.fromNode = { c, r };
    car.node = best;
    car.laneTarget = lanePoint(car);
  }

  function updatePolice(dt, fx) {
    if (spawnCooldown > 0) spawnCooldown -= dt;
    const desired = UNITS_PER_STAR[state.stars];
    const units = state.cars.filter((c) => c.driver === 'police' && c.health > 0);
    if (units.length < desired && spawnCooldown <= 0) {
      spawnUnit();
      spawnCooldown = 1.1;
    } else if (units.length > desired) {
      // The farthest unit gives up and blends back into traffic.
      let far = null;
      let farD = -1;
      for (const u of units) {
        const d = dist(u.x, u.y, state.player.x, state.player.y);
        if (d > farD) { farD = d; far = u; }
      }
      if (far) {
        far.driver = 'traffic';
        const n = nearestNode(far.x, far.y);
        far.node = { ...n };
        far.fromNode = { ...n };
        pickNextNode(far);
      }
    }
    const p = state.player;
    const playerSpeed = p.car ? Math.abs(p.car.speed) : Math.hypot(p.vx, p.vy);
    for (const unit of state.cars) {
      if (unit.driver !== 'police') continue;
      if (unit.health <= 0) { unit.speed = 0; continue; }
      if (unit.officer) { driveCar(unit, dt, 0, 0, fx); continue; }
      // Bail-out: an officer steps out when the player is close and slow, always at 3+ stars.
      const d = dist(unit.x, unit.y, p.x, p.y);
      const shouldBail = (state.stars >= 3 && d < 330 && Math.abs(unit.speed) < 70)
        || (playerSpeed < 52 && d < 205 && Math.abs(unit.speed) < 70);
      if (shouldBail && !unit.officer) {
        const officer = {
          x: unit.x + 20, y: unit.y + 14, angle: 0, hp: 2, unit,
          shootTimer: 0.7 + rng() * 0.5, returnTimer: 0, dead: false, fade: 0, walkPhase: 0,
        };
        unit.officer = officer;
        state.officers.push(officer);
        driveCar(unit, dt, 0, 0, fx);
        continue;
      }
      // Pursuit: direct line when close with sight, otherwise route over the junction grid.
      let tx;
      let ty;
      if (d < 500 && losClear(city, index, unit.x, unit.y, p.x, p.y)) {
        const lead = p.car ? 0.32 : 0.1;
        const pvx = p.car ? Math.cos(p.car.angle) * p.car.speed : p.vx;
        const pvy = p.car ? Math.sin(p.car.angle) * p.car.speed : p.vy;
        tx = p.x + pvx * lead;
        ty = p.y + pvy * lead;
      } else {
        const target = lanePoint(unit);
        if (target.t > 0.96) policeNextNode(unit);
        const fresh = lanePoint(unit);
        tx = fresh.x;
        ty = fresh.y;
      }
      const desiredA = Math.atan2(ty - unit.y, tx - unit.x);
      const diff = angDiff(unit.angle, desiredA);
      let steer = clamp(diff * 2.6, -1, 1);
      let throttle = Math.abs(diff) > 2.1 ? 0.3 : 1;
      if (unit.reverseTimer > 0) {
        unit.reverseTimer -= dt;
        throttle = -0.9;
        steer = -steer;
      } else if (obstacleAhead(unit, 26) && d > 120) {
        if (unit.speed > 50) throttle = -1;
        else {
          unit.stuck += dt;
          throttle = 0;
          if (unit.stuck > 1.15) { unit.reverseTimer = 0.55; unit.stuck = 0; }
        }
      } else {
        unit.stuck = 0;
      }
      // Against a suspect on foot the unit is a wall, not a weapon: it rolls up and stops
      // a few metres off so the officer can make the arrest — it never runs Rio down.
      // The approach is speed-capped by distance so it arrives gently instead of charging.
      if (!p.car) {
        if (d < 70) throttle = unit.speed > 12 ? -1 : 0;
        else if (d < 180 && unit.speed > 85) throttle = -1;
        else if (d < 300 && unit.speed > 170) throttle = -1;
      }
      // A unit wedged on scenery with the suspect nowhere near gives up and rejoins traffic;
      // a fresh unit takes its place. (Wrecks stop counting toward the desired total above.)
      if (Math.abs(unit.speed) < 6 && d > 110) {
        unit.stuckTime = (unit.stuckTime || 0) + dt;
        if (unit.stuckTime > 5) {
          unit.stuckTime = 0;
          unit.driver = 'traffic';
          const n = nearestNode(unit.x, unit.y);
          unit.node = { ...n };
          unit.fromNode = { ...n };
          pickNextNode(unit);
          continue;
        }
      } else unit.stuckTime = 0;
      driveCar(unit, dt, throttle, steer, fx);
    }
  }

  function updateOfficers(dt, fx) {
    const p = state.player;
    for (let i = state.officers.length - 1; i >= 0; i -= 1) {
      const o = state.officers[i];
      if (o.dead) {
        o.fade += dt;
        if (o.fade > 2.5) state.officers.splice(i, 1);
        continue;
      }
      const d = dist(o.x, o.y, p.x, p.y);
      o.angle = Math.atan2(p.y - o.y, p.x - o.x);
      const playerFast = p.car && Math.abs(p.car.speed) > 225;
      if (d > 460 || playerFast) {
        o.returnTimer += dt;
        if (o.returnTimer > 1.1) {
          if (o.unit) o.unit.officer = null;
          state.officers.splice(i, 1);
          continue;
        }
      } else o.returnTimer = 0;
      if (d > 58) {
        // Close in to arresting distance — an officer who stops at range and only shoots
        // could never work the bust meter, and the player would be shot dead waiting.
        const ux = (p.x - o.x) / (d || 1);
        const uy = (p.y - o.y) / (d || 1);
        const stepIn = Math.min(118 * dt, d - 52);
        o.x += ux * stepIn;
        o.y += uy * stepIn;
        resolveCircle(city, index, o, 9);
        o.walkPhase += dt * 6;
      }
      o.shootTimer -= dt;
      if (o.shootTimer <= 0 && d > 92 && d < 385 && losClear(city, index, o.x, o.y, p.x, p.y)) {
        o.shootTimer = 0.85 + rng() * 0.35;
        state.fx |= EVENT_OFFICER_SHOT;
        const chance = clamp(0.62 - d * 0.0011, 0.12, 0.6);
        if (rng() < chance) hurtPlayer(6 + rng() * 5, fx);
        state.particles.push({
          x: o.x + Math.cos(o.angle) * 14, y: o.y + Math.sin(o.angle) * 14,
          vx: Math.cos(o.angle) * 2200, vy: Math.sin(o.angle) * 2200,
          life: 0.12, maxLife: 0.12, size: 2, color: '#ffb3a3',
        });
      }
    }
  }

  function updateBust(dt) {
    const p = state.player;
    const playerSpeed = p.car ? Math.abs(p.car.speed) : Math.hypot(p.vx, p.vy);
    let near = false;
    for (const car of state.cars) {
      if (car.driver === 'police' && car.health > 0 && dist(car.x, car.y, p.x, p.y) < BUST.range) { near = true; break; }
    }
    if (!near) {
      for (const o of state.officers) {
        if (!o.dead && dist(o.x, o.y, p.x, p.y) < BUST.range) { near = true; break; }
      }
    }
    if (near && playerSpeed < BUST.slowSpeed) state.bust = Math.min(1, state.bust + dt / BUST.fillTime);
    else state.bust = Math.max(0, state.bust - dt / (BUST.fillTime * 0.55));
    if (state.bust >= 1) setOver('busted');
  }

  // ------------------------------------------------------------------ pedestrians
  function nearestPerimeterS(rect, x, y) {
    const candidates = [
      { s: clamp(x - rect.x, 0, rect.w), d: Math.abs(y - rect.y) },
      { s: rect.w + clamp(y - rect.y, 0, rect.h), d: Math.abs(x - (rect.x + rect.w)) },
      { s: rect.w + rect.h + clamp(rect.x + rect.w - x, 0, rect.w), d: Math.abs(y - (rect.y + rect.h)) },
      { s: 2 * rect.w + rect.h + clamp(rect.y + rect.h - y, 0, rect.h), d: Math.abs(x - rect.x) },
    ];
    candidates.sort((a, b) => a.d - b.d);
    return candidates[0].s;
  }

  function updatePeds(dt) {
    const p = state.player;
    for (const ped of state.peds) {
      if (ped.inCar) {
        ped.x = p.car ? p.car.x : ped.x;
        ped.y = p.car ? p.car.y : ped.y;
        continue;
      }
      if (ped.state === 'down') {
        ped.downTimer -= dt;
        if (ped.downTimer <= 0) {
          const c = Math.floor(rng() * COLS);
          const r = Math.floor(rng() * ROWS);
          ped.rect = { x: c * PITCH + ROAD + 10, y: r * PITCH + ROAD + 10, w: PITCH - ROAD - 20, h: PITCH - ROAD - 20 };
          ped.s = rng() * 2 * (ped.rect.w + ped.rect.h);
          ped.state = 'walk';
          const pos = perimeterPoint(ped.rect, ped.s);
          ped.x = pos.x;
          ped.y = pos.y;
        }
        continue;
      }
      if (ped.state === 'flee') {
        ped.timer -= dt;
        const d = dist(ped.x, ped.y, ped.threat.x, ped.threat.y) || 1;
        let fx = (ped.x - ped.threat.x) / d;
        let fy = (ped.y - ped.threat.y) / d;
        // Fleeing a moving car, dodge sideways like a person would — darting straight away
        // from a car on the road means running along its path and getting clipped anyway.
        if (ped.threatVel) {
          const tv = Math.hypot(ped.threatVel.x, ped.threatVel.y) || 1;
          let px = -ped.threatVel.y / tv;
          let py = ped.threatVel.x / tv;
          if (px * fx + py * fy < 0) { px = -px; py = -py; }
          fx = fx * 0.65 + px * 0.75;
          fy = fy * 0.65 + py * 0.75;
          const fl = Math.hypot(fx, fy) || 1;
          fx /= fl;
          fy /= fl;
        }
        ped.x += fx * 178 * dt;
        ped.y += fy * 178 * dt;
        resolveCircle(city, index, ped, 8);
        ped.walkPhase += dt * 11;
        if (ped.timer <= 0) {
          ped.state = 'walk';
          ped.threatVel = null;
          ped.s = nearestPerimeterS(ped.rect, ped.x, ped.y);
        }
        continue;
      }
      if (ped.state === 'hail') {
        ped.angle = Math.atan2(p.y - ped.y, p.x - ped.x);
        continue;
      }
      // Flee fast cars that get too close.
      let fled = false;
      for (const car of state.cars) {
        if (Math.abs(car.speed) > 155 && dist(car.x, car.y, ped.x, ped.y) < 52) {
          ped.state = 'flee';
          ped.timer = 1.4;
          ped.threat = { x: car.x, y: car.y };
          ped.threatVel = { x: Math.cos(car.angle) * car.speed, y: Math.sin(car.angle) * car.speed };
          fled = true;
          break;
        }
      }
      if (fled) continue;
      if (ped.beach) {
        ped.y += ped.beachDir * ped.speed * dt;
        if (ped.y < 170) ped.beachDir = 1;
        if (ped.y > CITY_H - 170) ped.beachDir = -1;
        ped.x = WATER_X - 92 + Math.sin(state.t * 0.5 + ped.walkPhase) * 8;
        ped.walkPhase += dt * ped.speed * 0.05;
        continue;
      }
      if (rng() < dt * 0.012) ped.dir *= -1;
      ped.s += ped.dir * ped.speed * dt;
      const pos = perimeterPoint(ped.rect, ped.s);
      ped.angle = Math.atan2(pos.y - ped.y, pos.x - ped.x);
      ped.x = pos.x;
      ped.y = pos.y;
      ped.walkPhase += dt * ped.speed * 0.055;
    }
  }

  // ------------------------------------------------------------------ car vs car, car vs people
  function carCarCollisions(fx) {
    const cars = state.cars;
    for (let i = 0; i < cars.length; i += 1) {
      for (let j = i + 1; j < cars.length; j += 1) {
        const a = cars[i];
        const b = cars[j];
        const d = dist(a.x, a.y, b.x, b.y);
        const minD = (a.spec.len + b.spec.len) * 0.4;
        if (d >= minD || d === 0) continue;
        const nx = (b.x - a.x) / d;
        const ny = (b.y - a.y) / d;
        const overlap = minD - d;
        const aShare = a.driver === 'parked' ? 0.25 : 0.5;
        const bShare = b.driver === 'parked' ? 0.25 : 0.5;
        a.x -= nx * overlap * aShare;
        a.y -= ny * overlap * aShare;
        b.x += nx * overlap * bShare;
        b.y += ny * overlap * bShare;
        const rel = Math.abs((a.speed * Math.cos(a.angle) - b.speed * Math.cos(b.angle)) * nx
          + (a.speed * Math.sin(a.angle) - b.speed * Math.sin(b.angle)) * ny);
        if (rel > 52) {
          hurtCar(a, (rel - 52) * 0.055, fx);
          hurtCar(b, (rel - 52) * 0.055, fx);
          fx.crash = Math.max(fx.crash, rel);
          state.shake = Math.min(9, state.shake + rel * 0.01);
          spawnParticles((a.x + b.x) / 2, (a.y + b.y) / 2, 5, '#f7b731', 80);
          const playerCar = a.driver === 'player' ? a : b.driver === 'player' ? b : null;
          if (playerCar) {
            hurtPlayer((rel - 165) * 0.05, fx);
            // A collision is only the player's crime when Rio is the one closing in — a
            // unit ramming him from behind is the PD's driving, not his — and collision
            // crimes are gated so a grinding chase cannot mint a crime per frame.
            const other = playerCar === a ? b : a;
            const ax = (playerCar.x - other.x) / (dist(playerCar.x, playerCar.y, other.x, other.y) || 1);
            const ay = (playerCar.y - other.y) / (dist(playerCar.x, playerCar.y, other.x, other.y) || 1);
            const pvx = Math.cos(playerCar.angle) * playerCar.speed;
            const pvy = Math.sin(playerCar.angle) * playerCar.speed;
            const ovx = Math.cos(other.angle) * other.speed;
            const ovy = Math.sin(other.angle) * other.speed;
            const closing = -((pvx - ovx) * ax + (pvy - ovy) * ay);
            if (closing > 25 && state.collisionCrimeGate <= 0) {
              state.collisionCrimeGate = 1.4;
              if (other.type === 'police') commitCrime(HEAT.hitPolice, state.player.x, state.player.y);
              else commitCrime(HEAT.hitCar, state.player.x, state.player.y);
            }
          }
        }
      }
    }
    // Cars versus the player on foot and pedestrians: a fast hull knocks people down.
    for (const car of state.cars) {
      if (Math.abs(car.speed) < 55) continue;
      const cos = Math.cos(-car.angle);
      const sin = Math.sin(-car.angle);
      const targets = state.player.car ? [] : [state.player];
      for (const ped of state.peds) if (ped.state !== 'down' && !ped.inCar) targets.push(ped);
      for (const t of targets) {
        const dx = t.x - car.x;
        const dy = t.y - car.y;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        if (Math.abs(lx) < car.spec.len / 2 + 6 && Math.abs(ly) < car.spec.wid / 2 + 6) {
          if (t === state.player) {
            hurtPlayer((Math.abs(car.speed) - 55) * 0.14, fx);
            state.player.vx = Math.cos(car.angle) * car.speed * 0.7;
            state.shake = Math.min(9, state.shake + 3);
          } else {
            t.state = 'down';
            t.downTimer = 6;
            if (car.driver === 'player') {
              state.stats.knockdowns += 1;
              commitCrime(HEAT.pedDown, t.x, t.y);
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ taxi & pickups & respray
  function updateTaxi(dt) {
    const taxi = state.taxi;
    const p = state.player;
    if (taxi.cooldown > 0) taxi.cooldown -= dt;
    if (taxi.phase === 'idle') {
      state.taxiMarker = null;
      if (taxi.cooldown <= 0 && p.car) {
        for (const ped of state.peds) {
          if (ped.state === 'walk' && !ped.beach && dist(ped.x, ped.y, p.x, p.y) < 720) {
            ped.state = 'hail';
            ped.hail = true;
            taxi.ped = ped;
            taxi.phase = 'pickup';
            taxi.timer = 26;
            state.taxiMarker = { x: ped.x, y: ped.y, kind: 'taxi' };
            break;
          }
        }
      }
      return;
    }
    if (taxi.phase === 'pickup') {
      const ped = taxi.ped;
      taxi.timer -= dt;
      if (!ped || ped.state !== 'hail' || taxi.timer <= 0) {
        if (ped && ped.state === 'hail') ped.state = 'walk';
        taxi.phase = 'idle';
        taxi.ped = null;
        taxi.cooldown = 9;
        state.taxiMarker = null;
        return;
      }
      state.taxiMarker = { x: ped.x, y: ped.y, kind: 'taxi' };
      if (p.car && Math.abs(p.car.speed) < 22 && dist(ped.x, ped.y, p.car.x, p.car.y) < 44) {
        ped.inCar = true;
        ped.state = 'ride';
        taxi.phase = 'ride';
        // A destination junction a good drive away.
        let dest = null;
        for (let tries = 0; tries < 24; tries += 1) {
          const c = Math.floor(rng() * (COLS + 1));
          const r = Math.floor(rng() * (ROWS + 1));
          const d = dist(roadX(c), roadY(r), p.x, p.y);
          if (d > 750 && d < 2300) { dest = { x: roadX(c), y: roadY(r), d }; break; }
          if (!dest) dest = { x: roadX(c), y: roadY(r), d };
        }
        taxi.dest = dest;
        state.taxiMarker = { x: dest.x, y: dest.y, kind: 'taxi' };
        popup('Passenger', 'Across town, friend — and step on it!');
      }
      return;
    }
    // Riding.
    const ped = taxi.ped;
    if (!p.car) {
      // Rio got out: the fare walks away.
      if (ped) {
        ped.inCar = false;
        ped.state = 'walk';
        ped.x = state.player.x + 24;
        ped.y = state.player.y + 10;
        ped.s = nearestPerimeterS(ped.rect, ped.x, ped.y);
      }
      taxi.phase = 'idle';
      taxi.ped = null;
      taxi.cooldown = 8;
      state.taxiMarker = null;
      return;
    }
    if (dist(p.x, p.y, taxi.dest.x, taxi.dest.y) < 64 && Math.abs(p.car.speed) < 70) {
      const fare = Math.round(35 + taxi.dest.d * 0.055);
      addCash(fare);
      state.stats.fares += 1;
      popup('Passenger', `Thanks! $${fare} — five stars.`);
      if (ped) {
        ped.inCar = false;
        ped.state = 'walk';
        ped.x = taxi.dest.x + 30;
        ped.y = taxi.dest.y + 26;
        const n = nearestNode(ped.x, ped.y);
        ped.rect = {
          x: clamp(n.c, 0, COLS - 1) * PITCH + ROAD + 10, y: clamp(n.r, 0, ROWS - 1) * PITCH + ROAD + 10,
          w: PITCH - ROAD - 20, h: PITCH - ROAD - 20,
        };
        ped.s = nearestPerimeterS(ped.rect, ped.x, ped.y);
      }
      taxi.phase = 'idle';
      taxi.ped = null;
      taxi.cooldown = 9;
      state.taxiMarker = null;
    }
  }

  function updatePickups(dt) {
    const p = state.player;
    for (const pk of state.pickups) {
      if (!pk.active) {
        pk.timer -= dt;
        if (pk.timer <= 0) pk.active = true;
        continue;
      }
      if (dist(p.x, p.y, pk.x, pk.y) < 30) {
        if (pk.kind === 'health' && p.health < 100) p.health = Math.min(100, p.health + 40);
        else if (pk.kind === 'armor' && p.armor < 100) p.armor = Math.min(100, p.armor + 50);
        else continue;
        pk.active = false;
        pk.timer = 45;
        state.fx |= EVENT_PICKUP;
        spawnParticles(pk.x, pk.y, 8, pk.kind === 'health' ? '#7ac74f' : '#5bc0de', 45);
      }
    }
  }

  function updateRespray() {
    const bay = city.specials.respray.bay;
    const p = state.player;
    const inside = p.car && p.x > bay.x && p.x < bay.x + bay.w && p.y > bay.y && p.y < bay.y + bay.h;
    if (!inside) {
      state.resprayArmed = true;
      return;
    }
    if (!state.resprayArmed || state.heat <= 0) return;
    let watched = false;
    for (const car of state.cars) {
      if (car.driver === 'police' && dist(car.x, car.y, p.x, p.y) < RESPRAY_WATCH_RANGE) { watched = true; break; }
    }
    if (!watched) {
      for (const o of state.officers) if (!o.dead && dist(o.x, o.y, p.x, p.y) < RESPRAY_WATCH_RANGE) { watched = true; break; }
    }
    if (watched) return;
    const cost = Math.min(state.cash, RESPRAY_COST);
    state.cash -= cost;
    state.heat = 0;
    state.seenTimer = 99;
    p.car.color = CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)];
    state.resprayArmed = false;
    state.fx |= EVENT_CASH;
    popup('Shine & Go', `Fresh paint, clean record. $${cost}.`);
  }

  // ------------------------------------------------------------------ save
  function saveData() {
    const p = state.player;
    return {
      v: 1,
      cash: state.cash,
      missionIndex: state.mission.index,
      x: Math.round(p.x),
      y: Math.round(p.y),
      health: Math.round(p.health),
      armor: Math.round(p.armor),
      clock: state.clock,
      stats: { ...state.stats },
    };
  }

  function applySave(data) {
    if (!data) return;
    state.cash = data.cash ?? state.cash;
    state.clock = data.clock ?? state.clock;
    if (data.stats) state.stats = { ...state.stats, ...data.stats };
    const p = state.player;
    p.x = clamp(data.x ?? p.x, 16, WORLD_W - 16);
    p.y = clamp(data.y ?? p.y, 16, CITY_H - 16);
    if (city.isWater(p.x, p.y)) { p.x = WATER_X - 60; }
    resolveCircle(city, index, p, PLAYER.radius);
    p.health = data.health ?? 100;
    p.armor = data.armor ?? 0;
    state.mission.index = clamp(data.missionIndex ?? 0, 0, 5);
    missionSetup(state, world);
    state.popups = [];
  }

  // ------------------------------------------------------------------ the step
  const ZERO_CTL = { mx: 0, my: 0, run: false, interact: false, fire: false, aimX: 0, aimY: 0 };

  function stepAmbient(dt, fx) {
    for (const car of state.cars) if (car.driver === 'traffic') updateTrafficCar(car, dt, fx);
    updatePeds(dt);
    stepParticles(dt);
  }

  function step(dt, ctl = ZERO_CTL, harmless = false) {
    state.fx = 0;
    const fx = { crash: 0 };
    state.t += dt;
    if (state.popups.length > 0) {
      state.popups[0].timer -= dt;
      if (state.popups[0].timer <= 0) state.popups.shift();
    }
    if (state.radio) {
      state.radio.timer -= dt;
      if (state.radio.timer <= 0) state.radio = null;
    }
    if (state.shake > 0) state.shake = Math.max(0, state.shake - dt * 14);

    if (state.over) {
      state.overTimer += dt;
      stepParticles(dt);
      return state.fx;
    }
    if (harmless) {
      stepAmbient(dt, fx);
      return state.fx;
    }

    state.clock = (state.clock + (dt * 24) / DAY_SECONDS) % 24;
    updatePlayer(dt, ctl, fx);
    if (!state.over) {
      for (const car of state.cars) if (car.driver === 'traffic') updateTrafficCar(car, dt, fx);
      updatePolice(dt, fx);
      updateOfficers(dt, fx);
      updatePeds(dt);
      carCarCollisions(fx);
      updateHeat(dt);
      updateBust(dt);
      updateRespray();
      updateTaxi(dt);
      updatePickups(dt);
      missionStep(state, world, dt, (flag) => { state.fx |= flag; });
    }
    stepParticles(dt);
    if (state.player.hurtTimer > 0) state.player.hurtTimer -= dt;
    let events = state.fx;
    if (fx.crash > 40) {
      events |= EVENT_CRASH;
      state.lastCrash = fx.crash;
    }
    return events;
  }

  reset();
  return world;
}
