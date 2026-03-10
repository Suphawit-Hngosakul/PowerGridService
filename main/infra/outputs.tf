output "api_url" {
  description = "API Gateway URL"
  value       = "https://${aws_api_gateway_rest_api.powergrid_api.id}.execute-api.${var.aws_region}.amazonaws.com/prod"
}

output "rds_endpoint" {
  description = "RDS Endpoint"
  value       = aws_db_instance.powergrid_db.address
}
