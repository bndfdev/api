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
- IAM execution role that can read `/<prefix>/<env>/*` from SSM, and an empty task role
- Route 53 A record `api-<env>.<domain>` (or `api.<domain>` for prod) when `HostedZoneId` is given

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
Route 53 records and SSM parameters in the target account. Pick the region
first — everything (ECR, certificate, ALB, cluster) must be in the same one:

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

## Step 2 — Route 53 hosted zone

```bash
export ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name bondfire.com \
  --query 'HostedZones[0].Id' --output text | sed 's|/hostedzone/||')
echo "zone: $ZONE_ID"
```

- If that prints an ID, you're set.
- If it prints `None`, create the zone with `aws route53 create-hosted-zone --name bondfire.com --caller-reference "$(date +%s)"`
  and copy the four `NS` records it returns into your registrar's DNS settings
  for `bondfire.com`. Wait for propagation (`dig NS bondfire.com +short`).

If your DNS is hosted elsewhere and you'd rather not move it, you can skip DNS
entirely: deploy with `HostedZoneId=` (empty) and create a CNAME from
`api-dev.bondfire.com` to the stack's `LoadBalancerDns` output yourself. The
certificate still needs DNS validation through whoever hosts the zone.

## Step 3 — ACM certificate (must be in the same region as the ALB)

```bash
export CERT_ARN=$(aws acm request-certificate \
  --domain-name "api-$ENV.bondfire.com" \
  --validation-method DNS \
  --region "$AWS_REGION" \
  --query CertificateArn --output text)
echo "cert: $CERT_ARN"
```

Create the DNS validation record automatically:

```bash
read -r VAL_NAME VAL_TYPE VAL_VALUE <<< "$(aws acm describe-certificate \
  --certificate-arn "$CERT_ARN" --region "$AWS_REGION" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Type,Value]' \
  --output text)"

aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$VAL_NAME\",\"Type\":\"$VAL_TYPE\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$VAL_VALUE\"}]}}]}"
```

Wait until issued (usually 2–10 minutes, occasionally longer):

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

> Reusing one certificate: a wildcard `*.bondfire.com` covers `api-dev`, `api-qa`
> and `api` in a single region. Request it once (`--domain-name '*.bondfire.com'`)
> and pass the same `CertificateArn` to every stack.

## Step 4 — Runtime secrets in SSM

The task definition reads these from `/<prefix>/<env>/<NAME>`:

| Parameter | Type | Notes |
| --- | --- | --- |
| `MONGODB_URI` | SecureString | required |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | SecureString | generated for you (ES256/P-256) |
| `TOKEN_ENC_KEY`, `CODE_HMAC_KEY` | SecureString | generated for you (32 random bytes, base64) |
| `SMTP_HOST`, `SMTP_FROM`, `SMTP_PORT` | String | **required** — production refuses to start without them |
| `SMTP_USER`, `SMTP_PASS` | SecureString | required unless `SmtpAuth=false` |

Run the helper, which generates the keys and refuses to overwrite them unless
you ask:

```bash
export MONGODB_URI='mongodb+srv://user:pass@cluster.mongodb.net/bondfire?retryWrites=true'
export SMTP_HOST='email-smtp.ap-south-1.amazonaws.com'
export SMTP_FROM='Bondfire <no-reply@bondfire.com>'
export SMTP_USER='...'
export SMTP_PASS='...'

infra/cloudformation/create-parameters.sh "$ENV"
```

Why SMTP is mandatory: `src/config.js` defaults `EMAIL_PROVIDER` to `smtp`
outside development and validates `SMTP_HOST`/`SMTP_FROM` at boot. If they are
missing the container exits with `Missing required environment variables` and
ECS restarts it until the deployment circuit breaker rolls back.

`SMTP_AUTH=false` + the stack parameter `SmtpAuth=false` is the only case where
the username/password parameters are not needed. `ROTATE_KEYS=true` regenerates
the key pair, which logs out every session.

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
    BaseDomain=bondfire.com \
    HostedZoneId="$ZONE_ID" \
    CertificateArn="$CERT_ARN" \
    ImageUri="$ECR_URI:latest" \
    VpcCidr=10.42.0.0/16
```

Takes about 3 minutes. Then read the outputs:

```bash
aws cloudformation describe-stacks --stack-name "bondfire-api-$ENV" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
```

## Step 7 — Verify

```bash
dig +short api-dev.bondfire.com
curl -s https://api-dev.bondfire.com/health
curl -s https://api-dev.bondfire.com/health/ready

aws logs tail "/ecs/bondfire-api-$ENV" --follow --region "$AWS_REGION"
```

Expected: `/health` returns `{"status":"ok",...}` and `/health/ready` returns
`{"status":"ready","checks":{"database":"ok"}}`. If tasks are stuck, the two
usual causes are a missing SSM parameter (`ResourceInitializationError`) and
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
| hostname | `api-dev.bondfire.com` | `api-qa.bondfire.com` | `api.bondfire.com` |
| `VpcCidr` | `10.42.0.0/16` | `10.43.0.0/16` | `10.44.0.0/16` |
| SSM prefix | `/bondfire/dev/*` | `/bondfire/qa/*` | `/bondfire/prod/*` |

Use separate SSM values per environment (never share `TOKEN_ENC_KEY` or the
MongoDB database between dev and prod). Each stack creates its own VPC and ALB,
so the three environments are fully isolated and cost ~$25/month each.

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
# SSM parameters (only if you are sure):
aws ssm get-parameters-by-path --path "/bondfire/$ENV" --recursive --region "$AWS_REGION" \
  --query 'Parameters[].Name' --output text | tr '\t' '\n' \
  | xargs -n1 -I{} aws ssm delete-parameter --name {} --region "$AWS_REGION"
```

## Gotchas

1. **CloudFormation vs CI task definitions.** The stack creates the first task
   definition; CI then registers new revisions. A later `cloudformation deploy`
   re-registers from the template's `ImageUri`. Keep that value at
   `...:latest` (which CI also pushes) so a stack update never pins old code.
2. **MongoDB Atlas allowlist.** Tasks use public IPs that change on every
   deployment. For dev/QA, allow `0.0.0.0/0` (or the region's AWS ranges); for
   prod, add a NAT gateway with an Elastic IP and allowlist that single IP.
3. **SMTP is not optional in production.** See Step 4.
4. **Certificate region.** ACM certificates are regional and only usable by an
   ALB in the same region. A `us-east-1` certificate cannot front an
   `ap-south-1` ALB.
5. **One ALB per environment is the main fixed cost.** If dev/QA hosting cost
   matters more than isolation, they can share an ALB with host-based listener
   rules; that is a different template.
6. **Health check path** is `/health/ready` (checks MongoDB). `/health` is the
   container-level liveness check only.
