// background.js — Service worker that proxies API calls (bypasses CORS)

importScripts("oidc.js");

var API_URL = "https://hierarchical-search.epfl.ch/rag/servicenow/generate";
var API_KEY_DEFAULT = "";
// Ignoré par /rag/servicenow/generate (source imposée : site + KB ServiceNow OBO),
// gardé pour le champ `library_used`/logs côté backend.
var API_LIBRARY = "servicenow_obo";

// MODELE UNIQUE depuis le 06.10.2026 : GLM-5.3-Flash, avec un interrupteur
// Reflexion (`reasoning` : "low" par defaut, "full" sur demande) -- comme
// Personal RAG (DPO-Agent) depuis le 22-24.09. Doit rester aligne avec
// GLM_MODEL dans content.js.
//
// Mesures, 264 tickets ServiceNow, grille ancree, juge Kimi-K2.7 (epfl-scraper,
// docs/rapport-evaluation-assistants-2026-08.md §6.11) :
//   GLM-5.3-Flash `full`  2,41   1er mot ~41 s a 50 usagers
//   GLM-5.3-Flash `low`   2,22   1er mot ~8 s
//   Qwen3.6-35B           1,96   (defaut du 10.08 au 06.10.2026)
//   Kimi-K2.7             2,41   (= GLM full : il sort du selecteur)
//
// Le niveau de reflexion est applique par le BACKEND (Hierarchical_search,
// _reglage_glm5) : sur GLM, seul `reasoning_effort: "low"` coupe la reflexion ;
// `enable_thinking: false` la deverse dans la reponse.
//
// Historique : 10.08.2026 : Qwen3.6-35B-A3B remplace Kimi-K2.7-Code comme defaut, au terme
// de l'evaluation de bout en bout (epfl-scraper,
// docs/rapport-evaluation-assistants-2026-08.md).
//
// /!\ 02.09.2026 : Qwen3.8-27B a ete retenu comme defaut puis ANNULE le jour
// meme. Il est DEMONTRE meilleur sur le banc — +0,178 [+0,059 ; +0,296] en
// apparie sur 264 tickets, grille ancree — et il coute moins cher. Mais RCP ne
// le sert PAS 24/7 : un modele charge a la demande impose 10 a 15 minutes de
// demarrage a froid au premier usager qui le sollicite. Redhibitoire pour un
// guichet, quelle que soit la qualite.
//
// La campagne des 01-02.09 avait mesure qualite, prix et latence, et OMIS la
// disponibilite — que le rapport d'aout suivait pourtant, colonne "24/7" contre
// "a la demande". A reconsiderer si Qwen3.8 passe en service permanent.
var DEFAULT_MODEL = "zai-org/GLM-5.3-Flash";

// Modeles retires cote RCP ou ecartes par la mesure. Le choix de l'utilisateur
// vit dans chrome.storage, donc un id retire survit a la mise a jour de
// l'extension et fait echouer — ou pire, reussir avec un mauvais modele — tous
// les appels RAG. On le remappe une fois, a l'installation/mise a jour.
// 2026-07-30 : Kimi-K2.6 n'est plus servi 24/7, remplace par Kimi-K2.7-Code.
// 2026-08-10 : Mistral-Small et gpt-oss sortent du catalogue. gpt-oss n'est pas
//   retire parce qu'il n'est plus servi, mais parce qu'il produit une
//   affirmation contredite par ses propres sources a chaque reponse.
// 2026-10-06 : Qwen3.6-35B et Kimi-K2.7 sortent a leur tour (modele unique
//   GLM-5.3-Flash). content.js envoie de toute facon GLM_MODEL sans lire le
//   choix stocke ; ce remappage nettoie seulement le stockage.
var RETIRED_MODELS = [
  "Qwen/Qwen3.6-35B-A3B",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "mistralai/Mistral-Small-3.2-24B-Instruct-2506-bfloat16",
  "openai/gpt-oss-120b-bfloat16",
];

