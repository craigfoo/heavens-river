# Heaven's River Explorer: how it is built

This page is for people changing the code. The spec (what the world should be) is the main [README](../README.md); this is how the implementation meets it.

## Big picture

Everything is generated at run time from a world seed and a section index: terrain, rivers, towns, buildings, textures (procedural shaders) and sound (Web Audio synthesis). The one asset is the Quinlan model (`public/models/`, see below). The main thread renders and simulates; a pool of module workers builds terrain chunks, towns and the map image.

```
main.ts ─ App (renderer, world streaming, frame loop)
        └ Game (states, keys, HUD, save, travel, barges, photo, intro, audio)
```

`App.step(dt)` runs one frame: input → player → game hooks → camera → lighting → terrain / grass / towns / crowds / birds / hatch streaming → render. With `?test` in the URL nothing runs on its own; tests call `window.__hr.step(dt, render)` and read `window.__game`.

## Coordinates on a spinning cylinder

- Positions are cylinder coordinates in doubles: `s` (metres around the circumference, wrapping at `CIRC`), `z` (metres along the axis, 0 to `L`) and `h` (height above the base shell, toward the axis). Canon constants live in `src/config.ts` (R = 90,123 m, L = 901,232 m, 0.73 g).
- **Floating origin** (`src/coords/cylinder.ts`): a render frame sits on the surface near the camera and re-bases every 1.5 km, so float32 GPU positions stay small anywhere on the 566 km circumference.
- **Bent geometry**: meshes are authored "unrolled" in (ds, h, dz) around an anchor on the base shell. The vertex shader (`src/render/bend.ts`) bends them onto the cylinder exactly, after instancing, and lights each point in its own local frame. `patchWorldMaterial` adds this to any three.js material, plus the atmosphere.
- The camera's logarithmic depth buffer covers 5 cm to 4,000 km, so the far side of the world (180 km away, overhead) draws in the same pass as your feet.

## Sky and light

