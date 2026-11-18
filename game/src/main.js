// Boot and the one loop: input is read every frame, the world advances in fixed 1/60 s steps
// (several in a slow frame, none in a fast one), and the renderer paints what is there. The
// game moves between title, help, play, paused and the busted/wasted screen; progress is kept
// in localStorage and refreshed automatically whenever a mission lands.
//
// ?seed=N fixes the city. ?shot=start|play|chase|end (with &seed=N) stages that scene instead
// of running the loop, paints it twice and sets window.__shotReady for a screenshot.
import { SAVE_KEY, STEP } from './config.js';
import { createRandom } from './random.js';
import {
  EVENT_CASH, EVENT_CRASH, EVENT_ENTER_CAR, EVENT_MISSION, EVENT_OFFICER_SHOT, EVENT_PICKUP,
  EVENT_POPUP, EVENT_SHOT, createWorld,
} from './world.js';
import { ACTION_PAUSE, createInput } from './input.js';
import { createRenderer, SCREEN_HELP, SCREEN_OVER, SCREEN_PAUSED, SCREEN_PLAY, SCREEN_TITLE } from './render.js';
import { createAudio } from './audio.js';
import { stageShot } from './shots.js';

/** The longest frame the loop catches up on; a longer stall (a hidden tab) is dropped, not replayed. */
const MAX_FRAME = 0.25;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) ? seedParam : Math.floor(Math.random() * 4294967296);

const canvas = document.getElementById('game');
const status = document.getElementById('status');
const world = createWorld(createRandom(seed), seed);
const renderer = createRenderer(canvas);
const audio = createAudio();

function readSave() {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSave() {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(world.saveData()));
  } catch {
    // Storage can be off (private windows): the run then lasts this visit only.
  }
}

function runShot(name) {
  const scene = stageShot(name, world);
  let painted = 0;
  function paint() {
    renderer.draw(world.state, scene.screen, { best: scene.best, menuIndex: 0, items: titleItems() });
    painted += 1;
    if (painted < 2) requestAnimationFrame(paint);
    else window.__shotReady = true;
  }
  requestAnimationFrame(paint);
}

function titleItems() {
  return readSave() ? ['New Game', 'Continue', 'How to Play'] : ['New Game', 'How to Play'];
}

