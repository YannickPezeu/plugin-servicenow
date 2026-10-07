// popup.js — Manages plugin settings via chrome.storage

// Doit rester aligne sur les DEFAULTS de content.js. Plus de choix de modele
// depuis le 06.10.2026 (GLM-5.3-Flash unique) : l'agent choisit le niveau de
// reflexion -- "low" par defaut, "full" quand l'interrupteur est active.
// top_k et rerank ne sont plus reglables (07.10.2026), cf. TOP_K / RERANK dans
// background.js.
var DEFAULTS = {
  reasoning: "low",
  assignmentGroup: "",
  additionalContext: "",
};

var reasoningToggle = document.getElementById("reasoning-toggle");
var assignmentGroupInput = document.getElementById("assignment-group-input");
var additionalContextInput = document.getElementById("additional-context-input");
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
  reasoningToggle.checked = data.reasoning === "full";
  assignmentGroupInput.value = data.assignmentGroup;
  additionalContextInput.value = data.additionalContext;
});

// Save on change
reasoningToggle.addEventListener("change", function () {
  chrome.storage.local.set({ reasoning: reasoningToggle.checked ? "full" : "low" });
});

assignmentGroupInput.addEventListener("input", function () {
  chrome.storage.local.set({ assignmentGroup: assignmentGroupInput.value });
});

additionalContextInput.addEventListener("input", function () {
  chrome.storage.local.set({ additionalContext: additionalContextInput.value });
});
