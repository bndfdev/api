#!/usr/bin/env bash
# Creates or updates the Bondfire API runtime configuration.
#
# AWS Secrets Manager (one JSON secret per environment, read by the ECS task):
#   MONGODB_URI  JWT_PRIVATE_KEY  JWT_PUBLIC_KEY
#   TOKEN_ENC_KEY  CODE_HMAC_KEY
#   SMTP_USER  SMTP_PASS              (only when SMTP_AUTH=true)
#
# SSM Parameter Store (non-sensitive config, also read by the ECS task):
#   <prefix>/<env>/SMTP_HOST  SMTP_PORT  SMTP_FROM
#
# Usage:
#   export AWS_REGION=ap-south-1
#   export MONGODB_URI='mongodb+srv://...'
#   export SMTP_HOST='email-smtp.ap-south-1.amazonaws.com'
#   export SMTP_FROM='Bondfire <no-reply@bondfire.ai>'
#   export SMTP_USER='...' SMTP_PASS='...'
#   ./create-secrets.sh dev
#
# Re-running updates MongoDB/SMTP values and keeps the existing keys. Set
# ROTATE_KEYS=true to replace the JWT key pair and TOKEN_ENC_KEY/CODE_HMAC_KEY
# (this logs out every session and invalidates outstanding tokens).
set -euo pipefail

ENV_NAME="${1:?usage: $0 <dev|qa|prod>}"
PREFIX="${SECRETS_PREFIX:-/bondfire}"
REGION="${AWS_REGION:-$(aws configure get region || true)}"
SECRET_NAME="${SECRET_NAME:-bondfire/$ENV_NAME/runtime}"

if [ -z "${REGION:-}" ]; then
  echo "AWS_REGION is not set and no default region is configured." >&2
  exit 1
fi

command -v python3 >/dev/null 2>&1 || {
  echo "python3 is required to merge the secret JSON." >&2
  exit 1
}

: "${MONGODB_URI:?export MONGODB_URI=mongodb+srv://...}"
: "${SMTP_HOST:?export SMTP_HOST=...}"
: "${SMTP_FROM:?export SMTP_FROM='Bondfire <no-reply@bondfire.ai>'}"

SMTP_PORT="${SMTP_PORT:-587}"
SMTP_AUTH="${SMTP_AUTH:-true}"
ROTATE_KEYS="${ROTATE_KEYS:-false}"

if [ "$SMTP_AUTH" = "true" ]; then
  : "${SMTP_USER:?export SMTP_USER=... (or SMTP_AUTH=false)}"
  : "${SMTP_PASS:?export SMTP_PASS=... (or SMTP_AUTH=false)}"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

secret_exists() {
  aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" >/dev/null 2>&1
}

CURRENT_FILE="$TMP_DIR/current.json"
if secret_exists; then
  aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$REGION" \
    --query SecretString --output text \
    | python3 -c 'import json,sys; json.dump(json.load(sys.stdin), open(sys.argv[1], "w"))' "$CURRENT_FILE"
else
  printf '{}' > "$CURRENT_FILE"
fi

