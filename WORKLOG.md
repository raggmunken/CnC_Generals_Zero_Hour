# Work log

An append-only conversation log for this project. **Never delete or rewrite
entries** — correct a mistake by adding a new entry that supersedes the old one,
so the reasoning trail stays intact.

Format is `Name: message`, newest at the bottom. Another Claude instance (or a
person) can append here to leave questions, corrections or instructions, and
whoever picks the project up next should read the tail of this file first.

---

Claude: Project started as "can we make a remastered web-based Command &
Conquer?" from EA's GPL source drop of Generals / Zero Hour. Explored several
routes and discarded most of them. Recording the reasoning because the discards
matter as much as the choice.

Claude: Route 1 — port the real engine to WASM. ~1.1M lines of 2003
Win32/DirectX 8 C++. The engine has a clean device seam (`GameEngine/` is
device-independent, `GameEngineDevice/` holds W3D/Win32/Miles), but the renderer
is fixed-function D3D8 funnelled through `dx8wrapper`. Months of renderer work
for no gameplay benefit. Rejected.

Claude: Route 2 — run the real game server-side and stream it to browsers. Got
a long way: built a Wine+DXVK container, a GStreamer `webrtcbin` streamer and a
browser client with RTS-correct input in `deploy/` and `web/`. Rejected Sunshine
as the primary path because it speaks NVIDIA GameStream, not WebRTC, so no
browser connects to it directly. This all still works and is still in the repo,
but it needs a GPU host, and every player needs a licence.

Claude: Along the way I improved the actual C&C AI in C++ (`AISmartSkirmishPlayer`,
`SkirmishEnemyModel`, `AIEvalHarness`) and got the full Zero Hour binary to link
via MinGW cross-compilation against TheSuperHackers/GeneralsGameCode. That work
is real and verified to link, but it is superseded — see the pivot below. Its
*design* is not superseded and fed directly into the new AI.

Claude: Key finding from reading EA's source, which shaped everything after:
`AIPlayer::selectTeamToBuild()` collects every buildable team, keeps those at
the highest script-authored priority, then picks one with
`GameLogicRandomValue()`. `isAGoodIdeaToBuildTeam()` checks only affordability
and instance caps. **Nothing in `AIPlayer` stores what the opponent has.** The
stock AI is not a weak strategist; it has no strategist, and its difficulty
levels are resource multipliers rather than better play. Every AI decision in
this project is a reaction to that.

Claude: Route 3 (chosen) — build a small Generals-flavoured RTS that runs
natively in the browser. User asked for "simpler", base-game Generals rather
than Zero Hour, 2D top-down, our own balance numbers. This removes every
blocker at once: no GPU, no Wine, no streaming, no encoding latency, no
per-player licence. Server is a plain Node process; friends open a URL. Lives
in `game/`.

Claude: Architecture is server-authoritative with a dumb client, chosen over
lockstep deliberately. Lockstep needs bit-exact determinism across clients,
which in JavaScript means fixed-point maths and a permanent desync-hunting tax.
Bandwidth is the cheaper trade at these player counts, and an RTS tolerates the
command latency a shooter would not.

Claude: The simulation is kept completely free of I/O — `step()` advances the
world and does nothing else. That is what makes headless self-play possible,
and it is now demonstrated rather than promised: `test/selfplay.ts` runs full AI
matches in-process with no browser and no sockets.

Claude: Phases A and B done — sim, WebSocket transport, Pixi renderer with
interpolation, tile map, selection, movement, construction, tech tree, power,
harvester economy. All verified end to end in headless Chromium against the
real server, plus headless sim tests.

Claude: Phase C done — combat built on a damage-type by armour-type matrix,
added first rather than bolted on after per-unit numbers hardened. A zero entry
means genuinely cannot hit, and target acquisition reads the same table so a
tank never closes on an aircraft. The test that matters is not that the matrix
exists but that counters play out: for identical money, four rocket teams kill a
tank in 66 ticks where seven riflemen need 450.

Claude: Also in Phase C — footprints. Buildings are hard obstacles; units
separate rather than block, because hard unit-vs-unit blocking without a
pathfinder deadlocks a group at the first narrow gap. Map presets by player
count (2–6) with starts evenly spaced on a circle, and terrain that shapes the
fight: rivers with fords punched through them, oceans, mountains, forests.
Connectivity is repaired rather than left to chance — a map you cannot cross is
broken, not hard.

Claude: Added A* pathfinding. Direct steering was fine on an open field and
stopped being fine the moment mountains arrived. Grid A* with octile heuristic,
binary heap, no corner-cutting, plus a smoothing pass that drops redundant
waypoints — raw grid A* zigzags and reads as a unit that cannot decide where it
is going.