chrome.runtime.onInstalled.addListener(function () {
  // Anciens reglages du popup, retires le 07.10.2026 (cf. TOP_K / RERANK, content.js).
  chrome.storage.local.remove(["topK", "rerank"]);
  // Precalcul retire le 07.10.2026 (groupe d'affectation, alarme 15 min,
  // declenchement a la navigation) : ses cles ne servent plus.
  chrome.storage.local.remove(["assignmentGroup", "snGckTimestamp"]);
  chrome.storage.local.get({ model: "" }, function (data) {
    if (data.model && RETIRED_MODELS.indexOf(data.model) !== -1) {
      chrome.storage.local.set({ model: DEFAULT_MODEL }, function () {
        console.log("[SN AI Plugin] Modele retire " + data.model + " -> " + DEFAULT_MODEL);
      });
    }
  });
});

// Note: the LLM system prompt lives server-side (DEFAULT_ANSWER_SYSTEM_PROMPT
// in Hierarchical_search/full_RAG_api/core/prompts.py) — it dictates the
// `[N: "verbatim quote"]` citation format that this extension parses.

// --- Shared utilities ---

function buildResponsePayload(answer, sources) {
  var list = Array.isArray(sources) ? sources : [];

  var cited = new Set();
  // Matches both [N] (legacy) and [N: "verbatim quote"] (DPO-style)
  var regex = /\[(\d+)(?::\s*"[^"]*")?\]/g;
  var match;
  while ((match = regex.exec(answer)) !== null) {
    cited.add(parseInt(match[1], 10));
  }

  var enriched = list.map(function (src, i) {
    var num = i + 1;
    return {
      number: num,
      title: (src.title || "Source " + num).replace(/\.md$/, ""),
      source_url: src.source_url || "",
      score: typeof src.score === "number" ? src.score : null,
      snippet: src.snippet || "",
      precise_content: src.precise_content || src.snippet || "",
      // context_content (chunk parent large) is what the LLM saw and what the
      // modal must display so that [N: "quote"] highlight finds the phrase.
      context_content: src.context_content || src.precise_content || src.snippet || "",
      header_path: src.header_path || "",
      page_number: typeof src.page_number === "number" ? src.page_number : null,
      file_type: src.file_type || "",
      search_text_start: src.search_text_start || "",
      search_text_end: src.search_text_end || "",
      cited: cited.has(num),
    };
  });

  return { text: answer, sources: enriched };
}

// Builds RAG request headers, adding Bearer token if user is signed in via OIDC.
function buildRagHeaders(apiKey) {
  return oidcGetIdToken().then(function (idToken) {
    var headers = {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    };
    if (idToken) headers["Authorization"] = "Bearer " + idToken;
    return headers;
  });
}

// Extrait le dernier message client de l'historique pour l'utiliser comme
// query de recherche RAG. Sans cela, le RAG cherche toujours sur le titre
// original du ticket (ex: "numero de TVA") meme si la derniere question
// du client porte sur un tout autre sujet (ex: "batiment INJ ferme").
function extractLastClientQuery(messages) {
  if (!messages || messages.length === 0) return null;
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender === "client") {
      return messages[i].content;
    }
  }
  return null;
}

