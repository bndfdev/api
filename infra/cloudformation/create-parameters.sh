#!/usr/bin/env bash
# Creates the SSM parameters the Bondfire API task definition reads at startup.
#
#   MONGODB_URI SMTP_HOST SMTP_PORT SMTP_FROM        always written
#   SMTP_USER SMTP_PASS                              only when SMTP_AUTH=true
#   JWT_PRIVATE_KEY JWT_PUBLIC_KEY                   generated once, never rotated by accident
#   TOKEN_ENC_KEY CODE_HMAC_KEY                      generated once (rotating them logs everyone out)
#
# Usage:
#   export AWS_REGION=ap-south-1
#   export MONGODB_URI='mongodb+srv://...'
#   export SMTP_HOST='email-smtp.ap-south-1.amazonaws.com'
#   export SMTP_FROM='Bondfire <no-reply@bondfire.com>'
#   export SMTP_USER='...' SMTP_PASS='...'
#   ./create-parameters.sh dev
#
# Re-running updates MongoDB/SMTP values, keeps existing keys. Set ROTATE_KEYS=true
# to replace the key pair and TOKEN_ENC_KEY/CODE_HMAC_KEY (invalidates all tokens).
set -euo pipefail

ENV_NAME="${1:?usage: $0 <dev|qa|prod>}"
PREFIX="${SECRETS_PREFIX:-/bondfire}"
REGION="${AWS_REGION:-$(aws configure get region || true)}"

if [ -z "${REGION:-}" ]; then
  echo "AWS_REGION is not set and no default region is configured." >&2
  exit 1
fi

: "${MONGODB_URI:?export MONGODB_URI=mongodb+srv://...}"
: "${SMTP_HOST:?export SMTP_HOST=...}"
: "${SMTP_FROM:?export SMTP_FROM='Bondfire <no-reply@bondfire.com>'}"

SMTP_PORT="${SMTP_PORT:-587}"
SMTP_AUTH="${SMTP_AUTH:-true}"
ROTATE_KEYS="${ROTATE_KEYS:-false}"

if [ "$SMTP_AUTH" = "true" ]; then
  : "${SMTP_USER:?export SMTP_USER=... (or SMTP_AUTH=false)}"
  : "${SMTP_PASS:?export SMTP_PASS=... (or SMTP_AUTH=false)}"
fi

exists() {
  aws ssm get-parameter --name "$1" --region "$REGION" >/dev/null 2>&1
}

put() {
  aws ssm put-parameter \
    --name "$1" --type "$2" --value "$3" --overwrite --region "$REGION" >/dev/null
  echo "  ok  $1"
}

echo "Writing parameters under $PREFIX/$ENV_NAME in $REGION"

put "$PREFIX/$ENV_NAME/MONGODB_URI" SecureString "$MONGODB_URI"
put "$PREFIX/$ENV_NAME/SMTP_HOST" String "$SMTP_HOST"
put "$PREFIX/$ENV_NAME/SMTP_PORT" String "$SMTP_PORT"
put "$PREFIX/$ENV_NAME/SMTP_FROM" String "$SMTP_FROM"

if [ "$SMTP_AUTH" = "true" ]; then
  put "$PREFIX/$ENV_NAME/SMTP_USER" SecureString "$SMTP_USER"
  put "$PREFIX/$ENV_NAME/SMTP_PASS" SecureString "$SMTP_PASS"
fi

if [ "$ROTATE_KEYS" = "true" ] || ! exists "$PREFIX/$ENV_NAME/JWT_PRIVATE_KEY"; then
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  openssl ecparam -name prime256v1 -genkey -noout -out "$TMP_DIR/ec.pem"
  openssl pkcs8 -topk8 -nocrypt -in "$TMP_DIR/ec.pem" -out "$TMP_DIR/private.pem"
  openssl ec -in "$TMP_DIR/private.pem" -pubout -out "$TMP_DIR/public.pem" 2>/dev/null

  put "$PREFIX/$ENV_NAME/JWT_PRIVATE_KEY" SecureString "$(cat "$TMP_DIR/private.pem")"
  put "$PREFIX/$ENV_NAME/JWT_PUBLIC_KEY" SecureString "$(cat "$TMP_DIR/public.pem")"
else
  echo "  keep $PREFIX/$ENV_NAME/JWT_PRIVATE_KEY (ROTATE_KEYS=true to replace)"
fi

if [ "$ROTATE_KEYS" = "true" ] || ! exists "$PREFIX/$ENV_NAME/TOKEN_ENC_KEY"; then
  put "$PREFIX/$ENV_NAME/TOKEN_ENC_KEY" SecureString "$(openssl rand -base64 32)"
else
  echo "  keep $PREFIX/$ENV_NAME/TOKEN_ENC_KEY"
fi

if [ "$ROTATE_KEYS" = "true" ] || ! exists "$PREFIX/$ENV_NAME/CODE_HMAC_KEY"; then
  put "$PREFIX/$ENV_NAME/CODE_HMAC_KEY" SecureString "$(openssl rand -base64 32)"
else
  echo "  keep $PREFIX/$ENV_NAME/CODE_HMAC_KEY"
fi

echo
echo "Done. Next: deploy the stack, then curl https://api-${ENV_NAME}.<domain>/health/ready"
