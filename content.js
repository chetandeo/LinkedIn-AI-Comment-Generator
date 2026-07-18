// content.js — injected into LinkedIn feed pages
// Detects comment boxes, injects a 5-tone AI toolbar, and inserts
// generated comments into LinkedIn's Quill-based contenteditable editor.
//
// LinkedIn's wrapper class names (e.g. .comments-comment-box) drift often
// and are unreliable. The Quill editor itself — .ql-editor[contenteditable]
// inside a comment context — is far more stable, so detection anchors on
// that instead.

(() => {
  const DEBUG = true;
  const log = (...args) => DEBUG && console.log("[AI Comment Generator]", ...args);

  const TONES = [
    { key: "professional", label: "Professional", className: "ai-btn-professional" },
    { key: "funny", label: "Funny", className: "ai-btn-funny" },
    { key: "absolute", label: "Absolute", className: "ai-btn-absolute" },
    { key: "angry", label: "Angry", className: "ai-btn-angry" },
    { key: "techie", label: "Techie", className: "ai-btn-techie" },
  ];

  // LinkedIn has used at least two different rich-text editor libraries for
  // comments over time: Quill (.ql-editor) and, as of mid-2026, Tiptap /
  // ProseMirror (.tiptap.ProseMirror). Both are supported here so the
  // toolbar keeps working across LinkedIn's rollout changes.
  const EDITOR_SELECTORS = [
    // Tiptap / ProseMirror (current as of 2026)
    'div.tiptap.ProseMirror[contenteditable="true"][aria-label*="comment" i]',
    'div[role="textbox"][contenteditable="true"][aria-label*="comment" i]',
    // Quill (legacy)
    '.comments-comment-box .ql-editor[contenteditable="true"]',
    '.comments-comment-texteditor .ql-editor[contenteditable="true"]',
    '[class*="comment"] .ql-editor[contenteditable="true"]',
    '.ql-editor[contenteditable="true"][data-placeholder*="comment" i]',
  ];

  // Broad fallback: any rich-text editable on the page (Tiptap or Quill).
  // Filtered afterwards by checking it looks like a comment box.
  const GENERIC_EDITOR_SELECTOR =
    '.tiptap.ProseMirror[contenteditable="true"], .ql-editor[contenteditable="true"], div[role="textbox"][contenteditable="true"]';

  const POST_ROOT_SELECTOR =
    '.feed-shared-update-v2, div[data-urn], .occludable-update, article, div[role="listitem"]';

  const POST_TEXT_CANDIDATES = [
    '[data-testid="expandable-text-box"]',
    ".feed-shared-update-v2__description .update-components-text",
    ".feed-shared-inline-show-more-text",
    ".update-components-text",
    ".feed-shared-text",
  ];

  const PROCESSED_ATTR = "data-ai-comment-toolbar";
  const MAX_POST_TEXT = 1500;

  function looksLikeCommentEditor(editor) {
    const placeholder = editor.getAttribute("data-placeholder") || "";
    if (/comment/i.test(placeholder)) return true;

    // Tiptap nests the placeholder text on a child <p data-placeholder="...">
    const childPlaceholder = editor.querySelector("[data-placeholder]");
    if (childPlaceholder && /comment/i.test(childPlaceholder.getAttribute("data-placeholder") || "")) {
      return true;
    }

    if (editor.closest('[class*="comment"]')) return true;

    const ariaLabel = editor.getAttribute("aria-label") || "";
    return /comment/i.test(ariaLabel);
  }

  function findEditors() {
    const found = new Set();

    for (const sel of EDITOR_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => found.add(el));
    }

    const genericMatches = document.querySelectorAll(GENERIC_EDITOR_SELECTOR);
    genericMatches.forEach((el) => {
      if (!found.has(el) && looksLikeCommentEditor(el)) found.add(el);
    });

    if (DEBUG && genericMatches.length > 0 && found.size === 0) {
      log(
        `Saw ${genericMatches.length} .ql-editor element(s) but none matched the comment filter.`,
        Array.from(genericMatches).map((el) => ({
          placeholder: el.getAttribute("data-placeholder"),
          ariaLabel: el.getAttribute("aria-label"),
          classList: el.className,
          parentClass: el.parentElement?.className,
        }))
      );
    }

    return Array.from(found);
  }

  function extractPostText(editor) {
    const postRoot = editor.closest(POST_ROOT_SELECTOR);
    if (!postRoot) return "";

    for (const sel of POST_TEXT_CANDIDATES) {
      const el = postRoot.querySelector(sel);
      if (el && el.textContent && el.textContent.trim().length > 0) {
        return el.textContent.trim().slice(0, MAX_POST_TEXT);
      }
    }
    return "";
  }

  function insertTextIntoEditor(editor, text) {
    editor.focus();

    // Explicitly clear existing content first. Relying solely on
    // execCommand('insertText') to "replace" a selection can leave stray
    // leftover <p> nodes in ProseMirror/Tiptap editors (observed as both
    // the old placeholder/prompt text AND the new comment appearing
    // together) — especially on a second click after a failed/empty first
    // generation. Selecting + deleting first, then inserting, is more
    // reliable across both Quill and Tiptap.
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    document.execCommand("delete", false);

    const inserted = document.execCommand("insertText", false, text);

    if (!inserted || editor.textContent.trim() !== text.trim()) {
      // Fallback: clear any residual DOM directly and dispatch input events
      // manually so the editor's internal state (Quill/Tiptap) stays in
      // sync with the DOM we just changed.
      editor.innerHTML = "";
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }
  }

  function setStatus(toolbar, message, type) {
    const statusEl = toolbar.querySelector(".ai-comment-status");
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.className = "ai-comment-status" + (type ? ` ai-comment-status--${type}` : "");
  }

  function setButtonsDisabled(toolbar, disabled) {
    toolbar.querySelectorAll("button.ai-comment-btn").forEach((btn) => {
      btn.disabled = disabled;
    });
  }

  function handleToneClick(editor, toolbar, category) {
    const postText = extractPostText(editor);

    setButtonsDisabled(toolbar, true);
    setStatus(toolbar, "Generating…", "loading");

    chrome.runtime.sendMessage(
      { type: "GENERATE_COMMENT", postText, category },
      (response) => {
        setButtonsDisabled(toolbar, false);

        if (chrome.runtime.lastError) {
          setStatus(toolbar, chrome.runtime.lastError.message, "error");
          return;
        }

        if (!response) {
          setStatus(toolbar, "No response from background script.", "error");
          return;
        }

        if (!response.ok) {
          setStatus(toolbar, response.error || "Something went wrong.", "error");
          return;
        }

        insertTextIntoEditor(editor, response.text);
        setStatus(toolbar, "Comment inserted ✓", "success");
      }
    );
  }

  function buildToolbar(editor) {
    const toolbar = document.createElement("div");
    toolbar.className = "ai-comment-toolbar";

    const label = document.createElement("span");
    label.className = "ai-comment-label";
    label.textContent = "AI:";
    toolbar.appendChild(label);

    TONES.forEach(({ key, label: toneLabel, className }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `ai-comment-btn ${className}`;
      btn.textContent = toneLabel;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleToneClick(editor, toolbar, key);
      });
      toolbar.appendChild(btn);
    });

    const status = document.createElement("span");
    status.className = "ai-comment-status";
    toolbar.appendChild(status);

    return toolbar;
  }

  function findInsertionAnchor(editor) {
    // IMPORTANT: We must insert INSIDE a known-safe flex container, never
    // as a sibling AFTER it. LinkedIn wraps most of the post/grid layout in
    // ancestor `display:contents` passthrough divs (seen as
    // data-display-contents="true" in the DOM) so their children act as
    // direct items of an outer CSS Grid. If our toolbar is inserted as a
    // sibling in that region, it becomes an unplaced grid item and the
    // grid's auto-placement algorithm squeezes an existing column down to
    // fit it — this is what caused the whole feed to collapse into a
    // single, character-wrapped column in testing.
    //
    // The commentBox-* div is a plain flex column (editor + icon row) that
    // we know is NOT display:contents, so appending our toolbar as its
    // LAST CHILD keeps it fully inside that safe, self-contained layout
    // context and never touches the ancestor grid at all.
    const commentBoxDiv = editor.closest('div[componentkey^="commentBox-"]');
    if (commentBoxDiv) {
      return { container: commentBoxDiv, mode: "append" };
    }

    const fallback =
      editor.closest('[data-testid="ui-core-tiptap-text-editor-wrapper"]') ||
      editor.closest(".comments-comment-box") ||
      editor.closest(".comments-comment-texteditor") ||
      editor.closest('[class*="comment-box"]') ||
      editor.closest('[class*="comment"]') ||
      editor.parentElement ||
      editor;

    return { container: fallback, mode: "append" };
  }

  function injectToolbarIfNeeded(editor) {
    if (editor.hasAttribute(PROCESSED_ATTR)) return;
    editor.setAttribute(PROCESSED_ATTR, "true");

    const { container } = findInsertionAnchor(editor);
    const toolbar = buildToolbar(editor);
    container.appendChild(toolbar);
    log("Injected toolbar for editor:", editor);
  }

  function scanForEditors() {
    const editors = findEditors();
    if (editors.length > 0) log(`Found ${editors.length} comment editor(s) in DOM.`);
    editors.forEach(injectToolbarIfNeeded);
  }

  let heartbeatCount = 0;
  function heartbeat() {
    heartbeatCount += 1;
    const totalQlEditors = document.querySelectorAll(GENERIC_EDITOR_SELECTOR).length;
    const totalContentEditables = document.querySelectorAll('[contenteditable="true"]').length;
    log(
      `Heartbeat #${heartbeatCount} — .ql-editor count: ${totalQlEditors}, ` +
        `contenteditable count: ${totalContentEditables}`
    );
    scanForEditors();
  }

  // Initial scan (may run before any comment box is expanded/rendered).
  scanForEditors();
  log("Content script loaded on", location.href);

  // LinkedIn is a SPA with infinite scroll and boxes that render lazily
  // when a user clicks "Comment" — mutation observer covers most cases.
  const observer = new MutationObserver(() => {
    scanForEditors();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Belt-and-suspenders: some editor mounts don't trigger observable
  // ancestor mutations (e.g. lazy Quill init on focus). Poll as a backstop
  // and print a heartbeat so we can see raw DOM state in the console.
  setInterval(heartbeat, 3000);
})();
