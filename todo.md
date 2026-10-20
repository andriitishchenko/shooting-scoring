# Backlog

## Done

1. The host can edit results in the detail view (`detail-score-grid`) in `host.html`.
   Test: `frontend/tests/host.test.js`.

2. The client refreshes the data after the user deletes scores. A user can save a result twice, open it again, and delete the last scores. The server then keeps only the remaining scores.
   Tests: `frontend/tests/contract.test.js` (real client and real Node server) and `frontend/tests/client.test.js`.

### JS client review (2026-10-17)

Items 3 to 19 are done. Each item has a test in `frontend/tests/client.test.js`, `api.test.js`, `websocket.test.js`, or `contract.test.js`.

3. The lane password screen stays open when the socket authenticates.
4. A failed event load stops the login.
5. The WebSocket client reconnects without a fixed limit, cancels timers, and isolates listener errors.
6. Each request has a timeout.
7. The shot buttons show the shots in shot order.
8. A network error does not clear a valid lane session.
9. One serialized `_reconcile()` function handles all server events.
10. A double submit of a participant sends one request.
11. The password screen has one key handler.
12. The password screen shows the real error.
13. The lane password is not in an HTML attribute.
14. The copy button reports a failed copy.
15. The client uses event delegation, not inline `onclick`.
16. Unsent scores from an old session go to a recovery archive. The user can download them.
17. API errors show readable text.
18. The code is encoded in URLs and checked in `?code=`.
19. Cleanup is done. The class is `AppStorage`. `CONFIG` has `LANE_COUNT` and `SERIES_SIZE`.

### Node server review (2026-10-17)

20. The server limits the request body (`MAX_BODY_BYTES`, default 4 MiB) and answers `413`.
21. The server accepts WebSocket messages of 4096 bytes or less.
22. The WebSocket upgrade handler does not stop the server when the URL is not valid. Before this change, `/ws/%ZZ` stopped the process.
23. The server closes a WebSocket with code `1011` after a server error and with code `1008` after a rejected session. The client connects again after code `1011`.
24. The server pings each WebSocket every 30 seconds and closes a connection that does not answer. This keeps proxy connections open.
25. `TRUSTED_PROXIES` makes the login limit work behind a reverse proxy. Without it, one user can lock the login for all users.
26. A score update refreshes one participant. Before this change, each saved shot caused a full lane reload.
27. `viewer.html` accepts 6 characters in the event code field.

### Lost logic and important findings (2026-10-17)

28. The lane list loads when one participant request fails. The client shows the saved scores and a notice. Test: `frontend/tests/client.test.js`.
29. Unsent scores of a finished event move to the recovery archive. The user can download them. The client does not accept score deletion after the event finished. Tests: `client.test.js` and `contract.test.js`.
30. The recovery archive does not keep two records for the same scores. Two archives in the same millisecond do not replace each other.
31. The client connects the WebSocket after login even when the first lane load fails.
32. The Node server checks and creates passwords in the thread pool. Before this change, each failed login stopped the server for about 120 ms. FastAPI uses `asyncio.to_thread` for the same work.
33. The server counts a login attempt before it checks the password. Parallel requests cannot pass the limit. Two devices that open the same new lane at the same time get one password.
34. The server limits failed logins from one address across all lanes and roles (`LOGIN_FAILURE_LIMIT`, default 100).
35. The server limits event creation for one address (`EVENT_CREATE_LIMIT`, default 60 each hour).

### Review of host, viewer, and architecture (2026-10-17)

36. The server runs each change and its notification in one transaction (`transaction()` accepts nested calls). The server reads the state inside the transaction. A failed notification does not leave a saved change.
37. The server deletes notifications older than one day.
38. The server does not write an error log when a client disconnects during an upload.
39. The leaderboard uses an index, not a search for each participant.
40. The viewer keeps one retry timer and one refresh timer. After exit, the viewer sends no request.
41. The host reloads once for many score updates. An older response cannot replace a newer one.
42. The host offers to create an event only when the server answers `404`.
43. The host settings do not open with default values when the load fails. Before this change, a save could set `allow add participant` to the default value.
44. The host page makes the QR code in the browser with `qrcode-generator`. The server provides the script at `/vendor/qrcode.js` (Node.js only). The link does not go to another service. A scanner decoded the generated QR code to the correct link.
45. The client leaves a distance with an uneven last series without a false warning.
46. The client shows lanes above 28 when participants use them.
47. Contract tests call each method of `api.js` and run the real host and viewer scripts against the Node server.

