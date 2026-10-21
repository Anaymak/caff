#!/bin/zsh
# Publish the CAFF static export to the S3 + CloudFront stack in infra/caff-site.yaml.
# Usage: scripts/deploy-aws.sh <stack-name>   (stack must already exist in us-east-1)
# Needs NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local (public values).
set -euo pipefail
STACK="${1:?stack name}"; REGION=us-east-1; cd "$(dirname "$0")/.."
out() { aws cloudformation describe-stacks --region $REGION --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out BucketName); DIST=$(out DistributionId)
npm test && npm run lint && rm -rf out .next && npm run build
# Hashed assets: cache for a year. Everything else (HTML, RSC .txt, icons): revalidate.
aws s3 sync out/_next/static "s3://$BUCKET/_next/static" --delete --cache-control "public,max-age=31536000,immutable"
aws s3 sync out "s3://$BUCKET" --delete --exclude "_next/static/*" --cache-control "public,max-age=0,must-revalidate"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text
echo "Deployed to $(out SiteUrl)"
