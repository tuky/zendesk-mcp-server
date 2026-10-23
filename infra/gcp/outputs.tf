output "dns_records" {
  value = [
    { name = var.hostname, type = "A", value = google_compute_global_address.mcp.address },
    { name = google_certificate_manager_dns_authorization.mcp.dns_resource_record[0].name,
      type = google_certificate_manager_dns_authorization.mcp.dns_resource_record[0].type,
    value = google_certificate_manager_dns_authorization.mcp.dns_resource_record[0].data }
  ]
}
output "mcp_url" { value = "https://${var.hostname}/mcp" }
output "zendesk_callback_url" { value = "https://${var.hostname}/oauth/callback" }
output "health_url" { value = "https://${var.hostname}/healthz" }
output "certificate_id" { value = google_certificate_manager_certificate.mcp.id }
