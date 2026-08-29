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

Claude: Added fog of war. Filtering is server-side, not a renderer effect — a
modified client must not be able to see through it. The server sends each
player only the units they can see, plus *remembered* enemy buildings, because
buildings do not walk away and every RTS lets you keep seeing a scouted base.
Units get no such memory: an army you cannot see is genuinely gone.

Claude: The client rasterises fog from the vision circles the server sends
rather than receiving a bitmap — a 112x112 grid at 15Hz is far more bandwidth
than a handful of positions. Fog rectangles are merged into row runs before
drawing; a 96x96 map is over nine thousand tiles and one rect each would cost
more than the rest of the frame.

Claude: `Sim.visionSources()` is now the single definition of sight, used by
both the AI's enemy model and the snapshot filter. Two definitions would drift
and the AI would quietly end up seeing more than a human in its position.
`AIPlayer.intel()` exposes what the AI believes, so "fog-respecting" is tested
rather than claimed: it stays blind to a distant enemy and learns the moment
one walks into sight.

Claude: Added splash damage (linear falloff to a floor fraction) and used it to
give weapons real identities. Splash hits enemies only — friendly fire is a
genuine mechanic but it needs an AI that understands it, and an AI that shells
its own army is worse than no splash at all.

Claude: Three defence structures now counter different things, which is the
"defence 1 beats X, defence 2 beats Y" the design asked for, and it is
measured: a Gun Nest clears six riflemen in 160 ticks where a Cannon Tower
takes 663, and a Cannon Tower kills two tanks in 429 ticks where a Gun Nest
*never* can. Added Artillery: long range, heavy splash, helpless if reached.

Claude: ISSUE FOUND AND FIXED — the browser end-to-end tests observed the world
through a second WebSocket. Fog broke that, correctly: a fresh connection joins
as a different player who can only see their own units. The tests now read the
client's own received view via a `window.__rts` debug hook, which is the more
honest check anyway since it verifies what a player actually receives.

Claude: Generated `game/assets/atlas.png` and `atlas.json` — every terrain,
building, unit and overlay in one labelled grid with footprints and costs, for
redrawing. Honest caveat: the placeholder art repeats. All eight buildings
share one shape, and units share three between them. The grid, labels and
manifest are the real deliverable; the pictures are a starting point.

Claude: Gameplay audit now at **37 working, 0 broken, 6 not implemented**.
Remaining gaps: aircraft (armour class, flak and AA battery all exist, nothing
flies yet), lobby UI, save/replays, sound, veterancy/stealth, and the atlas is
not yet wired into the renderer.

Claude: Wired the sprite atlas into the renderer. Split the one sheet into two
outputs, because they serve different readers: `client/public/sprites.png` is
what the game loads (clean grid, transparent, no labels, drawn neutral grey so
one sheet tints to every player colour) and `assets/atlas-guide.png` is the
labelled reference a human uses to decide what to draw. The renderer falls back
to primitive shapes if the sheet is absent, so the game stays playable while
art is being replaced.

Claude: Sprites are pooled by entity id rather than recreated per frame --
churning display objects every frame is the standard way to make a 2D renderer
stutter. Units are drawn deliberately larger than their collision radius:
sizing a sprite exactly to its footprint makes infantry unreadable at normal
zoom, and readability beats physical honesty here.

Claude: Added a minimap (terrain painted once offscreen, fog and units redrawn
on snapshots rather than per frame, click to jump, viewport rectangle) and
control groups (Ctrl+1-9 assign, 1-9 recall, skipping units that have since
died rather than selecting ghosts).

Claude: ISSUE FOUND AND FIXED — the hint bar sat behind the minimap and was
unreadable. Offset it past the minimap width.

Claude: The control-group end-to-end test was flaky where I first put it: by
the end of the run the units have been ordered across the map and may be off
screen, so re-selecting them fails for reasons unrelated to control groups.
Moved it to immediately after the first known-good selection.

Claude: Audit now 37 working, 0 broken, 5 not implemented. Remaining: aircraft
(deferred by the user), lobby UI, save/replays, sound, veterancy/stealth.

Claude: Added a lobby. The server now builds matches through `startMatch()`
rather than at boot, so a restart constructs a whole new match object instead
of mutating the old one — stale bots ticking a dead simulation is the kind of
bug that only surfaces as inexplicable behaviour three games later.

Claude: ISSUE FOUND AND FIXED — the WebSocket close handler deleted the player
id captured when the socket connected. A lobby restart re-seats everyone, so
that id may since have been reassigned, and a leaver would have freed somebody
else's slot. It now looks the socket up instead.