// Préfixe les messages d'un ticket avec des instructions système :
// 1) Dire au modèle de répondre au DERNIER message (sinon il répond au 1er)
// 2) Injecter le contexte d'actualité s'il est présent
// TODO: une fois que le backend gérera un champ `additional_context` dédié,
// l'utiliser à la place de cette injection dans previous_messages.
function prependSystemInstructions(messages, additionalContext) {
  var sys =
    "Tu es un assistant du servicedesk IT de l'EPFL. " +
    "L'historique de conversation est en ordre chronologique (le plus ancien en premier, le plus recent en dernier). " +
    "IMPORTANT : reponds UNIQUEMENT au DERNIER message de l'historique. " +
    "Si le dernier message provient du client, c'est sa question ou sa demande la plus recente : reponds a celle-ci. " +
    "Ne reponds pas aux messages precedents, ils ont deja ete traites.";
  if (additionalContext && additionalContext.trim()) {
    sys +=
      "\n\n[CONTEXTE D'ACTUALITE — Information fournie par le servicedesk]\n" +
      "Les informations ci-dessous decrivent une situation d'actualite (incident, fermeture de batiment, panne, etc.) communiquee par le servicedesk. " +
      "Elles sont AUTORISEES et PRIORITAIRES : si le ticket concerne ce sujet, reponds directement a partir de ces informations, de facon concise et naturelle, " +
      "comme tu le ferais avec une information evidente. " +
      "Ne cite PAS ce contexte avec le format [N: \"phrase\"] : ce ne sont pas des passages de reference, mais une directive du servicedesk. " +
      "Tu peux quand meme citer les passages de reference normaux si tu en utilises.\n\n" +
      additionalContext.trim();
  }
  var result = [{ sender: "system", content: sys }].concat(messages || []);

  // Message system FINAL : apres tout l'historique, on rappelle au modele
  // quel message il doit traiter. Sans cela, quand il y a plusieurs questions
  // client sans reponse entre les deux, le modele repond a une question
  // du milieu au lieu de la derniere.
  if (messages && messages.length > 0) {
    var last = messages[messages.length - 1];
    var lastSnippet = last.content.length > 120
      ? last.content.slice(0, 120) + "..."
      : last.content;
    result = result.concat([{
      sender: "system",
      content: "=== FIN DE L'HISTORIQUE ===\n" +
               "Tu dois repondre UNIQUEMENT au dernier message ci-dessus" +
               (last.sender === "client" ? " (provenant du client)" : "") +
               ". Voici son debut : \"" + lastSnippet + "\"\n" +
               "Les messages precedents ont tous ete traites. Ne reponds a aucun d'entre eux."
    }]);
  }

  return result;
}

// --- ServiceNow REST API ---

function fetchJournalEntries(origin, gck, sysId) {
  var url = origin + "/api/now/table/sys_journal_field" +
            "?sysparm_query=element_id=" + sysId +
            "^elementINcomments,work_notes" +
            "&sysparm_fields=value,element,sys_created_on,sys_created_by" +
            "&sysparm_display_value=true" +
            "&sysparm_limit=20" +
            "&sysparm_orderby=sys_created_on";

  return fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-UserToken": gck,
    },
    credentials: "include",
  })
  .then(function (r) {
    if (!r.ok) throw new Error("SN journal API error: " + r.status);
    return r.json();
  })
  .then(function (data) {
    return data.result || [];
  });
}

// Parse un champ journal SN (display_value) en entrees individuelles.
// Format d'une entree : "YYYY-MM-DD HH:MM:SS - Auteur (Label)\n<contenu>"
// Les entrees sont du plus recent au plus ancien.
function parseJournalField(text, defaultSender) {
  if (!text) return [];
  var headerRe = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - (.*?)\s*\((.*?)\)\s*$/gm;
  var heads = [];
  var m;
  while ((m = headerRe.exec(text)) !== null) {
    heads.push({ ts: m[1], author: m[2].trim(), start: m.index, contentStart: headerRe.lastIndex });
  }
  var out = [];
  for (var i = 0; i < heads.length; i++) {
    var end = (i + 1 < heads.length) ? heads[i + 1].start : text.length;
    var content = text.slice(heads[i].contentStart, end).trim();
    if (content) out.push({ ts: heads[i].ts, author: heads[i].author, sender: defaultSender, content: content });
  }
  return out;
}

