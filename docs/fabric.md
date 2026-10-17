# Fabric game companion

`bridges/fabric/dist/mct-bridge-<exact Minecraft version>.jar` is the client companion for real game observation and bounded input. Install **one matching JAR** in a separate Fabric instance's `mods` directory and launch that instance through the existing Minecraft launcher. Fabric Loader 0.19.5 or newer is required; Fabric API is not required. Do not install a different game version's JAR. Minecraft login stays in the existing launcher.

All 24 official releases from 1.20 through 26.3 have compiled artifacts and verified tick/render hook signatures. Compilation is **not** a claim that every gameplay scenario passed: `bridges/fabric/compatibility.json` records build and runtime evidence separately. Legacy releases use exact-version Yarn intermediary descriptors through Fabric's `MappingResolver`; 26.x uses Mojang's unobfuscated API. Unsupported API operations return `CAPABILITY_UNAVAILABLE` rather than reporting success.

The representative 26.3 artifact passed actual version-matched Vanilla client/server checks for connection, observation, movement, commands, chest interaction, native screenshots, cancellation, hotbar selection, Korean GUI text, mouse/scroll events and loaded/unloaded collision snapshots. Native left/right clicking changed synchronized chest stack counts and the inventory API restored them. Each retained report is linked to its installed JAR's SHA-256. Additional completed version reports are preserved individually; the user stopped the remaining full-version matrix, so versions without current evidence remain explicitly unverified.

Portable reports and native HUD/chest image evidence are included under `bridges/fabric/evidence/<version>/`. The compatibility manifest records SHA-256 hashes for the raw reports and copied PNGs; full diagnostic logs remain in `work/`.

## Attach and discovery

The mod binds `127.0.0.1` on an ephemeral port and writes `<game directory>/.mct/fabric-<pid>.json`. Set launcher JVM arguments `-Dmct.port=25590` and/or `-Dmct.discoveryDir=C:\path\to\discovery` to override these. The file contains a bearer token and should stay local. Unix directories/files receive owner-only permissions; Windows inherits the instance directory ACL.

The discovery object is `{kind:"fabric",protocol:1,port,token,pid,gameVersion,startedAt}`. Both `GET /status` and `POST /call` require `Authorization: Bearer <token>`. Cross-origin browser access is not enabled. Requests larger than 1 MiB are rejected. Responses are JSON; failures have `{error:{code,message,gameVersion}}` and an HTTP error status. Request timeout is 12 seconds; expired queued requests never execute later.

## Actions

Send `POST /call` with `{action,args}`:

| Action | Arguments and result |
| --- | --- |
| `observe` | No arguments. Returns actual client telemetry, screen, player and open container slots. |
| `capture` | No arguments. Returns PNG `base64`, `mimeType`, `source:"fabric-game-framebuffer"`, `captureFrame`, and telemetry. |
| `look` | Absolute `{yaw,pitch}` in degrees; pitch is -90 through 90. |
| `input` | `{key,action:"press"\|"release",durationMs}`. Keys: `forward`, `back`, `left`, `right`, `jump`, `sneak`, `sprint`, `attack`, `use`, `drop`, `inventory`, `escape`. Press lasts 200 ms by default and at most 5000 ms. Inventory opens its native screen; escape closes the current screen. |
| `inventory` | No arguments lists the current container. `{slot,button:0\|1,mode:"PICKUP"\|"QUICK_MOVE"\|"THROW"}` clicks a validated container slot. |
| `gui` | `{type:"click",x,y,button}`, `{type:"scroll",x,y,horizontal,vertical}`, `{type:"text",text}`, or `{type:"key",keyName:"enter"}` dispatches native GUI events. Portable mouse buttons are **0 left, 1 right, 2 middle**, translated to the game's GLFW/SDL constants. Coordinates use the logical screen size in `observe.screen`. `keyName` supports enter, escape, tab, backspace, delete and arrows; raw version-specific `{key,scanCode,modifiers}` is also accepted. Unicode text is dispatched as code points in modern versions and UTF-16 units in older versions. |
| `blocks` | Inclusive `{min:{x,y,z},max:{x,y,z}}`, at most 4096 integer positions. Returns `{blocks:[{position,name,properties,shapes,known}],version,dimension,bounds,observedAt,tick}`. Collision boxes are local block coordinates. Unloaded chunks return `known:false` and `reason:"chunk-not-loaded"`; the bridge uses `getChunk(...,FULL,false)` and does not generate chunks or trust the client's empty-chunk fallback. |
| `command` | `{text:"/time query daytime"}` sends a player command through the existing connection. This does not grant server permissions. |
| `chat` | `{text:"message"}` sends a single chat line, at most 256 characters. |
| `connect` | `{host,port}` starts the native connection flow. Disconnect an existing world first. |
| `disconnect` | Releases held input and disconnects the current world. |
| `stop` | Releases every key held by this bridge. |
| `hotbar` | `{slot:0..8}` selects the native hotbar slot and sends the carried-item update to the server. `selectedSlot` appears in the response, player telemetry and inventory telemetry. |
| `collision-export` | Incremental exact-registry export: `{operation:"start",contextPositions?,contextBounds?}` returns a job ID. Poll `{operation:"status",jobId}`; completed jobs optionally return `includeGzip:true` (`gzipBase64`) or `includeDataset:true`. Cancel with `{operation:"cancel",jobId}`. |

