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
generals.exe -smartAI
```

Off by default. The stock opponent stays the reference point, so A/B comparison
is a single flag rather than two builds.

## Building

The `.dsp` is updated for the VS6 project in this tree. If you are building
against [GeneralsGameCode](https://github.com/TheSuperHackers/GeneralsGameCode)
(recommended — VS2022/C++20, Windows and Linux) or a
[GeneralsX](https://github.com/fbraz3/GeneralsX) fork, confirm whether its
CMakeLists globs `Source/GameLogic/AI/*.cpp` or lists sources explicitly, and
add the two new `.cpp` files if the latter.

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

## Known gap: headless batch evaluation

Tuning the above by hand is guesswork without a way to run many games fast. The
engine has the capability but the flag is gated:

- `-noDraw`'s body sits inside `#ifdef DEBUG_CRC` (`CommandLine.cpp`), so it is
  a no-op in a release build.
- `-jumpToFrame N` sets `m_noDraw` unconditionally and also disables the FPS
  limit — the usable fast-forward route in any build.

Un-gating `parseNoDraw` is a one-line change and is the next piece of work: an
evaluation harness that runs N games of smart-vs-stock and reports win rate is
what turns AI tuning from vibes into measurement. It is also the same
infrastructure self-play needs later.

## Roadmap

**Tier 1 (this change)** — enemy model, counter-composition scoring, toggle.

**Tier 1.5** — headless eval harness; baseline the stock AI, then measure.

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
