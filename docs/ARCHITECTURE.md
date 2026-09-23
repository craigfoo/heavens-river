# Heaven's River Explorer: how it is built

This page is for people changing the code. The spec (what the world should be) is the main [README](../README.md); this is how the implementation meets it.

## Big picture

Everything is generated at run time from a world seed and a section index: terrain, rivers, towns, buildings, people, textures (procedural shaders) and sound (Web Audio synthesis). There are no asset files. The main thread renders and simulates; a pool of module workers builds terrain chunks, towns and the map image.

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
- Post-processing (`render/pipeline.ts`): HDR render, screen-space god rays (`sunShafts.ts`), optional depth of field (photo mode), bloom, grading, ACES tone mapping, vignette, SMAA or MSAA.

## Terrain, rivers and water

- `world/gen/world.ts` (`WorldGen`) is the deterministic generator for one section. It is pure TypeScript with no DOM or three.js, so the same code runs in the workers and on the main thread. Terrain is built "valley first": four main rivers with sine-generated meanders and calm reaches (`gen/rivers.ts`), flood plains, valley walls and hills, tributaries and streams carved in, towns flattened, and the barrier ring near each section end.
- The **hero hill** and **maintenance hatch**: a hand-shaped hill beside the first river city, with the arrival hatch cut into its city-facing flank (`WorldGen.heroHill`, `WorldGen.hatch`, `world/hatch.ts`).
- `world/terrain/` is a quadtree over the unrolled section (16 × 27 root tiles, 64 × 64 quads per chunk, down to ~1.1 m spacing), built by `terrainWorker.ts` through a priority queue in `workerPool.ts`. Chunks carry skirts, colours, material weights, a water grid and tree instances. A low-resolution far shell covers the rest of the cylinder.
- `worldQuery.ts` answers gameplay questions on the main thread (ground height matching the rendered triangles, water level and flow), plus colliders and walkable floors from towns.
- Water is a separate mesh per chunk with a flow-map shader (`world/water/waterMaterial.ts`): Fresnel reflection of the hologram, depth-based colour, shore foam, sun glints, and Snell's window from below.

## Towns and life

- `world/gen/settlements.ts` places hamlets, towns and river cities along the rivers and defines each town's frame (a along the river, c inland), canals and harbour basins. Names come from a syllable table (`gen/names.ts`); section numbers are shown in an invented base-8 Quinlan numbering.
- `towns/layout.ts` lays out quays, streets, plazas, markets, districts and buildings; `kit.ts` and `props.ts` build them (burrows, houses, towers, civic halls with domes, mills, boathouses, bridges, piers, barges, statues, fountains, murals); `townMaterial.ts` paints every surface procedurally (stone, half-timbering, tile, thatch, mosaics, murals, gold leaf). Towns are built in workers with near and far detail per tile, and come back with colliders, walkable floors, NPC waypoints, bird perches and mural positions.
- `npc/quinlanModel.ts` is the procedural Quinlan (2,870 or 584 triangles) with vertex-shader animation for idle, walk, all-fours run, swim, sit-and-sing and the jaw-rub smile. `townLife.ts` fills towns with walkers, stall keepers, dock watchers, singing circles, chatting pairs, the odd quarrel, swimmers and pier-diving kids, drawn as two instanced meshes. `birds.ts` adds Anek's surveillance birds. `avatar.ts` is your own body: shadow only in first person, visible in photo mode.

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
- **Not canon, invented here:** the Quinlan's exact look, town and river names, the numbering, the look of Anek's birds, the maintenance hatch and all mural subjects.

## Testing

There is no unit-test suite. Development used headless Chromium (Playwright with SwiftShader) driving `?test` mode: step the simulation, wait for the workers, render, and compare screenshots. `npm run build` type-checks the whole project. The model and intro have standalone preview pages at `/src/npc/preview.html` and `/src/intro/preview.html` in the dev server.

Frame rates were only measured with software rendering, so they say nothing about real GPUs. Quality presets (Settings → Graphics) scale terrain detail, shadows, grass density, pixel ratio and the vision render size.