need_keys=$(python3 - "$CURRENT_FILE" "$ROTATE_KEYS" <<'PY'
import json, sys
cur = json.load(open(sys.argv[1]))
rotate = sys.argv[2] == 'true'
have = all(cur.get(k) for k in ('JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'TOKEN_ENC_KEY', 'CODE_HMAC_KEY'))
print('0' if (have and not rotate) else '1')
PY
)

if [ "$need_keys" = "1" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$TMP_DIR/ec.pem"
  openssl pkcs8 -topk8 -nocrypt -in "$TMP_DIR/ec.pem" -out "$TMP_DIR/private.pem"
  openssl ec -in "$TMP_DIR/private.pem" -pubout -out "$TMP_DIR/public.pem" 2>/dev/null

  JWT_PRIVATE_KEY="$(cat "$TMP_DIR/private.pem")"
  JWT_PUBLIC_KEY="$(cat "$TMP_DIR/public.pem")"
  TOKEN_ENC_KEY="$(openssl rand -base64 32)"
  CODE_HMAC_KEY="$(openssl rand -base64 32)"
  echo "  new  JWT key pair + TOKEN_ENC_KEY + CODE_HMAC_KEY"
else
  JWT_PRIVATE_KEY=$(python3 -c 'import json,sys; sys.stdout.write(json.load(open(sys.argv[1]))["JWT_PRIVATE_KEY"])' "$CURRENT_FILE")
  JWT_PUBLIC_KEY=$(python3 -c 'import json,sys; sys.stdout.write(json.load(open(sys.argv[1]))["JWT_PUBLIC_KEY"])' "$CURRENT_FILE")
  TOKEN_ENC_KEY=$(python3 -c 'import json,sys; sys.stdout.write(json.load(open(sys.argv[1]))["TOKEN_ENC_KEY"])' "$CURRENT_FILE")
  CODE_HMAC_KEY=$(python3 -c 'import json,sys; sys.stdout.write(json.load(open(sys.argv[1]))["CODE_HMAC_KEY"])' "$CURRENT_FILE")
  echo "  keep existing JWT key pair + TOKEN_ENC_KEY + CODE_HMAC_KEY (ROTATE_KEYS=true to replace)"
fi

export MONGODB_URI JWT_PRIVATE_KEY JWT_PUBLIC_KEY TOKEN_ENC_KEY CODE_HMAC_KEY SMTP_AUTH
export SMTP_USER="${SMTP_USER:-}" SMTP_PASS="${SMTP_PASS:-}"

NEW_JSON=$(python3 - "$CURRENT_FILE" <<'PY'
import json, os, sys
with open(sys.argv[1]) as f:
    cur = json.load(f)
cur.update({
    'MONGODB_URI': os.environ['MONGODB_URI'],
    'JWT_PRIVATE_KEY': os.environ['JWT_PRIVATE_KEY'],
    'JWT_PUBLIC_KEY': os.environ['JWT_PUBLIC_KEY'],
    'TOKEN_ENC_KEY': os.environ['TOKEN_ENC_KEY'],
    'CODE_HMAC_KEY': os.environ['CODE_HMAC_KEY'],
})
if os.environ['SMTP_AUTH'] == 'true':
    cur['SMTP_USER'] = os.environ['SMTP_USER']
    cur['SMTP_PASS'] = os.environ['SMTP_PASS']
else:
    cur.pop('SMTP_USER', None)
    cur.pop('SMTP_PASS', None)
print(json.dumps(cur))
PY
)

echo "Writing runtime config for $ENV_NAME in $REGION"

if secret_exists; then
  aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" \
    --secret-string "$NEW_JSON" --region "$REGION" >/dev/null
  echo "  ok  updated secret $SECRET_NAME"
else
  aws secretsmanager create-secret --name "$SECRET_NAME" \
    --description "Bondfire $ENV_NAME runtime secrets" \
    --secret-string "$NEW_JSON" --region "$REGION" >/dev/null
  echo "  ok  created secret $SECRET_NAME"
fi

put() {
  aws ssm put-parameter --name "$1" --type "$2" --value "$3" \
    --overwrite --region "$REGION" >/dev/null
  echo "  ok  $1"
}

put "$PREFIX/$ENV_NAME/SMTP_HOST" String "$SMTP_HOST"
put "$PREFIX/$ENV_NAME/SMTP_PORT" String "$SMTP_PORT"
put "$PREFIX/$ENV_NAME/SMTP_FROM" String "$SMTP_FROM"

SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" \
  --region "$REGION" --query ARN --output text)

echo
echo "Secret ARN (pass as SecretArn):"
echo "  $SECRET_ARN"
echo
echo "Done. Next: deploy the stack, then curl https://${ENV_NAME}.<domain>/health/ready"
