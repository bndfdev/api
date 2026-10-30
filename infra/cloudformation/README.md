# Deploying the Bondfire API to ECS (CloudFormation)

One stack per environment. This guide builds **dev** first; QA and prod are the
same steps with different values.

## What the stack creates

Per environment:

- VPC (`10.42.0.0/16` default) with two public subnets in different AZs and an internet gateway
- Application Load Balancer with HTTPS (ACM certificate you supply) and HTTP→HTTPS redirect
- ECS Fargate cluster `bondfire-<env>` and service `bondfire-api-<env>`
- Task definition family `bondfire-api-<env>`, container name `api`, port 3000
- Target tracking autoscaling on CPU, 1→3 tasks
- CloudWatch log group `/ecs/bondfire-api-<env>` (14 days)
- IAM execution role that can read the runtime secret from Secrets Manager and the SMTP config from SSM, plus an empty task role
- Route 53 A record `<hostname>` (default `<env>.<domain>`) when `HostedZoneId` is given

No NAT gateway: tasks run in public subnets with a public IP and are reachable
only through the ALB security group. That saves ~$32/month per environment; the
trade-off is that outbound traffic leaves from a shared AWS IP range, which
matters for MongoDB Atlas allowlisting (see Gotchas).

**Approximate cost, dev:** ALB ~$16/month, Fargate 0.25 vCPU / 0.5 GB ~$9/month
if left running 24/7, plus pennies for logs. Nightly shutdown removes the
Fargate cost outside working hours.

## Prerequisites

```bash
brew install awscli          # v2
aws configure                # or export AWS_PROFILE / SSO login
aws sts get-caller-identity  # must print an account
```

You need permission to create VPC/EC2, ELB, ECS, IAM roles, CloudWatch logs,
Route 53 records, SSM parameters and Secrets Manager secrets in the target
account. Pick the region first — everything (ECR, certificate, ALB, cluster,
secret) must be in the same one:

```bash
export AWS_REGION=ap-south-1          # Mumbai; us-east-1 also fine
export ENV=dev
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_URI="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/bondfire-api"
docker --version                      # Docker Desktop must be running
```

## Step 1 — ECR repository (once, shared by all environments)

```bash
aws ecr create-repository \
  --repository-name bondfire-api \
  --image-scanning-configuration scanOnPush=true \
  --region "$AWS_REGION"
```

If it already exists, skip. The image URI becomes
`<account>.dkr.ecr.<region>.amazonaws.com/bondfire-api:latest`.

## Step 2 — DNS: keep bondfire.ai where it is

`bondfire.ai` is authoritative on **GoDaddy** (`ns71/ns72.domaincontrol.com`)
and its mail runs on **Microsoft 365**. Do **not** move the nameservers to Route
53: you would have to recreate MX, SPF, DKIM and autodiscover records, or
silently lose email.

So there is no hosted zone and no delegation. You add exactly two CNAME records
in GoDaddy, both covered below:

| Type | Name | Value | Added in |
| --- | --- | --- | --- |
| CNAME | ACM validation name | ACM validation target | Step 3 |
| CNAME | `dev` | ALB DNS name (stack output) | Step 7 |

Deploy with `HostedZoneId=` (empty) so CloudFormation does not touch DNS.

If you already created a Route 53 zone for the wrong domain (`bondfire.com`),
delete it once it only contains the auto-created NS/SOA records:

```bash
aws route53 delete-hosted-zone --id Z09041113OCYWQ0AIDQAV
```

## Step 3 — ACM certificate (must be in the same region as the ALB)

```bash
export CERT_ARN=$(aws acm request-certificate \
  --domain-name "$ENV.bondfire.ai" \
  --validation-method DNS \
  --region "$AWS_REGION" \
  --query CertificateArn --output text)
echo "cert: $CERT_ARN"
```

Read the validation record:

```bash
read -r VAL_NAME VAL_TYPE VAL_VALUE <<< "$(aws acm describe-certificate \
  --certificate-arn "$CERT_ARN" --region "$AWS_REGION" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Type,Value]' \
  --output text)"

echo "Type:  $VAL_TYPE"
echo "Name:  ${VAL_NAME%.bondfire.ai.}"
echo "Value: $VAL_VALUE"
```

Add that in GoDaddy: **My Products → Domains → bondfire.ai → DNS → Add New
Record**, type `CNAME`, TTL `600`, Name as printed above (GoDaddy appends
`.bondfire.ai`, so do not paste the full name), Value as printed.

Wait until issued (usually 2–10 minutes once the record propagates):

