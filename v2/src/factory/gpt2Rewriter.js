// gpt-image-2 prompt rewriter.
//
// gpt-image-2 responds poorly to keyword-stacked prompts (the shape nano-banana
// and flux models prefer). It produces posed, symmetric, editorial output that
// looks more like a stock-photo shoot than a candid photograph.
//
// Three structural rules, extracted from empirically-successful gpt-2 prompts:
//   1. Long continuous prose, not comma-stacked phrases
//   2. Explicit "iPhone/candid/handheld" device framing
//   3. Enumerated imperfection clauses + anti-directives ("avoid symmetry…")
//
// The 9-move template below is gpt-2 behavior, not brand-specific — it lives in
// the engine. Brand flavor (warm editorial, cozy interiors, diverse models,
// avoided clichés) comes from cartridge/<name>/gpt2_rewriter.md, loaded
// optionally and stitched into the system prompt.

const FEW_SHOT_EXAMPLES = [
  `A realistic mirror selfie of a young woman standing in a bathroom, holding a smartphone in front of her face while looking at the screen, with one hand holding the phone at chest level partially covering her face and the other hand resting casually on her hip. Her body is slightly angled rather than straight-on, and the frame captures her from mid-thigh to head with a natural crop. She has soft natural makeup with glowing skin, shoulder-length styled hair with slight volume, and is wearing a fitted white sleeveless top along with minimal but stylish jewelry. The environment is a cozy bathroom interior with a colored wall in teal combined with white paneling, a framed artwork visible in the background, and slight visibility of mirror edges to enhance realism. The lighting is warm indoor light coming softly from above or the side, creating gentle shadows without any harsh flash. The phone resembles an iPhone with a colorful case, showing slight reflection or glare on its surface. The image should have an iPhone mirror selfie look with slightly soft focus rather than ultra sharp detail, natural warm tones, subtle grain, and small imperfections like faint mirror smudges or dust marks. The overall mood is casual, confident, and everyday, with a natural social media candid vibe that does not feel posed like a professional shoot. Avoid perfect symmetry, maintain realistic proportions and reflections, and keep small imperfections in lighting, framing, and mirror details to preserve authenticity.`,
  `A candid indoor photo of a young man standing close to the camera in a relaxed home setting, wearing an open white button-down shirt with no undershirt so his torso is visible, and a white skincare face mask applied unevenly across his face. He is leaning slightly forward toward the camera, with one arm raised above and partially entering the top of the frame as if adjusting something or holding a phone, while the other hand rests casually near his waist. The framing is a medium close-up from waist to head with a slightly tight crop. He has a natural body that is not overly muscular, slightly messy or damp-styled hair, and a relaxed expression while looking directly at the camera. The environment is softly lit with warm indoor lighting in yellow or orange tones, and the background is slightly out of focus, hinting at a bedroom or bathroom with subtle practical lights like a lamp or ambient source. The image should feel like an iPhone front-camera selfie, with slight wide-angle distortion, soft shadows, natural skin texture without heavy retouching, and slightly imperfect exposure and framing. The face mask should look realistically uneven rather than perfectly applied, the shirt slightly wrinkled and casually worn, and the overall scene should feel spontaneous and unposed. The mood is intimate, casual, and late-night, capturing a raw, unfiltered everyday moment. Avoid any cinematic or editorial styling, keep it natural and slightly messy, and do not introduce perfect symmetry or studio-level polish.`,
  `A candid street-style photo of a young man walking casually on a quiet urban street during daytime, moving toward the camera in a relaxed and natural way, with one hand slightly adjusting near his waist or pocket and the other holding a drink such as iced coffee in a plastic cup. His body movement feels fluid and unposed, with messy, slightly voluminous hair, wearing round sunglasses, a fitted white t-shirt with a small graphic on the chest, casual blue jeans, and minimal accessories. The environment is a narrow city street lined with buildings on both sides, featuring a mix of modern and older architecture, with a sidewalk visible and some plants along one side, creating a sense of depth in the background. The lighting is natural daylight with a late afternoon feel, producing soft shadows from the buildings and slightly uneven lighting where some areas are brighter while others fall into shade. The image should feel like an iPhone candid shot with a slightly wide-angle perspective around 24-28mm, where the subject is centered but not perfectly framed, with slight motion blur from walking and a handheld, slightly unstable feel. Details such as a slightly reflective drink cup, a subtly wrinkled t-shirt, and background people softly out of focus add realism. The overall mood is effortless, cool, and everyday, capturing a spontaneous street moment that feels like a quick snap rather than a photoshoot. Avoid model-like posing, keep the movement natural and slightly imperfect, and do not apply cinematic grading or studio-style lighting.`
];

