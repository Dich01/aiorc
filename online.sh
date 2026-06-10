#!/bin/bash
# AIOrc online — levanta el server local y lo expone a internet con un
# Cloudflare Quick Tunnel (gratis, sin cuenta, sin dominio).
#
# Uso:   ./online.sh           imprime la URL pública compartible
#        ./online.sh stop      baja el túnel (el server local sigue)
#
# La URL *.trycloudflare.com es aleatoria y cambia cada vez que el túnel
# se reinicia — mientras no lo toques, se mantiene.

set -e
cd "$(dirname "$0")"

SERVER_LOG=/tmp/aiorc-server.log
TUNNEL_LOG=/tmp/cf-tunnel.log

if [ "$1" = "stop" ]; then
  pkill -f "cloudflared tunnel --url" 2>/dev/null && echo "Túnel detenido." || echo "No había túnel corriendo."
  exit 0
fi

# ── 1. Server local ──────────────────────────────────────────────────────────
if ! curl -s -o /dev/null --max-time 2 http://localhost:3001/health; then
  echo "Levantando el servidor AIOrc..."
  if [ ! -f .jwt-secret ]; then openssl rand -hex 32 > .jwt-secret; fi
  JWT_SECRET=$(cat .jwt-secret) nohup npx ts-node-dev --respawn --transpile-only src/index.ts > "$SERVER_LOG" 2>&1 &
  for i in $(seq 1 20); do
    sleep 1
    curl -s -o /dev/null --max-time 2 http://localhost:3001/health && break
  done
fi
curl -s -o /dev/null --max-time 2 http://localhost:3001/health || { echo "ERROR: el servidor no arrancó. Revisá $SERVER_LOG"; exit 1; }
echo "Servidor OK en http://localhost:3001"

# ── 2. Túnel (reusa el existente si sigue vivo) ──────────────────────────────
URL=""
if pgrep -f "cloudflared tunnel --url" > /dev/null; then
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
fi
if [ -z "$URL" ]; then
  echo "Levantando túnel de Cloudflare..."
  pkill -f "cloudflared tunnel --url" 2>/dev/null || true
  nohup cloudflared tunnel --url http://localhost:3001 > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  for i in $(seq 1 15); do
    sleep 1
    URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    [ -n "$URL" ] && break
  done
  # Mantener la Mac despierta mientras el túnel viva
  if [ -n "$TUNNEL_PID" ]; then
    caffeinate -s -w "$TUNNEL_PID" > /dev/null 2>&1 &
  fi
fi
[ -z "$URL" ] && { echo "ERROR: no se pudo obtener la URL. Revisá $TUNNEL_LOG"; exit 1; }

# ── 3. Verificación end-to-end ───────────────────────────────────────────────
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$URL/health")
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  AIOrc en línea ($CODE):"
echo ""
echo "  $URL"
echo ""
echo "  MCP endpoint:  $URL/mcp"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "La Mac no se dormirá mientras el túnel esté activo (caffeinate)."
echo "Para bajarlo: ./online.sh stop"
