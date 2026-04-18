const { loadSettings } = require('../../utils/config');

/**
 * Extract prompt from promptData and apply runtime theme
 * @param {string|object} promptData - Either a string or {prompt, hasPerson, ...}
 * @param {object} theme - Runtime theme to apply {background, color_grade}
 */
function extractPrompt(promptData, theme = null) {
  let basePrompt;
  if (typeof promptData === 'string') {
    basePrompt = promptData;
  } else {
    basePrompt = promptData.prompt || String(promptData);
  }

  // Apply theme at runtime for unified backgrounds across generation run
  if (theme && theme.background) {
    return `${basePrompt}, ${theme.background}, ${theme.color_grade}`;
  }

  return basePrompt;
}

/**
 * Generate an image using fal.ai API
 * @param {string|object} promptData - Either a string or {prompt, hasPerson}
 * @param {object} options - Generation options including runtime theme
 */
async function generateImage(promptData, options = {}) {
  const FAL_KEY = process.env.FAL_KEY;

  if (!FAL_KEY) {
    throw new Error('FAL_KEY environment variable not set');
  }

  const settings = loadSettings();
  const model = options.model || settings.generation.defaultModel;
  const aspectRatio = options.aspectRatio || settings.defaultAspectRatio;

  // Extract prompt and apply runtime theme
  const finalPrompt = extractPrompt(promptData, options.theme);
  const hasPerson = typeof promptData === 'object' ? promptData.hasPerson : true;

  console.log(`[fal.ai] Generating with ${model}, ${aspectRatio}, hasPerson: ${hasPerson}`);
  if (options.theme) {
    console.log(`[fal.ai] Runtime theme: ${options.theme.name || options.theme.key}`);
  }
  console.log(`[fal.ai] Prompt: ${finalPrompt.substring(0, 120)}...`);

  // Map model ID to fal.ai endpoint
  const endpoint = `https://fal.run/${model}`;

  const payload = {
    prompt: finalPrompt,
    aspect_ratio: aspectRatio,
    resolution: '1K',
    num_images: 1,
    output_format: 'png',
    safety_tolerance: '6'
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`fal.ai API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  // Extract image URL from response
  if (result.images && result.images.length > 0) {
    return {
      url: result.images[0].url,
      width: result.images[0].width || 1920,
      height: result.images[0].height || 1080,
      model: model
    };
  }

  throw new Error('No image returned from fal.ai');
}

/**
 * Download image from URL and return as buffer
 */
async function downloadImage(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  generateImage,
  downloadImage
};
