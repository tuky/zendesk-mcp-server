terraform {
  required_version = ">= 1.11, < 2.0"
  backend "gcs" {}
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
    random = { source = "hashicorp/random", version = "~> 3.7" }
  }
}
provider "google" {
  project = var.project_id
  region  = var.region
}
