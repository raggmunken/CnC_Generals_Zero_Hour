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

## Status

Phase A complete and verified: sim, transport, renderer, selection and movement
all work end to end in a real browser.

Next: economy and construction (B), combat and fog of war (C), AI opponent plus
self-play harness (D), lobby and teams (E).
