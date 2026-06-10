// popup.js — Manages plugin settings via chrome.storage

var DEFAULTS = {
  rerank: true,
  model: "moonshotai/Kimi-K2.6",
  topK: 10,
  apiKey: "",
  indexKey: "",
  assignmentGroup: "",
};

var rerankToggle = document.getElementById("rerank-toggle");
var modelSelect = document.getElementById("model-select");
var topkRange = document.getElementById("topk-range");
var topkValue = document.getElementById("topk-value");
var apiKeyInput = document.getElementById("api-key-input");
var indexKeyInput = document.getElementById("index-key-input");
var assignmentGroupInput = document.getElementById("assignment-group-input");
var authBtn = document.getElementById("auth-btn");
var authUser = document.getElementById("auth-user");
var authError = document.getElementById("auth-error");

var signedIn = false;

function renderAuth(user) {
  if (user && (user.email || user.name)) {
    signedIn = true;
    authUser.textContent = user.email || user.name;
    authUser.title = user.email || user.name;
    authBtn.textContent = "Déconnexion";
    authBtn.classList.remove("primary");
  } else {
    signedIn = false;
    authUser.textContent = "Non connecté";
    authUser.title = "";
    authBtn.textContent = "Se connecter";
    authBtn.classList.add("primary");
  }
}

function showAuthError(msg) {
  authError.textContent = msg;
  authError.style.display = msg ? "block" : "none";
}

oidcGetUserInfo().then(renderAuth);

authBtn.addEventListener("click", function () {
  showAuthError("");
  authBtn.disabled = true;
  var action = signedIn ? oidcSignOut() : oidcSignIn();
  action
    .then(function () { return oidcGetUserInfo(); })
    .then(renderAuth)
    .catch(function (err) {
      showAuthError(err.message || String(err));
    })
    .finally(function () { authBtn.disabled = false; });
});

var authDumpBtn = document.getElementById("auth-dump-btn");
var authCopyBtn = document.getElementById("auth-copy-btn");

authDumpBtn.addEventListener("click", function () {
  oidcDebugDumpToken().then(function (info) {
    if (!info) showAuthError("Pas de token. Connectez-vous d'abord.");
  });
});

authCopyBtn.addEventListener("click", function () {
  chrome.storage.local.get({ oidcIdToken: "" }, function (data) {
    if (!data.oidcIdToken) {
      showAuthError("Pas de token. Connectez-vous d'abord.");
      return;
    }
    navigator.clipboard.writeText(data.oidcIdToken).then(function () {
      var prev = authCopyBtn.textContent;
      authCopyBtn.textContent = "Copié !";
      setTimeout(function () { authCopyBtn.textContent = prev; }, 1500);
    }).catch(function (err) {
      showAuthError("Copie échouée: " + err.message);
    });
  });
});

// Load saved settings
chrome.storage.local.get(DEFAULTS, function (data) {
  rerankToggle.checked = data.rerank;
  modelSelect.value = data.model;
  topkRange.value = data.topK;
  topkValue.textContent = data.topK;
  apiKeyInput.value = data.apiKey;
  indexKeyInput.value = data.indexKey;
  assignmentGroupInput.value = data.assignmentGroup;
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

apiKeyInput.addEventListener("input", function () {
  chrome.storage.local.set({ apiKey: apiKeyInput.value });
});

indexKeyInput.addEventListener("input", function () {
  chrome.storage.local.set({ indexKey: indexKeyInput.value });
});

assignmentGroupInput.addEventListener("input", function () {
  chrome.storage.local.set({ assignmentGroup: assignmentGroupInput.value });
});
