// Procedural Palmira: a 13x10 block grid between avenues, a beach and bay on the east edge, a
// pier and dockside container yard, parks and parking lots, and four special buildings (the
// Palmira PD, St. Azure Hospital, the Shine & Go respray and Banco Palma). Everything is laid
// out from the world's seeded stream at creation, so a seed always builds the same city. The
// renderer and the collision code share the solids list built here.
import {
  BEACH_X, BUSINESSES, CITY_H, CITY_W, COLS, DISTRICTS, PITCH, ROAD, ROWS, WATER_X, WORLD_W,
  roadX, roadY,
} from './config.js';

const FACADES = ['#b08968', '#9c6644', '#7f8c8d', '#a26769', '#5d6d7e', '#c9a227', '#7d5ba6', '#4e7a6a', '#96604a', '#68707d', '#b56b45', '#546e7a'];
const ROOFS = ['#5a4a42', '#4a4a52', '#63564a', '#51424e', '#585048', '#3f4a4a'];
const AWNINGS = ['#c9453c', '#2e7d6b', '#31597f', '#c9862b', '#6d4a7a', '#3f7a3a'];

const SPECIAL_BLOCKS = {
  pd: { c: 2, r: 4 },
  hospital: { c: 9, r: 2 },
  respray: { c: 5, r: 6 },
  bank: { c: 6, r: 4 },
};

function blockInterior(c, r) {
  return { x: c * PITCH + ROAD, y: r * PITCH + ROAD, w: PITCH - ROAD, h: PITCH - ROAD };
}

/** Which named district a world point belongs to (coarse regions over the grid). */
export function districtAt(x, y) {
  const c = Math.max(0, Math.min(COLS - 1, Math.floor(x / PITCH)));
  const r = Math.max(0, Math.min(ROWS - 1, Math.floor(y / PITCH)));
  if (x >= BEACH_X) return 'Azure Row';
  if (r <= 2) return [DISTRICTS[0], DISTRICTS[1], DISTRICTS[4], DISTRICTS[6]][Math.min(3, Math.floor(c / 4))];
  if (r <= 5) return [DISTRICTS[0], DISTRICTS[3], DISTRICTS[5], DISTRICTS[7]][Math.min(3, Math.floor(c / 4))];
  return [DISTRICTS[2], DISTRICTS[3], DISTRICTS[8], DISTRICTS[9]][Math.min(3, Math.floor(c / 4))];
}

