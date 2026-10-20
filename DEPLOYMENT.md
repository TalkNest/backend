# TalkNest refresh — operational notes

## Entry point and scope

`npm start` runs **index.js**, not the legacy `server.js`.
`service.js` handles authenticated REST and Socket.IO; `store.js` is the Firebase
adapter. The old files remain for reference only.

The refresh writes exclusively to `talknest_v2_profiles` and
`talknest_v2_conversations/{id}/messages`. Old data is not deleted, migrated, or
silently exposed. Message reads return the newest 100 messages; older-message
pagination and image/file attachments are not implemented in this refresh.

## Free-host deployment

1. Use Node 22 and Render **Free** web service, build `npm ci --omit=dev`,
   start `npm start`, health check `/health`.
2. Set `ALLOWED_ORIGINS` to the exact frontend HTTPS origin (comma-separated).
3. Set `FIREBASE_CREDENTIALS` as a secret environment variable. Use a dedicated
   Firebase service account; never commit or paste its private key into chat.
4. Set up Firestore and Authentication in the chosen Firebase project.
   Prefer a **Spark** project if a hard no-charge boundary is needed. Blaze can
   bill beyond free quotas; a budget alert is not a hard spending cap.
5. Firestore **client access must be denied** for the refresh's collections.
   All writes go through this server. `firestore.rules` is a deny-all template for
   a dedicated project. Inspect existing rules before changing a shared project;
   a permissive wildcard rule overrides narrower deny rules.
6. Enable the chosen email/password or Google provider and add the frontend
   hostname to Firebase Authentication's authorized domains.

No production credential or database rule is installed by this repository.
Do not call the deployment ready until auth, private database access, and two
real accounts have been checked on the deployed hosts.

## Calling

Signaling uses authenticated user rooms, per-call ownership, busy checks,
ring/connection timeouts and disconnect cleanup. A single process holds presence
and call state. A restart terminates active calls; multiple replicas require
shared presence/call state and a Socket.IO adapter.

WebRTC currently uses STUN. Direct peer connections will not work on every
NAT/firewall. A production TURN broker providing short-lived credentials is still
needed for reliable cross-network calling; do not embed long-lived TURN passwords
in the frontend. No call recording is implemented.

## Limits and verification

Render Free services sleep after idle periods, have a shared monthly quota, and
can take time to wake up. This is a hobby deployment, not a production SLA.
Authenticated API rate limits and message-size limits reduce accidental abuse;
they are in-memory, per-instance limits, not a distributed anti-abuse system.

`npm test -- --runInBand` tests authentication, chat ownership, sender spoofing,
idempotency, CORS, offline/busy handling, signaling ownership and hang-up cleanup.
The storage interface is mocked in these tests. They do not establish live
Firestore durability or real camera/microphone media transport.
