terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}

# ------------------------------------------------------------------
# Look up all availability domains in the tenancy
# ad_number = 0 → AD-1, 1 → AD-2, 2 → AD-3
# Change var.ad_number in terraform.tfvars and re-run to retry
# ------------------------------------------------------------------
data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# ------------------------------------------------------------------
# Find latest Ubuntu 22.04 ARM64 image for A1 Flex shape
# ------------------------------------------------------------------
data "oci_core_images" "ubuntu_22_04_arm" {
  compartment_id           = var.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# ------------------------------------------------------------------
# Look up the existing VCN created manually
# ------------------------------------------------------------------
data "oci_core_vcns" "aca_vcn" {
  compartment_id = var.compartment_id
  display_name   = "aca-vcn"
}

# ------------------------------------------------------------------
# Look up the existing public subnet
# ------------------------------------------------------------------
data "oci_core_subnets" "aca_subnet" {
  compartment_id = var.compartment_id
  display_name   = "aca-public-subnet"
  vcn_id         = data.oci_core_vcns.aca_vcn.virtual_networks[0].id
}

# ------------------------------------------------------------------
# Create the VM instance
# Change ad_number in terraform.tfvars to try different ADs:
#   0 = AD-1, 1 = AD-2, 2 = AD-3
# ------------------------------------------------------------------
resource "oci_core_instance" "aca_server" {
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.ad_number].name
  compartment_id      = var.compartment_id
  display_name        = "aca-server"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = 4
    memory_in_gbs = 24
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu_22_04_arm.images[0].id
  }

  create_vnic_details {
    subnet_id        = data.oci_core_subnets.aca_subnet.subnets[0].id
    assign_public_ip = true
    display_name     = "aca-server-vnic"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
  }

  preserve_boot_volume = false
}