Claude: The lobby caps bot choices at players-1. Offering a count the server
would silently clamp is worse than not offering it, because the player cannot
tell whether their choice took effect. Any player may restart: this is a game
for you and people you invited, so host privileges would be ceremony.

Claude: A welcome message can now arrive mid-session, so the client drops
everything carried over from the previous match — selection, control groups,
placement mode, fog, remembered buildings.

Claude: Audit now 37 working, 0 broken, 4 not implemented. Remaining: aircraft
(deferred by the user), save/replays, sound, veterancy/stealth.

Claude: You sent back generated art for the whole sheet — good art, but with
the transparency checkerboard *painted into the image* rather than written as
an alpha channel. That is the normal failure mode: image models draw the
pattern they have seen in reference screenshots. Wrote `tools/import-sheet.py`
to key it out rather than asking for a regeneration, because the regeneration
would come back the same way.

Claude: MEASURED — the keying is harder than "delete the two checker greys".
Findings, so nobody redoes this search:
  - The checkerboard is NOT on a global parity grid. I fitted period and offset
    against pixels I was certain were background; best agreement was 0.39,
    i.e. no better than chance. The sheet was upscaled non-uniformly. Any
    approach that computes an expected tone from (x, y) is dead.
  - Matching the two exact tones (185 and 127) is not enough either. The upscale
    left soft 2px transitions on every checker boundary, and those intermediate
    greys are ~14% of the background.
  - Flooding through all mid-greys instead fixes that, but then the flood runs
    down the cannon turret's barrel — same grey as a checker square — and eats
    it. Gating the flood on "the neighbourhood is mostly checker tone" fixes the
    barrel and breaks connectivity elsewhere.
  - What worked: flood through mid-grey, but only where the neighbourhood is
    mostly checker tone OR the pixel is perfectly neutral. The drawn art is
    olive-tinted (blue channel below the others); the generator's background is
    exactly neutral. That one channel difference separates them.

Claude: ISSUE FOUND AND FIXED — `tools/atlas.ts` wrote its primitive
placeholder art straight to `client/public/sprites.png`. With real art in that
slot, one stray `npm run atlas` would have destroyed it with no warning. It now
writes to `assets/placeholder-sheet.png`.

Claude: The importer also normalises scale and centring per cell, forces
neutral greyscale, lifts brightness, and makes the terrain tiles wrap. The
brightness lift is not cosmetic: the renderer multiplies sprites by the player
colour, and the generated art sits around 40% grey, which times a mid red is
nearly black. Lightened `PLAYER_COLOR` for the same reason — a saturated
mid-tone tint crushes every panel line on a vehicle into one flat mass.

Claude: ISSUE FOUND AND FIXED — the renderer had never used the terrain cells
of the atlas at all. It filled flat colour rectangles, so five painted terrain
textures sat in the sheet doing nothing. Terrain is now composited once into a
single texture on an offscreen canvas: a sprite per tile would be ~12,500
display objects on a 112x112 map, for an image that never changes after the
match starts. Supply piles use the ore sprite for the same reason.

Claude: Units now turn to face where they are going. The server sends no
heading and does not need to — the art all faces down, so the client derives
the angle from the unit's own motion between frames, with a threshold so a
stationary unit does not spin on interpolation jitter.

Claude: Added `tools/guide.ts`. The old guide was drawn by the placeholder
generator, so it described the placeholders forever. This one reads whichever
sheet is actually installed, which is the only way the brief in
`assets/ART_PROMPT.md` stays true as the art is replaced.

Claude: ISSUE FOUND, NOT YET FIXED — `test/e2e.ts` is flaky. Three consecutive
runs failed on different assertions (building placement, then attack-move, then
two others) with no code change between them. The art work did not cause this;
a PNG cannot. But a gate that fails differently each run is not a gate, and it
needs a look before it is trusted again.

Claude: You asked to see a unit's range when it is selected, and to be able to
select more units at once. Both done.

Claude: Range rings are drawn from the same `weapon.range` the server fires
with, so the ring is the real engagement distance rather than a drawing of one.
They go *under* the units: a big selection drawn over its own army buries it.
Alpha falls off with the number of rings — forty overlapping circles at
readable strength is a white disc, and what you want from a large selection is
the shape of its coverage, not any one unit's ring. A dozer or harvester has no
weapon and so gets no ring, which is itself information.

Claude: Selection now has the idioms that were missing: double-click takes
every unit of that type on screen (ctrl widens it to the whole map),
Ctrl+A takes everything you own, E takes combat units only — the army without
the dozers and harvesters, which is what "select everything" usually means.
Shift+click on an already-selected unit now removes it; additive-only shift
meant a misclick could only be undone by starting the selection over. Box
select now takes a unit whose body overlaps the box rather than requiring its
centre inside, which at low zoom is several pixels of slack.