```bash
before=""
until [ "$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$AWS_REGION" \
          --query 'Certificate.Status' --output text)" = "ISSUED" ]; do
  status=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$AWS_REGION" --query 'Certificate.Status' --output text)
  [ "$status" != "$before" ] && echo "status: $status" && before="$status"
  sleep 20
done
echo "certificate issued"
```

> Reusing one certificate: a wildcard `*.bondfire.ai` covers `dev`, `qa`
> and `api` in one region. Request it once (`--domain-name '*.bondfire.ai'`) and
> pass the same `CertificateArn` to every stack. The validation CNAME is also a
> single record in that case.

## Step 4 — Runtime secrets

Two stores, one rule: **no credential is ever a plain environment variable in
the template or the task definition.**

- **Secrets Manager** (`bondfire/<env>/runtime`, a single JSON secret):
  `MONGODB_URI`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `TOKEN_ENC_KEY`,
  `CODE_HMAC_KEY` and, when `SmtpAuth=true`, `SMTP_USER`/`SMTP_PASS`.
- **SSM Parameter Store** (`/<prefix>/<env>/...`): non-sensitive SMTP config —
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`.

ECS injects both at container start. `describe-task-definition` shows only
references (`<secret-arn>:KEY::`), never values.

### Create it

```bash
export MONGODB_URI='mongodb+srv://user:pass@cluster.mongodb.net/bondfire?retryWrites=true&w=majority'
export SMTP_HOST='email-smtp.ap-south-1.amazonaws.com'
export SMTP_FROM='Bondfire <no-reply@bondfire.ai>'
export SMTP_USER='...'
export SMTP_PASS='...'

infra/cloudformation/create-secrets.sh "$ENV"
```

The helper:

- generates an ES256 (P-256) JWT key pair and 32-byte base64
  `TOKEN_ENC_KEY`/`CODE_HMAC_KEY` on first run;
- merges new values into the existing secret JSON, so re-runs keep the keys
  (`ROTATE_KEYS=true` replaces them and logs every session out);
- writes the SMTP config to SSM and prints the secret ARN for `SecretArn`.

Prefer to do it by hand? Store the values as one JSON object:

```bash
aws secretsmanager create-secret --name "bondfire/$ENV/runtime" \
  --description "Bondfire $ENV runtime secrets" --region "$AWS_REGION" \
  --secret-string '{"MONGODB_URI":"mongodb+srv://...","JWT_PRIVATE_KEY":"-----BEGIN PRIVATE KEY-----\n...","JWT_PUBLIC_KEY":"-----BEGIN PUBLIC KEY-----\n...","TOKEN_ENC_KEY":"...","CODE_HMAC_KEY":"...","SMTP_USER":"...","SMTP_PASS":"..."}'
```

### Updating values

```bash
export MONGODB_URI='mongodb+srv://...'
export SMTP_PASS='...'
infra/cloudformation/create-secrets.sh "$ENV"   # reuses the existing keys

aws ecs update-service --cluster "bondfire-$ENV" --service "bondfire-api-$ENV" \
  --force-new-deployment --region "$AWS_REGION"
```

Tasks read the secret when they start, so running tasks keep the old values
until they are replaced.

### No code changes needed

`src/config.js` still reads `process.env.MONGODB_URI`, `process.env.SMTP_PASS`
and so on. ECS populates those from Secrets Manager at container start, so the
application is unchanged and nothing sensitive exists in CloudFormation, the
task definition or GitHub.

If you want the secret to never reach the process environment at all, the app
must fetch it itself: add `@aws-sdk/client-secrets-manager`, load and cache the
JSON before `src/config.js` validates the env, and grant
`secretsmanager:GetSecretValue` to the **task role** instead of the execution
role. That is a real code change plus a hard startup dependency on the Secrets
Manager API, and buys little over ECS injection.

### Notes

- `SmtpAuth=false` means the JSON has no `SMTP_USER`/`SMTP_PASS` keys and the
  task definition omits those entries — keep the stack parameter in sync.
- SMTP is mandatory in production: `src/config.js` defaults `EMAIL_PROVIDER` to
  `smtp` outside development and refuses to boot without `SMTP_HOST`/`SMTP_FROM`.
- The IAM policy is scoped to the exact secret ARN. If you delete and recreate
  the secret its ARN suffix changes, so update the `SecretArn` parameter too.

## Step 5 — Build and push the first image

The service needs an image to exist before it can start.

```bash
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker build --platform linux/amd64 -t "$ECR_URI:latest" .
docker push "$ECR_URI:latest"
```

## Step 6 — Deploy the stack

```bash
aws cloudformation deploy \
  --stack-name "bondfire-api-$ENV" \
  --template-file infra/cloudformation/bondfire-api.yaml \
  --capabilities CAPABILITY_IAM \
  --region "$AWS_REGION" \
  --parameter-overrides \
    Environment="$ENV" \
    Hostname="$ENV.bondfire.ai" \
    HostedZoneId= \
    CertificateArn="$CERT_ARN" \
    ImageUri="$ECR_URI:latest" \
    SecretArn="$SECRET_ARN" \
    VpcCidr=10.42.0.0/16
