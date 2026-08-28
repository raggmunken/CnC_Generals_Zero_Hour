# Browser RTS

A small Generals-flavoured real-time strategy game that runs natively in a
browser. No streaming, no Wine, no GPU on the server: the server simulates, the
browser draws sprites.

## Run it

```sh
cd game
npm install
npm run build                 # bundle the client
npm run server                # serve it and run the match

PLAYERS=4 npm run server      # pick the map by player count (2-6)
PORT=8000 npm run server      # pick the port
SEED=7 npm run server         # different map layout
```

Open <http://localhost:8090>. **Open a second tab to join as another player** --
there is no AI opponent yet, so a second tab is currently the only way to have
an enemy.

`npm test` runs the end-to-end check: it drives the real client in a real
browser against the real server and asserts that a click actually moves a unit
on the server.

## Layout

| Path | What |
|---|---|
| `shared/` | Types, unit definitions, wire protocol |
| `server/sim.ts` | The authoritative simulation. No I/O — so it is testable, and self-play can run it headless in a loop |
| `server/mapgen.ts` | Deterministic seeded map generation |
| `server/index.ts` | HTTP + WebSocket, one match per process |
| `client/` | Pixi renderer, input, interpolation |
| `test/e2e.ts` | The Phase A gate |

## Design notes

**Server-authoritative, not lockstep.** Lockstep needs bit-exact determinism
across clients, which in JavaScript means fixed-point maths and a permanent
desync-hunting tax. This spends bandwidth instead, which is cheap at these
player counts, and an RTS tolerates the command latency a shooter would not.

**The client never simulates.** It renders the last two snapshots with
interpolation, which is what makes a 15Hz sim look smooth.

**Ownership is checked in the sim**, not at the transport layer, so a malformed
or hostile client cannot move somebody else's army.

## Build system

Shaped like Generals: a command centre unlocks the tree, power is a real
constraint, infantry and vehicles are split across two production buildings.
The numbers are ours.

| Building | Cost | Power | Needs | Produces |
|---|---|---|---|---|
| Command Center | 2000 | 0 | — | Dozer |
| Power Plant | 800 | +10 | Command Center | — |
| Supply Center | 1500 | -2 | Command Center | Harvester |
| Barracks | 700 | -2 | Command Center | Infantry, Rocket Infantry |
| War Factory | 2000 | -5 | Barracks | Battle Tank, AA Vehicle |
| Defense Turret | 900 | -3 | Barracks | — |

Unavailable entries stay visible but disabled with the reason ("needs
Barracks"). Hiding them would make the tech tree impossible to learn.

Drawing more power than you produce halves production rather than stopping it.
Generals stops dead, which punishes without teaching; halving makes the mistake
obvious and still recoverable.

All of it lives in `shared/content.ts` -- balance is a data edit, never a code
edit.

## Maps

Sized by player count, so the distance between neighbouring bases -- and so
rush timing -- stays roughly constant as the lobby grows.

| Players | Size | Name |
|---|---|---|
| 2 | 64x64 | Duel |
| 3 | 80x80 | Three-Way |
| 4 | 96x96 | Crossroads |
| 5 | 104x104 | Five Points |
| 6 | 112x112 | Six Corners |

Starts are evenly spaced around a circle, which generalises to any count.
Terrain is generated to shape the fight: **rivers** split the map with a
couple of fords punched through them, so they become chokepoints rather than
walls; **oceans** wall off an edge or two; **mountains** and **forests** are
impassable masses to path around, and both block line of sight. Rough ground
is passable but slow.

Generated obstacles can trivially wall a start off, so connectivity is
repaired rather than left to chance: every start is verified reachable from
every other, and a corridor is carved if not. That is checked for all five
presets in `npm test`.

## Combat

Damage resolves through a damage-type by armour-type matrix in
`shared/content.ts`. A zero means genuinely cannot hit -- and target
acquisition reads the same table, so a tank never closes on an aircraft it
could not hurt.

| damage / armour | infantry | light | heavy | structure | air |
|---|---|---|---|---|---|
| gun | 1.00 | 0.50 | 0.25 | 0.25 | 0.30 |
| cannon | 0.50 | 1.00 | 1.00 | 0.80 | 0.00 |
| rocket | 0.40 | 1.25 | 1.50 | 1.00 | 0.50 |
| flak | 0.60 | 0.50 | 0.20 | 0.20 | 1.50 |
| explosive | 1.25 | 0.80 | 0.60 | 1.50 | 0.00 |

For identical money, four rocket teams kill a tank in 66 ticks where seven
riflemen need 450 -- the counters come out of the data, and `npm test` asserts
that gap rather than trusting the table.

Buildings are hard obstacles; units separate rather than block, because hard
unit-versus-unit blocking without a pathfinder deadlocks a group at the first
narrow gap.

## Economy

Supply piles sit two per base and three in a contested centre, which is what
gives the map an early game and a mid game. Harvesters work automatically --
seek, gather, return, unload -- because babysitting them is busywork, not
strategy. A direct move order takes one off automatic so it stays where you
sent it.

Piles deplete, and their drawn radius tracks what is left, so the map reads its
own economy without a UI overlay.

## Art

`client/public/sprites.png` is the sheet the game loads, with
`client/public/atlas.json` mapping keys to cells. Sprites are drawn neutral grey
and tinted per player at runtime, so one sheet serves every faction.

`assets/atlas-guide.png` is the human-facing reference: the same cells labelled
with name, footprint and cost. Redraw cells in `sprites.png` on the same grid
and the game picks them up -- no code change. Regenerate both with
`npx tsx tools/atlas.ts`.

The renderer falls back to primitive shapes if the sheet is missing, so the
game stays playable while the art is being replaced.

## Status

Phases A and B complete and verified: simulation, transport, rendering,
selection, movement, construction, production queues, power, the tech tree and
a working harvester economy.

`npm test` runs both suites -- headless simulation tests for the economy and
tech tree, then the browser end-to-end check.

Next: combat and fog of war (C), AI opponent plus self-play harness (D), lobby
and teams (E).
