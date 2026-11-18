// Faro's story: five missions that walk Rio up Palmira's ladder, from a stolen sports car to an
// armored van delivered under a three-star chase. The manager runs inside world.step (so the
// screenshot staging plays the same rules), keeps the objective banner and the map marker
// current, and pays out through the world. After mission five the story is complete and the
// city is free roam.
import { HEAT, roadX, roadY } from './config.js';

export const EVENT_MISSION = 16;

export const MISSION_TITLES = [
  'Fresh Off the Boat',
  "Sal's Package",
  'Beachfront Run',
  'Cool Off',
  'The Pier 9 Job',
];

const INTROS = [
  'Rio. A teal Comet S is parked up in Old Town. Bring it to Shine & Go — clean, understood?',
  'Sal left a package on the south-east docks road. Pick it up, bring it to the Marina. Expect company.',
  'A client wants the beachfront timed. Five gates, eighty-five seconds. Do not scratch the paint.',
  'The PD thinks you are a ghost. Show them three stars — then vanish. No body, no story.',
  'Last one, Rio. A Bastion van sleeps at Banco Palma. Take it to Pier 9. Half the city will chase you.',
];

export function createMissionState() {
  return { index: 0, stage: 0, timer: 0, checkpoint: 0, targetCar: null, started: false };
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

/** Set up the current mission's world pieces (target car, markers, intro popup). */
export function missionSetup(state, world) {
  const m = state.mission;
  m.stage = 0;
  m.timer = 0;
  m.checkpoint = 0;
  m.targetCar = null;
  if (m.index >= MISSION_TITLES.length) {
    state.banner = null;
    state.marker = null;
    return;
  }
  world.popup('Faro', INTROS[m.index]);
  if (m.index === 0) {
    const spot = world.nearestParkingSpot(620, 780);
    m.targetCar = world.spawnSpecialCar('sport', 'comet', spot);
  } else if (m.index === 4) {
    const bank = state.city.specials.bank;
    const spot = world.nearestParkingSpot(bank.building.x + 190, bank.building.y + 90);
    m.targetCar = world.spawnSpecialCar('van', 'bastion', spot);
  }
  m.started = true;
}

function complete(state, world, emit, reward, outro) {
  world.addCash(reward);
  state.stats.missionsDone += 1;
  state.pendingSave = true;
  emit(EVENT_MISSION);
  world.popup('Faro', outro);
  state.mission.index += 1;
  missionSetup(state, world);
}

/** Advance the story by one step; called from world.step with the emit() event sink. */
export function missionStep(state, world, dt, emit) {
  const m = state.mission;
  const p = state.player;
  if (m.index >= MISSION_TITLES.length) {
    state.banner = null;
    state.marker = null;
    return;
  }
  const title = `${m.index + 1}. ${MISSION_TITLES[m.index]}`;

  if (m.index === 0) {
    // Fresh Off the Boat: steal the Comet S, deliver it to the respray bay.
    const car = m.targetCar;
    if (car && car.health <= 0) {
      world.popup('Faro', 'You wrecked the Comet? Another just rolled in. Again — carefully.');
      const spot = world.nearestParkingSpot(620, 780);
      m.targetCar = world.spawnSpecialCar('sport', 'comet', spot);
      m.stage = 0;
      return;
    }
    if (m.stage === 0) {
      state.banner = { title, sub: 'Steal the teal Comet S' };
      state.marker = car ? { x: car.x, y: car.y, kind: 'mission' } : null;
      if (p.car && car && p.car === car) {
        m.stage = 1;
        world.popup('Faro', 'Good hands. Now the garage, and keep it pretty.');
      }
    } else {
      const bay = state.city.specials.respray.bay;
      const cx = bay.x + bay.w / 2;
      const cy = bay.y + bay.h / 2;
      state.banner = { title, sub: 'Deliver the Comet to Shine & Go' };
      state.marker = { x: cx, y: cy, kind: 'mission' };
      if (p.car === car && dist(p.x, p.y, cx, cy) < 52) {
        complete(state, world, emit, 600, 'Beautiful. Six hundred, as agreed. More work soon.');
      }
    }
    return;
  }

  if (m.index === 1) {
    // Sal's Package: pick up across town, deliver under a forced two stars.
    const pickup = { x: roadX(10) + 62, y: roadY(8) };
    const drop = { x: roadX(3) - 60, y: roadY(1) + 10 };
    if (m.stage === 0) {
      state.banner = { title, sub: 'Pick up the package' };
      state.marker = { x: pickup.x, y: pickup.y, kind: 'mission' };
      if (dist(p.x, p.y, pickup.x, pickup.y) < 46) {
        m.stage = 1;
        world.heatAtLeast(2 * HEAT.perStar);
        world.popup('Faro', 'That is the one. The Marina, now — and lose the tail first if you can.');
      }
    } else {
      state.banner = { title, sub: 'Deliver the package to the Marina' };
      state.marker = { x: drop.x, y: drop.y, kind: 'mission' };
      if (dist(p.x, p.y, drop.x, drop.y) < 58) {
        complete(state, world, emit, 900, 'Delivered. Nine hundred. Sal sends his regards.');
      }
    }
    return;
  }

  if (m.index === 2) {
    // Beachfront Run: five gates down the east avenue against the clock.
    const gates = [1, 3, 5, 7, 9].map((r) => ({ x: roadX(13), y: roadY(r) }));
    if (m.stage === 0) {
      state.banner = { title, sub: 'Reach the first gate to start the clock' };
      state.marker = { x: gates[0].x, y: gates[0].y, kind: 'mission' };
      if (dist(p.x, p.y, gates[0].x, gates[0].y) < 64) {
        m.stage = 1;
        m.checkpoint = 1;
        m.timer = 85;
      }
    } else {
      m.timer -= dt;
      const gate = gates[m.checkpoint];
      state.banner = { title, sub: `Gate ${m.checkpoint + 1} of 5 — ${Math.max(0, Math.ceil(m.timer))}s` };
      state.marker = { x: gate.x, y: gate.y, kind: 'mission' };
      if (m.timer <= 0) {
        m.stage = 0;
        m.checkpoint = 0;
        world.popup('Faro', 'Too slow. The gates are still there when you are ready.');
      } else if (dist(p.x, p.y, gate.x, gate.y) < 64) {
        m.checkpoint += 1;
        if (m.checkpoint >= gates.length) {
          complete(state, world, emit, 750, 'Fast and clean. Seven fifty — the client is thrilled.');
        }
      }
    }
    return;
  }

  if (m.index === 3) {
    // Cool Off: reach three stars, then shake them.
    if (m.stage === 0) {
      state.banner = { title, sub: 'Make some noise — reach 3 wanted stars' };
      state.marker = null;
      if (state.stars >= 3) {
        m.stage = 1;
        world.popup('Faro', 'There they are. Now disappear.');
      }
    } else {
      state.banner = { title, sub: 'Lose the heat completely' };
      state.marker = null;
      if (state.heat <= 0) {
        complete(state, world, emit, 1000, 'A ghost, like I said. One thousand. One last job tomorrow.');
      }
    }
    return;
  }

  // The Pier 9 Job: steal the Bastion, deliver it to the pier under chase.
  const car = m.targetCar;
  if (car && car.health <= 0 && m.stage === 0) {
    world.popup('Faro', 'The van is scrap. Another is already parked at the bank. Move.');
    const bank = state.city.specials.bank;
    const spot = world.nearestParkingSpot(bank.building.x + 190, bank.building.y + 90);
    m.targetCar = world.spawnSpecialCar('van', 'bastion', spot);
    return;
  }
  const pier = state.city.pier;
  const dock = { x: pier.x + pier.w - 30, y: pier.y + pier.h / 2 };
  if (m.stage === 0) {
    state.banner = { title, sub: 'Steal the Bastion van at Banco Palma' };
    state.marker = car ? { x: car.x, y: car.y, kind: 'mission' } : null;
    if (p.car && car && p.car === car) {
      m.stage = 1;
      world.heatAtLeast(3 * HEAT.perStar);
      world.popup('Faro', 'They noticed. Pier 9, Rio — do not stop for anyone.');
    }
  } else {
    state.banner = { title, sub: 'Deliver the van to Pier 9' };
    state.marker = { x: dock.x, y: dock.y, kind: 'mission' };
    if (p.car === car && dist(p.x, p.y, dock.x, dock.y) < 74) {
      complete(state, world, emit, 2500, 'The big one is done. Palmira is yours now, Rio. — Faro');
      state.banner = { title: 'STORY COMPLETE', sub: 'Free roam — taxi fares and the city are yours' };
    }
  }
}
