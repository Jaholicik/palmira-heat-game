[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/Jaholicik/palmira-heat-game/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/Jaholicik/palmira-heat-game/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

# Palmira Heat

A complete top-down open-world crime game in the browser — plain static files, no build step,
no network requests, no libraries. You are **Rio Marino**, newly arrived in the coastal city of
**Palmira**. The fixer **Faro** has work for you: five jobs that take you from stealing a sports
car across town to lifting an armored van under a full police chase. Between jobs the city is
yours — steal any car, run taxi fares, dodge the Palmira PD, get your ride resprayed, and watch
the sun go down over the bay.

## The city

Palmira is a 13 × 10 block grid of named districts with sidewalks, ~120 buildings with lit
windows and rooftop clutter, palm trees, parks, a beach with animated water, a pier and docks,
a police station, a hospital and the Shine & Go respray garage. Traffic drives the avenues,
pedestrians walk the sidewalks (and run from gunfire), and the Palmira PD answers crimes on a
0–5 star wanted system: patrols chase and ram, officers bail out and shoot at three stars and
up, a bust meter fills when they pin you down, heat cools when you break their line of sight,
and a respray clears it for cash — if nobody is watching.

## Controls

| Input | Action |
|---|---|
| W A S D / Arrow keys | Move on foot · drive |
| Shift | Run on foot |
| F or E | Enter / exit a car (any car — it's stealing) |
| Mouse | Aim the pistol |
| Mouse held, or Space | Fire the pistol |
| Esc or P | Pause (resume / save / restart / title) |
| Enter or click | Menu confirm |
| M | Mute |

## How to run

```sh
node serve.ts            # serves game/ on http://localhost:8080
```

Then open http://localhost:8080 in a desktop browser. Everything runs offline from `game/`;
progress (cash, story, position, stats) is kept in `localStorage`.

For the make.fun hand-in, `node main.ts` copies `game/` and `screenshots/` to the output
directory and writes `dossier.json` with the vendored library.

## Architecture

- `game/src/config.js` — every tuning number: city grid, car types, heat/police/bust tuning,
  districts, businesses, radio stations, palette.
- `game/src/city.js` — procedural city generation (buildings, specials, pier, docks, props).
- `game/src/world.js` — the simulation: player, cars and traffic AI, pedestrians, police and
  officers, crimes and heat, busts, pickups, taxi fares, particles. Fixed step of 1/60 s,
  driven by one seeded mulberry32 stream, so a seed always replays the same city.
- `game/src/missions.js` — Faro's five-mission story chain plus the taxi loop.
- `game/src/render.js` — canvas renderer: day/night light pass, soft shadows, HUD, minimap,
  title / pause / busted / wasted screens.
- `game/src/audio.js` — a fully guarded WebAudio synth (engine, siren, shots, jingles); it
  stays silent and harmless until a user gesture unlocks audio.
- `game/src/shots.js` — the screenshot scenes behind `?shot=start|play|chase|end&seed=N`:
  autopilots play the real simulation into each frame, so the covers are honest gameplay.
- `game/src/main.js` — boot, the live loop, menus, pause and saving.

## Bounty

This entry was built for the make.fun bounty
[gta6-01](https://make.fun/bounty/gta6-01): the most complete open-world crime
game that fits in static browser files, with every name, place, vehicle and line of story
original to Palmira.

## License

MIT — see `LICENSE`.
