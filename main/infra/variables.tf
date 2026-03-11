variable "aws_region" {
  description = "AWS Region"
  type        = string
  default     = "us-east-1"
}

variable "db_username" {
  description = "RDS username"
  type        = string
  default     = "postgres"
}

variable "db_password" {
  description = "RDS password"
  type        = string
  sensitive   = true
}

variable "incident_service_url" {
  description = "Base URL of the external Incident Service API Gateway"
  type        = string
}

variable "driver_service_url" {
  description = "Base URL of the external Driver Service API Gateway"
  type        = string
}

variable "staff_service_url" {
  description = "Base URL of the external Staff Service API Gateway"
  type        = string
}
