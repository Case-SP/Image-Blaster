# Recast Systems — cloud-seeding company demo cartridge

Recast Systems makes the biology, the hardware, and the software for cloud seeding. The brand sits at the intersection of industrial design, atmospheric science, and aerial agriculture.

Every render is a single 4:5 contact sheet of 6 square panels on a `#FAFAFA` background. Each panel is one self-contained photograph drawn from one of five visual axes.

## The five visual axes (encoded in `intake.md` and `profile.json`)

1. **Studio hardware** — drones, robotic arms, sensor towers, machined aluminum modules on cool gray gradients
2. **Atmospheric sky** — dramatic cumulus, cirrus, stormfronts, twilight skies; sometimes a crescent moon
3. **Aerial top-down** — single small subject (tractor, vehicle, structure) in vast cultivated landscape
4. **Modular typology** — isometric arrays of small geometric structures on flat white, Eames-style accents
5. **Anonymous figures** — utility-wear figures, full-body, no faces, cutout grids or top-down

The intake LLM is instructed to span at least 3 of the 5 axes per contact sheet, so each render functions as a small brand-book page.

## How to prompt for a brand book

Paste any of these into the input field (the `titles` textarea in the UI, or as the title arg in `blast.js`). Each input becomes ONE contact sheet of 6 panels. Run with `N=3+` to get multiple variations of the same brief.

### Series prompts (the riff list)

```
series: drones in studio gradient
series: storm cell formation, dramatic atmospheric photography
series: aerial seeded fields at golden hour
series: anonymous figures in utility wear, walking
series: modular ground stations, isometric grid on white
series: brushed aluminum sensor housings
series: weatherproof equipment in the field
series: cloud forms Recast Systems reads — cumulus, cirrus, stratus, lenticular
series: hands operating equipment, no faces
series: agricultural patterns from above
```

### Brand-book prompts (open-ended)

```
what kind of materials defines this brand?
what kind of cloud forms would Recast Systems feature?
what kind of imagery for the about page?
what kind of vehicles and equipment in the field?
show me the hardware lineup
show me the human element — who operates this stuff
show me what we read in the sky
show me the network — installations across geographies
```

### Animal prompts (exploratory)

```
what kind of animals would Recast Systems feature in marketing?
animals adapted to weather extremes
birds that ride thermals — hawks, vultures, swallows, swifts
arid-climate fauna
```

The intake LLM will translate each into 6 panels that stay on brand (which means: probably not cute pets — likely raptors against dramatic skies, anonymous-figure-with-livestock at distance, or a single deer in cultivated land aerial).

## Smoke-test commands

```bash
# 1 brief × N=3 = 3 contact sheets, nano-only, 4:5
node scripts/blast.js --cartridge demo --count 1 --n-per 3 \
  --titles-prefix "series: drones in studio gradient"

# Same brief through both nano AND gpt-2 for A/B
node scripts/blast.js --cartridge demo --count 1 --n-per 2 \
  --models fal-ai/nano-banana,openai/gpt-image-2 \
  --quality low \
  --titles-prefix "series: storm cell formation, dramatic atmospheric photography"

# Five different briefs × N=2 = 10 sheets — confirms cross-brief consistency
for brief in \
  "series: drones in studio gradient" \
  "series: storm cell formation" \
  "series: aerial seeded fields" \
  "series: modular ground stations isometric" \
  "series: anonymous figures utility wear"; do
  node scripts/blast.js --cartridge demo --count 1 --n-per 2 --titles-prefix "$brief"
done
```

## Blast for ~200 images

200 conceptual images = ~34 contact sheets (6 panels each). Strategy: pick 6–8 series briefs, fire each with N=4–6.

```bash
# 8 briefs × N=4 × 1 model = 32 contact sheets ≈ 192 panels — ~$1.25 on cheap nano
for brief in \
  "series: drones in studio gradient" \
  "series: robotic arms, brushed aluminum, machined" \
  "series: storm cell formation, dramatic atmospheric photography" \
  "series: aerial seeded fields at golden hour" \
  "series: modular ground stations isometric on white" \
  "series: anonymous figures in utility wear walking, top-down" \
  "series: sensor towers in field at dusk" \
  "series: cloud forms — cumulus, cirrus, stratus, lenticular"; do
  node scripts/blast.js --cartridge demo --count 1 --n-per 4 --titles-prefix "$brief"
done
```

Cost: 32 renders × $0.039 (cheap nano) = **~$1.25** for ~192 panels.

For both-mode A/B: 32 × ($0.039 + $0.01) = **~$1.57** with gpt-2 LOW added.

## Iteration loop

If a brief produces off-brand panels, edit `profile.json` brand_dna or `intake.md` directly and re-run that brief. Server is on `--watch` so cartridge changes apply on next request (no restart). The references images in `references/` only matter at render time when using `nano-banana-pro` or `flux-pro/kontext` (the cheap `nano-banana` ignores them) — but the brand_dna text carries the references' visual language into every intake call.
