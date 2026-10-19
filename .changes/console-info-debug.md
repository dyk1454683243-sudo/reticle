### Fixed

- **`@reticlehq/engine`: a `console` check now reads `console.info` and `console.debug`.** The browser SDK records both, but the check refused `level: "info"` as "not captured" and skipped info lines. So `{ contains: "X", absent: true }` passed while X was logged with `console.info`. A check that names a message now matches it at any level. A clean-console check with no message still ignores info and debug.
