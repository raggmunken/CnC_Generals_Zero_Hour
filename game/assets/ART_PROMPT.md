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
| **Units and buildings in neutral greyscale** | They are tinted per player at runtime. Any colour you bake in fights the tint and every faction ends up muddy. The importer desaturates anyway, so a slight cast is survivable — a strong one loses detail |
| **No background** behind units, buildings and overlays | They are composited over terrain. Real alpha is ideal, but a painted transparency checkerboard is fine — the importer keys it out |
| **Terrain fully opaque and seamlessly tileable** | Terrain tiles repeat edge to edge across the whole map |
| **Light from the top-left**, consistently | Sprites sit next to each other; mismatched lighting reads as broken before anyone can say why |
| **Readable silhouette at 24 pixels** | That is roughly the on-screen size at normal zoom. Fine detail disappears; shape is all that survives |
| **Vehicles and infantry face DOWN (+Y)** | The renderer rotates sprites by heading from that baseline |
| **Square cell, subject centred**, small margin | The renderer scales each cell to the unit's real footprint. Any square cell size works — the importer rescales to 128×128 and re-centres |

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

Do not hand-clean the sheet. Run the importer:

```
pip install numpy scipy Pillow          # once
python3 tools/import-sheet.py assets/generated-sheet.png
npm run art:guide                       # relabel the reference to match
npm run build && npm run server
npm run art:shot                        # look at it in the actual game
```

It takes any 8×3 grid of square cells and does the things an image model will
not do reliably:

- **Keys out the painted checkerboard**, including inside enclosed shapes like
  the selection ring, and the flat grey patches where the generator blurred it.
  It floods only through territory it is sure is background, so a gun barrel
  the same grey as a checker square survives instead of being eaten.
- **Forces units and buildings to neutral greyscale** and lifts them, because
  the renderer multiplies by the player colour and 40% grey times a mid red is
  nearly black.
- **Rescales and re-centres** every sprite in its cell, so a 3×3 building and a
  1×1 turret both fill their cell and the engine's footprint scaling is the
  only thing deciding on-screen size.
- **Makes terrain wrap**, by rolling the seam into the interior and healing it
  against its own mirror. Ungated, a tile repeats a hard edge every 24 pixels.
- **Premultiplies the downscale**, so edges do not pick up a grey fringe.

It writes `client/public/sprites.png` and a keying check to
`/tmp/sheet-check.png` — background shows as magenta there, so anything it
missed is obvious. Look at that before looking at the game.

`atlas.json` maps cells by position, so nothing needs recompiling to reskin. If
the sheet is missing or fails to load the renderer falls back to primitive
shapes: a broken file shows up as plain circles rather than an error.

Replacing one cell rather than the sheet? Paste it into
`assets/generated-sheet.png` at that cell and re-run the importer.
