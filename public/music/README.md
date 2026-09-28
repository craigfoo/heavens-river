# Music

The game plays the audio files in this folder, choosing each one by its name
(`src/audio/tracks.ts`). Put one of these words in the file name:

| In the name | Plays |
|-------------|-------|
| `Start` | the arrival sequence, fading into the scene's music as it ends |
| `Map` | while the map is open (and on the trip it starts) |
| `Village`, `Town`, `City` | in towns, hamlets and cities |
| `Tavern` | kept for inside taverns, once buildings can be entered (not played yet) |
| `Barge` | aboard a barge |
| `Fields` | out in the country, with a spell of quiet between tracks |

Add `Night` or `Day` (e.g. `Daytime`) to a name to keep it to that time of day;
a name with neither plays at any time. Several files for the same place make a
shuffled playlist. Files are found when the game is built (or the dev server
reloads); mp3, ogg, m4a, wav and flac all work.