// Recupere l'historique du ticket via les champs comments/work_notes du record
// incident (display_value) — l'API table/sys_journal_field est bloquee par ACL.
// Retourne les messages en ordre CHRONOLOGIQUE (le plus recent en dernier).
function fetchTicketComments(origin, gck, sysId) {
  var url = origin + "/api/now/table/incident/" + sysId +
            "?sysparm_fields=comments,work_notes,caller_id&sysparm_display_value=true";
  return fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json", "X-UserToken": gck },
    credentials: "include",
  })
  .then(function (r) {
    if (!r.ok) throw new Error("SN incident API error: " + r.status);
    return r.json();
  })
  .then(function (data) {
    var rec = data.result || {};
    var callerName = (rec.caller_id || "").trim().toLowerCase();
    var comments = parseJournalField(rec.comments, "client");
    var workNotes = parseJournalField(rec.work_notes, "agent_support");

    // Re-labeliser les commentaires : dans ServiceNow, le champ "comments"
    // contient a la fois les messages du client ET les reponses de l'agent.
    // Tout etiqueter "client" rend le modele incapable de distinguer questions
    // et reponses dans l'historique, ce qui le fait repondre au mauvais message.
    // Heuristique 1 : si l'auteur != caller_id, c'est un agent.
    // Heuristique 2 : si le contenu contient la signature "Support IT EPFL",
    //                c'est une reponse generee par l'IA (meme si auteur = caller).
    comments.forEach(function (e) {
      if (callerName && e.author && e.author.toLowerCase() !== callerName) {
        e.sender = "agent_support";
      }
      if (/Support\s*IT\s*EPFL/i.test(e.content)) {
        e.sender = "agent_support";
      }
    });

    var msgs = comments.concat(workNotes);
    msgs.sort(function (a, b) { return a.ts < b.ts ? -1 : (a.ts > b.ts ? 1 : 0); });
    return msgs.map(function (e) { return { sender: e.sender, content: e.content }; });
  });
}

// --- Streaming SSE (affichage token par token, chemin à la demande) ---
// Distinct du précompute (qui reste non-streaming et alimente le cache).

// Enrichit les sources brutes du backend (event SSE "sources") pour matcher la
// forme attendue par la proposition box (number, cited, champs modal).
function enrichStreamSources(sources) {
  var list = Array.isArray(sources) ? sources : [];
  return list.map(function (src, i) {
    var num = i + 1;
    return {
      number: num,
      title: (src.title || "Source " + num).replace(/\.md$/, ""),
      source_url: src.source_url || "",
      score: typeof src.score === "number" ? src.score : null,
      snippet: src.snippet || "",
      precise_content: src.precise_content || src.snippet || "",
      context_content: src.context_content || src.precise_content || src.snippet || "",
      header_path: src.header_path || "",
      page_number: typeof src.page_number === "number" ? src.page_number : null,
      file_type: src.file_type || "",
      search_text_start: src.search_text_start || "",
      search_text_end: src.search_text_end || "",
      cited: true,
    };
  });
}

// Silence toléré ENTRE DEUX événements SSE avant d'abandonner. C'est un délai
// d'inactivité, pas une durée totale : le backend laisse au modèle jusqu'à 300 s
// pour rédiger, et une réponse longue mais qui progresse ne doit pas être coupée.
var STREAM_IDLE_TIMEOUT_MS = 120000;
// Garde-fou absolu, pour qu'un flux qui bavarde sans jamais conclure finisse
// quand même par rendre la main.
var STREAM_MAX_MS = 600000;

