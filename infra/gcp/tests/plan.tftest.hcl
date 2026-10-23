mock_provider "google" {}
provider "random" {}

variables {
  project_id              = "demo-zendesk-mcp"
  hostname                = "mcp.example.com"
  zendesk_subdomain       = "example"
  zendesk_oauth_client_id = "test-client"
  image                   = "europe-west3-docker.pkg.dev/demo-zendesk-mcp/release/mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
run "secure_defaults" {
  command = plan
  assert {
    condition     = google_cloud_run_v2_service.mcp.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
    error_message = "External access must use the HTTPS load balancer."
  }
  assert {
    condition     = google_cloud_run_v2_service.mcp.template[0].scaling[0].min_instance_count == 0
    error_message = "Idle instances must scale to zero."
  }
  assert {
    condition     = google_firestore_database.auth.delete_protection_state == "DELETE_PROTECTION_ENABLED" && google_firestore_database.auth.deletion_policy == "ABANDON"
    error_message = "The database must survive accidental destroy."
  }
  assert {
    condition     = !google_compute_backend_service.mcp.enable_cdn && !google_compute_backend_service.mcp.log_config[0].enable
    error_message = "Do not cache OAuth traffic or log callback URLs."
  }
  assert {
    condition     = strcontains(google_logging_project_exclusion.oauth_requests.filter, "httpRequest.requestUrl=~\"^https?://[^/]+/(auth|oauth/callback|interaction/[^/?]+/callback(/[^?]*)?)[?]\"")
    error_message = "Only OAuth authorization and callback URLs should be excluded from request logs."
  }
  assert {
    condition = alltrue([
      for url in [
        "https://mcp.example.com/auth?client_id=fixture",
        "https://mcp.example.com/oauth/callback?code=fixture&state=fixture",
        "https://mcp.example.com/interaction/fixture-id/callback?code=fixture",
        "https://mcp.example.com/interaction/fixture-id/callback/?code=fixture",
        "https://mcp.example.com/interaction/fixture-id/callback/extra?code=fixture",
      ] : can(regex(regex("httpRequest.requestUrl=~\"([^\"]+)\"", google_logging_project_exclusion.oauth_requests.filter)[0], url))
    ])
    error_message = "Every OAuth hop carrying a query-string code must be excluded, including the internal interaction callback."
  }
  assert {
    condition = alltrue([
      for url in [
        "https://mcp.example.com/healthz",
        "https://mcp.example.com/mcp?fixture=1",
        "https://mcp.example.com/interaction/fixture-id/confirm?fixture=1",
      ] : !can(regex(regex("httpRequest.requestUrl=~\"([^\"]+)\"", google_logging_project_exclusion.oauth_requests.filter)[0], url))
    ])
    error_message = "Keep ordinary request logs available."
  }
  assert {
    condition     = output.zendesk_callback_url == "https://mcp.example.com/oauth/callback"
    error_message = "The callback must use the public HTTPS origin."
  }
}
run "reject_unpinned_image" {
  command = plan
  variables { image = "example/mcp:latest" }
  expect_failures = [var.image]
}
