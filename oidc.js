// oidc.js — Microsoft Entra ID (EPFL tenant) sign-in via OAuth 2.0 + PKCE.
// Loaded in both the service worker (importScripts) and the popup (<script src>).
// Exposes globals: oidcSignIn, oidcSignOut, oidcGetIdToken, oidcGetUserInfo.

var OIDC_CLIENT_ID = "c24dbdf0-fa7c-407e-9294-255e856d8dc7";
var OIDC_TENANT_ID = "f6c2556a-c4fb-4ab1-a2c7-9e220df11c43";
var OIDC_AUTHORIZE_URL = "https://login.microsoftonline.com/" + OIDC_TENANT_ID + "/oauth2/v2.0/authorize";
var OIDC_TOKEN_URL = "https://login.microsoftonline.com/" + OIDC_TENANT_ID + "/oauth2/v2.0/token";
var OIDC_SCOPES = "openid profile email offline_access User.Read";
var OIDC_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

function _b64urlFromBytes(bytes) {
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function _randomBytes(len) {
  var arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return arr;
}

function _generateCodeVerifier() {
  return _b64urlFromBytes(_randomBytes(32));
}

function _generateCodeChallenge(verifier) {
  var data = new TextEncoder().encode(verifier);
  return crypto.subtle.digest("SHA-256", data).then(function (buf) {
    return _b64urlFromBytes(new Uint8Array(buf));
  });
}

function _decodeJwtPayload(jwt) {
  try {
    var parts = jwt.split(".");
    if (parts.length < 2) return null;
    var payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    return JSON.parse(atob(payload));
  } catch (e) {
    return null;
  }
}

function _getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

function _formEncode(obj) {
  return Object.keys(obj).map(function (k) {
    return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]);
  }).join("&");
}

function _storeTokens(tokenResponse) {
  var now = Date.now();
  var idToken = tokenResponse.id_token || "";
  var claims = idToken ? _decodeJwtPayload(idToken) : null;

  // Debug print: full token + decoded claims so the backend integrator can see
  // the exact wire format and claim shape (including accreds). Safe in dev;
  // remove or gate behind a flag before publishing to the Web Store.
  if (idToken) {
    console.log("[OIDC] === ID TOKEN (sent as 'Authorization: Bearer <token>') ===");
    console.log(idToken);
    console.log("[OIDC] === DECODED CLAIMS ===");
    console.log(JSON.stringify(claims, null, 2));
    console.log("[OIDC] === END ===");
  }

  var record = {
    oidcIdToken: idToken,
    oidcAccessToken: tokenResponse.access_token || "",
    oidcRefreshToken: tokenResponse.refresh_token || "",
    oidcExpiresAt: now + (Number(tokenResponse.expires_in || 3600) * 1000),
    oidcUser: claims ? {
      name: claims.name || "",
      email: claims.email || claims.preferred_username || "",
      oid: claims.oid || "",
      sub: claims.sub || "",
    } : null,
  };
  return new Promise(function (resolve) {
    chrome.storage.local.set(record, function () { resolve(record); });
  });
}

// Debug helper: prints the current stored ID token and its decoded claims.
// Call from the popup or service worker DevTools console: `oidcDebugDumpToken()`.
function oidcDebugDumpToken() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(
      { oidcIdToken: "", oidcAccessToken: "", oidcExpiresAt: 0 },
      function (data) {
        if (!data.oidcIdToken) {
          console.log("[OIDC] No ID token stored. Sign in first.");
          resolve(null);
          return;
        }
        var claims = _decodeJwtPayload(data.oidcIdToken);
        var info = {
          idToken: data.oidcIdToken,
          accessToken: data.oidcAccessToken,
          expiresAt: new Date(data.oidcExpiresAt).toISOString(),
          claims: claims,
        };
        console.log("[OIDC] === ID TOKEN ===");
        console.log(data.oidcIdToken);
        console.log("[OIDC] === ACCESS TOKEN (Graph, not sent to RAG) ===");
        console.log(data.oidcAccessToken);
        console.log("[OIDC] === DECODED ID TOKEN CLAIMS ===");
        console.log(JSON.stringify(claims, null, 2));
        console.log("[OIDC] === Expires at ===", info.expiresAt);
        resolve(info);
      }
    );
  });
}

