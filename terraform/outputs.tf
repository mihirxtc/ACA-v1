output "instance_public_ip" {
  description = "Public IP of the created VM — use this to SSH in and access the app"
  value       = oci_core_instance.aca_server.public_ip
}

output "instance_id" {
  description = "OCID of the created instance"
  value       = oci_core_instance.aca_server.id
}

output "availability_domain_used" {
  description = "Which availability domain the VM was created in"
  value       = oci_core_instance.aca_server.availability_domain
}

output "ssh_command" {
  description = "SSH command to connect to your VM"
  value       = "ssh -i ~/.ssh/aca_vm_key.key ubuntu@${oci_core_instance.aca_server.public_ip}"
}
