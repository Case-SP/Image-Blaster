# v2 — Brand Image Blaster

Parallel pipeline with live chain-inspection UI. Runs on port 3002.

## Run
```
cd v2
node src/server.js                        # UI at http://localhost:3002
```

## CLI (for scripting)
```
node -e "require('./src/orchestrator').runBatch({ titles: [...], N: 10 })"
```

## What this gives you
Every batch produces a trace at `data/traces/<runId>.json` capturing every stage of the prompt chain. Open the UI to inspect runs live or historically. Tag images `usable | not-usable | winner` to build the hit-rate dataset.

## Cartridge
`cartridge/<brand>/` — drop a folder, swap brands. See cartridge/nolla/ as reference.
