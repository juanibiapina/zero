# TinyBase local-replica proof

**Result (2026-09-25): the transport and offline-durability slice works; the todo redesign is not ready to ship.** This private workspace uses the [TinyBase Cloudflare Durable Objects guide](https://tinybase.org/guides/integrations/cloudflare-durable-objects/) as its starting point. Its `WsServerDurableObject` owns a `MergeableStore` persisted in DO SQLite. A REST writer mutates that same store. An isolated Expo SDK 57 app uses the JSON-mode Expo SQLite persister and the WebSocket client synchronizer. No production app, Clerk session, `UserDO`, web route, or todo database is changed.

## Repeat

Requires Node 22+, pnpm, Podman, jq and curl. The Android run also requires one connected Pixel with `adb`, Maestro, and Expo Go for SDK 57 installed. Ports 8787 (Worker) and 8093 (Metro) must be free. These scripts run host Wrangler in `node:22-slim` through Podman because host `workerd` cannot start on NixOS. They remove their temporary DO storage and stop their servers on exit.

```bash
pnpm --dir spikes/tinybase install
pnpm --dir spikes/tinybase run typecheck
pnpm --dir spikes/tinybase/mobile exec tsc --noEmit
gob run bash spikes/tinybase/scripts/run.sh
# On a connected Android device:
gob run bash spikes/tinybase/scripts/run-mobile.sh
```

The Node proof starts two independent SQLite-persisted clients and a client for another account. It asserts REST → clients, client → server → client, offline edit after SQLite reopen, sync after reconnect, rejection of an invalid REST Task, isolation across the proof accounts, and DO persistence after a Worker restart. The Android script uses a unique proof ID; it asserts REST Project → phone, phone Task → server, force-stop and reopen with the Worker stopped, offline edit persistence after a second force-stop, reconnection, and isolation from the second account. The phone test runs in Expo Go, not the Zero Agent package or its SQLite files. `PROOF_KEEP_ARTIFACTS=1` retains script temp files for investigation.

**Observed gap:** a directly synchronized Task with a nonexistent `projectId` enters the DO store and reaches the second client, even though the REST writer rejects the same invalid reference. TinyBase merges cells; REST-only validation cannot enforce Task/Project or After integrity on its WebSocket path. No production data path may use this proof's direct sync without a tested integrity/recovery design. The `proof-user-a`/`proof-user-b` tokens are fixed local fixtures, not Clerk authentication.

**Still unproved:** integration with existing `UserDO` methods and real web routes; complete terminal-row import; Project completion/deletion cascades and concurrent late children; Waiting/After and recurrence; same-cell/deletion conflict outcomes; lost acknowledgments and reconnection retry; interrupted migration of `zero-app-outbox-v2.sqlite`; JSON-mode Android size/write latency; a standalone APK and the production app's exact dependency set. TinyBase 10.0.1 expects React `^19.3.0`, while this SDK 57 slice has React 19.2.3; the observed native runtime works for these core modules despite the peer mismatch. Expo's RN DevTools executable reports a NixOS dynamic-linker warning, but Metro and the Android proof run.
