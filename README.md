# Heaven's River Explorer: Build Spec for Claude Code

A browser-based, real-time three.js world where the player explores the Heaven's River topopolis (Bobiverse Book 4, Dennis E. Taylor) as a Quinlan. Visual and mood reference: https://valley.mengto.here.now/ ("Sakura River Valley": a real-time 3D mountain river valley at golden hour). Match its feel: atmospheric haze, warm low-angle light, a river as the visual spine, small handcrafted settlements, cinematic but performant.

## Running the explorer

This repository contains the spec below **and** its implementation (TypeScript, three.js, Vite; no backend, no downloaded assets: every model, texture and sound is generated in code).

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check, then a static site in dist/ (deployable anywhere)
npm run preview    # serve the production build
```

**GitHub Pages:** `.github/workflows/pages.yml` builds the site and publishes it on every push to `main`, at https://craigfoo.github.io/heavens-river/. Before the first deploy, set *Settings → Pages → Build and deployment → Source* to **GitHub Actions**.

A first visit plays the one-minute arrival sequence (skippable with Enter, Space, Escape or a tap) and hands over at a hillside maintenance hatch above the first river city at golden hour. Progress autosaves to `localStorage`; *Reset saved game* in the menu starts over. Add `?nointro` to the URL to untick the intro by default.

| Keyboard / mouse | Action |
|---|---|
| WASD or arrows, mouse | Move, look (click the view to capture the mouse) |
| Shift / Ctrl | Drop to all fours and run / walk slowly |
| Space / C | Jump, surface / dive when swimming |
| E | Interact: signposts, docks (hire a barge), murals, plaques, barrier tunnels |
| V | Quinlan vision: 270° panorama → independent eyes → normal |
| Q / E held + mouse | Steer the left / right eye in independent-eyes mode (tap to re-centre) |
| B | Bob mode: switch the hologram sky off and see the far side of the world |
| M / J | Map (float, travel or set a destination) / journal |
| T, Shift+T | Scrub the time of day forwards / backwards |
| Tab | Photo mode: free camera, depth of field, poses; Enter saves a PNG |
| Enter | Arrive now, while on a barge |
| H, F3 | Hide the hints, developer panel |
| Esc | Menu and settings |

Gamepad: left stick move, right stick look, A jump, B dive, LB/RB hold to steer each eye, click the left stick or hold LT to run, X interact, Y vision, Back map, Start menu, D-pad up Bob mode, D-pad down photo mode. On phones and tablets, drag on the left half to move and on the right half to look, and use the on-screen buttons.

How the code is organised, and the decisions taken on the spec's open questions, are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). This is a non-commercial fan project set in Dennis E. Taylor's *Bobiverse*; it is not affiliated with the author or his publishers.

---

## 1. Source canon (what the books and author actually say)

Primary source: Dennis E. Taylor, "Heaven's River: A Quick Description of the Megastructure" (dennisetaylor.org, Oct 2020) plus his answers in that post's comments. Secondary: Bobiverse Fandom wiki pages for Quinlan, Anek, Quin.

Note: there is **no official concept art**. Taylor has said he has no sketches of the Quinlans, and the book covers show only Bob ships. Everything visual below is derived from text.

### 1.1 The structure

| Property | Canon value | Notes |
|---|---|---|
| Type | Topopolis: an O'Neill cylinder stretched into a closed loop around a star | |
| Star / system | Eta Leporis; homeworld Quin is planet 2 (now dead, war-ravaged) | Topopolis orbits the star, not the planet |
| Total length | ~1 billion miles | |
| Loops | Wraps the star 3 times in "loose loops" | Author pointed to a (3,8) torus knot image as the best representation |
| Orbital distance | Blog says ~100 million miles; the math for 1B miles / 3 loops gives ~53 million | Treat as flexible, it is only seen from space |
| Inner cylinder radius | 56 miles (~90.1 km) | |
| Section length | 560 miles (~901 km) per section | Sections are like individual O'Neill cylinders joined together |
| Spin speed at surface | ~1,800 mph (~0.5 mi/s, ~805 m/s) | |
| Rotation period | "a bit more than ten minutes" | Derived: ~11.7 min |
| Pseudo-gravity | Not stated | Derived from radius and speed: ~7.2 m/s², about **0.73 g** |
| "Up" | Toward the central axis | The orbit cancels solar gravity for inhabitants |
| Light | Fusion-powered light source on a structure running down the central axis | |
| Sky illusion | A diffuse hologram hides the central shaft and the far side of the cylinder by day, and projects constellations at night | |
| Outer shell | Non-rotating shell of rock/friable material for meteor protection, separated from the spinning inner cylinder by magnetic bearings | |
| Section ends | Each section has a barrier at each end, disguised as mountains. The barrier can close off the end completely in a blowout | |
| Rivers | 4 main rivers per section, each flowing in alternating directions. They meander, with tributaries and feeder streams, to maximize shoreline (ideal Quinlan habitat) | |
| Terrain | Topography is formed into the shell itself (no dumped dirt). The hollow space under hills and mountains holds infrastructure, admin and maintenance centers | |
| Heat | Radiators on the dark side of the strand | |
| Access | 9 spaceports on the outer shell. "Spin Transfer" vehicles accelerate along a track inside the outer shell until they match the inner shell's speed, clamp on and dock, then an elevator descends to the surface | |
| Flex | The strand bends roughly 1 mile per million miles; no expansion joints needed | |
| Administrator | Anek (ANEC-23), the AI running the structure. Surveils using fusion-powered robotic birds. Uses hired Quinlan "Crew". Moves people between segments in "Scatterings" | |

Author's side note: Quinlans use a version of metric, so proportions were chosen deliberately. Section length is 10x the radius (560 = 10 x 56).

### 1.2 The Quinlans (the player)

- About 4 feet tall (~1.2 m), stocky, furry, short legs.
- Face like an otter but with a more beak-like mouth with teeth (the snout is called a "houra"). Author says Sid the Sloth from Ice Age is a good reference.
- Eyes set wide on the sides of the head, moving independently; they can see behind themselves without turning. A mid-food-chain species.
- Webbing between arms and torso; broad beaver-like tail. Exceptional swimmers.
- Faster on all fours, but also walk upright.
- Iron Age, agricultural, trade-based, capitalist. Coins called coppers and irons.
- Art everywhere: every building and object carries decoration; public spaces full of sculptures and murals.
- Great singers (can sing two melodies at once), poor dancers. Social, loud, quick to anger.
- Rubbing the jaw back and forth is their smile.
- Most use first names only; elites use surnames.

### 1.3 Visual references found

- Torus knot (3,8), endorsed by the author as closest to the loop layout: https://en.wikipedia.org/wiki/Torus_knot#/media/File:TorusKnot-3-8.png
- Isaac Arthur / SFIA topopolis video (fan-recommended): https://www.youtube.com/watch?v=tqs1iQlvV-g
- YD Visual (Ken York) on YouTube made 3D topopolis animations for SFIA's continent-sized habitats episode.
- Fan Bobiverse miniatures (includes creature sculpts): https://www.reddit.com/r/bobiverse/comments/me1pgw/bobiverse_miniatures_wip_feedback_wanted/

---

## 2. Experience goals

1. **Be a Quinlan.** Low eye height, wide field of view, move on 2 or 4 legs, swim like it's home.
2. **Feel the cylinder.** Land curves up on both sides and disappears into sky haze. Occasionally you can "break the illusion" and see the far side 180 km overhead.
3. **The river is the spine.** Most interesting stuff (towns, docks, barges, mills) clusters along water.
4. **Scale honesty.** Real dimensions for the section you're in. Never fake the radius.
5. **Golden-hour beauty** on par with the reference site.
6. **Playable journeys.** Pick a named town from the book on the map, then float there down the river or cut straight to it, and explore.

---

## 3. Coordinate system and scale (critical)

### 3.1 Units
- 1 world unit = 1 meter.
- `R = 90_123` (56 mi), `L = 901_232` (560 mi), `CIRC = 2πR ≈ 566_257`.

### 3.2 Cylinder coordinates
Every surface point is described as `(s, z, h)`:
- `s`: arc distance around the circumference, `0..CIRC` (wraps)
- `z`: axial distance along the section, `0..L`
- `h`: height above the base shell, measured **toward the axis**

Conversion to world space (axis = world Z):
```
θ = s / R
r = R - h
pos = (r·cosθ, r·sinθ, z)
up  = -normalize(pos.x, pos.y, 0)   // toward the axis
```

### 3.3 Precision
90 km radius will jitter in float32. Required:
- **Floating origin**: keep the camera at or near (0,0,0). Store player state in `(s, z, h)` doubles in JS, and build a local tangent frame each frame. Re-base chunk meshes relative to the player.
- Logarithmic depth buffer or reversed-Z to render both nearby grass (0.1 m) and the far side (180 km).

### 3.4 Physics
- Gravity: `7.18 m/s²` along `-up` (outward).
- Optional toggle: Coriolis force for thrown objects and falling (rotation period ~702 s, ω ≈ 0.00895 rad/s). Off by default, on in a "physics nerd" setting.

---

## 4. World generation

Procedurally generate one section at real scale, with a hand-shaped "hero valley" around spawn.

### 4.1 Terrain
- Heightfield in `(s, z)` space, tiled seamlessly in `s` (wraps around the circumference).
- Chunked quadtree LOD over the unrolled `(s, z)` rectangle, displaced onto the cylinder in the vertex shader.
- Chunk budget: nearest chunks ~1 m resolution, far chunks coarse, the far side of the cylinder a single low-res shell with baked color.
- Height range: rolling hills 0 to 800 m, occasional ridges to ~3 km. Barrier ranges much higher (see 4.3).
- Biomes are gentle and river-focused: wetlands, reed beds, grassland, orchards, cultivated plots, woodland on hills.

### 4.2 Rivers
- 4 main rivers per section, placed roughly 90° apart around the circumference, running axially along `z`.
- Flow directions alternate (+z, -z, +z, -z).
- Meander via low-frequency noise on the lateral offset; branch tributaries and feeder streams off each main channel.
- Carve the channel into the heightfield, then render water as a separate mesh with a flow-map shader (direction follows the channel tangent).
- Main river width 150 to 600 m; tributaries 10 to 60 m; streams 2 to 8 m.
- **Assumption (not canon):** rivers pass through the section barriers via gorges/tunnels.

### 4.3 Section barriers
- Mountain ranges forming a full ring around the circumference at `z = 0` and `z = L`.
- Height: 10 to 20 km toward the axis, leaving the center open for the light tube.
- Visually natural mountains with passes. Optional debug view reveals the structural bulkhead inside.
- Walking past a barrier loads the next section (same generator, new seed). A section index is shown in the HUD in a Quinlan-flavored numbering.

### 4.4 Settlements
See section 7.1 for what towns look like and 7.2 for how they are generated.

### 4.5 Underworld (stretch goal)
- Hollow spaces beneath large hills: maintenance corridors, admin centers, clean sci-fi materials. Hidden hatches in hillsides lead in.

---

## 5. Sky, light, and atmosphere

### 5.1 Light tube and day/night
- A glowing line along the axis. Day/night via dimming and color shifting the tube (not a moving sun), so shadows point straight "down" most of the day.
- For the golden-hour look the reference has, allow the tube's emission to be non-uniform: a bright zone that drifts along the axis creating low-angle light over part of the section at dawn and dusk. This is an artistic liberty; document it in settings.
- Full cycle length configurable (default 20 real minutes).

### 5.2 Hologram sky
- A sky shader that blends toward opaque sky-blue as the view direction points closer to the axis. The far side of the cylinder is hidden at high elevation angles and fades in only near the horizons where the land curves up.
- At night: dark sky with procedural constellations (fixed, fictional Quin sky).
- **"Bob mode" toggle:** disables the hologram, revealing the light tube as a thin line and the entire far side of the world overhead, with rivers visible as silver threads 180 km up. This is the money shot.

### 5.3 Atmosphere
- Aerial perspective / height fog strong enough that the upward-curving land fades into haze within tens of kilometers.
- Warm tone mapping (ACES), bloom on water highlights and the light tube, subtle god rays.

---

## 6. Player (the Quinlan controller)

### 6.1 Body
- Standing eye height: 1.1 m. Quadruped eye height: 0.6 m.
- Default FOV: 100°. Setting to go up to 140°.
- **Quinlan vision mode:** a wide panoramic projection (render cube map, sample with a cylindrical or Panini projection) so you see nearly 270° at once. Optional split "independent eyes" view with each half steerable separately (gamepad sticks or mouse + Q/E).

### 6.2 Controls
| Input | Action |
|---|---|
| WASD | Move |
| Mouse | Look |
| Shift | Drop to all fours (faster, lower) |
| Space | Jump / surface when swimming |
| C | Dive when swimming |
| E | Interact (board boat, open hatch, read mural) |
| V | Toggle Quinlan vision |
| B | Toggle Bob mode (hologram off) |
| M | Map (pick a town: float, travel, or set destination) |
| J | Journal |
| T | Time of day scrub |
| Tab | Photo mode (free cam, depth of field) |

Gamepad and touch (virtual stick) support.

### 6.3 Movement tuning
- Bipedal walk 1.5 m/s, run 3.5 m/s.
- Quadruped run 7 m/s.
- Swim surface 3 m/s, underwater 5 m/s with tail thrust bursts. Hold breath ~90 s.
- Low gravity (0.73 g): jumps are floatier. Use the real value.
- Entering water should be the most satisfying action in the game: splash, camera dip, underwater color grading, muffled audio.

### 6.4 Travel
See section 7 for the map, river journeys and cutscene travel.

---

## 7. Gameplay: journeys between towns

The core loop: open the map, pick a town, get there by floating down the river or by cutscene teleport, then explore on foot. Free walking between towns is still allowed.

### 7.1 What Quinlan towns look like

No town names are used from the book. Towns are generated, but their look follows the book's descriptions of Quinlan society.

**Canon anchors (from the book and wiki):**
- Iron Age / roughly medieval technology, deliberately held there by Anek. No engines, no electricity, no gunpowder.
- Economy based on agriculture and trade; capitalist; metal coins (coppers, irons). So markets, shops, warehouses and trading barges are central.
- Semi-aquatic: Quinlans live on land but spend much of their time in rivers. Rivers were built to maximize shoreline because that is their ideal habitat.
- Art is valued highly and everything shows some artistic expression, from ordinary buildings to personal items. Public spaces are adorned with sculptures and murals.
- Great singers and musicians; social, loud, talkative in groups, prone to brawls.
- Institutions exist: universities, local authorities/police, and Anek's hired Crew.
- Quinlans are ~1.2 m tall, stocky, short-legged, and move fastest on all fours.

**Derived design rules (our interpretation, consistent with the above):**

*Scale*
- Doors ~1.5 m tall and wide (built for stocky bodies moving on all fours).
- Floor-to-ceiling ~2.2 m; eaves low, roughly 1.8 to 2.5 m on small houses.
- Ramps everywhere alongside or instead of stairs; stairs are shallow and deep.
- Street furniture, market counters and railings sized for 1.2 m people. A human-scale camera should notice everything is slightly small.

*Water first*
- Towns grow along the bank, not away from it. The river is the main street.
- Every waterfront building has a water entrance: stone slipways, underwater doorways, or ladders straight into the river.
- Canals cut through town blocks; small footbridges arch over them.
- Public bathing and swimming pools in squares; fountains with water channels in the pavement.
- Docks, piers and boathouses are the busiest spaces. Barges moor stern-in along long stone quays.
- Streams are channeled through town in open gutters and stone culverts.

*Materials and construction*
- Lower floors in fitted fieldstone or river stone (flood-resistant). Upper floors in timber framing with plaster infill.
- Roofs: thatch in villages, clay tile or wooden shingle in towns, occasional slate in wealthy districts.
- Buildings are low and wide (1 to 2 floors typical, 3 at most) with deep overhangs for shade from the overhead light tube.
- Rounded, burrow-like forms mixed in: half-sunken dwellings with turf roofs built into riverbanks, especially in villages.
- No glass or very little; window openings with wooden shutters and woven screens.

*Decoration (the defining feature)*
- Every surface decorated: carved door frames, painted shutters, patterned roof ridges, mosaic thresholds, carved dock posts.
- Every square has at least one statue; larger towns have many. Subjects: Quinlan figures, river creatures, abstract flowing forms.
- Large murals on warehouse and civic walls, painted in bold colors.
- Recurring motif: water and flow (waves, spirals, fish, the river as a line with no ends).
- Color palette: warm ochres, terracotta, deep river blues and greens, gold leaf on civic buildings. Weathered, not pristine.

*Town anatomy*
- **Hamlet (20 to 80 buildings):** a cluster of bank dwellings, a few jetties, fishing racks, a shrine or small statue, garden plots, a boathouse.
- **Town (200 to 800 buildings):** a stone quay, market square with a central statue and fountain, a music/singing hall, taverns, warehouses on the waterfront, a watch house, craft streets (smiths, potters, weavers, carvers), mills on a side channel, orchards and fields outside.
- **River city (2,000+ buildings):** walls with water gates, several districts along both banks joined by large arched stone bridges, a university quarter, a grand civic hall with a gilded dome or tower, a large amphitheater for performances, a major harbor basin.

*Life and sound*
- Crowds on the quays, swimmers in the river, kids diving off piers, barges loading grain and barrels.
- Singing everywhere: street performers, taverns, work songs on docks (two-melody harmonies).
- Occasional shouting match or scuffle in a crowd (ambient only).
- Anek's surveillance birds perched on rooftops.

### 7.2 Town generation
- Towns are placed procedurally along rivers (hierarchy and spacing from the anatomy above), deterministic from a seed.
- Layout: start from the river spline, lay a quay along the bank, grow streets perpendicular to and parallel with the water, add canals on flat ground, place the market square near the main dock, then fill blocks by district type.
- Buildings assembled from a modular kit (7.1 materials) with per-building variation: size, roof type, color, decoration density.
- Names: invented from a syllable table (no book names). Optional setting to rename towns.
- Performance: towns rendered with instancing and merged meshes; decoration detail streams in only within ~300 m.

### 7.3 The map (M)
- Full-screen, stylized as a Quinlan painted chart: the section unrolled as a long rectangle, 4 rivers running its length, towns as illustrated icons.
- Hover a town: name, size, distance, direction of river flow.
- Click a town, then choose how to go:
  - **Float downriver** (river sequence, 7.4)
  - **Travel** (cutscene teleport, 7.5)
  - **Set as destination** (walk there yourself with compass guidance)
- Discovered vs. undiscovered: undiscovered towns show as a question mark until visited or until someone mentions them (setting in options: "all towns unlocked").

### 7.4 Float downriver sequence
A playable, skippable barge journey.
- Player appears on a Quinlan river barge at the current town's dock.
- The barge follows the river spline to the destination dock. **Time compression** scales so any trip lasts 60 to 180 real seconds (configurable), with an "arrive now" button.
- During the ride the player can: free-look, walk the deck, drop into Quinlan vision, toggle Bob mode to see the far side of the world, or jump overboard and swim (cancels the ride, leaves you mid-river).
- Passing towns glide by on the banks with name captions; day/night advances with the compressed time.
- Upstream trips: the same sequence, but the barge is poled/towed and visibly slower, or the route prefers a parallel river that flows the right way (rivers alternate direction). If no river connects the two towns, only the cutscene option is offered.
- Ambient: crew singing, water sounds, a passenger or two .
- Arrival: barge docks, camera eases to the player, town name banner, control returns.

### 7.5 Cutscene teleport
For instant travel.
- 3 to 6 second cinematic: fade to a painted title card of the destination (town name in Quinlan glyphs, then translated), optional quick aerial flyover of the town, fade in at the town gate or dock.
- Loads the destination chunks behind the cutscene, so the transition doubles as a loading screen.
- Default flavor text is neutral travel narration. Optional "Anek style" theme: a surveillance bird swoops in and the scene cuts, a wink at the Scatterings.

### 7.6 In-town
- Arrival marks the town discovered.
- Each town has a dock (barge departures), a signpost, a landmark, and a square with statues and murals.
- Walking out of town is always possible; roads and riverside paths lead toward neighbors with signposts and compass markers.

### 7.7 Save system
- Autosave to localStorage on arrival: player `(s, z, h)`, current town, discovered towns, time of day, settings.

---

## 8. Arrival sequence (intro, skippable)

1. **Space view:** the star with the strand looping around it three times as a (3,8) torus-knot-like curve (`THREE.TorusKnotGeometry` with p=3, q=8 as a stylized stand-in). Radiator fins glint on the dark side.
2. Zoom to one of the 9 spaceports on the rocky, non-rotating outer shell.
3. **Spin Transfer:** ride along the track inside the outer shell while the inner shell's surface blurs past, speed ramps to ~805 m/s and the blur resolves into stillness as speeds match. Clamp and dock.
4. Elevator descent through the shell.
5. Doors open into a hillside maintenance hatch overlooking the hero valley at golden hour. You are now a Quinlan. Control handed over.

---

## 9. Audio
- River ambience driven by distance to nearest water.
- Distant Quinlan singing in towns (two-melody harmonies).
- Underwater low-pass filter.
- Wind picks up at altitude near barriers.
- Spin Transfer: rising mechanical whine, then silence on dock.

---

## 10. Tech stack

- **three.js** (latest), vanilla JS or TypeScript, bundled with **Vite**.
- WebGL2 baseline; WebGPU renderer as optional path if stable.
- `lil-gui` for debug panel.
- Postprocessing: `postprocessing` library (bloom, SMAA, god rays, DOF for photo mode).
- Noise: `simplex-noise`.
- Web Workers for chunk generation (terrain + river carving) so the main thread never stalls.
- No backend. Static site deployable anywhere.

### 9.1 Suggested structure
```
/src
  main.ts
  config.ts              // R, L, gravity, tuning constants
  coords/cylinder.ts     // (s,z,h) <-> world, local frames, floating origin
  world/terrain/         // heightfield, LOD quadtree, chunk worker
  world/rivers/          // path gen, carving, water mesh + flow shader
  world/barriers.ts
  world/settlements/     // placement, building kit, props, instancing
  sky/                   // light tube, hologram sky shader, stars, fog
  player/                // controller, swim, quad/biped, vision modes
  intro/                 // space view, spin transfer, elevator
  towns/                 // building kit, town layout generator, decoration
  gameplay/              // map travel, barge journeys, cutscenes, save
  ui/                    // HUD, compass, map, journal, settings, photo mode
  audio/
