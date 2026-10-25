# Deployment and infrastructure

All AWS resources are in account 971422695222, region us-east-1. The AWS CLI is at `~/.local/bin/aws` (not on the terminal PATH); when the session expires, run `~/.local/bin/aws login`.

## Stacks
| Stack | Template | Key parameters (2026-10-25) |
|---|---|---|
| `caff-site` | `infra/caff-site.yaml` | SiteBucketName=caff-site-971422695222, DomainName=caff.anaysprojects.com, HostedZoneId=Z05659181IL7TCAD61DJ5, PrimaryDomainName=caffleague.com, PrimaryHostedZoneId=Z0113817247OYN829KD1P, PaymentsApiDomain=5gzhai5cg65l6gqqhd6gff7cfi0emrqi.lambda-url.us-east-1.on.aws |
| `caff-payments` | `infra/caff-payments.yaml` | StripeMode=test, SecretsPath=/caff/payments/, SiteUrl=https://caffleague.com, SupabaseUrl, SupabaseAnonKey (publishable) |

Change stacks with a change set (`create-change-set` → review → `execute-change-set`), passing `UsePreviousValue=true` for unchanged parameters. Check for drift first if in doubt.

## Site deploy
`scripts/deploy-aws.sh caff-site` runs tests and lint, cleans and builds (reads `.env.local`, which must contain `NEXT_PUBLIC_PITCH_SESSIONS=on`), then syncs `out/` to S3 (hashed assets immutable, HTML revalidate) and invalidates `/*`. Rollback: redeploy a previous commit with the same script (S3 versioning keeps old objects for 14 days).

## Payments deploy
`scripts/deploy-payments.sh` runs the Lambda tests, deploys `caff-payments` (non-secret parameters only), zips `payments/handler.mjs` as `index.mjs` and calls `update-function-code`. Secrets are SSM SecureStrings under `SecretsPath`; they are cached in the function for 5 minutes.

## DNS and TLS
- `caffleague.com` zone: apex and www A/AAAA alias records → the distribution, plus ACM validation CNAMEs (managed by the stack).
- `anaysprojects.com` zone: `caff.anaysprojects.com` alias (kept; it redirects).
- A single ACM certificate covers all three names. The old single-name certificate still exists, unused.
- Vercel project `caff` (team anaymaks-projects): redirect-only. Deploy with `npx vercel@latest deploy --prod` in `vercel-redirect/`, then `vercel alias set <deployment> caffleague.vercel.app`.

## Monitoring
- No alerting is configured. Lambda logs are in `/aws/lambda/caff-payments`, kept 30 days.
- A daily GitHub Actions health check (`.github/workflows/supabase-health.yml`) keeps Supabase Free awake. [U: whether it runs on GitHub]
