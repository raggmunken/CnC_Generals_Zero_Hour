# Reactive Skirmish AI (Tier 1)

A drop-in replacement for the stock skirmish opponent that decides what to build
by looking at the game instead of rolling dice.

## Why

`AIPlayer::selectTeamToBuild()` in the shipped code does this:

1. Collect every team prototype that is currently *possible* to build.
2. Keep those at the highest `m_productionPriority` — a static integer typed
   into the map script by a level designer.
3. `GameLogicRandomValue( 0, count-1 )` — pick one at random.

`isAGoodIdeaToBuildTeam()`, despite the name, checks only four things: does the
script production condition pass, are we under the instance cap, are we already
building one, and can we afford it with a free factory. None of it consults the
game state.

Look at `AIPlayer`'s members and the picture completes: `m_baseCenter`,
`m_baseRadius`, supply-center tracking, bridge-repair state, two timers. There
is **no field anywhere holding what the enemy has, where they are, or what they
just did.** Base construction walks a fixed `BuildListInfo` in map order.
Production is gated on wall-clock timers rather than economy. Difficulty is
implemented as `Handicap` multipliers plus shorter timers — which is why Hard
feels like a cheating version of the same opponent rather than a better player.

The stock AI is not a weak strategist. It has no strategist. All actual strategy
was hand-authored per-map in script conditions.

## What this adds

Two new classes, both in the device-independent `GameEngine/GameLogic` layer:

### `SkirmishEnemyModel`

The missing half — a memory of what the opponent has been seen fielding.

- Sweeps the partition manager for enemy objects, bucketed into infantry,
  vehicle, aircraft, and structure.
- **Respects fog of war.** Observation runs through `PartitionFilterFreeOfFog`,
  so the resulting opponent is strong because it reacts, not because it cheats.
- Knowledge decays exponentially (45s half-life), so an army seen ten minutes
  ago stops driving decisions.
- Folds observations in with `max(remembered, observed)` rather than summing.
  Summing would double-count: seeing the same ten tanks on two consecutive ticks
  does not mean the enemy has twenty. Max means a fresh sighting supersedes
  stale memory, while memory survives when vision is lost.
- Tracks the centroid of seen enemy structures as a durable "where do they live"
  anchor.

### `AISmartSkirmishPlayer : public AISkirmishPlayer`

Overrides only the strategic layer. Pathfinding, unit state machines, group
movement and targeting — roughly 67,000 lines — are inherited untouched.

- `update()` ticks the enemy model on a 2-second cadence (the partition sweep is
  far too heavy for 30Hz), then runs the inherited update.
- `selectTeamToBuild()` replaces the random draw with a scored selection across
  *all* buildable teams, not just the top priority band. A well-countered team at
  priority 3 should beat a useless one at priority 5.
- `scoreTeam()` keeps the map-authored priority as a baseline prior — so scripted
  campaign maps still behave roughly as intended — and layers situational
  judgement on top.

The scoring currently handles the stock AI's most visible failure: it will
happily ignore an air force until it loses. `teamCanEngageAir()` resolves each
team member through `TheThingFactory` and inspects every weapon slot of every
weapon set for `WEAPON_ANTI_AIRBORNE_VEHICLE`.

## Files

```
GameEngine/Include/GameLogic/SkirmishEnemyModel.h
GameEngine/Source/GameLogic/AI/SkirmishEnemyModel.cpp
GameEngine/Include/GameLogic/AISmartSkirmishPlayer.h
GameEngine/Source/GameLogic/AI/AISmartSkirmishPlayer.cpp
GameEngine/Include/GameLogic/AIEvalHarness.h
GameEngine/Source/GameLogic/AI/AIEvalHarness.cpp
tools/ai_eval/run_eval.py
```

Wiring touched:

| File | Change |
|---|---|
| `Common/GlobalData.h/.cpp` | `m_useSmartAI` flag, defaults `FALSE` |
| `Common/CommandLine.cpp` | `parseSmartAI`, `-smartAI` table entry |
| `Common/RTS/Player.cpp` | `setPlayerType()` picks the smart AI when enabled |
| `Common/System/MemoryInit.cpp` | memory pool registration |
| `GameEngine/GameEngine.dsp` | new sources and headers |

## Enabling it

```
generals.exe -smartAI                 # every computer player uses it
generals.exe -smartAIPlayers 1,3      # only those player indices
```

Off by default. The stock opponent stays the reference point, so A/B comparison
is a flag rather than a second build.

`-smartAIPlayers` is what makes a proper experiment possible: smart and stock
can play *each other* inside one match, which is much stronger evidence than
comparing two separate runs against a third party.

## Building — verified recipe

**This has been compiled.** The three new translation units build clean (zero
warnings) against the real headers with a real toolchain. What follows is the
exact recipe that worked, not a guess.

