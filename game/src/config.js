// Every tuning number and colour for Palmira Heat in one place: the city grid, the car types,
// the wanted/heat model, the districts and businesses the renderer signs buildings with, and
// the palette. The simulation never reads the screen size; all distances are world pixels.

/** The simulation's fixed step, in seconds: 60 updates a second whatever the display's rate. */
export const STEP = 1 / 60;

// --------------------------------------------------------------------------- city geometry
// Blocks sit between roads: block (c, r) fills [c*PITCH + ROAD, (c+1)*PITCH] on each axis, so
// vertical road centres are c*PITCH + ROAD/2 for c in 0..COLS and horizontal ones likewise.
export const PITCH = 320;
export const ROAD = 96;
export const COLS = 13;
export const ROWS = 10;
export const CITY_W = COLS * PITCH + ROAD; // 4256 — includes the last road strip on each axis
export const CITY_H = ROWS * PITCH + ROAD; // 3296
export const BEACH_X = CITY_W; // sand starts where the avenues end
export const WATER_X = CITY_W + 170; // the bay
export const WORLD_W = WATER_X + 470;
export const WORLD_H = CITY_H;
export const SIDEWALK = 20;

/** Centre line of vertical road c (0..COLS) and horizontal road r (0..ROWS). */
export const roadX = (c) => c * PITCH + ROAD / 2;
export const roadY = (r) => r * PITCH + ROAD / 2;

// --------------------------------------------------------------------------- player
export const PLAYER = {
  radius: 9,
  walkSpeed: 152,
  runSpeed: 238,
  maxHealth: 100,
  maxArmor: 100,
  enterRange: 46, // how close to a car door F/E works
  interactCooldown: 0.35,
};

// --------------------------------------------------------------------------- cars
// len/wid are the hull in pixels; topSpeed and accel in px/s and px/s^2; grip is how fast the
// velocity vector bends toward the heading; health is crash hit points before a wreck.
export const CAR_TYPES = {
  sedan: { len: 46, wid: 22, topSpeed: 302, accel: 265, grip: 5.2, health: 100, name: 'Marina Sedan' },
  hatch: { len: 40, wid: 21, topSpeed: 282, accel: 285, grip: 5.8, health: 85, name: 'Colina Hatch' },
  taxi: { len: 46, wid: 22, topSpeed: 308, accel: 270, grip: 5.2, health: 100, name: 'Palma Cab' },
  sport: { len: 48, wid: 22, topSpeed: 432, accel: 385, grip: 6.4, health: 95, name: 'Comet S' },
  van: { len: 57, wid: 26, topSpeed: 262, accel: 215, grip: 4.2, health: 260, name: 'Bastion Van' },
  police: { len: 48, wid: 23, topSpeed: 402, accel: 362, grip: 6.0, health: 170, name: 'Interceptor' },
};
export const CAR_COLORS = ['#c9453c', '#3c6fc9', '#e8e4da', '#2f3338', '#7ac74f', '#e39b2d', '#8e5bb5', '#39b5a6', '#d96f9e', '#5b7a99', '#b8bcc2', '#74452a'];
export const TRAFFIC_COUNT = 20;
export const PARKED_COUNT = 44;
export const PED_COUNT = 52;

// --------------------------------------------------------------------------- wanted & police
export const HEAT = {
  max: 560,
  perStar: 112, // stars = ceil(heat / perStar), so 1..5 stars across 560
  theft: 110,
  pedDown: 120,
  gunfire: 55,
  hitCar: 26,
  hitPolice: 135,
  officerDown: 225,
  unwitnessedCap: 8, // a crime nobody saw barely registers
  witnessRange: 275,
  gunfireThrottle: 0.55, // seconds between heat bumps for sustained fire
  decayDelay: 6, // seconds unseen before heat starts cooling
  decayRate: 15, // heat per second while cooling
  seenRange: 430, // a unit this close with line of sight keeps the heat live
};
/** Police units the city fields at each star level, index 0..5. */
export const UNITS_PER_STAR = [0, 1, 2, 3, 4, 6];
export const BUST = {
  range: 96, // a unit or officer this close can work the meter
  fillTime: 1.7, // seconds pinned down to be busted
  slowSpeed: 42, // below this the player counts as pinned
  fine: 250,
};
export const WASTED_FEE = 300;
export const RESPRAY_COST = 400;
export const RESPRAY_WATCH_RANGE = 330; // no officer or unit this close, or no respray

// --------------------------------------------------------------------------- world dressing
/** One full day in seconds of play; the clock starts mid-morning. */
export const DAY_SECONDS = 480;
export const START_CLOCK = 10.4;
/** The hour the title screen is graded at: golden sunset over the bay. */
export const TITLE_CLOCK = 17.85;

export const DISTRICTS = [
  'Old Town', 'Mercado', 'The Flats', 'Centro', 'Palm Heights',
  'Marina', 'Colina', 'Dockside', 'Azure Row', 'Portside',
];

export const BUSINESSES = [
  'Café Brisa', 'Hotel Azul', 'Tacos El Faro', 'Marina Motors', 'Sol Pharmacy',
  'Barbería Cortez', 'Night Owl Liquor', 'Palmira Records', 'Sushi Ola', 'Gym Fortaleza',
  'Lavandería Burbujas', 'Bookshop Marea', 'Pizza Forno', 'Dental Sonrisa', 'Flores Jazmín',
  'Ferretería Martillo', 'Panadería Dulce', 'Club Neon Palms', 'Pawn Oro', 'Surf Espuma',
  'Óptica Vista', 'Pollo Bravo', 'Burger Bote', 'Helados Rio', 'Viajes Palma', 'Banco Palma',
];

export const RADIO_STATIONS = [
  'Palmira FM 103.7', 'Ola Suave 98.1', 'Neon Nights Radio',
  'Radio Marea 88.5', 'Bajo Bass 106.3', 'Costa Classics',
];

export const PALETTE = {
  backdrop: '#0d0f14',
  asphalt: '#33363d',
  asphaltDark: '#2b2e35',
  sidewalk: '#8f8c84',
  curb: '#6f6c64',
  lane: '#d8d4c4',
  centre: '#d9a441',
  block: '#565a4e',
  park: '#4d7a41',
  sand: '#d9bd85',
  sandWet: '#c2a26e',
  water: '#1d5f7a',
  waterDeep: '#174c66',
  foam: '#e8f2ee',
  roofDark: '#4a4a52',
  text: '#eef1f5',
  muted: '#9aa3b2',
  gold: '#f2c94c',
  danger: '#e5534b',
  police: '#2b4d9b',
};

export const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Where the save game is kept between visits (this browser only). */
export const SAVE_KEY = 'palmira-heat.save.v1';
