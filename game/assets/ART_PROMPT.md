# Art brief — generating a new sprite sheet

Two prompts below. **Use the per-cell one.** Image models are unreliable at
holding an exact grid across a large sheet, and one bad cell means
regenerating everything; per-cell you regenerate only what failed, and the
style stays consistent because each prompt carries the same style block.

Attach `atlas-guide.png` (the labelled reference) with either prompt.

---

## Non-negotiables

These are what make the art *work in the engine* rather than merely look good.
Any of them broken means the sprite is unusable regardless of quality.

| Rule | Why |
|---|---|
| **Top-down orthographic** — straight overhead, no perspective, no isometric, no 3/4 view | The camera is a flat overhead 2D view. A 3/4 sprite will look wrong the moment it sits next to terrain |
| **Units and buildings in neutral greyscale** | They are tinted per player at runtime. Any colour you bake in fights the tint and every faction ends up muddy |
| **Transparent background** on units, buildings and overlays | They are composited over terrain |
| **Terrain fully opaque and seamlessly tileable** | Terrain tiles repeat edge to edge across the whole map |
| **Light from the top-left**, consistently | Sprites sit next to each other; mismatched lighting reads as broken before anyone can say why |
| **Readable silhouette at 24 pixels** | That is roughly the on-screen size at normal zoom. Fine detail disappears; shape is all that survives |
| **Vehicles and infantry face DOWN (+Y)** | The renderer rotates sprites by heading from that baseline |
| **Square 128×128 cell, subject centred**, small margin | The renderer scales each cell to the unit's real footprint |

Keep the palette restrained. This reads as a military strategy game: greys,
gunmetal, olive, rust. Saturated colour belongs to the faction tint, not the art.

---

## Prompt A — per cell (recommended)

Paste this once per sprite, replacing the SUBJECT line.

```
Top-down orthographic game sprite for a 2D real-time strategy game, viewed
straight from above with no perspective and no isometric angle.

SUBJECT: <see the table below>

Style: clean, readable, slightly stylised military hardware. Restrained palette
of greys and gunmetal — NEUTRAL GREYSCALE ONLY, no coloured markings, because
the engine tints these per player at runtime. Consistent light source from the
top-left with soft shadow to the bottom-right. Crisp edges, no motion blur, no
glow, no text, no labels, no drop shadow outside the silhouette.

Composition: single subject centred on a square 128x128 canvas with a small
even margin. Fully transparent background. The subject must face DOWN toward
the bottom of the image.

Critical: the silhouette must stay instantly recognisable when scaled to 24x24
pixels. Favour bold distinct shape over surface detail.
```

### Subjects

**Buildings** — flat-roofed structures seen from directly above; the roof is
most of what you see. Footprint in brackets is the in-game size.

| Cell | SUBJECT line |
|---|---|
| `building.command_center` | a large square military headquarters building, flat roof with a central command mast and rooftop vents (3×3) |
| `building.power_plant` | a compact power station, flat roof with cooling units and cable runs (2×2) |
| `building.supply_center` | a supply depot with a wide loading bay opening on one side and stacked crates on the roof (3×3) |
| `building.barracks` | an infantry barracks, long low roof with a parade entrance and rooftop skylights (2×2) |
| `building.war_factory` | a heavy vehicle factory, large roof with a wide vehicle door and gantry crane rails (3×3) |
| `building.gun_turret` | a small sandbagged machine-gun nest with a short twin barrel (1×1) |
| `building.cannon_turret` | a squat armoured tower with one long heavy cannon barrel (1×1) |
| `building.aa_turret` | a small anti-aircraft battery with twin barrels angled upward and a radar dish (1×1) |

**Units** — seen from directly above, facing down.

| Cell | SUBJECT line |
|---|---|
| `unit.dozer` | a construction bulldozer with a wide front blade and an exposed cab |
| `unit.harvester` | a bulky mining harvester with a front collection scoop and a heavy ore hopper |
| `unit.infantry` | a single soldier from directly overhead: helmet, shoulders and a rifle held across the body |
| `unit.rocket` | a single soldier from directly overhead carrying a shoulder-launched rocket tube |
| `unit.tank` | a main battle tank, two tracks either side of a boxy hull, rotating turret and a long gun barrel |
| `unit.aa_vehicle` | a light wheeled anti-aircraft vehicle with a twin-barrel turret angled upward |
| `unit.artillery` | a tracked self-propelled artillery piece with a very long barrel and rear stabiliser spades |

**Terrain** — these are the exceptions to two rules: fully opaque, and colour
is allowed since terrain is never tinted. Must tile seamlessly.

| Cell | SUBJECT line |
|---|---|
| `terrain.ground` | a seamless tileable top-down patch of dry grassland and dirt, muted olive green, opaque, no transparency |
| `terrain.rough` | a seamless tileable top-down patch of broken scrubland with loose stones, dusty khaki, opaque |
| `terrain.water` | a seamless tileable top-down patch of calm water, deep blue with subtle ripples, opaque |
| `terrain.mountain` | a seamless tileable top-down patch of bare grey rock and scree, opaque |
| `terrain.trees` | a seamless tileable top-down patch of dense dark green forest canopy, opaque |

**Overlays** — UI marks, not world objects. Flat, no lighting, transparent.

| Cell | SUBJECT line |
|---|---|
| `overlay.supply` | a flat top-down pile of golden ore chunks, warm yellow, simple and graphic |
| `overlay.selection` | a thin clean white circular selection ring, flat, no fill, no shading |
| `overlay.rally` | a simple bright green rally waypoint marker: a circle with a vertical line through it, flat |

---

## Prompt B — whole sheet in one go

Only worth trying with a model that holds a strict grid. Expect to fall back to
Prompt A for individual cells.

```
Generate a single 1024x384 pixel sprite sheet for a top-down 2D real-time
strategy game, laid out as an exact 8-column by 3-row grid of 128x128 cells
with no gaps, no gutters, no borders and no labels.

Every sprite is drawn top-down orthographic — straight from above, no
perspective, no isometric angle. Units and buildings are NEUTRAL GREYSCALE with
no coloured markings, because the engine tints them per player at runtime.
Background fully transparent except the terrain cells, which are opaque and
must tile seamlessly. Light comes from the top-left throughout. Vehicles and
infantry face DOWN. Every silhouette must stay readable at 24x24 pixels.

Cells in reading order, left to right then top to bottom:

Row 1: grassland terrain; scrubland terrain; water terrain; rock terrain;
forest canopy terrain; command headquarters building (3x3); power plant (2x2);
supply depot with loading bay (3x3)

Row 2: infantry barracks (2x2); vehicle war factory (3x3); sandbagged
machine-gun nest; armoured cannon tower; anti-aircraft battery with radar;
construction bulldozer; mining harvester with front scoop; rifle soldier seen
from overhead

Row 3: rocket soldier seen from overhead; main battle tank with tracks and
turret; light anti-aircraft vehicle; self-propelled artillery with long barrel;
pile of golden ore; thin white circular selection ring; green rally waypoint
marker

No text, no labels, no numbers, no borders anywhere in the image.
```

---

## Putting new art in

Save as `game/client/public/sprites.png`, same 1024×384 grid. Nothing else
changes — `atlas.json` maps cells by position, so the game picks it up on
reload with no code change and no rebuild of the sheet.

Doing individual cells instead? Composite them into the grid at the coordinates
in `atlas.json`, or replace them in the existing sheet in any image editor.

Check it with `npm run build && npm run server`. If the sheet is missing or
fails to load the renderer falls back to primitive shapes, so a broken file
shows up as plain circles rather than an error.