// /!\ SANS CECI, LE STREAMING MEURT SUR LES RÉPONSES LENTES.
// Chrome termine un service worker MV3 après 30 s sans activité, et lire des
// octets d'un `fetch` ne compte PAS comme une activité : seuls un appel d'API
// `chrome.*` ou la réception d'un événement réarment le compteur. Le port est
// alors fermé sous les pieds du content script, qui affiche « Connexion
// interrompue » — sans erreur nulle part, puisque techniquement rien n'a échoué.
// Un appel bidon toutes les 20 s suffit à réarmer le compteur.
//
// La cause première était côté backend (le raisonnement du modèle n'était pas
// relayé, cf. `chat_completion_stream_events` dans Hierarchical_search : 30,5 s
// de silence mesurées le 03.09.2026 sur Qwen3.6). Ce keepalive reste néanmoins
// nécessaire : il protège aussi la phase de recherche et tout futur modèle qui
// ne dirait rien pendant une demi-minute.
function startKeepalive() {
  return setInterval(function () {
    chrome.runtime.getPlatformInfo(function () {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }, 20000);
}

// Lit le flux SSE et relaie chunks/sources au port. Événements backend :
// {type:"metadata"} {type:"sources",sources} {type:"progress",message}
// {type:"reasoning_chunk",content} {type:"answer_chunk",content} {type:"done"}
function readSSEStream(body, port, onActivity) {
  var reader = body.getReader();
  var decoder = new TextDecoder();
  var buffer = "";
  function pump() {
    return reader.read().then(function (result) {
      if (result.done) return;
      if (onActivity) onActivity();
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split("\n");
      buffer = lines.pop(); // garde la dernière ligne potentiellement incomplète
      lines.forEach(function (line) {
        line = line.trim();
        if (!line || line.indexOf("data:") !== 0) return;
        var data = line.substring(5).trim();
        if (!data) return;
        try {
          var ev = JSON.parse(data);
          if (ev.type === "answer_chunk" && ev.content) {
            port.postMessage({ type: "chunk", text: ev.content });
          } else if (ev.type === "reasoning_chunk" && ev.content) {
            port.postMessage({ type: "reasoning", text: ev.content });
          } else if (ev.type === "sources") {
            port.postMessage({ type: "sources", sources: enrichStreamSources(ev.sources) });
          } else if (ev.type === "progress" && ev.message) {
            port.postMessage({ type: "progress", message: ev.message });
          }
          // metadata ignoré ; done géré par le finally côté handler
        } catch (e) { /* keepalive / ligne non-JSON : ignorer */ }
      });
      return pump();
    });
  }
  return pump();
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== "rag-stream") return;

  port.onMessage.addListener(function (request) {
    if (request.type !== "rag-generate") return;

    var payload = request.payload || {};
    payload.stream = true;
    var sysId = request.sysId;

    chrome.storage.local.get({ apiKey: API_KEY_DEFAULT, snGck: "", snOrigin: "", additionalContext: "" }, function (settings) {
      // Historique via l'API record (comme le non-stream), remplace previous_messages.
      var prep = Promise.resolve();
      if (sysId && settings.snGck && settings.snOrigin) {
        prep = fetchTicketComments(settings.snOrigin, settings.snGck, sysId)
          .then(function (messages) {
            payload.previous_messages = prependSystemInstructions(messages, settings.additionalContext);
            var lastQuery = extractLastClientQuery(messages);
            if (lastQuery) { payload.short_description = lastQuery; payload.description = lastQuery; }
          })
          .catch(function (e) { console.warn("[SN AI Plugin] stream: lecture comments échouée:", e); });
      }

      prep.then(function () {
        buildRagHeaders(settings.apiKey).then(function (headers) {
          if (!headers["Authorization"] && !settings.apiKey) {
            port.postMessage({ type: "error", error: "Non connecté : ouvre le popup et connecte-toi (OIDC)." });
            port.postMessage({ type: "done" });
            return;
          }
          var controller = new AbortController();
          var idleTimer = null;
          var abortedForIdle = false;
          var keepalive = startKeepalive();

          function armIdleTimer() {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(function () {
              abortedForIdle = true;
              controller.abort();
            }, STREAM_IDLE_TIMEOUT_MS);
          }
          var maxTimer = setTimeout(function () { controller.abort(); }, STREAM_MAX_MS);
          armIdleTimer();

          // L'onglet est fermé / la page rechargée : inutile de laisser le
          // modèle écrire dans le vide, on coupe l'appel.
          port.onDisconnect.addListener(function () { controller.abort(); });

          fetch(API_URL, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          })
          .then(function (response) {
            armIdleTimer();
            if (!response.ok) {
              return response.text().then(function (b) {
                throw new Error("API error: " + response.status + " - " + b.substring(0, 200));
              });
            }
            return readSSEStream(response.body, port, armIdleTimer);
          })
          .catch(function (err) {
            var message = abortedForIdle
              ? "Le serveur n'a rien envoyé pendant " + (STREAM_IDLE_TIMEOUT_MS / 1000) + " s — génération abandonnée."
              : err.message;
            try { port.postMessage({ type: "error", error: message }); } catch (e) { /* port fermé */ }
          })
          .finally(function () {
            clearTimeout(idleTimer);
            clearTimeout(maxTimer);
            clearInterval(keepalive);
            try { port.postMessage({ type: "done" }); } catch (e) { /* port fermé */ }
          });
        });
      });
    });
  });
});