- `src/sky/daynight.ts` keys the light tube's brightness and colour over the day; `lighting.ts` drives a shadowed sun light, a hemisphere light and the shared uniforms in `render/uniforms.ts`.
- The light tube is overhead all day, so golden hour is an artistic liberty (spec 13): a bright zone slides along the axis at dawn and dusk, giving low, warm, directional light. It can be switched off in the settings.
- `render/atmosphereGlsl.ts` is the analytic aerial perspective of a spinning habitat: air density falls as exp(-k(R² − r²)) toward the axis, integrated in closed form (Dawson function), with Rayleigh and Mie scattering, the hologram shell at 24 km (adjustable), stars and the underwater look. Every world shader ends with `hrComposite`.
- `sky/sky.ts` draws whatever a ray sees when it hits nothing: the hologram, the haze toward the section ends, and in Bob mode (B) the light tube along the axis.
- Post-processing (`render/pipeline.ts`): HDR render, ambient occlusion, screen-space god rays (`sunShafts.ts`), optional depth of field (photo mode), bloom, grading, ACES tone mapping, vignette, SMAA or MSAA.
- Ambient occlusion is [N8AO](https://github.com/N8python/n8ao) (ISC) at half resolution. It rebuilds positions and normals from the depth buffer, so the bent geometry needs no extra pass. N8AO decodes logarithmic depth through a standard perspective depth, which has no precision left with a 4,000 km far plane; a small Vite plugin in `vite.config.ts` patches it to decode the view distance directly (the build fails if the patch stops applying).

## Terrain, rivers and water

- `world/gen/world.ts` (`WorldGen`) is the deterministic generator for one section. It is pure TypeScript with no DOM or three.js, so the same code runs in the workers and on the main thread. Terrain is built "valley first": four main rivers with sine-generated meanders and calm reaches (`gen/rivers.ts`), flood plains, valley walls and hills, tributaries and streams carved in, towns flattened, and the barrier ring near each section end.
- The **hero hill** and **maintenance hatch**: a hand-shaped hill beside the first river city, with the arrival hatch cut into its city-facing flank (`WorldGen.heroHill`, `WorldGen.hatch`, `world/hatch.ts`).
- `world/terrain/` is a quadtree over the unrolled section (16 × 27 root tiles, 64 × 64 quads per chunk, down to ~1.1 m spacing), built by `terrainWorker.ts` through a priority queue in `workerPool.ts` (one-off jobs such as the far shell and the map image go ahead of chunks). Chunks carry skirts, colours, material weights, a water grid and tree instances. A low-resolution far shell covers the rest of the cylinder; its shader draws the main rivers from a small data texture of their centrelines, so they show as silver threads on the far side in Bob mode.
- Trees (`world/vegetation/trees.ts`) are instanced per chunk from one base mesh per detail level: a trunk with branches, a solid inner canopy (so no tree looks see-through) and crossed cards of leaves, alpha-tested, reshaped per instance into broadleaf, poplar, willow and orchard trees. The bark and leaf texture is painted on a canvas at startup. Towns plant their square and garden trees through the same renderer.
- Farmland is painted in the terrain shader per farm region (jittered Voronoi cells with their own field orientation and size, strip fields and hedgerows), and a towpath runs along both banks of every main river.
- `worldQuery.ts` answers gameplay questions on the main thread (ground height matching the rendered triangles, water level and flow), plus colliders and walkable floors from towns.
- Water is a separate mesh per chunk (`world/water/waterMaterial.ts`). The look follows [Clearwater](https://github.com/Aureliengmz/clearwater) by Aurélien / Lumaris (MIT):
  - **Ripples:** a wave slope texture built once from an ocean spectrum (`world/water/waterTextures.ts`) is sampled in four layers and carried by each channel's current with a two-phase flow map. Drifting calm and choppy patches keep the tiles from showing.
  - **Glossy distance:** the texture's mipmaps store the mean squared slope, so the slope variance lost with distance widens the sun glint (LEAN mapping) instead of sparkling.
  - **Light:** exact Fresnel, a Beckmann sun glint, and Clearwater's absorption and scattering coefficients. The riverbed (terrain shader) absorbs its own light on the way down and back up, and gets caustics traced through the same waves. The surface adds the light the water column scatters, blended with alpha equal to the Fresnel term.
  - **Edges:** a thin foam line at the bank, and Snell's window from below.
  - **Seams:** tiles hang short "skirts" from their water edges, drawn after every surface. Where a surface is in front the depth test hides them, so they only fill seams between tiles of different detail.
- Under the surface, `world/underwater.ts` adds drifting motes and schools of silver fish.

## Towns and life

- `world/gen/settlements.ts` places hamlets, towns and river cities along the rivers and defines each town's frame (a along the river, c inland), canals and harbour basins. Canals loop back to the river so their water flows (a ring leaves the river, runs inland and returns downstream; cross canals cut it into islands), and they lie downstream of the market so their mills stand below the houses. It cuts the ground for them a few metres in under their banks (`QUAY_CUT`, `BANK_CUT`): the stone walls stand out in the water with a coping back over the bank, so the terrain's slope into the cut stays hidden at any level of detail, and the town adds walkable floors over it. Names come from a syllable table (`gen/names.ts`); section numbers are shown in an invented base-8 Quinlan numbering.
- `towns/layout.ts` lays out a town as a walking town, in its (a, c) frame: a quay and waterfront row, a market square opening onto the quay, neighbourhood centres (Poisson-scattered commons, each owning the ground nearest it, weighted), winding footpaths between them (a spanning tree plus loops, crossing canals square-on over footbridges), rings of lanes and spokes round each common, canal walks, and buildings stood along every path facing it (tight terraces in the cobbled core, looser in the outskirts). `geom.ts` has its 2D helpers (oriented footprints, separating-axis overlap, curve smoothing, a spatial hash). `kit.ts` and `props.ts` build them (burrows, houses, towers, civic halls with domes, mills with their wheels and races, boathouses, timber footbridges in towns and stone arches in cities, piers, barges, fish and drying racks, statues, fountains, murals); `townMaterial.ts` paints every surface procedurally (stone, half-timbering, tile, thatch, mosaics, murals, gold leaf). Towns are built in workers with near and far detail per tile, and come back with colliders, walkable floors, NPC waypoints, bird perches and mural positions.
- **Quinlans.** `npc/quinlanModel.ts` animates Quinlans in the vertex shader: idle, walk, all-fours run, swim, sit-and-sing and the jaw-rub smile. Each vertex belongs to one body part (body, head, jaw, arms, legs, tail) with a weight that blends it towards the part's parent, so thousands can be drawn instanced.
  - The model is a textured mesh made with Meshy from a concept (source in `art/quinlan/`). Meshy's Free plan licenses it under CC BY 4.0, so it is credited in the README, the About screen and `public/models/README.txt`. `tools/quinlan/build.mjs` (`npm run quinlan`) turns it into `public/models/quinlan.bin` and `quinlan-albedo.jpg`: it rigs it with bone-heat weights from hand-placed bones, finds the fur and the gear in the texture (for per-Quinlan fur tints and gear dyes) and builds three LODs. The near LOD samples the texture; the mid and far LODs carry its colours in their vertices, because the tightly packed atlas bleeds across its seams in the mipmaps. How the poses adapt to this body (it leans forward and carries its tail high) is stored in the same file. `npc/quinlanAsset.ts` loads it.
  - Until it has loaded, or if it can't be, the original procedural model (2,870 or 584 triangles, built in `quinlanModel.ts`) stands in.
  - `townLife.ts` fills towns with walkers, stall keepers, dock watchers, singing circles, chatting pairs, the odd quarrel, swimmers and pier-diving kids, drawn as one instanced mesh per LOD. `birds.ts` adds Anek's surveillance birds. `avatar.ts` is your own body: shadow only in first person, visible in photo mode.

## Gameplay

- `gameplay/game.ts` owns the state machine (`boot`, `intro`, `explore`, `map`, `menu`, `journal`, `cutscene`, `barge`, `photo`), key bindings, discovery, destinations, section crossing and saving (`save.ts`, `localStorage`).
- `travel.ts` is cutscene travel: a painted title card with the town's name in Quinlan glyphs (`ui/glyphs.ts`), an optional flyover or the "Anek-style" bird wipe, and arrival at the town gate. It loads the destination while the card is up.
- `barge.ts` is a river journey: the barge follows the river spline between docks with a monotone time-warp so any trip takes 60 to 180 s, with captions for passing towns, compressed day and night, a crew, "arrive now" and jumping overboard.
- `photo.ts` is photo mode; `render/vision.ts` provides Quinlan vision (three 90° renders stitched into a 270° cylindrical panorama, or two independently steerable eyes).
- `audioBridge.ts` feeds the procedural audio engine in `src/audio/` (river, wind, underwater, wildlife, town singing in two melodies, barge work songs, intro machinery, one-shot effects).
- `src/intro/` is the arrival sequence (Eta Leporis and the strand as a (3,8) torus knot, Spaceport 4, the Spin Transfer to 805 m/s, the elevator, the doors). It renders with its own scenes while the hero valley streams in behind it, then fades from gold into the world.

## Decisions on the spec's open questions

- **Rivers at the barriers:** each main river runs through a gorge into a stone-arched tunnel at each section end (`world/portals.ts`); E at a portal takes you to the neighbouring section. Walking or flying over the crest works too.
- **Golden-hour cheat:** on by default as a bright zone along the axis at dawn and dusk; the "Golden-hour light zone" setting (World) turns it off for the physically plain overhead tube.
- **The far side:** it is the same section's terrain, rendered as the low-resolution far shell, so what you see overhead in Bob mode is really there.
- **Not canon, invented here:** the Quinlan's exact look (the model follows the project owner's concept: a platypus-beaver with a bill and buck teeth, in travelling gear), town and river names, the numbering, the look of Anek's birds, the maintenance hatch and all mural subjects.

## Testing

The F3 panel (`ui/debugPanel.ts`) tunes time, haze, LOD and vision live, jumps between towns and sections, and can x-ray the structural bulkheads inside the barrier rings (`world/bulkhead.ts`, spec 4.3).

There is no unit-test suite. Development used headless Chromium (Playwright with SwiftShader) driving `?test` mode: step the simulation, wait for the workers, render, and compare screenshots. `npm run build` type-checks the whole project. The model and intro have standalone preview pages at `/src/npc/preview.html` and `/src/intro/preview.html` in the dev server. The model preview shows the textured Quinlan's three LODs in every gait (`?procedural` for the old model, `?pose={...}` to try pose adjustments).

Frame rates were only measured with software rendering, so they say nothing about real GPUs. Quality presets (Settings → Graphics) scale terrain detail, shadows, grass density, pixel ratio and the vision render size.

## Shader portability

On Windows, Chrome and Edge run WebGL through ANGLE on Direct3D 11, where some GLSL that is merely "undefined" elsewhere turns into NaN pixels. The bloom's mip chain then smears those into flickering black blocks. Software rendering hides all of this, so keep to these rules:

- Take derivatives (`fwidth`, `dFdx`, `dFdy`) and implicit-LOD texture reads at the top level of `main`, never inside a branch that can differ between neighbouring pixels or after a `discard`. Use `textureLod` inside branches.
- Clamp every `pow` base to be non-negative. A Fresnel term needs `clamp(dot(N, V), 0.0, 1.0)`, because the dot of two unit vectors can round a hair above 1.
- Give every local a value on every path, and prefer one `return` at the end of a function. ANGLE does not zero uninitialized variables on all drivers.
- Two safety nets catch what slips through, but they do not replace the rules above:
  - In the world, the god-ray pass (`render/sunShafts.ts`) always runs, even with rays off, and clamps any NaN or Inf pixel to a finite value before bloom.
  - In the intro, `F_POST` (`intro/glsl.ts`) clamps each scene shader's output.
