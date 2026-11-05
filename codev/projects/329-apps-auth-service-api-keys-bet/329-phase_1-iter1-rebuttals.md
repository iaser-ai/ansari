# Phase 1, iteration 1: rebuttal

Reviews: codex REQUEST_CHANGES; gemini COMMENT (skipped, `agy` not installed).

1. Probe 1b did not prove every field changed: accepted. The update now changes all four (`rateLimitMax` 1→5, `rateLimitTimeWindow` 60 s→30 s, `refillAmount` →2, `refillInterval` →1 s, plus `remaining` →1), asserts each column, and exercises each at the next verify: the window cap, the exhausted budget, then a refill past the new interval (remaining refilled to 2, one spent).
2. The absolute-form target covered 2 of 5 endpoints: accepted. The target list is now every `API_KEY_PATHS` entry plus a mixed-case variant.