function runGame() {
  const input = createInput(canvas);
  let screen = SCREEN_TITLE;
  let menuIndex = 0;
  let accumulator = 0;
  let last = performance.now();
  const heldBefore = new Set();

  function announce(message) {
    status.textContent = message;
  }

  function edge(code) {
    const now = input.keys.has(code);
    const was = heldBefore.has(code);
    if (now) heldBefore.add(code);
    else heldBefore.delete(code);
    return now && !was;
  }

  function playSounds(events) {
    if (events & EVENT_SHOT) audio.shot();
    if (events & EVENT_OFFICER_SHOT) audio.officerShot();
    if (events & EVENT_CRASH) audio.crash(Math.min(1, (world.state.lastCrash || 120) / 320));
    if (events & EVENT_PICKUP) audio.pickup();
    if (events & EVENT_CASH) audio.cash();
    if (events & EVENT_POPUP) audio.popup();
    if (events & EVENT_MISSION) {
      if (world.state.over) audio.sting();
      else audio.jingle();
    }
  }

  function startPlay(fresh) {
    if (fresh) world.reset();
    else {
      world.reset();
      const save = readSave();
      if (save) world.applySave(save);
    }
    accumulator = 0;
    screen = SCREEN_PLAY;
    announce('Playing. Palmira is yours.');
  }

  function menuConfirm() {
    if (screen === SCREEN_TITLE) {
      const items = titleItems();
      const choice = items[menuIndex];
      if (choice === 'New Game') startPlay(true);
      else if (choice === 'Continue') startPlay(false);
      else if (choice === 'How to Play') screen = SCREEN_HELP;
    } else if (screen === SCREEN_PAUSED) {
      const items = ['Resume', 'Save Game', 'Restart Story', 'Quit to Title'];
      const choice = items[menuIndex];
      if (choice === 'Resume') screen = SCREEN_PLAY;
      else if (choice === 'Save Game') {
        writeSave();
        screen = SCREEN_PLAY;
        announce('Saved.');
      } else if (choice === 'Restart Story') startPlay(true);
      else if (choice === 'Quit to Title') {
        screen = SCREEN_TITLE;
        menuIndex = 0;
      }
    }
  }

  function handleMenus() {
    const actions = input.takeActions();
    const clicked = input.takeClick();
    if (screen === SCREEN_HELP) {
      if (actions || clicked) screen = SCREEN_TITLE;
      return;
    }
    if (screen === SCREEN_OVER) {
      if ((actions || clicked) && world.state.overTimer > 0.5) {
        world.respawnAfterOver();
        screen = SCREEN_PLAY;
      }
      return;
    }
    if (screen === SCREEN_TITLE || screen === SCREEN_PAUSED) {
      const count = screen === SCREEN_TITLE ? titleItems().length : 4;
      if (edge('ArrowDown') || edge('KeyS')) menuIndex = (menuIndex + 1) % count;
      if (edge('ArrowUp') || edge('KeyW')) menuIndex = (menuIndex - 1 + count) % count;
      if (actions || clicked) menuConfirm();
      return;
    }
    if (screen === SCREEN_PLAY && (actions & ACTION_PAUSE)) {
      screen = SCREEN_PAUSED;
      menuIndex = 0;
      announce('Paused.');
    }
  }

  function buildControls(actions) {
    const k = input.keys;
    const mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const my = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    const aim = renderer.screenToWorld(input.mouse.x, input.mouse.y);
    return {
      mx,
      my,
      run: k.has('ShiftLeft') || k.has('ShiftRight'),
      interact: (actions & ACTION_INTERACT) !== 0,
      fire: input.mouse.down || k.has('Space'),
      aimX: aim.x,
      aimY: aim.y,
    };
  }

  function frame(now) {
    requestAnimationFrame(frame);
    accumulator += Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    if (edge('KeyM')) audio.toggleMute();
    handleMenus();

    let events = 0;
    if (screen === SCREEN_PLAY) {
      // One-shot menu actions were already drained by handleMenus; the interact edge comes
      // from the raw key state so a tap of F/E inside this frame still lands exactly once.
      const ctl = buildControls(0);
      ctl.interact = edge('KeyF') || edge('KeyE');
      while (accumulator >= STEP && screen === SCREEN_PLAY) {
        events |= world.step(STEP, ctl, false);
        ctl.interact = false;
        accumulator -= STEP;
        if (world.state.pendingSave) {
          world.state.pendingSave = false;
          writeSave();
        }
        if (world.state.over) {
          screen = SCREEN_OVER;
          announce(world.state.over === 'busted' ? 'Busted.' : 'Wasted.');
        }
      }
    } else if (screen === SCREEN_TITLE || screen === SCREEN_HELP) {
      while (accumulator >= STEP) {
        world.step(STEP, undefined, true);
        accumulator -= STEP;
      }
    } else {
      accumulator = 0;
    }
    playSounds(events);

    // Continuous audio: engine, siren by nearest unit, title music.
    const p = world.state.player;
    const inCar = screen === SCREEN_PLAY && p.car !== null;
    audio.setEngine(inCar, inCar ? Math.abs(p.car.speed) / p.car.spec.topSpeed : 0);
    let siren = 0;
    if (screen === SCREEN_PLAY && world.state.stars > 0) {
      let nearest = Infinity;
      for (const car of world.state.cars) {
        if (car.driver === 'police' && car.health > 0) {
          nearest = Math.min(nearest, Math.hypot(car.x - p.x, car.y - p.y));
        }
      }
      if (nearest < 900) siren = 1 - nearest / 900;
    }
    audio.setSiren(siren, world.state.t);
    audio.setTitleMusic(screen === SCREEN_TITLE);

    const items = screen === SCREEN_TITLE
      ? titleItems()
      : ['Resume', 'Save Game', 'Restart Story', 'Quit to Title'];
    renderer.draw(world.state, screen, {
      menuIndex,
      items,
      mouse: input.mouse,
      muted: audio.muted,
    });
  }

  window.addEventListener('pointerdown', () => audio.unlock(), { passive: true });
  window.addEventListener('keydown', () => audio.unlock());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && screen === SCREEN_PLAY) {
      screen = SCREEN_PAUSED;
      menuIndex = 0;
      announce('Paused.');
    }
  });

  announce('Palmira Heat. Choose New Game to start.');
  requestAnimationFrame(frame);
}

if (shot) runShot(shot);
else runGame();
