terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ─────────────────────────────────────────
# RDS PostgreSQL
# ─────────────────────────────────────────

resource "aws_security_group" "rds_sg" {
  name        = "powergrid-rds-sg"
  description = "Allow PostgreSQL from Lambda"

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "powergrid_db" {
  identifier        = "powergrid-db"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = "db.t3.micro"
  allocated_storage = 20

  db_name  = "powergrid"
  username = var.db_username
  password = var.db_password

  publicly_accessible    = true
  vpc_security_group_ids = [aws_security_group.rds_sg.id]
  skip_final_snapshot    = true

  tags = { Project = "powergrid-main" }
}

# ─────────────────────────────────────────
# Lambda Layer
# ─────────────────────────────────────────

resource "aws_lambda_layer_version" "psycopg2" {
  filename            = "${path.module}/layers/psycopg2.zip"
  layer_name          = "psycopg2-py312"
  compatible_runtimes = ["python3.12"]
}

# ─────────────────────────────────────────
# IAM Role — ใช้ LabRole ที่มีอยู่แล้ว
# ─────────────────────────────────────────

data "aws_iam_role" "lambda_role" {
  name = "LabRole"
}

# ─────────────────────────────────────────
# Lambda Function 1 — detect outage
# ─────────────────────────────────────────

data "archive_file" "function1_zip" {
  type        = "zip"
  source_file = "${path.module}/../lambda/fn1_detect_outage.py"
  output_path = "${path.module}/builds/function1.zip"
}

resource "aws_lambda_function" "detect_outage" {
  filename         = data.archive_file.function1_zip.output_path
  function_name    = "powergrid-detect-outage"
  role             = data.aws_iam_role.lambda_role.arn
  handler          = "fn1_detect_outage.lambda_handler"
  runtime          = "python3.12"
  timeout          = 30
  source_code_hash = data.archive_file.function1_zip.output_base64sha256

  layers = [aws_lambda_layer_version.psycopg2.arn]

  environment {
    variables = {
      DB_HOST                   = aws_db_instance.powergrid_db.address
      DB_PORT                   = "5432"
      DB_NAME                   = "powergrid"
      DB_USER                   = var.db_username
      DB_PASSWORD               = var.db_password
      HEARTBEAT_TIMEOUT_SECONDS = "30"
    }
  }

  tags = { Project = "powergrid-main" }
}

# ─────────────────────────────────────────
# Lambda Function 2 — get outage nodes
# ─────────────────────────────────────────

data "archive_file" "function2_zip" {
  type        = "zip"
  source_file = "${path.module}/../lambda/fn2_get_outage_nodes.py"
  output_path = "${path.module}/builds/function2.zip"
}

resource "aws_lambda_function" "get_outage_nodes" {
  filename         = data.archive_file.function2_zip.output_path
  function_name    = "powergrid-get-outage-nodes"
  role             = data.aws_iam_role.lambda_role.arn
  handler          = "fn2_get_outage_nodes.lambda_handler"
  runtime          = "python3.12"
  timeout          = 30
  source_code_hash = data.archive_file.function2_zip.output_base64sha256

  layers = [aws_lambda_layer_version.psycopg2.arn]

  environment {
    variables = {
      DB_HOST     = aws_db_instance.powergrid_db.address
      DB_PORT     = "5432"
      DB_NAME     = "powergrid"
      DB_USER     = var.db_username
      DB_PASSWORD = var.db_password
    }
  }

  tags = { Project = "powergrid-main" }
}

# ─────────────────────────────────────────
# Lambda Function 3 — check incident
# ─────────────────────────────────────────

data "archive_file" "function3_zip" {
  type        = "zip"
  source_file = "${path.module}/../lambda/fn3_check_incident.py"
  output_path = "${path.module}/builds/function3.zip"
}

resource "aws_lambda_function" "check_incident" {
  filename         = data.archive_file.function3_zip.output_path
  function_name    = "powergrid-check-incident"
  role             = data.aws_iam_role.lambda_role.arn
  handler          = "fn3_check_incident.lambda_handler"
  runtime          = "python3.12"
  timeout          = 30
  source_code_hash = data.archive_file.function3_zip.output_base64sha256

  layers = [aws_lambda_layer_version.psycopg2.arn]

  environment {
    variables = {
      DB_HOST                = aws_db_instance.powergrid_db.address
      DB_PORT                = "5432"
      DB_NAME                = "powergrid"
      DB_USER                = var.db_username
      DB_PASSWORD            = var.db_password
      INCIDENT_SERVICE_MOCK  = var.incident_service_mock
      INCIDENT_SERVICE_URL   = var.incident_service_url
      INCIDENT_TIMEOUT_SEC   = "5"
      INCIDENT_MAX_RETRIES   = "1"
    }
  }

  tags = { Project = "powergrid-main" }
}

# ─────────────────────────────────────────
# API Gateway
# ─────────────────────────────────────────

resource "aws_api_gateway_rest_api" "powergrid_api" {
  name = "powergrid-api"
}

resource "aws_api_gateway_resource" "nodes" {
  rest_api_id = aws_api_gateway_rest_api.powergrid_api.id
  parent_id   = aws_api_gateway_rest_api.powergrid_api.root_resource_id
  path_part   = "nodes"
}

resource "aws_api_gateway_method" "get_nodes" {
  rest_api_id   = aws_api_gateway_rest_api.powergrid_api.id
  resource_id   = aws_api_gateway_resource.nodes.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "get_nodes" {
  rest_api_id             = aws_api_gateway_rest_api.powergrid_api.id
  resource_id             = aws_api_gateway_resource.nodes.id
  http_method             = aws_api_gateway_method.get_nodes.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.get_outage_nodes.invoke_arn
}

resource "aws_api_gateway_resource" "node_id" {
  rest_api_id = aws_api_gateway_rest_api.powergrid_api.id
  parent_id   = aws_api_gateway_resource.nodes.id
  path_part   = "{node_id}"
}

resource "aws_api_gateway_resource" "heartbeat" {
  rest_api_id = aws_api_gateway_rest_api.powergrid_api.id
  parent_id   = aws_api_gateway_resource.node_id.id
  path_part   = "heartbeat"
}

resource "aws_api_gateway_method" "post_heartbeat" {
  rest_api_id   = aws_api_gateway_rest_api.powergrid_api.id
  resource_id   = aws_api_gateway_resource.heartbeat.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "post_heartbeat" {
  rest_api_id             = aws_api_gateway_rest_api.powergrid_api.id
  resource_id             = aws_api_gateway_resource.heartbeat.id
  http_method             = aws_api_gateway_method.post_heartbeat.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.detect_outage.invoke_arn
}

resource "aws_api_gateway_resource" "check_incident" {
  rest_api_id = aws_api_gateway_rest_api.powergrid_api.id
  parent_id   = aws_api_gateway_resource.node_id.id
  path_part   = "check-incident"
}

resource "aws_api_gateway_method" "post_check_incident" {
  rest_api_id   = aws_api_gateway_rest_api.powergrid_api.id
  resource_id   = aws_api_gateway_resource.check_incident.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "post_check_incident" {
  rest_api_id             = aws_api_gateway_rest_api.powergrid_api.id
  resource_id             = aws_api_gateway_resource.check_incident.id
  http_method             = aws_api_gateway_method.post_check_incident.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.check_incident.invoke_arn
}

resource "aws_lambda_permission" "apigw_detect_outage" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.detect_outage.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.powergrid_api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_get_outage_nodes" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_outage_nodes.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.powergrid_api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_check_incident" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.check_incident.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.powergrid_api.execution_arn}/*/*"
}

resource "aws_api_gateway_deployment" "powergrid" {
  rest_api_id = aws_api_gateway_rest_api.powergrid_api.id
  depends_on = [
    aws_api_gateway_integration.get_nodes,
    aws_api_gateway_integration.post_heartbeat,
    aws_api_gateway_integration.post_check_incident,
  ]
}

resource "aws_api_gateway_stage" "prod" {
  deployment_id = aws_api_gateway_deployment.powergrid.id
  rest_api_id   = aws_api_gateway_rest_api.powergrid_api.id
  stage_name    = "prod"
}
