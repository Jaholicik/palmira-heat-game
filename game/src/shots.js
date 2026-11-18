// The screenshot scenes behind ?shot=start|play|chase|end. Each one plays the real rules
// forward from a fresh world, steered by autopilots that walk, steal, drive the avenue grid,
// commit real crimes and get caught by the real mechanics — so the frame is honest gameplay
// and the same seed always gives the same frame. Wanted levels are earned, never set.
import { COLS, ROWS, STEP, roadX, roadY } from './config.js';
import { SCREEN_OVER, SCREEN_PLAY, SCREEN_TITLE } from './render.js';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function angDiff(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

const idleCtl = () => ({ mx: 0, my: 0, run: false, interact: false, fire: false, aimX: 0, aimY: 0 });

/** Walk (or run) toward a point. */
function walkCtl(state, tx, ty) {
  const p = state.player;
  const dx = tx - p.x;
  const dy = ty - p.y;
  const d = Math.hypot(dx, dy) || 1;
  return {
    ...idleCtl(),
    mx: clamp(dx / 24, -1, 1),
    my: clamp(dy / 24, -1, 1),
    run: d > 130,
  };
}

/** A tiny grid router for the driving pilot: greedy junction-to-junction toward the goal. */
function segmentBlocked(state, ax, ay, bx, by) {
  const steps = Math.max(2, Math.floor(Math.hypot(bx - ax, by - ay) / 22));
  for (let i = 1; i < steps; i += 1) {
    if (insideSolid(state, ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps, 2)) return true;
  }
  return false;
}

function makeDriver(state) {
  return {
    node: null,
    from: null,
    stuckTime: 0,
    reverseTime: 0,
    ctl(dest, speedCap = 0) {
      const p = state.player;
      const car = p.car;
      if (!car) return idleCtl();
      if (this.node === null) {
        this.node = {
          c: clamp(Math.round((car.x - 48) / 320), 0, COLS),
          r: clamp(Math.round((car.y - 48) / 320), 0, ROWS),
        };
        this.from = { ...this.node };
      }
      let tx = dest.x;
      let ty = dest.y;
      const direct = dist(car.x, car.y, dest.x, dest.y) < 150
        && !segmentBlocked(state, car.x, car.y, dest.x, dest.y);
      if (!direct) {
        const nc = { x: roadX(this.node.c), y: roadY(this.node.r) };
        if (dist(car.x, car.y, nc.x, nc.y) < 52) {
          const options = [];
          const { c, r } = this.node;
          if (c > 0) options.push({ c: c - 1, r });
          if (c < COLS) options.push({ c: c + 1, r });
          if (r > 0) options.push({ c, r: r - 1 });
          if (r < ROWS) options.push({ c, r: r + 1 });
          let best = options[0];
          let bestD = Infinity;
          for (const o of options) {
            const d = dist(roadX(o.c), roadY(o.r), dest.x, dest.y);
            if (d < bestD) { bestD = d; best = o; }
          }
          this.from = { ...this.node };
          this.node = best;
        }
        tx = roadX(this.node.c);
        ty = roadY(this.node.r);
      }
      const desired = Math.atan2(ty - car.y, tx - car.x);
      const diff = angDiff(car.angle, desired);
      const ctl = idleCtl();
      // Something in the way? Brake like a citizen.
      const hx = Math.cos(car.angle);
      const hy = Math.sin(car.angle);
      let blocked = false;
      for (const other of state.cars) {
        if (other === car) continue;
        if (dist(other.x, other.y, car.x + hx * 58, car.y + hy * 58) < 30) { blocked = true; break; }
      }
      // Wedged (nose-to-nose in a parking spot, or on a building): if we mean to move but
      // are not moving, back out with opposite lock, then carry on.
      if (this.reverseTime > 0) {
        this.reverseTime -= STEP;
        ctl.my = 0.9;
        ctl.mx = clamp(-diff * 2.2, -1, 1);
        return ctl;
      }
      if (Math.abs(diff) > 2.25 && Math.abs(car.speed) < 42) {
        ctl.my = 0.85; // reverse out of the bad angle
        ctl.mx = clamp(-diff * 2.2, -1, 1);
      } else {
        ctl.my = blocked && car.speed > 55 ? 1 : -1;
        if (blocked && car.speed <= 55) ctl.my = 0;
        ctl.mx = clamp(diff * 2.4, -1, 1);
      }
      const wantsMove = ctl.my !== 0 || blocked;
      if (Math.abs(car.speed) < 11 && wantsMove) {
        this.stuckTime += STEP;
        if (this.stuckTime > 1.1) {
          this.stuckTime = 0;
          this.reverseTime = 0.65;
        }
      } else this.stuckTime = 0;
      // Optional pace cap: lift off (or brush the brake) once past it.
      if (speedCap > 0 && ctl.my === -1 && Math.abs(car.speed) > speedCap) ctl.my = 0.3;
      return ctl;
    },
  };
}

function brakeCtl(state) {
  const ctl = idleCtl();
  const car = state.player.car;
  if (car && Math.abs(car.speed) > 8) ctl.my = car.speed > 0 ? 1 : -1;
  return ctl;
}

/** Find a parked car worth stealing: prefer one a pedestrian can witness. */
function pickStealTarget(state, nearX, nearY, wantWitness) {
  let best = null;
  let bestScore = Infinity;
  for (const car of state.cars) {
    if (car.driver !== 'parked' || car.health <= 0) continue;
    let witnessed = false;
    for (const ped of state.peds) {
      if (ped.state !== 'down' && dist(ped.x, ped.y, car.x, car.y) < 215) { witnessed = true; break; }
    }
    if (wantWitness && !witnessed) continue;
    // Chases want a witness; quiet getaways want the opposite.
    const score = dist(nearX, nearY, car.x, car.y) + (witnessed ? (wantWitness ? -260 : 500) : 0);
    if (score < bestScore) { bestScore = score; best = car; }
  }
  if (!best && wantWitness) return pickStealTarget(state, nearX, nearY, false);
  return best;
}

/** Is a point inside any building (expanded a touch)? Used to pick detour sides. */
function insideSolid(state, x, y, pad = 6) {
  for (const b of state.city.buildings) {
    if (x > b.x - pad && x < b.x + b.w + pad && y > b.y - pad && y < b.y + b.h + pad) return true;
  }
  return state.city.isWater(x, y);
}

const nearestRoadX = (x) => roadX(clamp(Math.round((x - 48) / 320), 0, COLS));
const nearestRoadY = (y) => roadY(clamp(Math.round((y - 48) / 320), 0, ROWS));

/**
 * Walk to a point, routing along the avenues for the long legs (sidewalk-straight lines wedge
 * on buildings) and sidestepping around anything the final leg clips. Returns true on arrival
 * within `arrive` px.
 */
function walkTo(world, tx, ty, maxSteps, arrive = 14) {
  const state = world.state;
  const p = state.player;
  const waypoints = [];
  if (dist(p.x, p.y, tx, ty) > 380) {
    waypoints.push({ x: nearestRoadX(p.x), y: p.y });
    waypoints.push({ x: nearestRoadX(p.x), y: nearestRoadY(ty) });
    waypoints.push({ x: tx, y: nearestRoadY(ty) });
  }
  waypoints.push({ x: tx, y: ty });
  let wi = 0;
  let lastX = p.x;
  let lastY = p.y;
  let stallWindow = 0;
  let detour = null;
  let detourSteps = 0;
  let side = 1;
  for (let i = 0; i < maxSteps; i += 1) {
    if (p.car) return false;
    const goal = detour || waypoints[wi];
    const d = dist(p.x, p.y, goal.x, goal.y);
    if (detour) {
      detourSteps -= 1;
      if (d < 16 || detourSteps <= 0) detour = null;
    } else if (d < (wi === waypoints.length - 1 ? arrive : 20)) {
      wi += 1;
      if (wi >= waypoints.length) return true;
      continue;
    }
    // Stall detection over a half-second window: barely moved while a goal is still ahead
    // means a building is in the way — sidestep around it.
    stallWindow += 1;
    if (stallWindow >= 30) {
      const moved = Math.hypot(p.x - lastX, p.y - lastY);
      lastX = p.x;
      lastY = p.y;
      stallWindow = 0;
      if (moved < 9 && !detour) {
        const dx = goal.x - p.x;
        const dy = goal.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const px = (-dy / len) * side;
        const py = (dx / len) * side;
        side *= -1;
        let cx = p.x + px * 84;
        let cy = p.y + py * 84;
        if (insideSolid(state, cx, cy)) {
          cx = p.x - px * 84;
          cy = p.y - py * 84;
        }
        detour = { x: cx, y: cy };
        detourSteps = 60 * 2;
      }
    }
    world.step(STEP, walkCtl(state, goal.x, goal.y));
    if (dist(p.x, p.y, tx, ty) < arrive) return true;
  }
  return dist(p.x, p.y, tx, ty) < arrive;
}

/** Walk to a car and get in. Returns true once the player is driving it. */
function stealCar(world, target, maxSteps) {
  const state = world.state;
  const budget = { left: maxSteps };
  while (budget.left > 0) {
    const p = state.player;
    if (p.car === target) return true;
    if (p.car) {
      world.step(STEP, brakeCtl(state));
      budget.left -= 1;
      continue;
    }
    const d = dist(p.x, p.y, target.x, target.y);
    if (d < target.spec.len / 2 + 34) {
      const ctl = idleCtl();
      ctl.interact = true;
      world.step(STEP, ctl);
      budget.left -= 1;
    } else {
      const before = state.t;
      walkTo(world, target.x, target.y, Math.min(budget.left, 60 * 20), target.spec.len / 2 + 30);
      budget.left -= Math.round((state.t - before) / STEP);
    }
  }
  return state.player.car === target;
}

/** Get out of the current car (brake first, then F). */
function exitCar(world, maxSteps) {
  const state = world.state;
  for (let i = 0; i < maxSteps; i += 1) {
    if (!state.player.car) return true;
    const car = state.player.car;
    if (Math.abs(car.speed) > 60) world.step(STEP, brakeCtl(state));
    else {
      const ctl = idleCtl();
      ctl.interact = true;
      world.step(STEP, ctl);
    }
  }
  return !state.player.car;
}

function stageStart(world) {
  const state = world.state;
  for (let i = 0; i < 5 / STEP; i += 1) world.step(STEP, idleCtl(), true);
  return { screen: SCREEN_TITLE, best: 0 };
}

function stagePlay(world) {
  const state = world.state;
  const driver = makeDriver(state);
  // Steal any parked car, drive across town, take the Comet, head for the respray.
  const first = pickStealTarget(state, state.player.x, state.player.y, false);
  if (first) stealCar(world, first, 60 * 30);
  const comet = state.mission.targetCar;
  if (state.player.car && comet) {
    for (let i = 0; i < 60 * 90 && state.player.car !== comet; i += 1) {
      const d = dist(state.player.x, state.player.y, comet.x, comet.y);
      if (d < 120) break;
      world.step(STEP, driver.ctl({ x: comet.x, y: comet.y }));
    }
    exitCar(world, 60 * 6);
    stealCar(world, comet, 60 * 45);
  }
  if (state.player.car === comet) {
    const bay = state.city.specials.respray.bay;
    const dest = { x: bay.x + bay.w / 2, y: bay.y + bay.h / 2 };
    let driven = 0;
    for (let i = 0; i < 60 * 60; i += 1) {
      world.step(STEP, driver.ctl(dest));
      driven += STEP;
      const popupLive = state.popups.length > 0;
      if (driven > 1.6 && Math.abs(comet.speed) > 205 && popupLive) break;
      if (driven > 9) break;
    }
  }
  return { screen: SCREEN_PLAY, best: state.cash };
}

function stageChase(world) {
  const state = world.state;
  const driver = makeDriver(state);
  const target = pickStealTarget(state, state.player.x, state.player.y, true);
  if (target) stealCar(world, target, 60 * 30);
  if (!state.player.car) return { screen: SCREEN_PLAY, best: state.cash };
  // Commit metal: ram the responding units until the board reads exactly three stars.
  let fleeSteps = 0;
  for (let i = 0; i < 60 * 150; i += 1) {
    const p = state.player;
    if (!p.car) break;
    if (state.stars >= 3) {
      // Run along the avenue the theft happened on — straight, lit, and nearly ped-free —
      // and freeze the moment the pursuit is visibly formed up behind us.
      fleeSteps += 1;
      const avenueX = nearestRoadX(p.x);
      const room = p.y > 1650 ? -1 : 1;
      const dest = { x: avenueX, y: p.y + room * 2200 };
      world.step(STEP, driver.ctl(dest, 205));
      // Freeze only when the pursuit is IN FRAME: the camera shows ±640×±400 around Rio,
      // so use an elliptical test — units within |dx|<580, |dy|<350 are on screen.
      let unitsNear = 0;
      for (const car of state.cars) {
        if (car.driver !== 'police') continue;
        if (Math.abs(car.x - p.x) < 580 && Math.abs(car.y - p.y) < 350) unitsNear += 1;
      }
      const moving = Math.abs(p.car.speed) > 90;
      const boxed = Math.abs(p.car.speed) < 40 && unitsNear >= 2 && fleeSteps > 30;
      if ((fleeSteps > 10 && unitsNear >= 2 && moving) || boxed || fleeSteps > 60 * 7) break;
      continue;
    }
    // Find the nearest unit and drive at it; if none has arrived yet, cruise slowly.
    let unit = null;
    let unitD = Infinity;
    for (const car of state.cars) {
      if (car.driver !== 'police' || car.health <= 0) continue;
      const d = dist(car.x, car.y, p.x, p.y);
      if (d < unitD) { unitD = d; unit = car; }
    }
    if (unit) world.step(STEP, driver.ctl({ x: unit.x, y: unit.y }, 175));
    else {
      const cruise = { x: p.x, y: p.y - 300 };
      world.step(STEP, driver.ctl(cruise));
    }
  }
  return { screen: SCREEN_PLAY, best: state.cash };
}

function stageEnd(world) {
  const state = world.state;
  const target = pickStealTarget(state, state.player.x, state.player.y, true);
  if (target) stealCar(world, target, 60 * 30);
  if (state.player.car) exitCar(world, 60 * 6);
  // Stand still by the stolen car and let the response arrive and work the bust meter.
  for (let i = 0; i < 60 * 70; i += 1) {
    world.step(STEP, idleCtl());
    if (state.over === 'busted') break;
  }
  return { screen: state.over === 'busted' ? SCREEN_OVER : SCREEN_PLAY, best: state.cash };
}

/**
 * Set `world` to the named scene (start, play, chase or end; any other name is start) and
 * return the screen to draw over it and a figure to show.
 */
export function stageShot(name, world) {
  world.reset();
  if (name === 'play') return stagePlay(world);
  if (name === 'chase') return stageChase(world);
  if (name === 'end') return stageEnd(world);
  return stageStart(world);
}
