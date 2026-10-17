# Legacy Fabric runtime QA

`scripts/verify-fabric-legacy.mjs` launches exact-version client JARs using the project's Fabric smoke preparer. It uses an isolated offline `MctSmoke` identity, generated game directories under `work/fabric-tools/smoke-VERSION`, and evidence under `work/fabric-runtime-legacy/VERSION`. It does not use launcher credentials or existing saves.

Run `pnpm build` first. An explicit Java home is required. Java 25 was used on the development machine; compatibility of older clients with newer JVM/native libraries must be assessed from the actual logs.

```powershell
node scripts/verify-fabric-legacy.mjs --java-home C:\path\to\jdk --versions 1.20
```

That checks title-screen startup, observation, and a real framebuffer capture only. It deliberately leaves all gameplay scenario certifications unverified.

For full gameplay checks, review the [Minecraft EULA](https://aka.ms/MinecraftEULA) and supply the explicit opt-in. This creates an exact-version Vanilla server bound to loopback, a generated flat arena, a chest, and temporary operator privileges for the generated offline identity:

```powershell
node scripts/verify-fabric-legacy.mjs --java-home C:\path\to\jdk --versions 1.20,1.20.1 --gameplay --accept-eula
```

Omitting `--versions` selects every `1.x` version in the Fabric build matrix. Versions run sequentially. Server and client processes belong to the verifier and are stopped in its cleanup. The script never edits the shared Fabric compatibility matrix: evidence must be reviewed and merged by the build owner.

`--resume` reuses a version only when its saved seven gameplay scenarios, hotbar selection, GUI clicks and Unicode chat all passed and its loaded mod SHA-256 still matches the current exact-version JAR. A rebuild, partial result, or failure automatically runs again. Chest interaction retries reset the player pose and aim immediately before using the block, and retain missed poses as evidence if physical mouse movement interferes with the test client.

Gameplay success requires observed server connection; world/player/inventory inspection; actual position change from timed input; a player command confirmed by teleport position; opening a chest confirmed by menu slots; native framebuffer screenshots with HUD; and position stability after cancelling held input. A successful title-screen capture alone cannot mark a version runtime verified. Reports identify the SHA-256 of the exact loaded mod JAR.

The extended verifier also selects hotbar slots `0 → 7 → 0` and checks both player and inventory telemetry, rejecting out-of-range/fractional slots. Actual GUI left/right clicks operate a chest stack and confirm slot counts `3 → 0 → 3 → 1 → 3`, with slot actions restoring the cursor's stack between checks. Korean GUI text is captured in the chat field, submitted with the semantic Enter key, and confirmed in the Vanilla server log. These additional checks have their own evidence JSON and images.

Create the output directory's `stop.request` file (or pass `--stop-file FILE`) to stop after the current version's cleanup. SIGINT also requests a stop at that boundary. Remove the file before resuming. This lets a changed artifact finish its current isolated test without interrupting unrelated game processes.

Each version directory contains `result.json`, preparation/client logs, native PNG screenshots and metadata, plus the managed server's provenance and logs. The aggregate `results.json` records the actual seven scenario outcomes. Partial runs and failures retain evidence. A failed or incomplete scenario leaves `runtimeVerified: false`.

The first render hook may fire before vanilla finishes its initial resource reload. Current bridges expose `loading: false` only after the overlay finishes; the verifier waits for readiness and then one additional second. Older bridges without loading metadata receive a ten-second warmup. Override this with `--warmup-ms`. The eventual connection, movement, UI, and screenshot assertions still require actual success.

Cancellation is checked while facing an open section of the generated arena, away from the chest. The verifier first confirms the held input produced motion, then checks position stability after `stop`, so colliding with the chest cannot masquerade as a successful cancellation.

## Completed development run

On 2026-10-18 (Asia/Seoul), all 19 legacy releases passed the seven real gameplay checks: 1.20 through 1.20.6 (7 versions), and 1.21 through 1.21.11 (12 versions). The completed run is recorded in `work/fabric-runtime-legacy/final/results.json`; individual version directories retain native HUD/chest images and observations.

An independent `audit.json` in the same directory checked all 19 loaded JAR SHA-256 values against the distributed JARs at the time, confirmed horizontal movement while on the arena floor, observed actual chest menus, and checked both initial motion and stable position after cancellation. All 19 passed that historical audit. These results describe those tested artifacts on the development host; rebuilding a JAR requires rerunning its runtime checks. The extended hotbar/GUI/chat run records its final-artifact results separately under `work/fabric-runtime-legacy/expanded`.