// --- Cache eviction (remove entries older than 7 days) ---

function evictOldCacheEntries() {
  chrome.storage.local.get({ precomputeCache: {} }, function (data) {
    var cache = data.precomputeCache;
    var now = Date.now();
    var maxAge = 7 * 24 * 60 * 60 * 1000;
    var changed = false;

    Object.keys(cache).forEach(function (sysId) {
      if (now - cache[sysId].timestamp > maxAge) {
        delete cache[sysId];
        changed = true;
      }
    });

    if (changed) {
      chrome.storage.local.set({ precomputeCache: cache });
      console.log("[SN AI Plugin] Evicted old cache entries");
    }
  });
}

evictOldCacheEntries();

// --- Message handler ---

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.type !== "rag-generate") return false;

  var payload = request.payload;

  chrome.storage.local.get({ apiKey: API_KEY_DEFAULT, snGck: "", snOrigin: "", additionalContext: "" }, function (settings) {

    // L'historique de conversation est recupere via l'API ServiceNow (fiable,
    // independant de l'UI classique/moderne) plutot que par scraping DOM cote
    // content script. Sans ca, les questions de suivi ne remontent pas et le RAG
    // re-repond a la question initiale du ticket.
    var prep = Promise.resolve();
    if (request.sysId && settings.snGck && settings.snOrigin) {
      prep = fetchTicketComments(settings.snOrigin, settings.snGck, request.sysId)
        .then(function (messages) {
          payload.previous_messages = prependSystemInstructions(messages, settings.additionalContext);
          var lastQuery = extractLastClientQuery(messages);
          if (lastQuery) { payload.short_description = lastQuery; payload.description = lastQuery; }
          console.log("[SN AI Plugin] on-demand: " + messages.length + " messages depuis comments/work_notes");
        })
        .catch(function (e) {
          console.warn("[SN AI Plugin] lecture comments echouee, fallback messages DOM:", e);
        });
    }

    prep.then(function () {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, 120000);

      buildRagHeaders(settings.apiKey).then(function (headers) {
        // L'auth passe par le Bearer OIDC. La clé API n'est plus requise.
        if (!headers["Authorization"] && !settings.apiKey) {
          throw new Error("Non connecté : ouvre le popup et connecte-toi (OIDC), ou configure une clé API.");
        }
        return fetch(API_URL, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      })
      .then(function (response) {
        if (!response.ok) {
          return response.text().then(function (body) {
            console.error("[SN AI Plugin] API error " + response.status + ":", body);
            throw new Error("API error: " + response.status + " - " + body.substring(0, 200));
          });
        }
        return response.json();
      })
      .then(function (data) {
        var answer =
          data.answer ||
          data.response ||
          data.message ||
          data.text ||
          data.content ||
          (typeof data === "string" ? data : JSON.stringify(data));

        var built = buildResponsePayload(answer, data.sources);
        sendResponse({ success: true, text: built.text, sources: built.sources });
      })
      .catch(function (err) {
        sendResponse({ success: false, error: err.message });
      })
      .finally(function () {
        clearTimeout(timeoutId);
      });
    });
  });

  return true;
});
