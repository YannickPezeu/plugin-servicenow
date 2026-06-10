"""Probe candidate EPFL userinfo endpoints with the test JWTs from .env.

Tests every (URL, token_type) combination, reports status + response preview.
Goal: find the live endpoint the admin pointed at (/entra-api/v1/oidc/userinfo)
and discover the accreds response shape.
"""

import json
import os
import sys

import requests
from dotenv import load_dotenv


load_dotenv()

ID_TOKEN = os.environ.get("ID_JWT_TOKEN_TEST", "").strip()
ACCESS_TOKEN = os.environ.get("ACCESS_JWT_TOKEN_TEST", "").strip()

if not ID_TOKEN or not ACCESS_TOKEN:
    sys.exit("Missing ID_JWT_TOKEN_TEST or ACCESS_JWT_TOKEN_TEST in .env")

CANDIDATE_URLS = [
    "https://entra-api.epfl.ch/v1/oidc/userinfo",
    "https://entra-api.epfl.ch/oidc/userinfo",
    "https://api.epfl.ch/entra-api/v1/oidc/userinfo",
    "https://api.epfl.ch/v1/oidc/userinfo",
    "https://entra-api.epfl.ch/api/v1/oidc/userinfo",
    "https://tequila.epfl.ch/entra-api/v1/oidc/userinfo",
    # Microsoft's standard userinfo (baseline for comparison; works with access token)
    "https://graph.microsoft.com/oidc/userinfo",
]

TOKENS = [("ID", ID_TOKEN), ("ACCESS", ACCESS_TOKEN)]


def preview(text, n=400):
    text = text.replace("\r", "").strip()
    if len(text) <= n:
        return text
    return text[:n] + f"\n... [truncated, total {len(text)} chars]"


def try_get(url, token):
    try:
        r = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=10,
            allow_redirects=False,
        )
        return r.status_code, dict(r.headers), r.text
    except requests.exceptions.ConnectionError as e:
        return None, None, f"CONNECTION ERROR: {e}"
    except requests.exceptions.Timeout:
        return None, None, "TIMEOUT"
    except Exception as e:
        return None, None, f"ERROR: {type(e).__name__}: {e}"


print(f"Testing {len(CANDIDATE_URLS)} URLs × {len(TOKENS)} token types\n")
print("=" * 78)

hits = []
for url in CANDIDATE_URLS:
    print(f"\n>>> {url}")
    for label, token in TOKENS:
        status, headers, body = try_get(url, token)
        marker = "*" if status == 200 else " "
        status_str = str(status) if status is not None else "ERR"
        print(f"  {marker} [{label:6}] HTTP {status_str}")
        if status is None:
            print(f"      {body}")
        elif status == 200:
            hits.append((url, label, body))
            # Pretty-print JSON if possible
            try:
                parsed = json.loads(body)
                print("      " + json.dumps(parsed, indent=2, ensure_ascii=False).replace("\n", "\n      "))
            except Exception:
                print(f"      {preview(body)}")
        else:
            # Show response body for non-200 to learn what kind of error
            location = headers.get("location") or headers.get("Location") if headers else None
            if location:
                print(f"      Location: {location}")
            print(f"      {preview(body, 200)}")

print("\n" + "=" * 78)
print(f"\nSummary: {len(hits)} URL/token combos returned HTTP 200")
for url, label, _ in hits:
    print(f"  - {url} (with {label} token)")
