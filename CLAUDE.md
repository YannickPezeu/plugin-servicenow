# ServiceNow AI Response Generator — Chrome Extension

## Overview
Chrome extension (Manifest V3) that adds AI-powered response generation to ServiceNow ticket pages at `support.epfl.ch`. Uses a RAG API (`lex-chatbot.epfl.ch/rag/generate`) to generate responses based on ticket content and a knowledge base (`finance_embeddings` library). Authenticates via OIDC (Microsoft Entra ID, EPFL tenant) in addition to a transitional API key.

## Architecture

### Files
- **manifest.json** — MV3 manifest. Permissions: `activeTab`, `storage`, `alarms`, `identity`. Host permissions for `lex-chatbot.epfl.ch`, `support.epfl.ch`, `login.microsoftonline.com`. Contains a `key` field that pins the extension ID to `alkbalieeodmgfcejfjdpdomlalbojom` (paired with `extension-key.pem`, gitignored).
- **background.js** — Service worker. Proxies RAG API calls (bypasses CORS), orchestrates precompute pipeline, manages cache eviction, handles periodic/navigation-triggered precompute. `importScripts("oidc.js")` for shared auth helpers.
- **oidc.js** — OAuth 2.0 / OIDC PKCE flow against Microsoft Entra ID (EPFL tenant). Loaded both in the service worker (importScripts) and the popup (`<script src>`). Exposes globals `oidcSignIn / oidcSignOut / oidcGetIdToken / oidcGetUserInfo / oidcDebugDumpToken`.
- **content.js** — Content script injected into all frames on `*.service-now.com` / `support.epfl.ch`. Handles button injection, precompute triggering, and auto-fill from cache.
- **inject.js** — Main-world script injected via `<script>` tag. Accesses `window.g_ck` (CSRF token) and AngularJS scope for textarea value injection.
- **popup.html / popup.js** — Settings UI. Fields: API Key, Index Key, Assignment Group, Model, Top K, Rerank toggle. Sign-in section with EPFL OIDC, plus debug buttons "Voir token (console)" and "Copier JWT".
- **styles.css** — Styles for the "Generer IA" button.
- **extension-key.pem** *(gitignored)* — RSA private key whose public half pins the extension ID. Back up safely.
- **test_userinfo.py** *(dev-only)* — Probe script for EPFL userinfo endpoints. Reads `ID_JWT_TOKEN_TEST` and `ACCESS_JWT_TOKEN_TEST` from `.env` (gitignored).

### Key Concepts

**Cross-world communication**: `inject.js` runs in the main world (page context), `content.js` runs in the isolated world. Data passes via DOM attributes (`data-sn-ai-gck`) and CustomEvents (signal only, no detail payload — Chrome strips `detail` across worlds).

**ServiceNow iframe architecture**: SN uses a `gsft_main` iframe. The top frame has `g_ck`, the iframe has ticket data. `content.js` detects which frame it's in via `window === window.top` and `incident.do` URL pattern.

**AngularJS scope injection**: To set textarea values in SN, `inject.js` uses `angular.element(textarea).scope().$apply()` to write to the scope field (`activity_field_0.value`). Fallback: direct `.value` + input/change/blur events.

### Precompute Pipeline
1. `g_ck` captured from any SN page visit, persisted to `chrome.storage.local`
2. Triggered by: manual button, page navigation (debounced 2min), or periodic alarm (every 15min)
3. Fetches incidents via SN REST API filtered by assignment group + non-closed state
4. For each ticket: fetches journal entries, computes hash of `short_description|description|messages`
5. If hash matches cache → skip. Otherwise → call RAG API, cache response
6. Cache stored in `chrome.storage.local.precomputeCache[sys_id]` = `{ hash, response, timestamp, shortDescription }`
7. On ticket page load: reads cache by sys_id, auto-fills textarea after 2s delay (waits for Angular init), watches for Angular resets via MutationObserver + polling

### Concurrency
`PRECOMPUTE_CONCURRENCY` in background.js controls parallel RAG API calls. Default: 1 (sequential). Set to 20 for load testing. The API at `lex-chatbot.epfl.ch` is sensitive to high concurrency.

### Authentication & Authorization

**Identity provider:** Microsoft Entra ID, EPFL tenant.
- Client ID: `c24dbdf0-fa7c-407e-9294-255e856d8dc7`
- Tenant ID: `f6c2556a-c4fb-4ab1-a2c7-9e220df11c43`
- Registration type: Single Page App (public client, PKCE, no secret)
- Authorize: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`
- Token: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
- JWKS: `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`
- Scopes requested: `openid profile email offline_access User.Read`
- Redirect URI: `https://alkbalieeodmgfcejfjdpdomlalbojom.chromiumapp.org/` (pinned via the manifest `key` field).

