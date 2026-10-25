#!/bin/zsh
# Deploy the CAFF payments Lambda (infra/caff-payments.yaml + payments/handler.mjs). Run only with approval.
# Prerequisite: SecureString parameters STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and SUPABASE_SERVICE_ROLE_KEY
# under /caff/payments/ in SSM Parameter Store (us-east-1). No secret is passed on the command line.
# Usage: scripts/deploy-payments.sh
set -euo pipefail
REGION=us-east-1; STACK=caff-payments; cd "$(dirname "$0")/.."
SUPABASE_URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)
SUPABASE_ANON_KEY=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
node --test tests/payments-handler.test.mjs
aws cloudformation deploy --region $REGION --stack-name $STACK --template-file infra/caff-payments.yaml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "SupabaseUrl=$SUPABASE_URL" "SupabaseAnonKey=$SUPABASE_ANON_KEY"
BUILD=$(mktemp -d); trap 'rm -rf "$BUILD"' EXIT
cp payments/handler.mjs "$BUILD/index.mjs"; (cd "$BUILD" && zip -q function.zip index.mjs)
aws lambda update-function-code --region $REGION --function-name caff-payments --zip-file "fileb://$BUILD/function.zip" --query LastModified --output text
aws lambda wait function-updated --region $REGION --function-name caff-payments
echo "PaymentsApiDomain for the caff-site stack: $(aws cloudformation describe-stacks --region $REGION --stack-name $STACK --query "Stacks[0].Outputs[?OutputKey=='FunctionUrlDomain'].OutputValue" --output text)"
