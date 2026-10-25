#!/bin/zsh
# Switch the CAFF payments service between Stripe test and live credentials. Run only with the owner's explicit approval.
#   scripts/go-live.sh live   -> StripeMode=live, SecretsPath=/caff/payments-live/  (requires the three live SecureStrings)
#   scripts/go-live.sh test   -> StripeMode=test, SecretsPath=/caff/payments/       (rollback)
# The CAFF database switch (Admin -> Payment settings -> Stripe mode) is separate and Owner-only; both must match.
# Never prints secret values: only parameter names are listed.
set -euo pipefail
MODE="${1:?usage: go-live.sh live|test}"; REGION=us-east-1; STACK=caff-payments
case "$MODE" in live) SECRETS=/caff/payments-live/ ;; test) SECRETS=/caff/payments/ ;; *) echo "live or test"; exit 1 ;; esac
for name in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET SUPABASE_SERVICE_ROLE_KEY; do
  aws ssm describe-parameters --region $REGION --parameter-filters "Key=Name,Values=${SECRETS}${name}" --query "Parameters[0].Type" --output text | grep -q SecureString \
    || { echo "Missing SecureString ${SECRETS}${name}"; exit 1; }
done
echo "All three ${SECRETS}* SecureStrings exist."
aws cloudformation create-change-set --region $REGION --stack-name $STACK --change-set-name "mode-$MODE-$(date +%s)" --use-previous-template \
  --capabilities CAPABILITY_IAM --parameters ParameterKey=StripeMode,ParameterValue=$MODE ParameterKey=SecretsPath,ParameterValue=$SECRETS \
  ParameterKey=SiteUrl,UsePreviousValue=true ParameterKey=SupabaseUrl,UsePreviousValue=true ParameterKey=SupabaseAnonKey,UsePreviousValue=true \
  --query Id --output text > /tmp/caff-mode-changeset
CS=$(cat /tmp/caff-mode-changeset); aws cloudformation wait change-set-create-complete --region $REGION --change-set-name "$CS"
aws cloudformation describe-change-set --region $REGION --change-set-name "$CS" --query "Changes[].ResourceChange.[Action,LogicalResourceId,Replacement]" --output text
read "?Apply this change set (switch payments service to $MODE)? [yes/N] " answer
[[ "$answer" == yes ]] || { aws cloudformation delete-change-set --region $REGION --change-set-name "$CS"; echo "Cancelled."; exit 1; }
aws cloudformation execute-change-set --region $REGION --change-set-name "$CS"
aws cloudformation wait stack-update-complete --region $REGION --stack-name $STACK
aws lambda get-function-configuration --region $REGION --function-name caff-payments --query "Environment.Variables.[STRIPE_MODE,SECRETS_PATH]" --output text
echo "Payments service now $MODE. Next: Owner sets Payment settings -> Stripe mode to match, then run the Owner health check."
