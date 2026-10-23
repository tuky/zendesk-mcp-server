# Fork validation

Repository-only delivery: no live GCP project or Zendesk tenant is used.

## Local checks

Use Node 24 and the package manager pinned in package.json.

```sh
pnpm install --frozen-lockfile
docker compose -f compose.firestore.yml up -d
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 pnpm test:firestore
pnpm check
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:bundle
docker build -t zendesk-mcp:staging-check .
node scripts/container-smoke.mjs zendesk-mcp:staging-check
node scripts/container-firestore-smoke.mjs zendesk-mcp:staging-check
terraform -chdir=infra/gcp init -backend=false
terraform -chdir=infra/gcp validate
terraform -chdir=infra/gcp test
docker compose -f compose.firestore.yml down
```

Tests require a loopback Firestore emulator and a demo project. Do not point them
at production. Emulator data is disposable. The emulator is prohibited when
NODE_ENV=production.

The container Firestore smoke test starts and cleans up its own emulator and
network. It verifies encrypted database writes and reads after container
replacement using the shipped bundle, without mounted source or dependencies.
It uses NODE_ENV=test to permit the emulator; real ADC/IAM and the production
REST transport still need the staging checks below.

An independent reviewer should inspect encryption and TTL, grant replay
invalidation, concurrent refresh, process replacement, rollback, IAM scope and
the absence of secrets in state.

## Independent staging acceptance plan

Run on a deployed staging release with two consenting test users of different
Zendesk roles. Record release SHA/image digest, client versions, timestamps and
sanitized outcomes. Never include credentials or ticket content in the report.

- Discover OAuth metadata; verify issuer and audience match the public hostname.
- Register a client and complete PKCE login through several instances.
- List tools and read one permitted ticket with full comment pagination.
- Confirm user B cannot read a ticket unavailable to B in Zendesk itself.
- Replace an instance and repeat requests with existing credentials.
- Refresh tokens concurrently; replay a spent token and verify the entire grant
  becomes unusable on every instance.
- Revoke at Zendesk and verify reauthentication without silently replaying writes.
- Check both supported MCP protocol eras in the intended desktop clients.
- Verify unavailable database fails closed, then restore service.
- Check default read-only policy; if writes are approved, use disposable tickets.
- Confirm direct external run.app ingress is rejected, HTTPS works after
  out-of-band DNS setup, and certificate renewal authorization remains present.
- Inspect Terraform plan/state and request logs for accidental secret exposure.
- Exercise key rotation with overlap, image rollback and restoration from backup.

Post findings separately from implementer results. Production approval belongs
to the repository owner after these live scenarios pass.