function _clearTokens() {
  return new Promise(function (resolve) {
    chrome.storage.local.remove(
      ["oidcIdToken", "oidcAccessToken", "oidcRefreshToken", "oidcExpiresAt", "oidcUser"],
      function () { resolve(); }
    );
  });
}

function _exchangeCodeForTokens(code, codeVerifier) {
  var body = _formEncode({
    client_id: OIDC_CLIENT_ID,
    grant_type: "authorization_code",
    code: code,
    redirect_uri: _getRedirectUri(),
    code_verifier: codeVerifier,
    scope: OIDC_SCOPES,
  });
  return fetch(OIDC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
  }).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) {
        var msg = data.error_description || data.error || ("HTTP " + r.status);
        throw new Error("Token exchange failed: " + msg);
      }
      return data;
    });
  });
}

function _refreshTokens(refreshToken) {
  var body = _formEncode({
    client_id: OIDC_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: OIDC_SCOPES,
  });
  return fetch(OIDC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
  }).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) {
        var msg = data.error_description || data.error || ("HTTP " + r.status);
        throw new Error("Token refresh failed: " + msg);
      }
      return data;
    });
  });
}

function oidcSignIn() {
  var codeVerifier = _generateCodeVerifier();
  var state = _b64urlFromBytes(_randomBytes(16));
  var nonce = _b64urlFromBytes(_randomBytes(16));
  var redirectUri = _getRedirectUri();

  return _generateCodeChallenge(codeVerifier).then(function (codeChallenge) {
    var authUrl = OIDC_AUTHORIZE_URL +
      "?client_id=" + encodeURIComponent(OIDC_CLIENT_ID) +
      "&response_type=code" +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&response_mode=query" +
      "&scope=" + encodeURIComponent(OIDC_SCOPES) +
      "&state=" + encodeURIComponent(state) +
      "&nonce=" + encodeURIComponent(nonce) +
      "&code_challenge=" + encodeURIComponent(codeChallenge) +
      "&code_challenge_method=S256" +
      "&prompt=select_account";

    return new Promise(function (resolve, reject) {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        function (responseUrl) {
          if (chrome.runtime.lastError || !responseUrl) {
            reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "Auth flow cancelled"));
            return;
          }
          try {
            var url = new URL(responseUrl);
            var params = url.searchParams;
            var err = params.get("error");
            if (err) {
              reject(new Error("Auth error: " + err + " - " + (params.get("error_description") || "")));
              return;
            }
            var returnedState = params.get("state");
            if (returnedState !== state) {
              reject(new Error("State mismatch — possible CSRF"));
              return;
            }
            var code = params.get("code");
            if (!code) {
              reject(new Error("No authorization code in response"));
              return;
            }
            _exchangeCodeForTokens(code, codeVerifier)
              .then(_storeTokens)
              .then(resolve)
              .catch(reject);
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  });
}

function oidcSignOut() {
  return _clearTokens();
}

function oidcGetUserInfo() {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ oidcUser: null, oidcExpiresAt: 0 }, function (data) {
      resolve(data.oidcUser);
    });
  });
}

// Returns a valid ID token, or null if not signed in. Auto-refreshes if near expiry.
function oidcGetIdToken() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(
      { oidcIdToken: "", oidcRefreshToken: "", oidcExpiresAt: 0 },
      function (data) {
        if (!data.oidcIdToken) { resolve(null); return; }
        if (Date.now() < data.oidcExpiresAt - OIDC_TOKEN_REFRESH_SKEW_MS) {
          resolve(data.oidcIdToken);
          return;
        }
        if (!data.oidcRefreshToken) {
          // Token expired with no refresh option — caller should prompt sign-in
          resolve(null);
          return;
        }
        _refreshTokens(data.oidcRefreshToken)
          .then(_storeTokens)
          .then(function (rec) { resolve(rec.oidcIdToken || null); })
          .catch(function (err) {
            console.warn("[SN AI Plugin] Token refresh failed, signing out:", err.message);
            _clearTokens().then(function () { resolve(null); });
          });
      }
    );
  });
}
