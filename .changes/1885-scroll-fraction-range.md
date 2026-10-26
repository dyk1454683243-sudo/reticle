### Fixed

- **`@reticlehq/browser`: out-of-range scroll fraction silently degraded to a normal step.** Passing a `fraction` outside the valid range of 0–1 (such as `1.5` or `-0.2`) failed the bounds check and silently performed a default viewport scroll step without notifying the caller. The browser action now rejects out-of-range fraction values before executing, throwing a RangeError that specifies the allowed 0–1 range. Closes [#1885](https://github.com/reticlehq/reticle/issues/1885).
