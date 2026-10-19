# Examples

Both examples install the actual built NPM tarball, rather than importing `src/`.
They ask for your credentials, generate a random project ID and remember only that
non-secret ID in localStorage. Re-enter the same credentials after a page reload.
First use creates a local Admin project; neither example grants access to someone
else's project merely from an ID.

From the repository root, with Node.js 24 and Emscripten activated:

```sh
npm ci
npm run demo:prepare
npm run demo:react     # http://127.0.0.1:4182
# Or, in another terminal:
npm run demo:vanilla   # http://127.0.0.1:4183
```

| Example | Demonstrates |
| --- | --- |
| [React To-Do + files](react-demo/src/App.jsx) | `useProject`, `ProjectProvider`, `useLiveQuery`, task add/update/delete, `useStorage` upload/progress/cancel and streamed export |
| [Vanilla TypeScript To-Do](vanilla-todo/src/main.ts) | Direct `LocalCoreClient` create/open, dispatch, snapshots, commit subscriptions and explicit close |
| [Two-device sync](vanilla-todo/sync.html) | Separate local wallets, root-pinned signed invitations, encrypted Nostr discovery, real WebRTC, offline edits/reconnect and OPFS recovery; open `/sync.html` in the Vanilla example |

The React example uses Strict Mode and cleans up its session on close. Large file
export uses the browser's save-file stream; the fallback Blob path supports at
most 16 MiB. Files remain local until a connected, authorized peer requests them.

The To-Do examples do not connect to any relay automatically. The two-device page
connects only after you click **Connect peers**, with editable public Nostr relay
and ICE settings. See the [complete two-device walkthrough](../docs/ADOPTION.md).
For other integrations, configure
`P2PSync` with your own signaling URL and a shared random room token, distribute
Admin-signed invitations, and register the transport with `client.storage.addPeer`.
See [the complete P2P contract](../docs/P2P.md).

Core browser, crypto and DX test harnesses live under `tests/fixtures/`; their
deliberately fixed test credentials and identifiers are not part of these examples.
