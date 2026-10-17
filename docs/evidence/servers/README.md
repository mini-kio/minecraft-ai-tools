# Server verification evidence

Generated 2026-10-17T18:04:12.018Z. 17 exact STABLE Paper releases passed seven actual scenarios; 7 exact releases have no official STABLE build.

The seven scenarios are connection, observation/inventory, measured movement, player-command result, chest GUI interaction, capture and stopped movement after cancellation.

7 versions use the actual Fabric Minecraft renderer with the recorded matching bridge SHA256, native HUD and a hotbar selection assertion. 10 versions use Mineflayer with an explicitly approximate Prismarine capture; these do not prove native HUD, resource packs or exact game rendering. No protocol or server-version fallback is used.

Paper builds and checksums come from the [official Fill API](https://fill.papermc.io/v3/projects/paper). [matrix.json](paper/matrix.json) contains raw per-version results; absolute paths refer to the original isolated QA run and are retained as provenance. The adjacent PNG files are portable copies.

| Game release | Exact Paper build | Backend | Result | Evidence |
|---|---:|---|---|---|
| 1.20 | 17 | fabric | passed | [JSON](paper/1.20.json) · [PNG](paper/1.20.png) · [Observation](paper/1.20-observe.json) · [Chest](paper/1.20-chest.json) · [Chest PNG](paper/1.20-chest.png) |
| 1.20.1 | 196 | mineflayer | passed | [JSON](paper/1.20.1.json) · [PNG](paper/1.20.1.png) · [Observation](paper/1.20.1-observe.json) · [Chest](paper/1.20.1-chest.json) |
| 1.20.2 | 318 | mineflayer | passed | [JSON](paper/1.20.2.json) · [PNG](paper/1.20.2.png) · [Observation](paper/1.20.2-observe.json) · [Chest](paper/1.20.2-chest.json) |
| 1.20.3 | unavailable | — | unavailable | [JSON](paper/1.20.3.json) |
| 1.20.4 | 499 | mineflayer | passed | [JSON](paper/1.20.4.json) · [PNG](paper/1.20.4.png) · [Observation](paper/1.20.4-observe.json) · [Chest](paper/1.20.4-chest.json) |
| 1.20.5 | unavailable | — | unavailable | [JSON](paper/1.20.5.json) |
| 1.20.6 | 151 | mineflayer | passed | [JSON](paper/1.20.6.json) · [PNG](paper/1.20.6.png) · [Observation](paper/1.20.6-observe.json) · [Chest](paper/1.20.6-chest.json) |
| 1.21 | 130 | fabric | passed | [JSON](paper/1.21.json) · [PNG](paper/1.21.png) · [Observation](paper/1.21-observe.json) · [Chest](paper/1.21-chest.json) · [Chest PNG](paper/1.21-chest.png) |
| 1.21.1 | 133 | mineflayer | passed | [JSON](paper/1.21.1.json) · [PNG](paper/1.21.1.png) · [Observation](paper/1.21.1-observe.json) · [Chest](paper/1.21.1-chest.json) |
| 1.21.2 | unavailable | — | unavailable | [JSON](paper/1.21.2.json) |
| 1.21.3 | 83 | mineflayer | passed | [JSON](paper/1.21.3.json) · [PNG](paper/1.21.3.png) · [Observation](paper/1.21.3-observe.json) · [Chest](paper/1.21.3-chest.json) |
| 1.21.4 | 232 | mineflayer | passed | [JSON](paper/1.21.4.json) · [PNG](paper/1.21.4.png) · [Observation](paper/1.21.4-observe.json) · [Chest](paper/1.21.4-chest.json) |
| 1.21.5 | unavailable | — | unavailable | [JSON](paper/1.21.5.json) |
| 1.21.6 | 48 | mineflayer | passed | [JSON](paper/1.21.6.json) · [PNG](paper/1.21.6.png) · [Observation](paper/1.21.6-observe.json) · [Chest](paper/1.21.6-chest.json) |
| 1.21.7 | 32 | fabric | passed | [JSON](paper/1.21.7.json) · [PNG](paper/1.21.7.png) · [Observation](paper/1.21.7-observe.json) · [Chest](paper/1.21.7-chest.json) · [Chest PNG](paper/1.21.7-chest.png) |
| 1.21.8 | 60 | mineflayer | passed | [JSON](paper/1.21.8.json) · [PNG](paper/1.21.8.png) · [Observation](paper/1.21.8-observe.json) · [Chest](paper/1.21.8-chest.json) |
| 1.21.9 | unavailable | — | unavailable | [JSON](paper/1.21.9.json) |
| 1.21.10 | 130 | fabric | passed | [JSON](paper/1.21.10.json) · [PNG](paper/1.21.10.png) · [Observation](paper/1.21.10-observe.json) · [Chest](paper/1.21.10-chest.json) · [Chest PNG](paper/1.21.10-chest.png) |
| 1.21.11 | 132 | mineflayer | passed | [JSON](paper/1.21.11.json) · [PNG](paper/1.21.11.png) · [Observation](paper/1.21.11-observe.json) · [Chest](paper/1.21.11-chest.json) |
| 26.1 | unavailable | — | unavailable | [JSON](paper/26.1.json) |
| 26.1.1 | unavailable | — | unavailable | [JSON](paper/26.1.1.json) |
| 26.1.2 | 74 | fabric | passed | [JSON](paper/26.1.2.json) · [PNG](paper/26.1.2.png) · [Observation](paper/26.1.2-observe.json) · [Chest](paper/26.1.2-chest.json) · [Chest PNG](paper/26.1.2-chest.png) |
| 26.2 | 134 | fabric | passed | [JSON](paper/26.2.json) · [PNG](paper/26.2.png) · [Observation](paper/26.2-observe.json) · [Chest](paper/26.2-chest.json) · [Chest PNG](paper/26.2-chest.png) |
| 26.3 | 202 | fabric | passed | [JSON](paper/26.3.json) · [PNG](paper/26.3.png) · [Observation](paper/26.3-observe.json) · [Chest](paper/26.3-chest.json) · [Chest PNG](paper/26.3-chest.png) |

[Actual Java startup cancellation](cancellation/server-start.json) verifies that the owned PID has exited before CANCELLED returns. [Actual player cancellation](cancellation/player.json) verifies early connect cleanup, released movement, capture cleanup and reuse, and disconnected pending container interaction.

Every included JSON/PNG file has byte size and SHA256 in [sha256.json](sha256.json). No discovery records, bridge tokens, account credentials, user configuration or native host permissions are included.
