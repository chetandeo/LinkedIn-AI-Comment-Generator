// background.js — service worker
// Holds the OpenRouter API key (never exposed to the LinkedIn page context)
// and performs the actual LLM call on behalf of content.js.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const CATEGORY_PROMPTS = {
  professional: [
    "You are writing a LinkedIn comment in a polished, professional tone.",
    "Add genuine value or insight related to the post — no fluff, no slang, no emoji.",
    "Keep it concise (1-3 sentences), specific, and worth reading.",
  ].join(" "),

  funny: [
    "You are writing a LinkedIn comment that is witty and tasteful.",
    "Make it genuinely funny while staying professional enough to post publicly.",
    "Use at most 1 emoji. Keep it short (1-3 sentences).",
  ].join(" "),

  absolute: [
    "You are writing a LinkedIn comment with a bold, no-hedging hot take.",
    "State a strong, confident opinion related to the post. No 'maybe' or 'I think'.",
    "Keep it short, punchy, and quotable (1-3 sentences).",
  ].join(" "),

  angry: [
    "You are writing a LinkedIn comment that expresses frustration or sharp criticism.",
    "Be direct and critical but NOT abusive, offensive, or personally attacking — it must be safe to post publicly.",
    "Keep it short (1-3 sentences).",
  ].join(" "),

  techie: [
    "You are writing a LinkedIn comment with a technical framing.",
    "Reference relevant tools, trade-offs, or engineering considerations related to the post.",
    "Keep it concise and credible (1-3 sentences), avoid unnecessary jargon.",
  ].join(" "),
};

const DEFAULT_MODEL = "openrouter/free";

/**
 * Truncate text to a max length, cutting on a word boundary when possible.
 */
function truncateText(text, maxLen = 1500) {
  if (!text || text.length <= maxLen) return text || "";
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.8 ? cut.slice(0, lastSpace) : cut) + "…";
}

async function generateComment(postText, category) {
  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);

  if (!apiKey) {
    throw new Error("No OpenRouter API key set. Open the extension popup to add one.");
  }

  const systemPrompt = CATEGORY_PROMPTS[category] || CATEGORY_PROMPTS.professional;
  const trimmedPost = truncateText(postText, 1500);

  const body = {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `Here is the LinkedIn post:\n\n"""\n${trimmedPost}\n"""\n\n` +
          "Write ONE LinkedIn comment as instructed. " +
          "Respond with a single plain-text paragraph only — no line breaks, no markdown, " +
          "no bullet points, no numbering, no quotes, no preamble, no labels.",
      },
    ],
    // Some free/routed OpenRouter models are "reasoning" models that spend
    // tokens on an internal chain-of-thought before the final answer. If
    // max_tokens is too low, the reasoning alone can consume the whole
    // budget and leave literally nothing for the actual comment (the empty
    // response you hit). We also explicitly ask OpenRouter to exclude
    // reasoning tokens from the response when the routed model supports it.
    max_tokens: 500,
    temperature: 0.8,
    reasoning: { exclude: true },
  };

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://www.linkedin.com/",
      "X-Title": "LinkedIn AI Comment Generator",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `OpenRouter error (${response.status})`;
    try {
      const errJson = await response.json();
      if (errJson?.error?.message) message = errJson.error.message;
    } catch (_) {
      /* ignore parse error */
    }
    throw new Error(message);
  }

  const data = await response.json();
  const choice = data?.choices?.[0];
  let rawText = choice?.message?.content?.trim();

  // Fallback: some routed models ignore `reasoning.exclude` and put
  // EVERYTHING (including the whole chain-of-thought) into `content`, with
  // `message.reasoning` left empty — or vice versa. If `content` is empty,
  // try the dedicated reasoning field as a last resort.
  if (!rawText) {
    rawText = choice?.message?.reasoning?.trim();
  }

  if (!rawText) {
    throw new Error(
      "OpenRouter returned an empty response. This can happen with some free/reasoning models — try again or pick a different model in the popup."
    );
  }

  // If the model still leaked its chain-of-thought into the text (e.g.
  // "Let's craft something like: \"...\""), try to isolate just the final
  // answer: prefer the last quoted string, otherwise fall back to the last
  // non-empty line/sentence so we never post the reasoning itself.
  const quotedMatches = rawText.match(/"([^"]{10,500})"/g);
  if (quotedMatches && quotedMatches.length > 0) {
    rawText = quotedMatches[quotedMatches.length - 1].replace(/^"|"$/g, "");
  } else {
    const lines = rawText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      rawText = lines[lines.length - 1];
    }
  }

  // Some models (especially free/smaller ones) return odd formatting —
  // stray line breaks after every word, markdown bullets, etc. Collapse
  // all whitespace/newlines into single spaces so it reads as one clean
  // paragraph, matching what a real LinkedIn comment should look like.
  const text = rawText
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();

  if (!text) {
  }

  return text;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "GENERATE_COMMENT") return false;

  generateComment(message.postText, message.category)
    .then((text) => sendResponse({ ok: true, text }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));

  // Keep the message channel open for the async response.
  return true;
});