**Two tokens, two different audiences — don't confuse them.** The OIDC flow returns:
- **ID token** (`aud = client_id`) — proves identity. Sent to `lex-chatbot.epfl.ch` as `Authorization: Bearer <id_token>` and to the EPFL userinfo endpoint.
- **Access token** (`aud = Microsoft Graph`) — only valid for `graph.microsoft.com`. NOT sent to the RAG backend or to EPFL userinfo (would fail JWKS validation — wrong signing audience).

**RAG API auth — transitional dual mode.** Every call to `lex-chatbot.epfl.ch/rag/generate` carries both:
- `X-API-Key: <existing key>` (current authoritative auth)
- `Authorization: Bearer <id_token>` (added if user signed in; ignored by backend until migrated)

Header construction is centralized in `buildRagHeaders()` in [background.js](background.js). Don't open-code RAG fetch headers elsewhere.

**Per-user authorization via accreds.** The ID token contains identity claims (`uniqueid` = SCIPER, `gaspar`, `oid`, `preferred_username`) but **not** accreds, despite the "Accreds" checkbox being set on the registration. EPFL's custom claims provider is attached to the app but does not emit the claim. The supported way to get accreds is to call the EPFL userinfo endpoint:

```
GET https://api.epfl.ch/v1/oidc/userinfo
Authorization: Bearer <id_token>
```

Returns a JSON object with: `accreds[]`, `cfs[]`, `groups[]`, `rights{}`, plus identity claims duplicated from the ID token. The accreds format is colon-separated: `unit_id:unit_short:hierarchy_path:type:status` (e.g. `12608:SCI-IC-MR:EPFL IC GR-SCI-IC SCI-IC-MR:P:E`).

There is also a more restrictive variant at `https://api.epfl.ch/entra-api/v1/oidc/userinfo` that requires the appId to be added to its ACL. The current extension is **not** on that ACL — use the plain `/v1/oidc/userinfo` until/unless the IAM team grants explicit access.

**Backend-side validation (to implement on `lex-chatbot.epfl.ch`):** see the plan at `C:\Users\pezeu\.claude\plans\rag-backend-oidc.md`. The backend has not yet been updated to validate Bearer tokens — that work is pending.

**Token storage.** Both tokens, the refresh token, expiry, and decoded user info live in `chrome.storage.local` under keys `oidcIdToken`, `oidcAccessToken`, `oidcRefreshToken`, `oidcExpiresAt`, `oidcUser`. `oidcGetIdToken()` auto-refreshes when the token is within 5 min of expiry; on refresh failure the user is silently signed out and the next call falls back to API-key-only.

**Debug helpers.** The popup has two buttons that target the local console: "Voir token (console)" dumps both tokens + decoded claims via `oidcDebugDumpToken()`, "Copier JWT" copies the ID token to clipboard. Useful for jwt.ms inspection and for backend-side testing without re-running the full sign-in.

### Known Issues / Gotchas
- `g_ck` expires with the SN session. Background precompute checks token age (max 8h).
- Auto-fill can be reset by SN's Angular digest cycle — MutationObserver + polling re-applies up to 3 times.
- `precomputeRunning` flag prevents duplicate precompute runs but resets only when queue is fully drained.
- Sending the **access token** (vs ID token) to any non-Graph endpoint returns `invalid token signature`. Always use `oidcGetIdToken()`, never `oidcAccessToken` directly, for RAG and EPFL APIs.
- The custom claims provider is attached to the registration (`app_displayname` no longer contains `(Failed to add custom provider)`) but still doesn't emit `accreds` in the token. The userinfo endpoint is the supported workaround — don't waste time trying to fix the in-token claim.
- The `groups` claim in the ID token contains only **app-assigned** Entra groups (1 entry today), filtered server-side. The user's actual group memberships (~40 groups) are accessible via Graph `/me/memberOf` or via the EPFL userinfo `groups` array (which uses named groups like `personnel-epfl`, not GUIDs). Don't conflate the two.

## Development
- Branch `feature/precompute-responses` has the precompute feature
- Branch `master` has the base extension (button + single RAG call)
- Test on `support.epfl.ch` (EPFL's ServiceNow instance)
- Debug: Chrome DevTools on the service worker (chrome://extensions) and on the SN page (F12)
- To clear precompute cache: `chrome.storage.local.remove("precomputeCache")` in service worker console
