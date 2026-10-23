# GCP deployment

This fork starts from Fruggr v3.5.0. The GCP profile runs stateless HTTP instances
on Cloud Run, stores encrypted authorization state in Firestore, and terminates
HTTPS at Google's external Application Load Balancer with Certificate Manager.
Caddy is unnecessary in this profile. It keeps the upstream tool surface and
per-user Zendesk OAuth; it does not copy tickets into Firestore.

## Prerequisites

Use an existing billing-enabled project, an existing access-restricted GCS state
bucket (enable versioning), Terraform >=1.11, and Google Application Default
Credentials with permission to create the resources in `infra/gcp`. Set the
quota project for those credentials. Organization policies must permit the
public Cloud Run invoker binding; the service restricts ingress to the load
balancer and internal Google traffic, and application OAuth protects MCP.

Register a **public** Zendesk OAuth client with callback
`https://YOUR_HOSTNAME/oauth/callback`. Each colleague authenticates individually;
Zendesk applies their existing permissions. No tenant-wide API token is used.

Publish a reviewed release image to a registry Cloud Run can pull from.
The release workflow publishes GHCR images; mirror the selected digest into
your project's Artifact Registry if Cloud Run cannot fetch that registry.
Use an immutable digest in Terraform. No image or release has been published
merely by cloning this repository.

## Administrator workflow

1. Clone `https://github.com/tuky/zendesk-mcp-server.git` and check out the chosen
   reviewed release tag in detached mode. Review its release notes.
2. Copy `infra/gcp/terraform.tfvars.example` to `terraform.tfvars`, and
   `backend.hcl.example` to `state.tfbackend` in the same directory. Set project,
   region, public hostname, Zendesk client and image digest. Both local files,
   plans and state files are ignored by Git.
3. Run from `infra/gcp`:

   ```sh
   terraform init -backend-config=state.tfbackend
   terraform fmt -check
   terraform validate
   terraform plan -out=deployment.tfplan
   terraform apply deployment.tfplan
   terraform output dns_records
   ```

4. Create the emitted A and certificate-authorization CNAME records in your DNS
   provider, out of band. Keep the CNAME for renewal. Wait for certificate
   activation and DNS propagation; Terraform completion does not prove HTTPS
   readiness.
5. Check `https://YOUR_HOSTNAME/healthz`, then connect the MCP client to
   `https://YOUR_HOSTNAME/mcp` and complete OAuth. Exercise the live acceptance
   scenarios in [fork validation](fork-validation.md).

The default is read-only. Enabling writes is an explicit Terraform setting and
requires appropriate Zendesk scope and permissions.

## State, keys and costs

Terraform generates the initial encryption key using an ephemeral random value
and writes it through the provider's write-only Secret Manager argument; raw key
material does not enter Terraform state or a saved plan. You may instead provide
a base64 key ring through ephemeral `TF_VAR_master_secret`; provide the same
value for both plan and apply. Do not put secrets in committed files.
Do not increment `master_secret_version` casually: generated replacement keys
invalidate stored grants. For overlap rotation, supply the new key plus the old
key using the application's documented comma-separated key ring, increment the
version, deploy all instances, and retain old keys until old records have been
rewrapped or expired. Back up keys separately under restricted access.

The runtime identity has Firestore data access conditioned to the selected
database and read access to its specific secret. It does not need service
account key files. Firestore TTL removes expired documents asynchronously;
the application enforces expiry immediately.

Firestore is usage-priced, but the named database, TTL deletes, point-in-time
recovery and the load balancer are **not a free deployment**. The load balancer
has a fixed cost even with no traffic. Maximum Cloud Run instances limit compute
scale, not total spending. Set project budgets and alerts before deployment.
PITR is enabled by default. Database deletion protection and Terraform
`ABANDON` preserve data; `terraform destroy` is not a database erase procedure.

## Runtime limits and operations

The Firestore profile requires `SLA_PUSH=false` and
`SLA_USER_PREFERENCES=false`. Persistent subscriptions and background push are
not supported across these stateless instances. Legacy (2025) clients also cannot
use server-initiated form elicitation in this JSON-only mode; provide explicit tool
arguments instead. Clients use ordinary HTTP
requests and reconnect without a sticky session. Local file/memory profiles
retain the upstream stateful behavior.

Health checks confirm the process answers HTTP, not Zendesk authorization or
database availability. Monitor Cloud Run errors/latency, Firestore errors and
certificate status. Do not log OAuth query strings, bearer tokens or ticket
content. The Terraform profile disables load-balancer request logs and excludes
Cloud Run request URLs with query strings on `/auth` and `/oauth/callback` from
the default log sink; other request logs remain available. Review any
organization-level sinks separately.

Upgrade by checking out a reviewed tag, selecting its image digest, and running
plan/apply. Roll back the image digest using the previous release's configuration
only if its storage format is compatible. Retain the same master secret and
database. For disaster recovery restore Firestore and the matching key ring
together, or deliberately invalidate all grants and require new login.

The emulator and Terraform mock tests cannot validate Google IAM, organization
policies, DNS, certificate issuance, real Zendesk permissions or client behavior.
A staging acceptance run is required before declaring this production-ready.
