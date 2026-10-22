// popup.js — Manages plugin settings via chrome.storage

// Plus aucun reglage de generation : modele unique GLM-5.3-Flash (06.10.2026),
// top_k / rerank fixes (07.10.2026), reflexion toujours rapide (22.10.2026),
// cf. content.js. Reste le contexte d'actualite.
var DEFAULTS = {
  additionalContext: "",
};

// Seul compte qui voit les boutons de debug (jeton en console, copie du JWT).
// Simple masquage d'interface : le jeton reste dans chrome.storage de chacun.
var DEBUG_ACCOUNT = "yannick.pezeu@epfl.ch";

var additionalContextInput = document.getElementById("additional-context-input");
var authBtn = document.getElementById("auth-btn");
var authUser = document.getElementById("auth-user");
var authError = document.getElementById("auth-error");
var authDebug = document.getElementById("auth-debug");

var signedIn = false;

function renderAuth(user) {
  var email = (user && user.email ? user.email : "").trim().toLowerCase();
  authDebug.style.display = email === DEBUG_ACCOUNT ? "flex" : "none";
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
chrome.storage.local.get({ oidcSignInError: "" }, function (data) {
  if (data.oidcSignInError) showAuthError("Connexion échouée : " + data.oidcSignInError);
});

// La connexion se termine souvent popup ferme : on suit le stockage plutot
// que la reponse du message.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local") return;
  if (changes.oidcUser) renderAuth(changes.oidcUser.newValue);
  if (changes.oidcSignInError && changes.oidcSignInError.newValue) {
    showAuthError("Connexion échouée : " + changes.oidcSignInError.newValue);
  }
});

// Le flux OIDC tourne dans le service worker (cf. background.js) : lance
// depuis le popup, il mourait avec lui des que la fenetre Microsoft s'ouvrait.
function signInViaBackground() {
  return chrome.runtime.sendMessage({ type: "oidc-sign-in" }).then(function (res) {
    if (!res || !res.success) throw new Error((res && res.error) || "Connexion échouée");
  });
}

authBtn.addEventListener("click", function () {
  showAuthError("");
  authBtn.disabled = true;
  var action = signedIn ? oidcSignOut() : signInViaBackground();
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
  additionalContextInput.value = data.additionalContext;
});

// Save on change
additionalContextInput.addEventListener("input", function () {
  chrome.storage.local.set({ additionalContext: additionalContextInput.value });
});
