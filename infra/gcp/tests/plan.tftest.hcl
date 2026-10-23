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
    condition     = strcontains(google_logging_project_exclusion.oauth_requests.filter, "httpRequest.requestUrl=~\"^https?://[^/]+/(auth|oauth/callback)[?]\"")
    error_message = "Only OAuth authorization and callback URLs should be excluded from request logs."
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
