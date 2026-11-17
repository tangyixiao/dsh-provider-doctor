# 0.1.10 — HTTP admission hardening

All registered HTTP routes first call the Host's synchronous `connection.requestRejection(request)` policy, then require the authenticated owner. Missing methods, thrown checks, invalid results and asynchronous results fail closed before reading request bodies or performing route work. Existing local request restrictions and per-action keys remain in place.

The installed DSH 0.2.2-rc.3 implementation already applies its Host/Origin policy inside `admit`; this change makes the published route contract explicit and hardens broken-service handling. It does not claim a demonstrated authentication bypass in that runtime.

No live model calls or local profile changes are needed for this source change.