Claude: Selected units use the drawn selection ring from the atlas instead of a
filled white disc. The disc was from the placeholder era: at the sprite sizes
the real art uses, a disc big enough to see is big enough to hide the unit
standing on it.

Claude: FIXED — the flaky e2e from the previous entry. Both failures were the
same root cause: the test used fixed screen pixels, and where the camera sits
depends on which start position the player drew from the circle. So "place a
building at (700,300)" could land in water or on a supply pile, and the box
drag that was meant to select the army could come up empty once the units had
walked off screen. Placement now tries a handful of spots — the check is that a
building *can* be placed, so it is allowed to look for somewhere to put one —
and the selection step uses Ctrl+A, which does not care where the camera is.
Six consecutive green runs, where before three runs failed three different
ways.

Claude: MEASURED, and worth knowing before chasing a ghost: e2e runs cannot
overlap. Two runs against the same server join the same match, take each
other's player slots and fail on unit counts and box selection. One failure I
saw was entirely self-inflicted by running the suite in parallel with itself.
Run it sequentially.

Claude: ISSUE FOUND AND FIXED — the first version of the range test read its
numbers off `window.__rts`, which the snapshot handler replaces wholesale 15
times a second, so anything the frame loop wrote there was raced away and read
back as zero. Per-frame view state now lives on its own `__rtsView` hook.

Claude: PRESENTATION AND FEEL PASS. The game played correctly and looked like
a proof of concept, so this round was all client-side: nothing in the sim or
the protocol changed, and every effect below is derived from data the client
already had.

Terrain stopped reading as a grid. The bake now does three deterministic
passes after compositing tiles: quarter-tile brightness jitter (per-tile
jitter correlated with the grid and read as checkerboard — the first version
did exactly that, and the fix was finer grain at lower amplitude), seam
gradients that bleed each neighbour's colour across shared edges, and a
shoreline treatment wherever water meets land — sand band on the land side,
shallow tint on the water side. That last one is the strongest single cue
that a river is a river and not a blue corridor.

Fog is a bitmap now, not nine thousand rectangles. One pixel per tile into a
canvas, upscaled with bilinear filtering: the feathered edge of vision falls
out of the upscale for free, where the rectangle pass stepped hard at every
tile boundary and cost more than the rest of the frame.

Everything casts a shadow. Units and buildings without shadows float over the
terrain; offset down-right so the light matches the art's up-left shading.
Buildings get a wide soft ellipse, units a tighter one.

Combat reads now. Shots flash at the muzzle and spark at the impact — the
tracer line alone read as a ruler. Deaths are detected, not sent: something
that vanishes from a tile you can see blew up, and fog is what makes that
sound — an enemy that walks out of sight disappears identically to one that
died, so explosions only spawn where the tile is currently visible (or for
your own units, which you always see). Buildings get the bigger boom.

Orders land somewhere. Move clicks drop a green ring that closes inward on
the point, attacks and attack-moves a red one with a cross. An order with no
visible consequence reads as an order that did not take.

The match ends on screen, not in the HUD. The server reports who is
eliminated; whether that means victory or defeat depends on teams, which only
the welcome message knows. Defeat shows the moment you are out; victory when
no opposing team has anything left, with a guard against "winning" a match
that has no opponents yet. Buttons for New Match and Keep Watching — a
defeated player in a friends game wants to spectate.

Input idioms filled in: hovering an enemy with an armed selection shows the
crosshair cursor; double-tapping a control-group number centres the camera on
the group; the HUD lists what you have selected ("Rifle Infantry x2, Dozer")
instead of a bare count.

Also fixed the test harness portability bug: e2e and the screenshot tool
hardcoded /opt/pw-browsers/chromium-1194/chrome-linux/chrome, and both the
revision directory and the chrome-linux vs chrome-linux64 subdirectory change
with Playwright releases. test/browser.ts now honours PW_CHROMIUM and scans
the cache roots for whatever is actually installed.

Verified: build clean, sim ALL PASS, audit still 37/0/4, e2e ALL PASS
including two new checks (order ping spawns, end screen stays hidden
mid-match). Screenshots compared against the pre-change captures.

