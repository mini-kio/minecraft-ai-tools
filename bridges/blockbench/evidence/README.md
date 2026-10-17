# Blockbench runtime evidence

Official Windows desktop Blockbench 4.12.6 and 5.2.2 were exercised in isolated profiles using the actual plugin file loader, real CLI model/external PNG files, production WebSocket services, native model codec and renderer. No fixture filesystem adapter or app permission change was used. Model and texture data travels through the production CLI bridge.

| Version | Checks | Evidence |
|---|---:|---|
| 4.12.6 | 15 passed | [Metadata](4.12.6/metadata.json) · [Raw report](4.12.6/evidence.json) |
| 5.2.2 | 16 passed | [Metadata](5.2.2/metadata.json) · [Raw report](5.2.2/evidence.json) |

Each version includes actual initial.png, half.png, camera.png and externalTexture.png captures. Initial/half retain the same camera and differ in animation time. Camera/externalTexture retain the same camera and animation time and differ after editing the real PNG and reloading. SHA256 and portable filenames are in metadata.json. Original model bytes remain unchanged by observation, malformed reload keeps the working project, and closing a session preserves an unrelated project.

The 5.2.2 raw report retains official app startup console errors. The [independent app-only baseline](5.2.2/vanilla-startup-baseline.json) and [source diagnosis](5.2.2/console-diagnosis.json) reproduce them without MCT. They originate in official start-screen resizer initialization. The application was not patched; this does not certify a clean upstream console.

Raw reports retain historical absolute paths; adjacent copied PNGs are portable. Accounts, tokens, profiles, permission state, app binaries and fixture filesystem shims are excluded. [Reproduction instructions](../../../docs/testing-blockbench.md).
