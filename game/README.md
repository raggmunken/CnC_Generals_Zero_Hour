# Browser RTS

A small Generals-flavoured real-time strategy game that runs natively in a
browser. No streaming, no Wine, no GPU on the server: the server simulates, the
browser draws sprites.

## Run it

```sh
cd game
npm install
npm run build          # bundle the client
npm run server         # serve it and run the match
```

Open <http://localhost:8090>. Open a second tab to join as another player.

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

## Status

Phases A and B complete and verified end to end in a real browser: simulation,
transport, rendering, selection, movement, construction, production queues,
power and the tech tree.

Next: combat and fog of war (C), AI opponent plus self-play harness (D), lobby
and teams (E).
