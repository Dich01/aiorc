#!/bin/bash
# deploy.sh — sube el codigo a la VM de Oracle y reconstruye los contenedores.
#
# Uso:   ./deploy.sh          despliega y reconstruye
#        ./deploy.sh logs     muestra estado y logs recientes
#
# IMPORTANTE: NO sube data/ — la DB viva vive en la VM (volumen docker).
# Copiar data/ pisaria los datos que cargaron los usuarios.

set -e
cd "$(dirname "$0")"

# ── Config ───────────────────────────────────────────────────────────────────
KEY=ssh-key-2026-07-08.key
HOST=ubuntu@204.216.144.224
REMOTE_DIR=/home/ubuntu/aiorc
URL=https://204-216-144-224.sslip.io
SSH="ssh -i $KEY -o ConnectTimeout=20"

# ── logs / estado ────────────────────────────────────────────────────────────
if [ "$1" = "logs" ]; then
  $SSH $HOST "cd $REMOTE_DIR && sudo docker compose ps && echo '--- logs ---' && sudo docker compose logs --tail=40"
  exit 0
fi

# ── 1. Copiar codigo (sin node_modules/dist/.git/data/secretos) ──────────────
echo "==> Subiendo codigo a la VM..."
# --delete: sin esto, un archivo borrado del repo se sigue sirviendo desde la VM
# para siempre. Paso exactamente eso con public/FaqBackup.html. Los --exclude
# protegen al receptor, asi que --delete NO toca data/, .env ni los secretos.
#
# Los secretos de produccion se excluyen a proposito: viven solo en la VM. Si se
# sincronizaran desde la maquina de desarrollo, un deploy pisaria el JWT_SECRET
# (cierra todas las sesiones) y la clave de firma de auditoria (invalida las
# firmas ya emitidas).
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='data' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='*.key' \
  --exclude='.env' \
  --exclude='.jwt-secret' \
  --exclude='.audit-secret' \
  --exclude='.mail-config.json' \
  -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  ./ "$HOST:$REMOTE_DIR/"

# ── 2. Reconstruir y levantar ────────────────────────────────────────────────
echo "==> Reconstruyendo y levantando contenedores..."
$SSH $HOST "cd $REMOTE_DIR && sudo docker compose up -d --build"

# ── 3. Verificacion end-to-end ───────────────────────────────────────────────
echo "==> Verificando..."
sleep 5
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$URL/health" || echo "000")
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Deploy listo. Health: HTTP $CODE"
echo "  $URL"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Ver logs:  ./deploy.sh logs"
