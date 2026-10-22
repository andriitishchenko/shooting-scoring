# Separate Scoring application

The **Scoring** link on the home page opens `/scoring/`.
The application files are in `frontend/scoring`.
The Node.js server serves this folder with the other frontend files.

## Build

The imported archive is `archeryscoring-web.zip`, version `1.1.2`, build `1`.
The archive has this SHA-256 value:

```text
688bcdef242df1c9b53541cb916738e7b9a04765cda236de149bab1a87d7926f
```

The copy has three changes:

- `index.html` uses `<base href="/scoring/">`.
- `manifest.json` uses `/scoring/` for its ID, start URL, and scope.
- `flutter_bootstrap.js` does not register the disabled Flutter service worker.
  This prevents a four-second wait at startup.

The copy does not contain the `.DS_Store` file from the archive.
All other application files are included. The Dart application is unchanged.

CanvasKit is the graphics runtime of this Flutter build. Its JavaScript and
WebAssembly files load from `/scoring/canvaskit/`. The build includes Roboto.
Flutter can also load fallback fonts from `https://fonts.gstatic.com`.

## Server settings

The server sends `application/wasm` for WebAssembly files. It also sends the
font and JPEG content types.

Only `/scoring/` uses the Flutter Content-Security-Policy. That policy permits
WebAssembly, image blobs, and fallback fonts. Other pages keep their existing
policy. An explicit `CONTENT_SECURITY_POLICY` setting has priority.

Publish the updated server files and the complete `frontend/scoring` folder.
Restart the Node.js server after you publish the server changes.
A reverse proxy must forward `/scoring/` to the Node.js server.

## Verification

Run `npm run test:all` from `backend-node`.
The added checks are in `backend-node/tests/scoring-app.test.js`.
Open the home page. Select **Scoring**. Check that the target list opens.

## Language review

Check the technical terms CanvasKit, WebAssembly, and service worker against
the ASD-STE100 Issue 9 dictionary before publication.
