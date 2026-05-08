output "rds_endpoint" {
  value = aws_db_instance.pg.endpoint
}

output "api_endpoint" {
  value = aws_api_gateway_stage.api.invoke_url
}

output "web_bucket" {
  value = aws_s3_bucket.web.id
}

output "web_url" {
  value = "http://${aws_s3_bucket_website_configuration.web.website_endpoint}"
}

output "database_url" {
  value     = "postgres://${var.db_username}:${var.db_password}@${aws_db_instance.pg.endpoint}/${var.db_name}"
  sensitive = true
}

output "sns_outage_topic_arn" {
  value = aws_sns_topic.outage_confirmed.arn
}

output "sns_status_topic_arn" {
  value = aws_sns_topic.node_status_changed.arn
}

output "friend_subscribe_instructions" {
  description = "Send this to teammates so they can subscribe their SQS to our status topic"
  value       = <<-EOT
    Topic ARN: ${aws_sns_topic.node_status_changed.arn}

    Step 1 — Ask the PowerGrid team to run on their side:
      ./scripts/sns-subscribers.sh add <YOUR_AWS_ACCOUNT_ID>

    Step 2 — Then create the subscription on your side:

    resource "aws_sqs_queue" "powergrid_status" {
      name = "powergrid-status-feed"
    }

    resource "aws_sqs_queue_policy" "allow_sns" {
      queue_url = aws_sqs_queue.powergrid_status.id
      policy = jsonencode({
        Statement = [{
          Effect    = "Allow"
          Principal = { Service = "sns.amazonaws.com" }
          Action    = "sqs:SendMessage"
          Resource  = aws_sqs_queue.powergrid_status.arn
          Condition = { ArnEquals = { "aws:SourceArn" = "${aws_sns_topic.node_status_changed.arn}" } }
        }]
      })
    }

    resource "aws_sns_topic_subscription" "powergrid_status" {
      topic_arn = "${aws_sns_topic.node_status_changed.arn}"
      protocol  = "sqs"
      endpoint  = aws_sqs_queue.powergrid_status.arn
    }
  EOT
}

output "lambdas" {
  value = {
    ingest   = aws_lambda_function.ingest.function_name
    detect   = aws_lambda_function.detect.function_name
    dispatch = aws_lambda_function.dispatch.function_name
    confirm  = aws_lambda_function.confirm.function_name
    api      = aws_lambda_function.api.function_name
  }
}