/public
  /models /textures /audio
```

### 9.2 Performance targets
- 60 fps on an M1 MacBook Air / mid-range desktop GPU at 1080p.
- 30 fps minimum on recent phones with reduced LOD.
- Draw calls under ~400 via instancing and merged chunk meshes.
- Initial load under 10 MB before the intro starts; stream the rest.

---

## 11. Build phases

**Phase 1: The tube.** Cylinder coordinate system, floating origin, true-scale cylinder interior, light tube, basic walker with radial gravity. Acceptance: walk anywhere, land curves up, no jitter at any `s`.

**Phase 2: Terrain + LOD.** Noise heightfield with wraparound, chunked LOD, worker generation. Acceptance: smooth streaming while running on all fours across 20 km.

**Phase 3: Rivers + swimming.** Four alternating main rivers, meanders, tributaries, flowing water, swimming with current. Acceptance: follow a river 50 km without a seam.

**Phase 4: Towns + map (first playable).** Building kit, town generator (hamlet, town, city), quays and canals, statues and murals, map screen with town selection, cutscene teleport, discovery, save. Acceptance: open the map, pick a town, watch the cutscene, arrive on its quay and walk streets that feel Quinlan (small scale, water everywhere, decorated everything).

**Phase 5: River journeys.** Barge model, river-spline following, time compression, onboard free movement, upstream handling, arrive-now skip, jump-overboard. Acceptance: float from one town to another downriver in under 3 minutes and dock cleanly.

**Phase 6: Sky.** Hologram sky shader, fog/aerial perspective, day/night, stars, Bob mode.

**Phase 7: Quinlan life.** Decorated building kit, murals, statues, ambient NPCs, surveillance birds, audio.

**Phase 8: Barriers and sections.** Mountain rings at section ends, loading the next section.

**Phase 9: Intro.** Space view, spin transfer, elevator.

**Phase 10: Polish.** Quinlan vision mode, photo mode, touch controls, performance pass.

---

## 12. Assets

- **Quinlan model:** no canon art exists. Build a stylized low-poly procedural or glTF model from section 1.2: stocky 1.2 m body, otter-like head with a short beak-like toothed snout, side-set eyes, arm-to-torso webbing, broad flat tail. Needed for NPCs, the player's shadow/reflection, and third-person photo mode. Animation set: idle, walk (biped), run (quad), swim, jaw-rub "smile".
- **Buildings:** modular kit per 7.1: stone lower walls, timber-frame upper walls, thatch/tile/shingle roofs, turf-roofed bank dwellings, shutters, carved trims, mural panels, statues, quay and slipway pieces, bridges, canal walls.
- **Textures:** CC0 from Poly Haven / ambientCG.
- Keep all third-party assets CC0 or clearly licensed.

---

## 13. Open questions (decide or leave configurable)

- River behavior at section barriers (gorges vs. tunnels).
- How much golden-hour "cheat" to allow from a light source that is directly overhead.
- Whether each section's far side should be randomized or show the same world (it is the same section; it should be consistent with the generated terrain).
- Fan project: this uses Dennis E. Taylor's setting. Keep it non-commercial and credit the books.
