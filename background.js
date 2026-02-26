// background.js — Service worker that proxies API calls (bypasses CORS)

var API_URL = "https://lex-chatbot.epfl.ch/rag/generate";
var API_KEY_DEFAULT = "";

var SYSTEM_PROMPT =
  "Tu es un assistant de support IT pour l'EPFL. Tu rediges des reponses a des tickets ServiceNow.\n\n" +
  "REGLES DE FORMATAGE STRICTES :\n" +
  "- Ecris UNIQUEMENT en texte brut. Pas de markdown, pas de gras, pas de titres, pas de listes a puces avec tirets.\n" +
  "- La reponse sera inseree dans une textarea ServiceNow qui ne supporte AUCUN formatage.\n" +
  "- Cite tes sources dans le texte avec des numeros entre crochets : [1], [2], etc.\n" +
  "- Chaque numero correspond a un document source qui sera liste en bas de la reponse automatiquement.\n" +
  "- Sois professionnel, concis et utile. Reponds en francais.\n" +
  "- Ne mets pas de section 'Sources' toi-meme, elle sera ajoutee automatiquement.";

function formatResponseWithSources(answer, sources) {
  if (!sources || sources.length === 0) return answer;

  // Find which source numbers the LLM actually cited in the answer
  var citedNumbers = new Set();
  var regex = /\[(\d+)\]/g;
  var match;
  while ((match = regex.exec(answer)) !== null) {
    citedNumbers.add(parseInt(match[1], 10));
  }

  if (citedNumbers.size === 0) return answer;

  // Only include sources that were actually referenced
  var sourceLines = ["\n\n--- Sources ---"];
  citedNumbers.forEach(function (num) {
    var idx = num - 1;
    if (idx >= 0 && idx < sources.length) {
      var src = sources[idx];
      var title = (src.title || "Source " + num).replace(/\.md$/, "");
      var url = src.source_url || "";
      sourceLines.push("[" + num + "] " + title + (url ? " : " + url : ""));
    }
  });

  return answer + sourceLines.join("\n");
}

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.type !== "rag-generate") return false;

  // System prompt is handled server-side to avoid WAF blocking
  var payload = request.payload;

  chrome.storage.local.get({ apiKey: API_KEY_DEFAULT }, function (settings) {
    if (!settings.apiKey) {
      sendResponse({ success: false, error: "Cle API non configuree. Ouvrez le popup du plugin pour la saisir." });
      return;
    }

    var controller = new AbortController();
    var timeoutId = setTimeout(function () { controller.abort(); }, 120000);

    fetch(API_URL, {
      method: "POST",
      headers: {
        "X-API-Key": settings.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
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

      var text = formatResponseWithSources(answer, data.sources);
      sendResponse({ success: true, text: text });
    })
    .catch(function (err) {
      sendResponse({ success: false, error: err.message });
    })
    .finally(function () {
      clearTimeout(timeoutId);
    });
  });

  // Return true to indicate async sendResponse
  return true;
});
