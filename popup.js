// popup.js — settings UI logic

const apiKeyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const saveBtn = document.getElementById("saveBtn");
const statusMsg = document.getElementById("statusMsg");

function loadSettings() {
  chrome.storage.local.get(["apiKey", "model"], ({ apiKey, model }) => {
    if (apiKey) apiKeyInput.value = apiKey;
    if (model) modelSelect.value = model;
  });
}

function showStatus(message, isError = false) {
  statusMsg.textContent = message;
  statusMsg.className = "status-msg" + (isError ? " status-msg--error" : " status-msg--success");
  setTimeout(() => {
    statusMsg.textContent = "";
    statusMsg.className = "status-msg";
  }, 2000);
}

saveBtn.addEventListener("click", () => {
  const apiKey = apiKeyInput.value.trim();
  const model = modelSelect.value;

  if (!apiKey) {
    showStatus("Please enter an API key.", true);
    return;
  }

  chrome.storage.local.set({ apiKey, model }, () => {
    showStatus("Saved ✓");
  });
});

document.addEventListener("DOMContentLoaded", loadSettings);
