# LinkedIn AI Comment Generator — Architecture

Chrome extension (Manifest V3) that injects a 5-tone AI comment toolbar
(Professional, Funny, Absolute, Angry, Techie) near every LinkedIn comment
box, using OpenRouter as the LLM provider.

> **Note:** "Absolute" is treated here as a bold, no-hedging / hot-take
> tone. Redefine it in the prompt table below if you meant something else.

---

## 1. High-level flow

```
LinkedIn feed (DOM)
   │
   │  MutationObserver detects comment box
   ▼
content.js  ──injects──▶  AI toolbar (5 tone buttons) under comment box
   │
   │  user clicks a tone button
   │  extracts post text from DOM
   │  chrome.runtime.sendMessage({ postText, category })
   ▼
background.js (service worker)
   │
   │  looks up API key + model from chrome.storage.local
   │  builds tone-specific system prompt
   │  fetch() → OpenRouter /chat/completions
   ▼
OpenRouter API
   │
   │  returns generated comment text
   ▼
background.js ──sendResponse──▶ content.js
   │
   │  document.execCommand('insertText', ...) into the
   │  contenteditable comment box (Quill editor)
   ▼
Comment box now contains the generated text, ready to post
```

---

## 2. Components

### 2.1 `manifest.json`
- Manifest V3
- `permissions`: `storage`, `activeTab`
- `host_permissions`: `https://www.linkedin.com/*`, `https://openrouter.ai/*`
- `background.service_worker`: `background.js`
- `content_scripts`: `content.js` + `content.css`, matched on `linkedin.com`, `run_at: document_idle`
- `action.default_popup`: `popup.html`

### 2.2 `content.js` — injected into LinkedIn
Responsibilities:
- **Detect comment boxes.** LinkedIn is a SPA with infinite scroll, so comment boxes appear dynamically. Use a `MutationObserver` on `document.body` (childList + subtree) plus an initial `querySelectorAll` scan on load.
- **Selector targets** (fragile — LinkedIn's class names change; keep these centralized and easy to patch):
  - Comment editor: `.comments-comment-box .ql-editor[contenteditable="true"]`
  - Comment box wrapper (insertion anchor): `.comments-comment-box`
  - Post text candidates (tried in order, first match wins): `.feed-shared-update-v2__description .update-components-text`, `.feed-shared-inline-show-more-text`, `.update-components-text`, `.feed-shared-text`
  - Post root (to scope the text search to the right post): `.feed-shared-update-v2` / `div[data-urn]`
- **Mark processed boxes** with a `data-ai-comment-toolbar` attribute so the observer doesn't double-inject on re-renders.
- **Build and insert the toolbar** (5 buttons + status text) directly after the comment box element.
- **On button click:**
  1. Extract post text from the nearest post root (cap length, e.g. 1500 chars, to keep the prompt small).
  2. Disable buttons, show "Generating…".
  3. `chrome.runtime.sendMessage({ type: 'GENERATE_COMMENT', postText, category })`.
  4. On success, insert the returned text into the editor via `execCommand('insertText')` — this fires the input events LinkedIn's Quill editor listens for, keeping its internal state (and the Post button) in sync. Directly setting `innerHTML`/`textContent` would desync Quill.
  5. On error, show the message inline, keep buttons enabled.

### 2.3 `background.js` — service worker (holds the API key)
Responsibilities:
- Own the OpenRouter API key — never exposed to the LinkedIn page context, only reachable via message passing.
- Maintain a `CATEGORY_PROMPTS` map, one system prompt per tone:

  | Category | System prompt intent |
  |---|---|
  | `professional` | Polished, adds genuine value, no slang/emoji |
  | `funny` | Witty, tasteful, max 1 emoji |
  | `absolute` | Bold, no-hedging hot take |
  | `angry` | Frustrated/critical but not abusive — postable publicly |
  | `techie` | Technical framing, references tools/trade-offs |

- Listen for `chrome.runtime.onMessage` of type `GENERATE_COMMENT`.
- Read `apiKey` / `model` from `chrome.storage.local`.
- Call OpenRouter:
  - `POST https://openrouter.ai/api/v1/chat/completions`
  - Headers: `Authorization: Bearer <key>`, `HTTP-Referer`, `X-Title`
  - Body: `{ model, messages: [system, user(postText)], max_tokens, temperature }`
- Return `{ ok: true, text }` or `{ ok: false, error }` via `sendResponse` (async — listener returns `true` to keep the channel open).

### 2.4 `popup.html` / `popup.js` / `popup.css` — settings UI
- Input for OpenRouter API key (`type="password"`).
- Dropdown for model (e.g. `openai/gpt-4o-mini`, `anthropic/claude-3.5-haiku`, `meta-llama/llama-3.1-8b-instruct`, `google/gemini-flash-1.5`).
- Save button → `chrome.storage.local.set({ apiKey, model })`.
- Load stored values on open.

### 2.5 `content.css`
- Styles the injected toolbar: 5 pill buttons (one accent color per tone), a label, and a status line for loading/error/success states.

---

## 3. Data flow contract (message passing)

**Request** (`content.js` → `background.js`):
```json
{
  "type": "GENERATE_COMMENT",
  "postText": "string, up to ~1500 chars",
  "category": "professional | funny | absolute | angry | techie"
}
```

**Response** (`background.js` → `content.js`):
```json
{ "ok": true, "text": "generated comment" }
```
or
```json
{ "ok": false, "error": "human-readable message" }
```

---

## 4. Storage schema (`chrome.storage.local`)

| Key | Type | Description |
|---|---|---|
| `apiKey` | string | OpenRouter API key |
| `model` | string | OpenRouter model id, e.g. `openai/gpt-4o-mini` |

---

## 5. Security & privacy notes

- API key lives only in `chrome.storage.local` and the service worker's memory — never injected into the LinkedIn page/content script.
- `host_permissions` scoped to just `linkedin.com` and `openrouter.ai` — no broad `<all_urls>`.
- Post text sent to OpenRouter is truncated and only the visible post body — no author profile data, no personal messages.
- No analytics/telemetry beyond the direct OpenRouter call.

---

## 6. Known limitations / maintenance points

- LinkedIn's DOM selectors will drift over time — centralize them (as above) so updates are a one-file fix.
- No caching or rate limiting — every button click is a billed OpenRouter call.
- No retry/backoff on OpenRouter errors (e.g. 429) — could be added in `background.js`.
- No bundled extension icon — Chrome will fall back to a default placeholder unless one is added and referenced in `manifest.json`.

---

## 7. Suggested build order

1. `manifest.json` skeleton + `popup.html/js/css` (get storage working first).
2. `background.js` with a hardcoded test prompt, verify OpenRouter call works via the extension's service worker console.
3. `content.js` detection + toolbar injection only (no API call yet) — confirm it survives LinkedIn's feed re-renders.
4. Wire click handler → message → insertion.
5. Harden selectors, add error states, style pass.
