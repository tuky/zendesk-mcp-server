variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "europe-west3"
}
variable "name" {
  type    = string
  default = "zendesk-mcp"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}$", var.name))
    error_message = "Use 3-20 lowercase letters, digits or hyphens, starting with a letter."
  }
}
variable "hostname" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]+\\.[a-z]{2,}$", var.hostname))
    error_message = "Supply a public DNS hostname, without scheme or path."
  }
}
variable "zendesk_subdomain" { type = string }
variable "zendesk_oauth_client_id" { type = string }
variable "image" {
  type        = string
  description = "Published release image pinned by sha256 digest."
  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Pin the container by its immutable sha256 digest."
  }
}
variable "database_id" {
  type    = string
  default = "zendesk-mcp"
}
variable "firestore_location" {
  type    = string
  default = "europe-west3"
}
variable "read_only" {
  type    = bool
  default = true
}
variable "max_instances" {
  type    = number
  default = 3
  validation {
    condition     = var.max_instances >= 1 && var.max_instances <= 20 && floor(var.max_instances) == var.max_instances
    error_message = "Choose an integer instance limit between 1 and 20."
  }
}
variable "deletion_protection" {
  type    = bool
  default = true
}
variable "master_secret_version" {
  type        = number
  default     = 1
  description = "Increment to replace the master secret. Generated-key replacement signs all users out."
}
variable "master_secret" {
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = null
  description = "Optional base64 key/key ring from TF_VAR_master_secret. Null generates a key outside Terraform state."
}