Claude: ISSUE FOUND AND FIXED — A* reasoned about tile centres and treated every
unit as a point, ignoring radius. A harvester of radius 0.55 sitting at x=40.50
against a building edge at x=40.0 clipped by 0.05, so its path routed straight
through a gap its body could not fit and it froze permanently. Fixed with a
radius-inflated grid: a unit wider than a tile cannot use tiles orthogonally
adjacent to an obstacle. Diagonals do not need inflating — the widest unit
(radius 0.6) overhangs an edge but never a corner.

Claude: ISSUE FOUND AND FIXED — the AI's build order counted only *completed*
buildings, so while its first Supply Center was under construction it counted
zero and bought a second one. It spent itself to $0, could never afford the
$700 harvester that would have paid for it, and sat frozen for the whole match.
This is why every self-play game was a draw in 0.1s. Build-order decisions now
count buildings under construction, only one structure goes up at a time, and
harvester money is reserved before structures.

Claude: Current state — AI opponent exists (`server/ai.ts`) with a decaying,
vision-limited enemy model. It only knows what its own units and buildings can
actually see. Difficulty changes think interval, attack threshold and harvester
target; it never changes how much money the AI is handed, because that is the
thing I criticised in the original.

Claude: OPEN — early self-play at N=4 games showed hard beating normal 4-0 but
hard vs easy at 2-2, which is suspicious. N=4 is far too small to conclude
anything (the Wilson intervals say so plainly) so I am running a larger series
before touching the tuning.

Claude: OPEN / KNOWN GAPS — no fog of war rendering (the AI respects vision but
the client draws everything); no lobby, so map and bot count come from env vars
(`PLAYERS`, `BOTS`, `DIFFICULTY`, `SEED`, `PORT`); balance is untuned first-guess
numbers and the economy is probably too fast; sprites exist in `game/tools/` but
are not yet wired into the renderer, which still draws coloured circles.

Claude: NOTE FOR WHOEVER IS NEXT — run `cd game && npm install && npm test`.
That runs headless sim tests then a browser end-to-end check. `GAMES=20 npx tsx
test/selfplay.ts` runs AI evaluation. Read `game/README.md` for the design
rationale; read this file's tail for what is currently broken.

Claude: Added an AI opponent (`server/ai.ts`) and a self-play harness
(`game/test/selfplay.ts`). The harness plays every map twice, once with each
side in each slot, because swapping sides across *different* maps only averages
over map bias rather than cancelling it. With the AI made deterministic (seeded
PRNG, not `Math.random`), a mirror match now settles to exactly 50% — which is
the harness checking itself. Every number below is only trustworthy because
that check passes.

Claude: ISSUE FOUND AND FIXED — the AI re-issued attack-move to its whole army
on every think. Each order recomputes a path and restarts the route, so a
faster-thinking AI churned its own army in place and never arrived. Orders are
now only issued to units that need one.

Claude: ISSUE FOUND AND FIXED — the army oscillated across the attack
threshold: cross it, attack, take losses, drop under, get recalled home,
rebuild, attack again. Added hysteresis (commit at the threshold, only
disengage below 35% of it). This moved hard-vs-easy from 34% [27%,41%] to
43% [35%,52%] over 120 games.

Claude: MEASURED, so nobody repeats the search. Attack threshold has no
detectable effect anywhere in 1200..4800. Raising `maxProduction` above 2 makes
the AI *weaker* — income is the bottleneck, not factory count, so extra
buildings drain money that should be army. Think-interval differences were
noise once the two bugs above were fixed. I also caught myself reading a
"BETTER" result off a 12-comparison ablation sweep at p≈0.04, which is exactly
what multiple testing produces; that result was noise and I discarded it.

Claude: HONEST STATUS ON DIFFICULTY — the tiers are only weakly differentiated.
easy/normal/hard do not form a clean strength ordering, and I could not make
them with constant-tuning alone. Making difficulty properly monotonic needs a
better AI, not better constants. The tiers are labelled as such in the code
rather than pretending otherwise. Notably none of them cheat: difficulty never
touches income, which is the thing I criticised in the original game.

Claude: Added `game/test/gameplay.ts`, a full feature audit that exercises each
mechanic a player would actually use and reports anything unimplemented as
MISSING rather than omitting it. Current result: **28 working, 0 broken, 7 not
implemented**. The AI plays a complete game — expands its base, runs an economy,
builds ~35 combat units and destroys an idle opponent.

Claude: Four "failures" in the first audit run were all bugs in my test
fixtures, not the game: production looked broken when it was merely browned out
and I had not waited long enough; a single rocket team "failing" to kill a tank
is the damage matrix working correctly, since a tank beats one rocket team; and
a turret would not place because I had not built its prerequisite barracks.
Worth recording because each looked like a real defect at first glance.

Claude: `npm test` now runs sim tests, the gameplay audit, then the browser
end-to-end check. `npm run selfplay` and `npm run ablate` are separate because
they take minutes, not seconds.
