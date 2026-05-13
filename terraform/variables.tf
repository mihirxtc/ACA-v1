variable "tenancy_ocid" {
  description = "Your Oracle Cloud tenancy OCID. Profile → Tenancy → OCID"
  type        = string
}

variable "user_ocid" {
  description = "Your Oracle Cloud user OCID. Profile → My Profile → OCID"
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint of the OCI API key. Profile → API Keys → fingerprint column"
  type        = string
}

variable "private_key_path" {
  description = "Path to the OCI API private key file on your laptop (not the SSH key)"
  type        = string
  default     = "~/.oci/oci_api_key.pem"
}

variable "region" {
  description = "Oracle Cloud region identifier"
  type        = string
  default     = "uk-london-1"
}

variable "compartment_id" {
  description = "Compartment OCID — same as tenancy_ocid for root compartment"
  type        = string
}

variable "ssh_public_key" {
  description = "Contents of your SSH public key file (.pub) for VM access"
  type        = string
}

variable "ad_number" {
  description = "Availability domain index: 0=AD-1, 1=AD-2, 2=AD-3. Change and re-run if capacity error."
  type        = number
  default     = 0
}
