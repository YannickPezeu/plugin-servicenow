// popup.js — Manages plugin settings via chrome.storage

var DEFAULTS = {
  rerank: true,
  model: "mistralai/Mistral-Small-3.2-24B-Instruct-2506-bfloat16",
  topK: 10,
  apiKey: "",
};

var rerankToggle = document.getElementById("rerank-toggle");
var modelSelect = document.getElementById("model-select");
var topkRange = document.getElementById("topk-range");
var topkValue = document.getElementById("topk-value");
var apiKeyInput = document.getElementById("api-key-input");

// Load saved settings
chrome.storage.local.get(DEFAULTS, function (data) {
  rerankToggle.checked = data.rerank;
  modelSelect.value = data.model;
  topkRange.value = data.topK;
  topkValue.textContent = data.topK;
  apiKeyInput.value = data.apiKey;
});

// Save on change
rerankToggle.addEventListener("change", function () {
  chrome.storage.local.set({ rerank: rerankToggle.checked });
});

modelSelect.addEventListener("change", function () {
  chrome.storage.local.set({ model: modelSelect.value });
});

topkRange.addEventListener("input", function () {
  topkValue.textContent = topkRange.value;
  chrome.storage.local.set({ topK: parseInt(topkRange.value, 10) });
});

apiKeyInput.addEventListener("change", function () {
  chrome.storage.local.set({ apiKey: apiKeyInput.value });
});
