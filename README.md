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

3. Best practices:
   - Restrict the role trust policy to your organization or specific repos/branches.
   - Use branch protections and required reviews on `main` to control who can trigger deploys.
   - Prefer OIDC over storing long-lived AWS credentials in GitHub.

If you want, I can add a Terraform snippet to create the role and policy, or further customize the workflow to push Docker images to ECR or run `terraform apply`.
