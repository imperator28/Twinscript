#!/usr/bin/env bash
set -euo pipefail

identity_name="Bilingual Meeting Captions Local Signing"
login_keychain="${HOME}/Library/Keychains/login.keychain-db"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Local macOS signing setup can only run on macOS." >&2
  exit 1
fi

if /usr/bin/security find-identity -v -p codesigning \
  | /usr/bin/grep -Fq "\"${identity_name}\""; then
  echo "Local signing identity is already ready: ${identity_name}"
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to create the local signing identity." >&2
  exit 1
fi

task_temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/bilingual-caption-signing.XXXXXX")"
cleanup() {
  find "${task_temp_dir}" -type f -delete 2>/dev/null || true
  rmdir "${task_temp_dir}" 2>/dev/null || true
}
trap cleanup EXIT

if /usr/bin/security find-certificate \
  -c "${identity_name}" \
  -p \
  > "${task_temp_dir}/identity-cert.pem" 2>/dev/null; then
  echo "The local identity is already imported and only needs trust approval."
  /usr/bin/security add-trusted-cert \
    -r trustRoot \
    -p codeSign \
    -k "${login_keychain}" \
    "${task_temp_dir}/identity-cert.pem"
  if /usr/bin/security find-identity -v -p codesigning \
    | /usr/bin/grep -Fq "\"${identity_name}\""; then
    echo "Local signing identity is ready: ${identity_name}"
    exit 0
  fi
  echo "The certificate is still not trusted for code signing." >&2
  exit 1
fi

p12_password="$(openssl rand -hex 24)"

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -sha256 \
  -days 3650 \
  -nodes \
  -subj "/CN=${identity_name}/O=Local Development" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  -keyout "${task_temp_dir}/identity-key.pem" \
  -out "${task_temp_dir}/identity-cert.pem"

openssl pkcs12 \
  -export \
  -legacy \
  -inkey "${task_temp_dir}/identity-key.pem" \
  -in "${task_temp_dir}/identity-cert.pem" \
  -out "${task_temp_dir}/identity.p12" \
  -passout "pass:${p12_password}"

echo "macOS may request approval once while the local identity is imported."
/usr/bin/security import "${task_temp_dir}/identity.p12" \
  -k "${login_keychain}" \
  -P "${p12_password}" \
  -T /usr/bin/codesign

/usr/bin/security add-trusted-cert \
  -r trustRoot \
  -p codeSign \
  -k "${login_keychain}" \
  "${task_temp_dir}/identity-cert.pem"

if ! /usr/bin/security find-identity -v -p codesigning \
  | /usr/bin/grep -Fq "\"${identity_name}\""; then
  echo "The certificate was imported but is not yet trusted for code signing." >&2
  echo "Open Keychain Access, find '${identity_name}', and set Code Signing to Always Trust." >&2
  exit 1
fi

echo "Local signing identity is ready: ${identity_name}"
echo "Future npm run package and npm run make builds will select it automatically."
