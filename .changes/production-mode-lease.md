### Added

- **`@reticlehq/server`: `reticle_lease { action: "acquire", url, production: { workspaceId, scope, intent? } }` opens a production drive in one step.** The daemon mints a session nonce for the site's origin, asks the linked Reticle service for an activation ticket (`POST /v1/production-mode/tickets { workspaceId, nonce, bridgePort, scope }`, authenticated with the linked API key), and opens `<url>?reticle_activate=<ticket>`. The leased page gets no injected SDK: the site loads its own behind the ticket. Every request the leased page sends passes the production policy before it leaves the browser, and a refused one is answered 403 and fails the act that sent it. A service without the ticket route gets a clear refusal: "the server does not offer production mode".

### Changed

- **`@reticlehq/server`: a leased Chromium starts with `--disable-features=LocalNetworkAccessChecks`.** Chromium 151 blocks a public page from reaching `ws://127.0.0.1` unless a person grants it, and a leased browser has no person. Without the flag, a production drive's page could never reach the bridge.
