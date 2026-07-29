# Phase 1 VAD experiment

Status: **shell ready; live comparison pending**

Run the same representative fixture with local VAD on and off. Compare:

- submitted audio milliseconds;
- clipped onsets/endings;
- missing short acknowledgements;
- first partial and final latency;
- provider usage and cost;
- dropped chunks and reconnects.

Keep VAD only if it reduces billed/submitted audio without material semantic
loss or clipped engineering values.
