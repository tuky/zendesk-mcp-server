resource "google_project_service" "api" {
  for_each = toset([
    "run.googleapis.com", "firestore.googleapis.com", "secretmanager.googleapis.com",
    "compute.googleapis.com", "certificatemanager.googleapis.com", "iam.googleapis.com"
  ])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
resource "google_service_account" "runtime" {
  account_id   = var.name
  display_name = "Zendesk MCP runtime"
  depends_on   = [google_project_service.api]
}
resource "google_firestore_database" "auth" {
  project                           = var.project_id
  name                              = var.database_id
  location_id                       = var.firestore_location
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "PESSIMISTIC"
  delete_protection_state           = var.deletion_protection ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  deletion_policy                   = "ABANDON"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  depends_on                        = [google_project_service.api]
}
resource "google_firestore_field" "expiry" {
  project    = var.project_id
  database   = google_firestore_database.auth.name
  collection = "oauth"
  field      = "expiresAt"
  ttl_config {}
  index_config {}
}
resource "google_firestore_field" "ciphertext" {
  project    = var.project_id
  database   = google_firestore_database.auth.name
  collection = "oauth"
  field      = "value"
  index_config {}
}
resource "google_project_iam_member" "database" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
  condition {
    title       = "OnlyMcpDatabase"
    expression  = "resource.name == 'projects/${var.project_id}/databases/${var.database_id}' || resource.name.startsWith('projects/${var.project_id}/databases/${var.database_id}/')"
    description = "Limit runtime data access to the MCP database."
  }
}
ephemeral "random_password" "master" {
  length  = 64
  special = false
}
resource "google_secret_manager_secret" "master" {
  secret_id = "${var.name}-oauth-master"
  replication {
    auto {}
  }
  depends_on = [google_project_service.api]
}
resource "google_secret_manager_secret_version" "master" {
  secret                 = google_secret_manager_secret.master.id
  secret_data_wo         = coalesce(var.master_secret, ephemeral.random_password.master.result)
  secret_data_wo_version = var.master_secret_version
  deletion_policy        = "DISABLE"
}
resource "google_secret_manager_secret_iam_member" "runtime" {
  secret_id = google_secret_manager_secret.master.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_cloud_run_v2_service" "mcp" {
  name                = var.name
  location            = var.region
  deletion_protection = var.deletion_protection
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  template {
    service_account                  = google_service_account.runtime.email
    timeout                          = "300s"
    max_instance_request_concurrency = 40
    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }
    containers {
      image = var.image
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = {
          NODE_ENV                = "production"
          TRANSPORT               = "http"
          LISTEN_HOST             = "0.0.0.0"
          PUBLIC_URL              = "https://${var.hostname}"
          ZENDESK_SUBDOMAIN       = var.zendesk_subdomain
          ZENDESK_OAUTH_CLIENT_ID = var.zendesk_oauth_client_id
          OAUTH_STORE             = "firestore://${var.project_id}/${var.database_id}/oauth"
          READ_ONLY               = tostring(var.read_only)
          SLA_PUSH                = "false"
          SLA_USER_PREFERENCES    = "false"
        }
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "OAUTH_MASTER_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.master.secret_id
            version = google_secret_manager_secret_version.master.version
          }
        }
      }
      startup_probe {
        http_get { path = "/healthz" }
        period_seconds    = 10
        failure_threshold = 12
      }
      liveness_probe {
        http_get { path = "/healthz" }
      }
    }
  }
  depends_on = [google_project_iam_member.database, google_secret_manager_secret_iam_member.runtime, google_firestore_field.expiry, google_firestore_field.ciphertext, google_logging_project_exclusion.oauth_requests]
}
# Public at the GCP IAM layer; ingress restricts the network path and the app
# validates per-user, audience-bound OAuth on every MCP request.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.mcp.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
resource "google_compute_global_address" "mcp" {
  name       = var.name
  depends_on = [google_project_service.api]
}
resource "google_compute_region_network_endpoint_group" "mcp" {
  name                  = var.name
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = google_cloud_run_v2_service.mcp.name }
}
resource "google_compute_backend_service" "mcp" {
  name                  = var.name
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  enable_cdn            = false
  backend { group = google_compute_region_network_endpoint_group.mcp.id }
  log_config { enable = false }
}
resource "google_compute_url_map" "mcp" {
  name            = var.name
  default_service = google_compute_backend_service.mcp.id
}
resource "google_certificate_manager_dns_authorization" "mcp" {
  name       = var.name
  domain     = var.hostname
  depends_on = [google_project_service.api]
}
resource "google_certificate_manager_certificate" "mcp" {
  name = var.name
  managed {
    domains            = [var.hostname]
    dns_authorizations = [google_certificate_manager_dns_authorization.mcp.id]
  }
}
resource "google_certificate_manager_certificate_map" "mcp" {
  name       = var.name
  depends_on = [google_project_service.api]
}
resource "google_certificate_manager_certificate_map_entry" "mcp" {
  name         = var.name
  map          = google_certificate_manager_certificate_map.mcp.name
  certificates = [google_certificate_manager_certificate.mcp.id]
  hostname     = var.hostname
}
resource "google_compute_target_https_proxy" "mcp" {
  name            = var.name
  url_map         = google_compute_url_map.mcp.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.mcp.id}"
}
resource "google_compute_global_forwarding_rule" "https" {
  name                  = var.name
  ip_address            = google_compute_global_address.mcp.address
  target                = google_compute_target_https_proxy.mcp.id
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# Authorization codes and browser state travel in OAuth query strings. Keep
# other Cloud Run request logs available for operational visibility.
resource "google_logging_project_exclusion" "oauth_requests" {
  project     = var.project_id
  name        = "${var.name}-oauth-request-urls"
  description = "Exclude OAuth authorization and callback URLs from the default sink."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.name}\" AND log_id(\"run.googleapis.com/requests\") AND httpRequest.requestUrl=~\"^https?://[^/]+/(auth|oauth/callback)[?]\""
}
resource "google_compute_url_map" "redirect" {
  name = "${var.name}-redirect"
  default_url_redirect {
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
  }
}
resource "google_compute_target_http_proxy" "redirect" {
  name    = "${var.name}-redirect"
  url_map = google_compute_url_map.redirect.id
}
resource "google_compute_global_forwarding_rule" "http" {
  name                  = "${var.name}-http"
  ip_address            = google_compute_global_address.mcp.address
  target                = google_compute_target_http_proxy.redirect.id
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
