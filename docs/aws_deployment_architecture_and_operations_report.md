# AWS Deployment Report — Bazhanka

## 1. Executive Summary & Deployment Endpoints

The **Bazhanka** web application is deployed to **Amazon Web Services (AWS)** in the `us-east-1` (N. Virginia) region using a fully serverless, Infrastructure-as-Code (IaC) architecture defined via **AWS CloudFormation** and orchestrated through a single-command **`Makefile`** contract.

* **Production Application URL (CloudFront):** `https://d1je5vufmmk66c.cloudfront.net`
* **Health Check Endpoint:** `https://d1je5vufmmk66c.cloudfront.net/healthz`
* **Direct Backend Origin (AWS Lambda Function URL):** `https://plurra7os4vxikamdjiyieuj2e0gblhy.lambda-url.us-east-1.on.aws`
* **AWS Region:** `us-east-1`
* **AWS Account ID:** `283609055480`

---

## 2. System Architecture

Rather than provisioning long-running virtual machines or managed container orchestrators with idle hourly costs, the deployment uses a unified **CloudFront Reverse-Proxy + Serverless Compute** pattern:

```text
                       ┌───────────────────────────────────────────┐
                       │          Amazon CloudFront (HTTPS)        │
                       │    https://d1je5vufmmk66c.cloudfront.net  │
                       └─────────────────────┬─────────────────────┘
                                             │
                 ┌───────────────────────────┴───────────────────────────┐
                 │ Default (/*)                                          │ /api/* & /healthz
                 ▼                                                       ▼
┌─────────────────────────────────┐                     ┌─────────────────────────────────┐
│        Amazon S3 Bucket         │                     │    AWS Lambda (Container)       │
│  bazhanka-frontend-283609055480 │                     │       bazhanka-backend          │
│   (Private, OAC-authenticated)  │                     │  Node.js 22 + Express 5 + LWA   │
└─────────────────────────────────┘                     └────────────────┬────────────────┘
                                                                         │ VPC Private Subnets
                                                                         ▼ (TCP 5432 / SSL)
                                                        ┌─────────────────────────────────┐
                                                        │   Amazon Aurora Serverless v2   │
                                                        │     PostgreSQL (bazhanka-db)    │
                                                        │  Auto-scales 0.0 – 1.0 ACU      │
                                                        └─────────────────────────────────┘
```

### Key Architectural Decisions

1. **Single-Origin Reverse Proxy via CloudFront:**
   * The React (Vite) frontend communicates with the API using relative paths (`/api/...`) and `credentials: 'same-origin'`.
   * CloudFront routes static asset requests (`/*`) to a private S3 bucket and proxies API requests (`/api/*` and `/healthz`) directly to the backend Lambda Function URL using AWS managed policies (`CachingDisabled` and `AllViewerExceptHostHeader`).
   * **Benefit:** Eliminates Cross-Origin Resource Sharing (CORS) complexity, avoids hardcoding backend URLs into the frontend bundle at build time, and preserves `HttpOnly` / `Secure` session cookies (`bz_session`) under a single HTTPS domain.
2. **SPA Client-Side Routing Support:**
   * A lightweight **CloudFront Function** (`bazhanka-spa-rewrite`) intercepts viewer requests for extensionless routes (e.g., `/wishlists/...`) and rewrites them to `/index.html`, ensuring React Router handles deep links without `403/404` S3 errors.
3. **Zero-Code-Change Containerized Lambda (`AWS Lambda Web Adapter`):**
   * The Express 5 server (`backend/src/index.js`) is packaged in `backend/Dockerfile.lambda` alongside the **AWS Lambda Web Adapter (`v0.9.1`)**.
   * The adapter translates Lambda invocation events into standard HTTP requests on port `3000` and verifies readiness via `/healthz`, allowing the exact same Express application to run identically in local Docker Compose and AWS Lambda.
4. **Scale-to-Zero Relational Database (`Aurora Serverless v2`):**
   * PostgreSQL runs inside a private VPC subnet group with `MinCapacity: 0` ACU and `SecondsUntilAutoPause: 300`.
   * When idle for 5 minutes, compute pauses automatically (incurring zero compute charges) and resumes automatically (~10–15 seconds cold start) upon the next incoming database connection.
   * Database schema migrations (`migrate()` in `backend/src/db.js`) are idempotent and execute automatically on container startup.

---

## 3. Provisioned AWS Resources (CloudFormation Stacks)

All infrastructure is partitioned into three modular CloudFormation stacks tagged with `PROJECT_NAME=bazhanka`:

| Stack Name | Template File | AWS Resources Provisioned | Purpose |
| :--- | :--- | :--- | :--- |
| **`bazhanka-ecr`** | `infra/ecr.yml` | `AWS::ECR::Repository` (`bazhanka-backend`) | Private Docker registry with vulnerability scanning on push and a lifecycle policy retaining the 5 most recent images. |
| **`bazhanka-backend`** | `infra/backend.yml` | `AWS::Lambda::Function` (`bazhanka-backend`)<br>`AWS::Lambda::Url`<br>`AWS::RDS::DBCluster` & `DBInstance` (`bazhanka-db`)<br>`AWS::EC2::SecurityGroup` (Function & DB)<br>`AWS::Logs::LogGroup` (7-day retention) | Runs the containerized Node.js API inside the default VPC, isolates PostgreSQL ingress strictly to the Lambda Security Group, and exposes a public HTTPS Function URL. |
| **`bazhanka-frontend`** | `infra/frontend.yml` | `AWS::S3::Bucket` (`bazhanka-frontend-283609055480`)<br>`AWS::CloudFront::Distribution`<br>`AWS::CloudFront::OriginAccessControl`<br>`AWS::CloudFront::Function` (`bazhanka-spa-rewrite`) | Hosts the compiled Vite static bundle in a locked-down S3 bucket (accessible only via CloudFront SigV4 OAC) and serves the unified application globally over HTTPS. |

---

## 4. Security & Configuration Management

* **Network Isolation:** The Aurora PostgreSQL cluster (`publiclyAccessible: false`) accepts TCP traffic on port `5432` **only** from `FunctionSecurityGroup` attached to the Lambda function. All database connections enforce SSL (`DATABASE_SSL=true`).
* **Private Storage:** Public access to `bazhanka-frontend-283609055480` is completely blocked (`BlockPublicAcls`, `BlockPublicPolicy`, `RestrictPublicBuckets`). S3 bucket policy permits `s3:GetObject` exclusively to the CloudFront distribution ARN.
* **Secret Handling:** Sensitive credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DB_PASSWORD`, `AWS_JWT_SECRET`) are stored locally in a gitignored `.env` file and injected into CloudFormation parameters (`NoEcho: true`) at deployment time—never committed to version control.
* **Immutable Image Pinning:** `make aws-deploy-backend` resolves the exact SHA-256 image digest (`repo@sha256:...`) after pushing to ECR, guaranteeing deterministic deployments.

---

## 5. Deployment Automation (`Makefile` Contract)

The root `Makefile` serves as the single operational interface for building, deploying, inspecting, and tearing down the environment:

| Command | Description |
| :--- | :--- |
| `make aws-whoami` | Verifies active AWS IAM credentials (`sts get-caller-identity`). |
| `make aws-ecr` | Provisions or updates the `bazhanka-ecr` stack. |
| `make aws-push` | Builds `backend/Dockerfile.lambda` (`linux/amd64`), authenticates with ECR, and pushes the image. |
| `make aws-deploy-backend` | Pushes the backend image, deploys `bazhanka-backend` (Lambda + Aurora PostgreSQL) pinned by image digest, and prints the Function URL. |
| `make aws-deploy-frontend` | Deploys `bazhanka-frontend` (S3 + CloudFront), builds the Vite bundle (`npm run build`), syncs assets with cache-control headers (`immutable` for hashed assets, `no-cache` for `index.html`), and creates a CloudFront invalidation (`/*`). |
| `make aws-deploy` | Runs the complete end-to-end deployment pipeline (`aws-deploy-backend` followed by `aws-deploy-frontend`). |
| `make aws-url` | Outputs the live CloudFront and Lambda Function URLs. |
| `make aws-logs` | Streams real-time CloudWatch logs from `/aws/lambda/bazhanka-backend`. |
| `make aws-destroy` | Empties the S3 bucket and deletes all three CloudFormation stacks (`frontend` → `backend` → `ecr`) to prevent ongoing storage charges. |

---

## 6. Verification Checklist

1. **API & Database Health:** Accessing `https://d1je5vufmmk66c.cloudfront.net/healthz` routes through CloudFront to Lambda, executes `SELECT 1` against Aurora PostgreSQL, and returns `{"ok":true}`.
2. **Frontend Delivery & SPA Routing:** Opening `https://d1je5vufmmk66c.cloudfront.net` serves `index.html` over TLS 1.2+, and reloading nested client routes resolves cleanly without 404 errors.
3. **End-to-End Persistence:** User authentication (`POST /api/auth/login` setting the `bz_session` cookie) and wishlist operations persist across page reloads in Aurora PostgreSQL.