```

`SECRET_ARN` is printed by `create-secrets.sh` (Step 4) and is required.

Takes about 3 minutes. Then read the outputs:

```bash
aws cloudformation describe-stacks --stack-name "bondfire-api-$ENV" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
```

## Step 7 — Point dev at the ALB, then verify

The stack's `LoadBalancerDns` output is the hostname to target:

```bash
LB_DNS=$(aws cloudformation describe-stacks --stack-name "bondfire-api-$ENV" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='LoadBalancerDns'].OutputValue" --output text)
echo "$LB_DNS"
```

In GoDaddy: **My Products → Domains → bondfire.ai → DNS → Add New Record**,
type `CNAME`, Name `dev`, Value `$LB_DNS`, TTL `600`. There is no existing
`dev` record (it currently returns NXDOMAIN), so nothing is overwritten.

Then:

```bash
dig +short dev.bondfire.ai
curl -s https://dev.bondfire.ai/health
curl -s https://dev.bondfire.ai/health/ready

aws logs tail "/ecs/bondfire-api-$ENV" --follow --region "$AWS_REGION"
```

Expected: `/health` returns `{"status":"ok",...}` and `/health/ready` returns
`{"status":"ready","checks":{"database":"ok"}}`. If tasks are stuck, the two
usual causes are a missing secret/parameter (`ResourceInitializationError`) and
Atlas rejecting the task's IP (readiness stays 503). Check the stopped-task
reason:

```bash
aws ecs list-tasks --cluster "bondfire-$ENV" --desired-status STOPPED --region "$AWS_REGION"
```

## Step 8 — Wire the GitHub Actions deploy

The stack's outputs feed the workflow's repository variables:

```bash
gh variable set ECS_CLUSTER --repo bndfdev/api --body "bondfire-$ENV"
gh variable set ECS_SERVICE --repo bndfdev/api --body "bondfire-api-$ENV"
gh variable set ECR_REPOSITORY --repo bndfdev/api --body "bondfire-api"
gh variable list --repo bndfdev/api
```

`ECS_CLUSTER` is the cluster **name** (`bondfire-dev`), not the ARN.
`ECS_SERVICE` doubles as the task definition family, which the template names
`bondfire-api-dev`, so both values are consistent.

The OIDC role the workflow assumes needs this inline policy (fill in the
account, region and the two role ARNs from the stack outputs):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "arn:aws:ecr:ap-south-1:<ACCOUNT_ID>:repository/bondfire-api"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeTaskDefinition",
        "ecs:RegisterTaskDefinition",
        "ecs:UpdateService",
        "ecs:DescribeServices"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "<ExecutionRoleArn output>",
        "<TaskRoleArn output>"
      ],
      "Condition": {
        "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" }
      }
    }
  ]
}
```

The trust policy still has to accept the token's `sub` — that is the error you
were debugging earlier. Once it matches, a push to `feature/cicd_integration`
builds, pushes `:<sha>` + `:latest`, registers a new task definition revision
and rolls the service.

## Step 9 — Nightly scale-to-zero (optional, saves the Fargate cost)

Fargate cannot serve requests at zero tasks, and there is no request-driven
wake-up like Lambda. Nightly shutdown works because nobody is calling the API
overnight; the first request after 08:00 IST may take ~30–60 s while a task
starts and the ALB health check goes green.

```bash
# 01:30 IST (20:00 UTC) on weekdays: 0 tasks
aws application-autoscaling put-scheduled-action \
  --service-namespace ecs \
  --scheduled-action-name "bondfire-$ENV-nightly-down" \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id "service/bondfire-$ENV/bondfire-api-$ENV" \
  --schedule "cron(0 20 ? * MON-FRI *)" \
  --scalable-target-action MinCapacity=0,MaxCapacity=0 \
  --region "$AWS_REGION"

# 08:00 IST (02:30 UTC) on weekdays: back to 1-3 tasks
aws application-autoscaling put-scheduled-action \
  --service-namespace ecs \
  --scheduled-action-name "bondfire-$ENV-morning-up" \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id "service/bondfire-$ENV/bondfire-api-$ENV" \
  --schedule "cron(30 2 ? * MON-FRI *)" \
  --scalable-target-action MinCapacity=1,MaxCapacity=3 \
  --region "$AWS_REGION"
```

