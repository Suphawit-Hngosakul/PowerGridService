import json
import os
import psycopg2
from datetime import datetime, timezone

DB_HOST                   = os.environ["DB_HOST"]
DB_PORT                   = os.environ.get("DB_PORT", "5432")
DB_NAME                   = os.environ["DB_NAME"]
DB_USER                   = os.environ["DB_USER"]
DB_PASSWORD               = os.environ["DB_PASSWORD"]
HEARTBEAT_TIMEOUT_SECONDS = int(os.environ.get("HEARTBEAT_TIMEOUT_SECONDS", "30"))

PRIORITY_MAP = {"HOSPITAL": 1, "SHELTER": 2, "GENERAL": 3}

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
    node_id = event.get("pathParameters", {}).get("node_id")
    if not node_id:
        return response(400, {"error": "node_id is required"})

    now = datetime.now(timezone.utc)

    try:
        conn = get_connection()
        cur  = conn.cursor()

        cur.execute("""
            SELECT m.place_type, g.status, g.last_heartbeat
            FROM power_node_master m
            JOIN live_grid_health_state g ON m.node_id = g.node_id
            WHERE m.node_id = %s
        """, (node_id,))

        row = cur.fetchone()
        if not row:
            return response(404, {"error": f"Node {node_id} not found"})

        place_type, current_status, last_heartbeat = row

        if current_status == "OUTAGE_DETECTED":
            # อัพเดต last_heartbeat แต่ไม่เปลี่ยน status (ยังคง OUTAGE_DETECTED)
            cur.execute("""
                UPDATE live_grid_health_state
                SET last_heartbeat = %s, updated_at = %s
                WHERE node_id = %s
            """, (now, now, node_id))
            conn.commit()
            cur.close(); conn.close()
            return response(200, {
                "node_id": node_id, "status": "OUTAGE_DETECTED",
                "last_heartbeat": now.isoformat(),
                "message": "Heartbeat recorded; node remains OUTAGE_DETECTED"
            })

        cur.execute("""
            UPDATE live_grid_health_state
            SET last_heartbeat = %s, updated_at = %s
            WHERE node_id = %s
        """, (now, now, node_id))

        is_outage = False
        if last_heartbeat:
            if last_heartbeat.tzinfo is None:
                last_heartbeat = last_heartbeat.replace(tzinfo=timezone.utc)
            is_outage = (now - last_heartbeat).total_seconds() > HEARTBEAT_TIMEOUT_SECONDS

        if is_outage:
            priority_level = PRIORITY_MAP.get(place_type, 99)
            cur.execute("""
                UPDATE live_grid_health_state
                SET status = 'OUTAGE_DETECTED', priority_level = %s, updated_at = %s
                WHERE node_id = %s
            """, (priority_level, now, node_id))
            conn.commit()
            cur.close(); conn.close()
            return response(200, {
                "node_id": node_id, "status": "OUTAGE_DETECTED",
                "priority_level": priority_level, "detected_at": now.isoformat()
            })

        conn.commit()
        cur.close(); conn.close()
        return response(200, {
            "node_id": node_id, "status": "NORMAL",
            "last_heartbeat": now.isoformat()
        })

    except psycopg2.OperationalError as e:
        return response(503, {"error": "Database connection failed", "detail": str(e)})
    except Exception as e:
        return response(500, {"error": "Internal server error", "detail": str(e)})