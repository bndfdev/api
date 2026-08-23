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

2. The repository includes a sample workflow at `.github/workflows/deploy.yml` that assumes the role and runs deploy steps. Customize the deploy commands to match your pipeline (build, ECR push, S3 sync, CloudFormation/Terraform, etc.).

3. Configure the IAM role trust policy to allow this repository's GitHub OIDC tokens. The `sub` values must include every event and branch that can deploy:

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

4. Commands and steps to perform

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