Turn it off with `aws application-autoscaling delete-scheduled-action --scheduled-action-name bondfire-dev-nightly-down ...`
(then the same for `-morning-up`). Scheduled actions live outside the stack, so
deleting the stack does not remove them.

## Step 10 — Add QA (and prod later)

Same steps, different values:

| | dev | qa | prod |
| --- | --- | --- | --- |
| `ENV` | `dev` | `qa` | `prod` |
| stack name | `bondfire-api-dev` | `bondfire-api-qa` | `bondfire-api-prod` |
| hostname | `dev.bondfire.ai` | `qa.bondfire.ai` | `api.bondfire.ai` |
| `VpcCidr` | `10.42.0.0/16` | `10.43.0.0/16` | `10.44.0.0/16` |
| SSM prefix | `/bondfire/dev/*` | `/bondfire/qa/*` | `/bondfire/prod/*` |
| secret | `bondfire/dev/runtime` | `bondfire/qa/runtime` | `bondfire/prod/runtime` |

Use separate secrets per environment (never share `TOKEN_ENC_KEY` or the
MongoDB database between dev and prod). Each stack creates its own VPC and ALB,
so the three environments are fully isolated and cost ~$25/month each.

Prod is the one exception to the `<env>.<domain>` default: the apex
`bondfire.ai` serves the marketing site, so pass `Hostname=api.bondfire.ai`
instead of `Hostname=prod.bondfire.ai`.

Right now all branches share one set of repository variables, so only one
environment can receive CI deploys. To route `main`→prod, `stage`→qa,
`dev`/feature→dev, define **GitHub Environments** (Settings → Environments)
with per-environment `ECS_CLUSTER`/`ECS_SERVICE` variables and add
`environment: <name>` to the deploy job. Say the word and I'll restructure the
workflow for that.

## Teardown

CloudFormation deletes the VPC, ALB, cluster, service, roles and log group. It
does **not** delete resources created outside the stack:

```bash
aws cloudformation delete-stack --stack-name "bondfire-api-$ENV" --region "$AWS_REGION"
aws ecr delete-repository --repository-name bondfire-api --force --region "$AWS_REGION"   # deletes all images
aws acm delete-certificate --certificate-arn "$CERT_ARN" --region "$AWS_REGION"
aws secretsmanager delete-secret --secret-id "bondfire/$ENV/runtime" \
  --force-delete-without-recovery --region "$AWS_REGION"
# SSM parameters (only if you are sure):
aws ssm get-parameters-by-path --path "/bondfire/$ENV" --recursive --region "$AWS_REGION" \
  --query 'Parameters[].Name' --output text | tr '\t' '\n' \
  | xargs -n1 -I{} aws ssm delete-parameter --name {} --region "$AWS_REGION"
```

## Gotchas

1. **Never move `bondfire.ai`'s nameservers for this.** DNS is on GoDaddy and
   mail on Microsoft 365. Switching the zone to Route 53 means recreating MX,
   SPF, DKIM and autodiscover records; getting one wrong silently drops email.
   Two CNAMEs in GoDaddy are enough, which is why the stack is deployed with
   `HostedZoneId=` empty.
2. **GoDaddy CNAME Name field is a prefix.** For a validation record named
   `_abc123.dev.bondfire.ai`, enter `_abc123.dev`; GoDaddy appends the
   domain. Pasted in full, it becomes
   `_abc123.dev.bondfire.ai.bondfire.ai` and validation never completes.
3. **CloudFormation vs CI task definitions.** The stack creates the first task
   definition; CI then registers new revisions. A later `cloudformation deploy`
   re-registers from the template's `ImageUri`. Keep that value at
   `...:latest` (which CI also pushes) so a stack update never pins old code.
4. **MongoDB Atlas allowlist.** Tasks use public IPs that change on every
   deployment. For dev/QA, allow `0.0.0.0/0` (or the region's AWS ranges); for
   prod, add a NAT gateway with an Elastic IP and allowlist that single IP.
5. **SMTP is not optional in production.** See Step 4.
6. **Certificate region.** ACM certificates are regional and only usable by an
   ALB in the same region. A `us-east-1` certificate cannot front an
   `ap-south-1` ALB.
7. **One ALB per environment is the main fixed cost.** If dev/QA hosting cost
   matters more than isolation, they can share an ALB with host-based listener
   rules; that is a different template.
8. **Health check path** is `/health/ready` (checks MongoDB). `/health` is the
   container-level liveness check only.
