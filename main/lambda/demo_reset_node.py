import json
import os
import psycopg2
from datetime import datetime, timezone

DB_HOST     = os.environ["DB_HOST"]
DB_PORT     = os.environ.get("DB_PORT", "5432")
DB_NAME     = os.environ["DB_NAME"]
DB_USER     = os.environ["DB_USER"]
DB_PASSWORD = os.environ["DB_PASSWORD"]


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
        user=DB_USER, password=DB_PASSWORD, connect_timeout=5
    )


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str)
    }


def lambda_handler(event, context):
    """Demo Utility — Reset node กลับเป็น NORMAL เพื่อทดสอบซ้ำ"""
    node_id = (event.get("pathParameters") or {}).get("node_id")
    if not node_id:
        return response(400, {"error": "node_id is required"})

    now = datetime.now(timezone.utc)

    try:
        conn = get_connection()
        cur  = conn.cursor()

        cur.execute("""
            SELECT status FROM live_grid_health_state WHERE node_id = %s
        """, (node_id,))
        row = cur.fetchone()

        if not row:
            cur.close(); conn.close()
            return response(404, {"error": f"Node {node_id} not found"})

        old_status = row[0]

        if old_status == "NORMAL":
            cur.close(); conn.close()
            return response(200, {
                "node_id": node_id,
                "message": "Node is already NORMAL",
                "status": "NORMAL"
            })

        # Reset ทุก field กลับเป็นค่าเริ่มต้น
        cur.execute("""
            UPDATE live_grid_health_state
            SET status                = 'NORMAL',
                priority_level        = NULL,
                last_heartbeat        = %s,
                incident_id           = NULL,
                incident_verification = 'VERIFIED',
                unverified_since      = NULL,
                updated_at            = %s
            WHERE node_id = %s
        """, (now, now, node_id))

        conn.commit()
        cur.close(); conn.close()

        return response(200, {
            "node_id":     node_id,
            "status":      "NORMAL",
            "previous":    old_status,
            "message":     "Node reset to NORMAL for demo",
            "reset_at":    now.isoformat()
        })

    except psycopg2.OperationalError as e:
        return response(503, {"error": "Database connection failed", "detail": str(e)})
    except Exception as e:
        return response(500, {"error": "Internal server error", "detail": str(e)})
