# Bondfire API

This is a Node.js Express API for the Bondfire mobile app.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

## Endpoints

- `GET /` — Health check
- `GET /users` — List users (placeholder)
- `GET /artists` — List artists (placeholder)
- `POST /follow` — Follow artist (placeholder)
- `POST /unfollow` — Unfollow artist (placeholder)

## Next Steps
- Connect to a database
- Implement authentication
- Flesh out endpoint logic
- Integrate with the mobile app

## Run with Docker

`Dockerfile` builds a production image on `node:22-bookworm-slim`, installs only
production dependencies, and runs as the unprivileged `node` user.

```bash
docker build -t bondfire-api:local .
docker run --rm -p 3000:3000 --env-file .env bondfire-api:local
```

Migrations are not run on boot. Apply them once per deploy as a separate one-off:

```bash
docker run --rm --env-file .env bondfire-api:local npm run migrate
```

Notes:

- All configuration comes from environment variables (`MONGODB_URI`,
  `JWT_PRIVATE_KEY`, `TOKEN_ENC_KEY`, …). See `.env.example`; `.env` is ignored
  by `.dockerignore` and must not be baked into the image.
- `GET /health` is used as the container healthcheck. Point the load balancer or
  ECS health check at `GET /health/ready` so it also verifies MongoDB.
- Uploaded files are written to `public/uploads`, which is ephemeral inside a
  container. Mount a volume there or move uploads to S3/EFS before relying on
  them in production.

## Deployment (GitHub Actions + AWS OIDC)

We use GitHub Actions to assume an AWS IAM role via OIDC and perform CI/CD deploys.

- **IAM role ARN**: arn:aws:iam::9xxx:role/github-actions-xxx-xxx

Steps to enable deploys for the team:

1. Add organization or repository secrets in GitHub:
   - `AWS_ROLE_TO_ASSUME` — set to the role ARN above (storing as a secret is optional; ARN itself is not secret).
   - `AWS_REGION` — e.g. `us-east-1`.

   In the GitHub UI: Settings → Secrets and variables → Actions → New repository secret (or Organization secrets).

   Or using GitHub CLI (example for org secret):

   ```bash
   gh secret set AWS_ROLE_TO_ASSUME --org YOUR_ORG --body "arn:aws:iam::9xxx:role/github-actions-xxx-xxx"
   gh secret set AWS_REGION --org YOUR_ORG --body "us-east-1"
   ```

2. Add the repository **variables** (Settings → Secrets and variables → Actions → Variables) the workflow uses:

   | Variable | Required | Default | Purpose |
   | --- | --- | --- | --- |
   | `ECR_REPOSITORY` | no | `bondfire-api` | ECR repository name the image is pushed to. |
   | `ECS_CLUSTER` | yes | — | ECS cluster to deploy into. |
   | `ECS_SERVICE` | yes | — | ECS service **and** task definition family name (e.g. `bondfire-api`). |
   | `ECS_CONTAINER_NAME` | no | `api` | Container name inside the task definition that gets the new image. |

   ```bash
   gh variable set ECR_REPOSITORY --org YOUR_ORG --body "bondfire-api"
   gh variable set ECS_CLUSTER    --org YOUR_ORG --body "bondfire-prod"
   gh variable set ECS_SERVICE    --org YOUR_ORG --body "bondfire-api"
   ```

3. The IAM role needs `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, plus `ecs:DescribeTaskDefinition`, `ecs:RegisterTaskDefinition`, `ecs:UpdateService`, `ecs:DescribeServices` and `iam:PassRole` (for the task execution/task roles).

4. On every push to `main`, `dev`, `stage` or `feature/cicd_integration`, the workflow at `.github/workflows/deploy.yml` builds the `Dockerfile`, pushes `:<sha>` and `:latest` to ECR, re-registers the task definition with the new image and waits for the service to stabilise.

5. Configure the IAM role trust policy to allow this repository's GitHub OIDC tokens. The `sub` values must include every event and branch that can deploy:

```json
{
   "Version": "2012-10-17",
   "Statement": [
      {
         "Effect": "Allow",
         "Principal": {
            "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
            "StringEquals": {
               "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
            },
            "StringLike": {
               "token.actions.githubusercontent.com:sub": [
                  "repo:bndfdev/api:ref:refs/heads/main",
                  "repo:bndfdev/api:ref:refs/heads/dev",
                  "repo:bndfdev/api:ref:refs/heads/stage",
                  "repo:bndfdev/api:ref:refs/heads/feature/cicd_integration",
                  "repo:bndfdev/api:pull_request"
               ]
            }
         }
      }
   ]
}
```

Replace `<AWS_ACCOUNT_ID>` with the account containing the role. If the repository uses GitHub's immutable OIDC subject claims, update the `sub` values with the organization and repository numeric ID suffixes shown in the token claims.

6. Commands and steps to perform

Below are concrete commands to create the required GitHub secrets, trigger builds by merging a PR into `main`, `dev`, or `stage`, and manually trigger the workflow from the CLI.

- Create org-level secrets (masked ARN shown):

```bash
gh secret set AWS_ROLE_TO_ASSUME --org YOUR_ORG --body "arn:aws:iam::9xxx:role/github-actions-xxx-xxx"
gh secret set AWS_REGION --org YOUR_ORG --body "us-east-1"
```

- Create repo-level secrets (alternative):

```bash
gh secret set AWS_ROLE_TO_ASSUME --repo YOUR_ORG/YOUR_REPO --body "arn:aws:iam::9xxx:role/github-actions-xxx-xxx"
gh secret set AWS_REGION --repo YOUR_ORG/YOUR_REPO --body "us-east-1"
```

- Trigger build by merging a PR into `dev`, `stage`, or `main` (example using `dev`):

```bash
git checkout -b feature/test-deploy
git commit --allow-empty -m "test: trigger deploy"
git push origin feature/test-deploy
gh pr create --base dev --head feature/test-deploy --title "test: trigger deploy" --body "Trigger CI"
# After review, merge the PR (merge method as appropriate):
gh pr merge --auto --merge
```

- Manually trigger the workflow from CLI (workflow_dispatch) specifying branch input:

```bash
gh workflow run deploy.yml --ref main --field branch=dev
```

- Manually trigger from Actions UI:
   - Go to the repository Actions tab → select `CI/CD Deploy` → Run workflow → choose `branch` → Run workflow.

These commands are what the team needs to perform to set secrets and trigger builds; adjust `YOUR_ORG` and `YOUR_REPO` to your values and replace the masked ARN when creating the secret.

## Development

```bash
cp .env.example .env   # set MONGODB_URI (and CORS_ORIGINS if needed)
npm install
npm start              # http://localhost:3000, Swagger UI at /api-docs
npm test               # node:test + supertest, no database needed
```

The v1 contract lives in `docs/api/` (split source: `openapi.yaml`, `paths/`, `components/`;
bundled: `dist/openapi.yaml`). `/v1` requests are validated against the bundle at runtime and
CI lints the spec and checks that the bundle is current:
`npx redocly bundle docs/api/openapi.yaml --config docs/api/redocly.yaml -o docs/api/dist/openapi.yaml`.
