# Quinlan source art

Source files for the Quinlan model: the Meshy export (GLB) and concept images. Nothing here ships with the site. `npm run quinlan` (tools/quinlan/build.mjs) rigs `quilan.glb` and writes the game's copy to `public/models/`; run it again after replacing the model. If the new model has different proportions, move the bones and joints in the script to match (`--debug` writes coloured part maps to `tools/quinlan/out/`).

If a model's licence asks for credit (for example CC BY), note it here and in the main README.