function buildSystemPrompt(brandVoice = '') {
  const brandBlock = brandVoice.trim()
    ? `\n\nBRAND CONTEXT (honor when rewriting — do not contradict):\n${brandVoice.trim()}\n`
    : '';

  return `You rewrite image prompts so they produce REALISTIC CANDID PHOTOGRAPHS on OpenAI's gpt-image-2 model. You do not generate images. You do not change the subject matter. You rewrite keyword-style prompts into continuous prose that gpt-image-2 interprets as real photography instead of editorial stock.

GPT-IMAGE-2's DEFAULT FAILURE MODE: too clean, too symmetric, too posed, too "professional photoshoot." Your rewritten prompt must actively push against this with device-framing, asymmetry, and enumerated imperfections.

OUTPUT FORMAT: a single paragraph of prose, 110–180 words. No bullet points. No section headers. No Markdown. No keywords separated by commas. Full English sentences.

THE 9-MOVE STRUCTURE (every rewrite must contain all nine, in this order, woven into prose):

1. SHOT QUALIFIER — opening sentence: "A candid/realistic/everyday [setting] photo of a [subject] [doing action]…"
2. BODY + FRAMING — describe what each hand/limb is doing, body angle, specific crop (e.g. "mid-thigh to head"), posture texture.
3. WARDROBE + GROOMING — fabrics named (fitted, ribbed, cotton), with small imperfections (wrinkled, damp, smudged, uneven).
4. ENVIRONMENT IN LAYERS — 2–3 sentences building architectural depth: background elements, practical light sources, depth cues.
5. LIGHTING IN PHOTOGRAPHER VOCABULARY — named source (warm indoor, late-afternoon window, overhead practical), shadow behavior, uneven vs even.
6. CAMERA / DEVICE HINT — "iPhone [front/back] camera", "slightly wide-angle around 24-28mm", "handheld, slightly unstable feel", or similar.
7. IMPERFECTION CLAUSE — enumerate 3–5 specific flaws: motion blur, soft focus, subtle grain, slight exposure unevenness, wrinkled fabric, smudges, asymmetric framing, background people out of focus.
8. MOOD LINE — "The mood is [adj], [adj], and [adj]" with a qualifier like "social-media candid", "late-night", "everyday".
9. ANTI-DIRECTIVE TAIL — "Avoid [model-like posing / cinematic grading / perfect symmetry / studio polish]. Keep [naturalness]. Do not [introduce glossy retouching / over-stylize]."

HARD RULES:
- Preserve the subject of the original prompt exactly. If it names a substance, body region, or product type, keep it.
- Never name a real brand, logo, or product name — keep subjects generic (a tub of cream, a serum bottle, a device) unless the original explicitly included one.
- Never describe text, labels, or packaging copy on any object.
- Do not introduce people if the original prompt had none. Do not remove people if the original had them.
- Keep the composition family roughly intact (overhead → overhead, portrait → portrait, macro → macro) — but describe it as candid rather than art-directed.${brandBlock}

Return ONLY the rewritten prompt as prose. No prefix, no suffix, no quotes.`;
}

async function rewriteForGpt2({ prompt, brandVoice = '', model = 'anthropic/claude-3-haiku', context = {} } = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  if (!prompt || typeof prompt !== 'string') throw new Error('prompt (string) required');

  const systemPrompt = buildSystemPrompt(brandVoice);
  const contextTags = [
    context.subject_type && `subject_type: ${context.subject_type}`,
    context.subject_topic && `subject_topic: ${context.subject_topic}`,
    context.composition && `composition: ${context.composition}`,
    context.body_region && context.body_region !== 'default' && `body_region: ${context.body_region}`,
    context.theme && `theme: ${context.theme}`
  ].filter(Boolean).join(' · ');

  const userPrompt =
    `Rewrite this image prompt following the 9-move structure for realistic gpt-image-2 output.\n\n` +
    (contextTags ? `Shot context: ${contextTags}\n\n` : '') +
    `ORIGINAL PROMPT:\n${prompt}\n\n` +
    `FEW-SHOT EXAMPLES of the target style (rewrite should match this voice, length, and structure — NOT the subject):\n\n` +
    FEW_SHOT_EXAMPLES.map((ex, i) => `Example ${i + 1}:\n${ex}`).join('\n\n') +
    `\n\nNow rewrite the ORIGINAL PROMPT above. One paragraph, 110–180 words, all 9 moves.`;

  const t0 = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3002',
      'X-Title': 'Brand Image Blaster v2'
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const result = await response.json();
  const rewritten = (result.choices?.[0]?.message?.content || '').trim()
    .replace(/^["“”']+|["“”']+$/g, '')   // strip outer quotes if Haiku adds them
    .replace(/^```[a-z]*\s*|\s*```$/g, ''); // strip fences just in case

  return {
    rewritten,
    meta: {
      model,
      elapsedMs: Date.now() - t0,
      systemPromptChars: systemPrompt.length,
      userPromptChars: userPrompt.length,
      tokensUsed: result.usage,
      originalChars: prompt.length,
      rewrittenChars: rewritten.length
    }
  };
}

module.exports = { rewriteForGpt2, buildSystemPrompt };
