#!/usr/bin/env bash
# Stores the AbuseIPDB API key in SSM Parameter Store as a SecureString.
# The key is read without echo and passed to AWS via a private temp file, so it never
# appears in shell history, process arguments, or this repository.
set -euo pipefail

REGION="${AWS_REGION:-eu-west-1}"
NAME="${PARAMETER_PREFIX:-/traffic-monitor}/abuseipdb-api-key"

read -r -s -p "AbuseIPDB API key (hidden): " KEY; echo
[[ -n "$KEY" ]] || { echo "No key entered." >&2; exit 1; }

input="$(umask 077; mktemp)"
trap 'rm -f "$input"' EXIT
NAME="$NAME" VALUE="$KEY" node -e '
  process.stdout.write(JSON.stringify({ Name: process.env.NAME, Type: "SecureString", Value: process.env.VALUE, Overwrite: true }));
' > "$input"
aws ssm put-parameter --region "$REGION" --cli-input-json "file://$input" >/dev/null
echo "Saved $NAME (SecureString)."