export function generateCity(rng) {
  const buildings = [];
  const solids = [];
  const palms = [];
  const lamps = [];
  const benches = [];
  const boats = [];
  const containers = [];
  const crates = [];
  const parks = [];
  const parkingSpots = [];
  const specials = {};

  function addBuilding(x, y, w, h, special) {
    const b = {
      id: buildings.length,
      x, y, w, h,
      facade: special ? '#7a7f8c' : FACADES[Math.floor(rng() * FACADES.length)],
      roof: ROOFS[Math.floor(rng() * ROOFS.length)],
      grade: special ? 2 : 1 + Math.floor(rng() * 3), // pseudo-3D lift + shadow length
      shop: null,
      awning: null,
      special: special || null,
      ac: Math.floor(rng() * 3), // rooftop AC units
      tower: rng() < 0.3, // rooftop water tower
    };
    if (!special && rng() < 0.52) {
      b.shop = BUSINESSES[Math.floor(rng() * BUSINESSES.length)];
      b.awning = AWNINGS[Math.floor(rng() * AWNINGS.length)];
    }
    if (special === 'pd') { b.facade = '#5d6d8a'; b.shop = 'PALMIRA PD'; }
    if (special === 'hospital') { b.facade = '#cfd4d8'; b.shop = 'ST. AZURE HOSPITAL'; }
    if (special === 'respray') { b.facade = '#3f7a6a'; b.shop = 'SHINE & GO RESPRAY'; }
    if (special === 'bank') { b.facade = '#8a7a4a'; b.shop = 'BANCO PALMA'; }
    buildings.push(b);
    solids.push({ x, y, w, h });
    return b;
  }

  function addPalm(x, y) {
    palms.push({ x, y, phase: rng() * Math.PI * 2, s: 0.85 + rng() * 0.4 });
  }

  // --- blocks -------------------------------------------------------------
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const inner = blockInterior(c, r);
      const specialKind = Object.keys(SPECIAL_BLOCKS).find((k) => SPECIAL_BLOCKS[k].c === c && SPECIAL_BLOCKS[k].r === r);
      if (specialKind) {
        const b = addBuilding(inner.x + 18, inner.y + 30, 118, 150, specialKind);
        const door = { x: inner.x - 14, y: inner.y + inner.h / 2 };
        if (specialKind === 'respray') {
          const bay = { x: inner.x + 148, y: inner.y + 52, w: 66, h: 116 };
          specials.respray = { building: b, bay, door };
        } else {
          specials[specialKind] = { building: b, door };
        }
        // Forecourt parking beside every special.
        for (let i = 0; i < 3; i += 1) {
          parkingSpots.push({ x: inner.x + 160, y: inner.y + 34 + i * 62, angle: 0 });
        }
        continue;
      }
      const roll = rng();
      if (c >= COLS - 1 && r >= 4 && r <= 6) {
        // Dockside: two big warehouses a block from the water.
        addBuilding(inner.x + 16, inner.y + 20, 88, 184, null).shop = 'DOCK 9 STORAGE';
        addBuilding(inner.x + 118, inner.y + 20, 88, 184, null).shop = 'FRIO FREIGHT';
        continue;
      }
      if (roll < 0.12) {
        // A park: grass, benches, palms, no buildings.
        parks.push({ x: inner.x + 6, y: inner.y + 6, w: inner.w - 12, h: inner.h - 12 });
        for (let i = 0; i < 4; i += 1) benches.push({ x: inner.x + 30 + rng() * (inner.w - 60), y: inner.y + 30 + rng() * (inner.h - 60) });
        for (let i = 0; i < 5; i += 1) addPalm(inner.x + 24 + rng() * (inner.w - 48), inner.y + 24 + rng() * (inner.h - 48));
        continue;
      }
      if (roll < 0.24) {
        // A parking lot: asphalt pad with two rows of marked spots.
        parks.push({ x: inner.x + 6, y: inner.y + 6, w: inner.w - 12, h: inner.h - 12, lot: true });
        for (let i = 0; i < 4; i += 1) {
          parkingSpots.push({ x: inner.x + 40 + i * 48, y: inner.y + 40, angle: Math.PI / 2 });
          parkingSpots.push({ x: inner.x + 40 + i * 48, y: inner.y + inner.h - 40, angle: -Math.PI / 2 });
        }
        continue;
      }
      // Buildings: one big, two, or four to a block, inside a sidewalk margin.
      const m = 24;
      const ux = inner.x + m;
      const uy = inner.y + m;
      const uw = inner.w - m * 2;
      const uh = inner.h - m * 2;
      const layout = rng();
      if (layout < 0.45) {
        addBuilding(ux + rng() * 14, uy + rng() * 14, uw - 16 - rng() * 10, uh - 16 - rng() * 10, null);
      } else if (layout < 0.8) {
        const vertical = rng() < 0.5;
        if (vertical) {
          addBuilding(ux, uy, (uw - 14) / 2, uh - 8, null);
          addBuilding(ux + (uw + 14) / 2, uy, (uw - 14) / 2, uh - 8, null);
        } else {
          addBuilding(ux, uy, uw - 8, (uh - 14) / 2, null);
          addBuilding(ux, uy + (uh + 14) / 2, uw - 8, (uh - 14) / 2, null);
        }
      } else {
        const gw = (uw - 12) / 2;
        const gh = (uh - 12) / 2;
        addBuilding(ux, uy, gw, gh, null);
        addBuilding(ux + gw + 12, uy, gw, gh, null);
        addBuilding(ux, uy + gh + 12, gw, gh, null);
        addBuilding(ux + gw + 12, uy + gh + 12, gw, gh, null);
      }
      // Curb parking along the block's south edge.
      if (rng() < 0.65) {
        const n = 2 + Math.floor(rng() * 2);
        for (let i = 0; i < n; i += 1) parkingSpots.push({ x: inner.x + 44 + i * 56, y: inner.y + inner.h - 12, angle: 0 });
      }
      if (rng() < 0.4) addPalm(inner.x + 12, inner.y + 12);
    }
  }

  // --- lamps at intersection corners ---------------------------------------
  for (let r = 0; r <= ROWS; r += 1) {
    for (let c = 0; c <= COLS; c += 1) {
      lamps.push({ x: roadX(c) - ROAD / 2 + 6, y: roadY(r) - ROAD / 2 + 6 });
      lamps.push({ x: roadX(c) + ROAD / 2 - 6, y: roadY(r) + ROAD / 2 - 6 });
    }
  }

  // --- beach, pier, docks ---------------------------------------------------
  for (let y = 60; y < CITY_H - 40; y += 96 + rng() * 60) {
    addPalm(BEACH_X + 34 + rng() * 40, y);
    if (rng() < 0.5) addPalm(WATER_X - 30 - rng() * 30, y + 40);
  }
  const pierY = roadY(5);
  const pier = { x: WATER_X - 6, y: pierY - 23, w: 320, h: 46 };
  const boatColors = ['#e8e4da', '#c9453c', '#3c6fc9', '#e39b2d', '#39b5a6'];
  for (let i = 0; i < 7; i += 1) {
    boats.push({
      x: WATER_X + 40 + rng() * (WORLD_W - WATER_X - 90),
      y: 140 + rng() * (CITY_H - 280),
      angle: rng() * Math.PI * 2,
      phase: rng() * Math.PI * 2,
      color: boatColors[Math.floor(rng() * boatColors.length)],
    });
  }
  // Two boats moored alongside the pier, always in frame for the title shot.
  boats.push({ x: pier.x + 120, y: pier.y - 34, angle: 0.2, phase: 1.3, color: '#e8e4da' });
  boats.push({ x: pier.x + 210, y: pier.y + pier.h + 16, angle: -0.15, phase: 3.9, color: '#c9453c' });
  // Container yard on the sand by the pier, plus crates near the warehouses.
  const containerColors = ['#b3502e', '#2e6db3', '#3f8a4f', '#8a8f96', '#a03d5c'];
  for (let i = 0; i < 6; i += 1) {
    const w = 62;
    const h = 26;
    const x = BEACH_X + 16 + (i % 2) * 74;
    const y = pierY - 210 + Math.floor(i / 2) * 44;
    containers.push({ x, y, w, h, color: containerColors[i % containerColors.length] });
    solids.push({ x, y, w, h });
  }
  for (let i = 0; i < 8; i += 1) {
    const s = 20 + rng() * 8;
    const x = BEACH_X + 10 + rng() * 130;
    const y = pierY + 120 + rng() * 260;
    crates.push({ x, y, w: s, h: s });
    solids.push({ x, y, w: s, h: s });
  }

  // Palm trunks are small solid circles for the collision code.
  const circles = palms.map((p) => ({ x: p.x, y: p.y, r: 5 }));

  return {
    buildings, solids, circles, palms, lamps, benches, boats, containers, crates, parks,
    parkingSpots, specials, pier,
    width: WORLD_W,
    height: CITY_H,
    isWater(x, y) {
      if (x < WATER_X) return false;
      // The pier deck is solid ground over the bay.
      if (x >= pier.x && x <= pier.x + pier.w && y >= pier.y && y <= pier.y + pier.h) return false;
      return true;
    },
  };
}
