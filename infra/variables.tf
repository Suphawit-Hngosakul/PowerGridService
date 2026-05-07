variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "powergrid"
}

variable "db_username" {
  type    = string
  default = "powergrid"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "db_name" {
  type    = string
  default = "powergrid"
}

variable "subnet_ids" {
  type        = list(string)
  description = "Subnets for RDS (use default VPC subnets)"
}

variable "lambda_security_group_id" {
  type        = string
  description = "SG that allows egress to RDS + internet"
}

variable "resource_completed_queue_arn" {
  type        = string
  description = "Cross-account SQS queue (owned by ResourceAllocation team) that publishes POWERGRID_COMPLETED events. The queue owner must grant this account's LabRole sqs:ReceiveMessage / DeleteMessage / GetQueueAttributes via queue policy. Wired into the confirm Lambda's event source mapping."
}

variable "incident_impact_zone_url" {
  type        = string
  description = "GET endpoint of IncidentImpactZone Service (other team) returning active impact zones. Wired into the dispatch Lambda as INCIDENT_IMPACT_ZONE_URL."
}

variable "priority_case_service_url" {
  type        = string
  description = "POST endpoint of PriorityCase Service (other team) accepting one report per outaged node. Wired into the dispatch Lambda as PRIORITY_CASE_SERVICE_URL."
}

variable "outbound_shared_secret" {
  type        = string
  description = "Shared secret for HMAC signing of outbound POSTs and Bearer auth on outbound GETs. Wired into the dispatch Lambda as OUTBOUND_SHARED_SECRET."
  sensitive   = true
}