Game operations run on the client thread at the tail of actual game ticks. Captures run at the tail of the natural render loop and use Minecraft's screenshot API, including the asynchronous readback API in newer versions. The mod does not call the renderer recursively or replace gameplay with a mock image. Tick/frame counters come from actual hooks; HTTP polling does not advance them. Images include normal HUD and active screens. If the client stops rendering, capture times out instead of claiming a fresh frame.

Input releases on timeout, game disconnect and action failure. `stop` affects bridge-owned input. Internal inspection code should use movement/look/capture without `attack`, `use`, `drop` or inventory edits when the inspection must not change the world.

`ready` and `loading` describe the resource reload overlay. After connecting, `connected:true` can arrive while Vanilla still displays its terrain loading screen. Wait until `screen:null` before world movement; otherwise inspect the named screen and act on it. `input` also accepts `chat` and `command` to open the native chat/command interface before sending GUI text. Asynchronous screenshot telemetry is associated with `captureFrame`; `readbackCompletedAt` records when PNG readback finished.

## Build and verification

Use a portable JDK 25 and Node.js 24; no system-wide installation is needed:

```powershell
node scripts/fabric-build.mjs --java-home C:\path\to\jdk-25
node scripts/fabric-build.mjs --java-home C:\path\to\jdk-25 --versions 1.20,26.3
```

`source-snapshots/<sourceSha256>` preserves each Java source revision used by the shipped artifacts. To rebuild a recorded revision, add `--source-sha <the version's sourceSha256>` with the desired `--versions`. The build checks the snapshot's content hash before compilation. Rebuilding creates new JAR hashes and requires runtime revalidation; it does not inherit an old artifact's pass automatically.

The build downloads official manifests, exact-version Yarn mappings, Fabric compile dependencies and unobfuscated client jars into `work/fabric-tools`. Client downloads are SHA-1 checked against Mojang's manifest. Java bytecode targets each game's required Java version (17, 21 or 25). Each artifact's SHA-256, compile source SHA-256 and exact hook signatures are written to `compatibility.json`; building one version preserves the other versions' original compile hashes. Minecraft code is not included inside the mod JARs.

Developer smoke testing uses `scripts/fabric-smoke.mjs --java-home ... --version 26.3`. It creates a separate `work/fabric-tools/smoke-<version>` game directory with a dummy offline identity and no access to existing accounts, saves or configuration. It is for local QA; normal users launch their authenticated client through their launcher. An optional `--server <port>` connects only to `127.0.0.1` for an offline local test server. Logs and launch arguments remain in that isolated directory. Runtime evidence must name the version and actual scenarios exercised; do not set all versions verified from one successful client launch.

Use `--stay` to retain the owning launcher process during QA. The isolated instance disables pause on lost focus so concurrent test clients cannot open each other's game menus. `scripts/fabric-matrix.mjs --java-home ... --accept-eula` runs the modern five-release matrix against exact-version local Vanilla servers, including native HUD/chest screenshots, bounded movement and cancellation, inventory clicks, Korean GUI text, mouse/scroll events and real collision snapshots. `scripts/fabric-merge-evidence.mjs` marks a runtime pass only when all seven core scenarios pass and the installed JAR SHA-256 matches the current compiled artifact.

## Offline collision registry data

Where present, `bridges/fabric/collision-data/<version>.json.gz` contains data exported by that exact game client, with a neighboring `.metadata.json` recording the gzip SHA-256, installed bridge artifact SHA-256, registry fingerprint, game version and observed counts. The index records completed and missing versions; an absent table does not imply compatibility. `defaultStates` records each block's real default properties; `states` lists every literal registry state. Coordinates in `shapes` are local block AABBs. An empty shape is `[]`; an unproven state is `null` with a reason.

A static row requires Minecraft's own collision cache, agreement with a traced empty collision context, and no world dependency or entity-context read. This includes ordinary stairs, doors, fences and walls when their actual state properties are supplied. Default expansion supplies native literal defaults; it does not simulate block placement, redstone, neighbor updates or recompute a stair's `shape` property from a schematic's neighbors.

For states without that guarantee, an export can additionally trace up to 4,096 loaded positions. A usable `contextCases` row records the exact dimension, position, literal state, every block/fluid read as an offset plus expected state, and any world height/minimum-Y read. Consumers must require all of those conditions to match. Cases are observations with empty collision context, not an exhaustive table of all neighborhoods or entity behavior. Position is required even when dependencies are empty: bamboo and pointed dripstone can offset their shapes from world coordinates. Block-entity reads and entity-sensitive cases such as powder snow, scaffolding and moving pistons remain unknown. Missing chunks remain unknown and are never generated by export.

Exports use an eight millisecond budget per game tick and serialize gzip on a background worker. They do not place blocks, change worlds or press input. The optional developer `--fixture` flag below deliberately places a small local test fixture through operator commands and checks position-dependent bamboo and unsupported powder-snow behavior; use it only in the isolated QA server.

```powershell
node scripts/fabric-collision-export.mjs --discovery C:\path\to\fabric-PID.json
node scripts/fabric-collision-export.mjs --discovery C:\path\to\fabric-PID.json --fixture
node scripts/fabric-collision-matrix.mjs --java-home C:\path\to\jdk-25 --resume
```

The table matrix launches real exact-version clients at their title screens in separate `work/fabric-registry-runtime/<version>` directories, captures their native framebuffers and verifies each exported registry. `--resume` reuses a table only when both its gzip checksum and current JAR hash match. `fabric-smoke.mjs --game-dir <directory>` also supports isolated directories for parallel server QA.
