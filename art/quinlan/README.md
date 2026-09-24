# Quinlan source art

Source files for the Quinlan model: the Meshy export (GLB) and concept images. Nothing here ships with the site. `npm run quinlan` (tools/quinlan/build.mjs) rigs `quilan.glb` and writes the game's copy to `public/models/`; run it again after replacing the model. If the new model has different proportions, move the bones and joints in the script to match (`--debug` writes coloured part maps to `tools/quinlan/out/`).

## Licence

`quilan.glb` was generated with [Meshy](https://www.meshy.ai) on the Free plan, from the project's concept art. Meshy licenses Free-plan models under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): they may be used, changed and shared, including commercially, as long as Meshy is credited. The credit is in the main README, in the game's About screen and next to the game's copy in `public/models/`. The game's copy is changed from this file (rigged, simplified into levels of detail, texture resized, colours baked into the distant versions); say so wherever the model is credited.

A model made on a paid Meshy plan would not need the credit. Keep the licence of each file you add here noted in this section.
