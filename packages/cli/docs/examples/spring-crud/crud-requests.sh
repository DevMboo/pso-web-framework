#!/usr/bin/env bash
# Exercises every CRUD operation through the orchestrator. Run from the workspace root, with the service and the orchestrator running.
set -euo pipefail
GATEWAY="${GATEWAY:-http://127.0.0.1:3000}"
WRITE_TOKEN="$(node dev-token.mjs "products:read products:write")"
READ_TOKEN="$(node dev-token.mjs "products:read")"
json='content-type: application/json'

echo "== create";  curl -s -i -X POST "$GATEWAY/products" -H "authorization: Bearer $WRITE_TOKEN" -H "$json" -d '{"sku":"KB-100","name":"Keyboard","priceCents":4999}'
echo; echo "== list";    curl -s "$GATEWAY/products" -H "authorization: Bearer $READ_TOKEN"
ID="$(curl -s "$GATEWAY/products" -H "authorization: Bearer $READ_TOKEN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d)[0].id))')"
echo; echo "== get";     curl -s "$GATEWAY/products/$ID" -H "authorization: Bearer $READ_TOKEN"
echo; echo "== update";  curl -s -X PUT "$GATEWAY/products/$ID" -H "authorization: Bearer $WRITE_TOKEN" -H "$json" -d '{"name":"Mechanical keyboard","priceCents":5999}'
echo; echo "== delete";  curl -s -i -X DELETE "$GATEWAY/products/$ID" -H "authorization: Bearer $WRITE_TOKEN" | head -1
echo "== get after delete"; curl -s -o /dev/null -w "%{http_code}\n" "$GATEWAY/products/$ID" -H "authorization: Bearer $READ_TOKEN"