### Native Linux does not work (yet)

Upstream [GeneralsGameCode](https://github.com/TheSuperHackers/GeneralsGameCode)
does **not** build the Zero Hour engine natively on Linux at present.
`Core/GameEngine/Include/Precompiled/PreRTS.h` unconditionally includes
`atlbase.h`, `windows.h`, `direct.h`, `imagehlp.h` and friends; the ATL compat
shim is gated on `defined(__GNUC__) && defined(_WIN32)`. The README's "Linux"
support means cross-compiling a *Windows* binary via MinGW in Docker, and
"Cross-Platform Support (Linux, macOS)" is listed as wanted-help rather than
done. Native ports live in the [GeneralsX](https://github.com/fbraz3/GeneralsX)
forks (SDL3 / DXVK / OpenAL).

### MinGW cross-compile (what was verified)

On Ubuntu 24.04:

```sh
apt-get update
apt-get install -y gcc-multilib g++-multilib \
                   g++-mingw-w64-i686 gcc-mingw-w64-i686 \
                   ninja-build wine64-tools    # wine64-tools provides widl

git clone --depth 1 https://github.com/TheSuperHackers/GeneralsGameCode.git
cd GeneralsGameCode
cmake --preset mingw-w64-i686
```

`wine64-tools` is the non-obvious one: the EABrowserDispatch COM component needs
an IDL compiler, and CMake hard-fails configure without it. The error message
suggests `wine-stable-dev`, which on 24.04 does not ship `widl`.

The result is a 32-bit Windows binary, runnable under Wine.

### Adding these files

The fork lists sources explicitly — it does **not** glob — so the three new
`.cpp` files must be added to
`GeneralsMD/Code/GameEngine/CMakeLists.txt` alongside the existing
`Source/GameLogic/AI/AISkirmishPlayer.cpp` entry:

```
    Source/GameLogic/AI/AIEvalHarness.cpp
    Source/GameLogic/AI/AISmartSkirmishPlayer.cpp
    Source/GameLogic/AI/SkirmishEnemyModel.cpp
```

### Where the wiring actually goes in the fork

The fork has been refactored since EA's drop: code shared between Generals and
Zero Hour now lives under `Core/`, compiled once per game as INTERFACE sources
into `g_gameengine` and `z_gameengine`. The wiring does **not** land at the
same paths as in this tree.

| Change | This tree | Fork |
|---|---|---|
| New fields | `GeneralsMD/.../Include/Common/GlobalData.h` | same path, **plus** `Generals/.../Include/Common/GlobalData.h` |
| Field init | `GeneralsMD/.../Source/Common/GlobalData.cpp` | same path, **plus** the `Generals/` copy |
| Flag parsing | `GeneralsMD/.../Source/Common/CommandLine.cpp` | `Core/GameEngine/Source/Common/CommandLine.cpp` |
| Memory pool | `GeneralsMD/.../Source/Common/System/MemoryInit.cpp` | `Core/GameEngine/Source/Common/System/GameMemoryInitPools_GeneralsMD.inl` |
| `setPlayerType` | `GeneralsMD/.../Source/Common/RTS/Player.cpp` | same path |
| Harness hooks | `GeneralsMD/.../Source/GameLogic/System/GameLogic.cpp` | same path |

`CommandLine.cpp` being shared is the one that bites: it is compiled for both
games, so the four `GlobalData` fields must exist in **both** `GlobalData.h`
files or the Generals build breaks. The AI classes themselves stay Zero Hour
only; Generals just carries four unread fields.

The new flags go in `paramsForEngineInit` **above** the `#if defined(RTS_DEBUG)`
block. Everything below it is debug-only, and batch evaluation runs against a
Release build.

### Do not port the `-noDraw` un-gate to the fork

The fork already has a first-class `-headless` mode (`MouseDummy`,
`GameWindowManagerDummy`, dummy audio/particles/view) in `paramsForStartup`,
unconditional in Release and exercised in upstream CI. Use that instead; the
un-gate below is redundant there and its `-noDraw` entry stays inside the
fork's `RTS_DEBUG` param block. `tools/ai_eval/run_eval.py` passes both flags,
so one command line works against either binary.

### Verified result

Against TheSuperHackers/GeneralsGameCode at `45178ee`, the **full Zero Hour
executable links** with all of the above applied:

```sh
cmake --preset mingw-w64-i686
cmake --build build/mingw-w64-i686 --target z_generals -j4
# -> build/mingw-w64-i686/GeneralsMD/generalszh.exe  (PE32, i386)
```

`nm` confirms `AISmartSkirmishPlayer::selectTeamToBuild()`,
`SkirmishEnemyModel::observe(Player*)` and `AIEvalHarness::update()` are in
`libz_gameengine.a`, that `Player.cpp.obj` carries an undefined reference to
`AISmartSkirmishPlayer::AISmartSkirmishPlayer(Player*)`, and that all five new
flag strings survive into the stripped binary. The three AI translation units
compile with zero warnings of their own.

The engine has **not been run** — no `.BIG` assets are available in that
environment — so nothing here is a claim about runtime behaviour.

The `.dsp` in this tree is also updated, but the VS6 project is not a realistic
build path for this work.

## Tuning

The knobs are all at the top of `AISmartSkirmishPlayer.cpp`, deliberately
grouped so they can be swept:

| Constant | Meaning |
|---|---|
| `MODEL_UPDATE_INTERVAL_SECONDS` | how often the map is swept |
| `PRIORITY_WEIGHT` | how much designer intent still counts |
| `AA_URGENCY_BONUS` | reward for answering an air force |
| `AA_WASTE_PENALTY` | penalty for AA nobody needs |
| `INFANTRY_MIRROR_BONUS` | reward for massing infantry into infantry |
| `BLIND_SCOUT_BONUS` | reward for map presence while blind |

`MEMORY_HALF_LIFE_SECONDS` in `SkirmishEnemyModel.cpp` sets how sharp the AI's
memory is.

Do not tune these by playing. Use the harness.

---

# Evaluation harness (Tier 1.5)

Tuning by hand is guesswork. This runs matches in bulk and reports whether a
change actually helped.

## Engine support

`AIEvalHarness` watches a running match, decides when it has resolved, appends
a machine-readable record, and quits. It hooks into `GameLogic::update()` right
after `TheVictoryConditions->UPDATE()` and is inert unless `-aiEval` names an
output file.

A contender is identified as a player who has built *something*, rather than by
player type — maps vary in how they declare neutral and civilian sides, but by
the time a match resolves the real participants have production on the board and
the scenery sides do not.

New flags:

| Flag | Effect |
|---|---|
| `-aiEval <file>` | append a match record to `<file>`, then quit |
| `-aiEvalMaxFrames N` | declare a draw after N logic frames |
| `-forceSkirmishAI` | use the skirmish AI on a map launched via `-file` |
| `-smartAIPlayers a,b` | per-player smart AI assignment |

`-noDraw` was previously a no-op: its body sat inside `#ifdef DEBUG_CRC`, so it
did nothing in a release build. It is now un-gated **in this tree**, since batch
evaluation needs renderless runs from a normal build and `m_noDraw` is only read
by the display path. (`-jumpToFrame N` also sets it, and remains the way to
fast-forward.) The fork does not need this change — it has `-headless`; see
"Do not port the `-noDraw` un-gate to the fork" above.

## Record format

Flat `key=value` text, one block per match — trivial to parse and safe to
concatenate across runs:

```
RESULT reason=victory endFrame=28744 map=... winner=1
PLAYER idx=1 name=PlyrAmerica ai=smart defeated=0 unitsBuilt=84 unitsLost=51 ...
PLAYER idx=2 name=PlyrChina   ai=stock defeated=1 unitsBuilt=79 unitsLost=88 ...
END
```

## Driver

```
tools/ai_eval/run_eval.py --exe ./generalszh \
    --map "Maps/Tournament Desert/Tournament Desert.map" \
    --games 40 --players 1,2
```

Two things it does that make the output mean something:

**Side swapping.** Each run alternates which slot gets the smart AI. On an
asymmetric map, starting position can matter more than AI quality; without
swapping you measure the map, not the bot.

**Interval estimates.** A 7-3 record over ten games is not evidence. The driver
reports Wilson score intervals and only calls a difference when they separate,
so a promising-looking gap does not get mistaken for a result.

Sample output:

```
AI        played    wins  winrate   95% interval
----------------------------------------------------------
smart         40      27    67.5%   [52.0%, 79.9%]
stock         40      13    32.5%   [20.1%, 48.0%]

=> smart AI is ahead; the intervals do not overlap.
```

Mean per-AI economy and production figures are printed too, which is usually
where you see *why* a change helped or hurt.

## Roadmap

**Tier 1 (this change)** — enemy model, counter-composition scoring, toggle.

**Tier 1.5 (done)** — headless eval harness with side swapping and interval
estimates.

**Tier 2** — deliberate scouting, expansion and map control, army-value-based
engage/retreat, per-faction build-order openings, superweapon targeting via the
existing `computeSuperweaponTarget()` virtual.

**Tier 3** — strategic layer above the bot. Because `AIPlayer::update()` is the
slow tick, a higher-latency planner can set posture every 20–30s while the C++
bot executes at frame rate.

**Tier 4 — self-play (the end goal)** — needs Tier 1.5's harness plus an
observation/action serialization layer. The `AIPlayer` virtual interface is the
natural action boundary, and `SkirmishEnemyModel` is most of the observation
already.
