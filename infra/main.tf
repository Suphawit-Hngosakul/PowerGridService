terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  name = var.project
}

data "aws_iam_role" "lab" {
  name = "LabRole"
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = var.subnet_ids
}

resource "aws_db_instance" "pg" {
  identifier             = "${local.name}-pg"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t3.micro"
  allocated_storage      = 20
  username               = var.db_username
  password               = var.db_password
  db_name                = var.db_name
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.lambda_security_group_id]
  skip_final_snapshot    = true
  publicly_accessible    = true
  storage_encrypted      = false
}

resource "aws_sns_topic" "outage_confirmed" {
  name = "${local.name}-outage-confirmed"
}

resource "aws_sns_topic" "node_status_changed" {
  name = "${local.name}-node-status-changed"
}


resource "aws_sqs_queue" "dispatch_dlq" {
  name                      = "${local.name}-dispatch-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "dispatch" {
  name                       = "${local.name}-dispatch"
  visibility_timeout_seconds = 60
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dispatch_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sns_topic_subscription" "dispatch" {
  topic_arn = aws_sns_topic.outage_confirmed.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.dispatch.arn
}

resource "aws_sqs_queue_policy" "dispatch" {
  queue_url = aws_sqs_queue.dispatch.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.dispatch.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.outage_confirmed.arn } }
    }]
  })
}

locals {
  common_env = {
    DATABASE_URL              = "postgres://${var.db_username}:${var.db_password}@${aws_db_instance.pg.endpoint}/${var.db_name}"
    SNS_OUTAGE_TOPIC_ARN      = aws_sns_topic.outage_confirmed.arn
    SNS_STATUS_TOPIC_ARN      = aws_sns_topic.node_status_changed.arn
    SUSPECT_AFTER_SECONDS     = "60"
    OUTAGE_AFTER_SECONDS      = "120"
    INCIDENT_IMPACT_ZONE_URL  = var.incident_impact_zone_url
    PRIORITY_CASE_SERVICE_URL = var.priority_case_service_url
    OUTBOUND_SHARED_SECRET    = var.outbound_shared_secret
  }
}

resource "aws_lambda_function" "ingest" {
  function_name = "${local.name}-ingest"
  filename      = "${path.module}/build/ingest.zip"
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  role          = data.aws_iam_role.lab.arn
  timeout       = 10
  memory_size   = 256
  environment { variables = local.common_env }
}

resource "aws_lambda_function" "detect" {
  function_name = "${local.name}-detect"
  filename      = "${path.module}/build/detect.zip"
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  role          = data.aws_iam_role.lab.arn
  timeout       = 30
  memory_size   = 256
  environment { variables = local.common_env }
}

resource "aws_lambda_function" "dispatch" {
  function_name = "${local.name}-dispatch"
  filename      = "${path.module}/build/dispatch.zip"
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  role          = data.aws_iam_role.lab.arn
  timeout       = 30
  memory_size   = 256
  environment { variables = local.common_env }
}

resource "aws_lambda_event_source_mapping" "dispatch_sqs" {
  event_source_arn = aws_sqs_queue.dispatch.arn
  function_name    = aws_lambda_function.dispatch.arn
  batch_size       = 1
}

resource "aws_lambda_function" "confirm" {
  function_name = "${local.name}-confirm"
  filename      = "${path.module}/build/confirm.zip"
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  role          = data.aws_iam_role.lab.arn
  timeout       = 15
  memory_size   = 256
  environment { variables = local.common_env }
}

resource "aws_lambda_event_source_mapping" "confirm_sqs" {
  event_source_arn = var.resource_completed_queue_arn
  function_name    = aws_lambda_function.confirm.arn
  batch_size       = 1
}

resource "aws_lambda_permission" "iot_invoke" {
  statement_id  = "AllowIotCoreInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest.function_name
  principal     = "iot.amazonaws.com"
}

resource "aws_iot_topic_rule" "heartbeat" {
  name        = "${replace(local.name, "-", "_")}_heartbeat"
  enabled     = true
  sql         = "SELECT * FROM 'powergrid/nodes/+/heartbeat'"
  sql_version = "2016-03-23"

  lambda { function_arn = aws_lambda_function.ingest.arn }
}

resource "aws_scheduler_schedule" "detect" {
  name = "${local.name}-detect"
  flexible_time_window { mode = "OFF" }
  schedule_expression = "rate(30 seconds)"
  target {
    arn      = aws_lambda_function.detect.arn
    role_arn = data.aws_iam_role.lab.arn
  }
}

resource "aws_lambda_permission" "scheduler_invoke" {
  statement_id  = "AllowSchedulerInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.detect.function_name
  principal     = "scheduler.amazonaws.com"
}

resource "aws_lambda_function" "api" {
  function_name = "${local.name}-api"
  filename      = "${path.module}/build/api.zip"
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  role          = data.aws_iam_role.lab.arn
  timeout       = 30
  memory_size   = 256
  environment { variables = local.common_env }
}

resource "aws_apigatewayv2_api" "api" {
  name          = "${local.name}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "v1"
  auto_deploy = true
}

resource "aws_apigatewayv2_integration" "api" {
  api_id             = aws_apigatewayv2_api.api.id
  integration_type   = "AWS_PROXY"
  integration_method = "POST"
  integration_uri    = aws_lambda_function.api.invoke_arn
}

resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