### Node.js server redesign (2026-10-18)

The Node.js server is now a separate service. It has its own database and does not depend on FastAPI.

48. One process with a lock file on the data folder. Messages go from memory to memory. No notification table, no polling, no pruning.
49. Own database format with migrations (`user_version`), WAL, foreign keys, and indexes. One file for each event in `backend-node/data`.
50. Layers: `http/`, `domain/`, `db/`, `security/`, `ws/`. A handler that changes data runs in one synchronous transaction. The notification waits for the commit.
51. Own input schemas. No `openapi.json`, no `/docs`, no `/redoc`.
52. Passwords use scrypt in the thread pool. The limits for logins and for event creation are in memory. A login attempt counts before the check.
53. Sessions: hashed token in an indexed table, several sessions for each role, a lifetime of 14 days, revocation after a password change or a lane reset. The server closes the sockets of a revoked session.
54. The static file server keeps small files in memory, compresses them (brotli, gzip), and uses ETag. It checks a file again once each second.
55. The WebSocket hub: ping every 30 seconds, close codes, limit for the number of sockets, drop of a slow client.
56. The leaderboard is calculated one time for each change of the data.
57. Orderly stop on `SIGTERM` and `SIGINT`. The start message shows the network addresses. A backup script. `LOG_LEVEL`.
58. 246 tests for the server, with 98% line coverage. The frontend has 111 tests. The parity tests with FastAPI are gone.
59. Documents and start scripts are for Node.js (`README.md`, `SETUP.md`, `DOCUMENTATION.md`, `regression_testing.md`, `backend-node/README.md`, `backend-node/docs/API.md`).
60. Measured speed: 3 to 10 times more requests per second than the first Node.js port, and 30% less memory.

### Client changes for the new server

61. The allow-add setting is a boolean in the host page.
62. The host page returns to the login screen when the socket rejects its session. It also follows `event_status` and `distance_update` of another admin device.
63. The viewer page follows the changes live through a WebSocket. The two-minute refresh is a backup. It asks for the password again after a password change.
64. A `429` message shows how long to wait.

### Decisions of 2026-10-18

65. Ranking: more points, then more 10s (an X is a 10), then more X. Equal participants share a rank. The server orders each group. The pages use `frontend/js/ranking.js`.
66. The host sees the lane passwords next to the lanes. The database keeps the lane password in the clear (`lanes.password`).
67. Strict Content-Security-Policy. The pages have no inline handlers. `frontend/js/actions.js` runs registered actions from `data-*` attributes.
68. The lock file has a time that the server renews. A stopped or crashed server never blocks the next start. Nobody must delete the file.

### Features of 2026-10-18 (evening)

69. The host copies a lane password with a double click.
70. The participant card of the client shows the number of results that are entered for each distance (`shots_taken` in the state of a participant).
71. A lane that lost its password asks the host for a reset. The host approves or denies in the host panel. After an approval, the device that asked shows the new password like on the first entry. The request waits 15 minutes in memory, survives a page reload on the client, and an approval ends the other sessions of the lane.

72. After `session_rejected`, the viewer keeps the results on the screen and logs in again. After a network error, it tries again after 3 seconds, then 6, 12, and up to 30 seconds. If the server asks for a password, the viewer shows the password screen.

## Open

- Unsent client scores can replace a host correction on a finished distance. The last write wins. The server accepts this by design.
- The `backend` folder (FastAPI) is not used and not changed. Nobody needs its data.

## Auto-review backlog

1. 2026-10-19 · low · `backend-node/src/domain/resets.js:29` · A new reset request replaces a request that the host approved but that the device did not collect.
   - Failure scenario: Lane 3 asks for a reset. The host approves. The old sessions of lane 3 end. Before the device asks for the result, a second device sends `POST /api/sessions/:code/lane/3/reset-request`. The first device gets `expired` and has no session. The host must read the new password in the host panel and give it to the lane.
   - Not fixed: The correct rule needs a decision of the user. Two options: refuse a new request (409) while an approved result waits, or keep the approved result next to the new request.

