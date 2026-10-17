# Native Fabric verification

Each accepted runtime report matches the current shipped JAR SHA-256. Core checks cover connect, observe, move, command, chest interaction, native capture and cancellation. Hotbar selection, actual left/right GUI stack changes and Unicode chat are additional required checks.

| Minecraft | Java | Core + hotbar + GUI + Unicode | Native registry states | Evidence |
| --- | --- | --- | ---: | --- |
| 1.20 | 17 | passed | 23924 / 24135 static | [report](./1.20/result.json) |
| 1.20.1 | 17 | passed | 23924 / 24135 static | [report](./1.20.1/result.json) |
| 1.20.2 | 17 | passed | 24065 / 24276 static | [report](./1.20.2/result.json) |
| 1.20.3 | 17 | passed | 26433 / 26644 static | [report](./1.20.3/result.json) |
| 1.20.4 | 17 | passed | 26433 / 26644 static | [report](./1.20.4/result.json) |
| 1.20.5 | 21 | passed | 26473 / 26684 static | [report](./1.20.5/result.json) |
| 1.20.6 | 21 | passed | 26473 / 26684 static | [report](./1.20.6/result.json) |
| 1.21 | 21 | passed | 26473 / 26684 static | [report](./1.21/result.json) |
| 1.21.1 | 21 | passed | 26473 / 26684 static | [report](./1.21.1/result.json) |
| 1.21.2 | 21 | passed | 27107 / 27318 static | [report](./1.21.2/result.json) |
| 1.21.3 | 21 | passed | 27107 / 27318 static | [report](./1.21.3/result.json) |
| 1.21.4 | 21 | passed | 27655 / 27866 static | [report](./1.21.4/result.json) |
| 1.21.5 | 21 | passed | 27703 / 27914 static | [report](./1.21.5/result.json) |
| 1.21.6 | 21 | passed | 27735 / 27946 static | [report](./1.21.6/result.json) |
| 1.21.7 | 21 | passed | 27735 / 27946 static | [report](./1.21.7/result.json) |
| 1.21.8 | 21 | pending | 27735 / 27946 static | pending |
| 1.21.9 | 21 | pending | 29460 / 29671 static | pending |
| 1.21.10 | 21 | pending | 29460 / 29671 static | pending |
| 1.21.11 | 21 | pending | pending | pending |
| 26.1 | 25 | passed | 29662 / 29873 static | [report](./26.1/result.json) |
| 26.1.1 | 25 | passed | 29662 / 29873 static | [report](./26.1.1/result.json) |
| 26.1.2 | 25 | passed | 29662 / 29873 static | [report](./26.1.2/result.json) |
| 26.2 | 25 | passed | 32135 / 32366 static | [report](./26.2/result.json) |
| 26.3 | 25 | passed | 35492 / 35723 static | [report](./26.3/result.json) |

Registry rows without a certified static shape remain context dependent. Bundled context cases require their recorded exact position, dimension, literal state and dependencies; entity-sensitive cases remain unknown. The [collision index](../collision-data/index.json) records dataset checksums and source/artifact hashes.

Detailed logs remain in ignored work directories. Portable raw reports and native PNGs are included beside this file.