Kimi: SOUND AND CONTROL DEPTH PASS. The audit's "sound: no audio at all" gap
is closed. The sim still sends no audio events; the client derives everything
from the snapshot data it already had, so the protocol grew exactly one field
(tracers now carry the weapon's damage type, which picks the firing sound).

Sound itself: an eight-sample pack (rifle, cannon, rocket, small and large
explosion, construction complete, harvest delivery, UI click), generated
rather than synthesized by hand, played through WebAudio. Three decisions
matter. First, the AudioContext is created on the first user gesture because
browsers refuse it earlier and every play before that is dropped, not queued.
Second, everything positional is attenuated by distance from the viewport
centre and silenced past a hearing range, so a battle across the map does not
drown the one in front of you. Third, every sound has a retrigger interval, a
voice cap, and a small random detune -- without that, forty rifles a second
phase into a tone. "Construction complete" and the harvest chime are
notifications, not positional: you are meant to hear them wherever the camera
is. M toggles mute and persists it. New samples are dropped, never queued.

Controls: S stops the selection (clears order, queue, path, and harvest job;
the unit still fires on anything in range -- stop is not a ceasefire). Shift
queues orders behind what a unit is already doing, capped at eight. The queue
is sim-side, not client-side: a queued attack that completes chains into the
next order even if the player has closed the tab. A plain order discards the
queue, which is what an RTS player expects a new command to mean.

MEASURED: queued orders only chain at real completion points (arrival for
move/attack-move, target destroyed for attack). Units arriving at a queued
waypoint re-path through applyOrder, so obstacles on leg two route around
exactly as a fresh order would.

Verified: build clean; sim ALL PASS including six new stop/queue checks;
audit 38/0/3 (sound moved out of the gap list, replaced by a pack-on-disk
check; e2e asserts the server actually serves all eight samples); e2e ALL
PASS, 23 checks, including the new S-stop check which compares only selected
units so a working harvester cannot fail it.

Kimi: CORRECTION TO THE SOUND ENTRY ABOVE -- the pack does not ship as mp3
files. They are base64-encoded into client/src/audio-data.ts (generated by
tools/encode-audio.ts), and AudioEngine decodes from there. Reason: the code
hosting path available for pushing mangles binary, and as a side benefit the
game needs no fetches before the first sound can play. The mp3s stay in
client/public/audio/ locally as the source of truth for regenerating; re-run
the encoder after replacing any sample. Tests updated accordingly: the audit
checks the embedded pack, e2e checks the client decodes all eight.

Kimi: CORRECTION #2 -- audio-data.ts is no longer one module. It is now an
index importing one module per sample from client/src/audio-pack/ (same
encoder, `npx tsx tools/encode-audio.ts`). Reason: a single ~100KB module has
single lines tens of thousands of characters long, which editors, diffs and
text-only transport all handle badly; per-sample files keep every payload
under ~27KB with no line over 140 chars. Same runtime shape: audio.ts still
imports AUDIO_B64 from audio-data.ts and the decoded bytes are identical.

Kimi: E2E ROOT CAUSE, NOT FLAKINESS -- the control-group check failed as
"recalled=2 of 3" and it was the game working: the default match runs with a
live bot (BOTS defaults to players-1), the bot's infantry reached the test
player's base mid-check and killed one of the grouped units, and recall
correctly skips the dead. The check now captures the assigned ids before
Ctrl+1 and compares the recall against the members still alive. Same pass
also relaxed two waits (recall 250->400ms, S-stop settle 300->500ms) because
decoding the sound pack adds real load on the first seconds of a run.
Verified: tsc clean, sim ALL PASS, audit 38/0/3, e2e ALL PASS (23 checks).

Kimi: MODERN UI PASS (user-approved "concept B"). The monospace-terminal look is
gone. The HUD is now glass chips (connection, credits, power with a low-power
warning state, units/selected, mode badge for ATTACK-MOVE/DEFEATED, and a
selection-summary chip), the build panel is a floating card list where every
entry carries the SAME sprite the map draws (icons cut from sprites.png via
atlas.json -- the panel teaches the real art instead of a parallel
iconography), locked entries show their requirement in red, NEW MATCH is a
green accent pill, the minimap sits in a framed glass card, and the hint bar
is a set of key chips rather than a wall of monospace text. Lobby and end
screen got the same glass treatment.

Two bugs found en route, both in main.ts's new icon loader: (1) the loader
originally ran before later module declarations were initialised -- a fast
fetch + top-level await meant the callback hit a temporal dead zone, silently
swallowed by its own .catch; the load now runs at the very end of the module.
(2) The build-list makeItem call site lost its iconKey argument in an edit,
so every icon rendered as an empty chip; found by inspecting the live DOM in
headless Chromium, not by reading the code.

e2e compatibility: the HUD textContent still contains the literal strings the
suite parses ("connected", "$3000", "units N", "selected N", "ATTACK-MOVE") --
the chips are spans whose textContent concatenates to the same text.

Verified: tsc clean; sim ALL PASS; audit 38/0/3; e2e ALL PASS (23 checks);
screenshots eyeballed (icons, chips, framed minimap all rendering).
