import json
import os
import psycopg2
from datetime import timezone

DB_HOST     = os.environ["DB_HOST"]
DB_PORT     = os.environ.get("DB_PORT", "5432")
DB_NAME     = os.environ["DB_NAME"]
DB_USER     = os.environ["DB_USER"]
DB_PASSWORD = os.environ["DB_PASSWORD"]

VALID_STATUSES = {"NORMAL", "OUTAGE_DETECTED", "DISPATCHED", "UNDER_MAINTENANCE"}

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
    params          = event.get("queryStringParameters") or {}
    status_filter   = params.get("status")
    priority_filter = params.get("priority_level")

    if status_filter and status_filter not in VALID_STATUSES:
        return response(400, {"error": f"Invalid status '{status_filter}'", "valid_values": list(VALID_STATUSES)})

    if priority_filter:
        if not priority_filter.isdigit():
            return response(400, {"error": "priority_level must be an integer"})
        priority_filter = int(priority_filter)

    try:
        conn = get_connection()
        cur  = conn.cursor()

        query = """
            SELECT m.node_id, m.place_name, m.place_type, m.lat, m.lng,
                   g.status, g.priority_level, g.last_heartbeat,
                   g.incident_id, g.incident_verification, g.updated_at
            FROM power_node_master m
            JOIN live_grid_health_state g ON m.node_id = g.node_id
            WHERE 1=1
        """
        query_params = []

        if status_filter:
            query += " AND g.status = %s"
            query_params.append(status_filter)
        if priority_filter:
            query += " AND g.priority_level = %s"
            query_params.append(priority_filter)

        query += " ORDER BY g.priority_level ASC NULLS LAST, g.updated_at ASC"

        cur.execute(query, query_params)
        rows = cur.fetchall()
        cur.close(); conn.close()

        nodes = []
        for row in rows:
            node_id, place_name, place_type, lat, lng, status, priority_level, \
            last_heartbeat, incident_id, incident_verification, updated_at = row

            # DB ใช้ TIMESTAMP (ไม่มี timezone) แต่เก็บเป็น UTC
            # ต้อง attach timezone เพื่อให้ browser ตีความถูกต้อง
            if last_heartbeat and last_heartbeat.tzinfo is None:
                last_heartbeat = last_heartbeat.replace(tzinfo=timezone.utc)
            if updated_at and updated_at.tzinfo is None:
                updated_at = updated_at.replace(tzinfo=timezone.utc)

            nodes.append({
                "node_id": node_id, "place_name": place_name, "place_type": place_type,
                "geo_location": {"lat": float(lat), "lng": float(lng)},
                "status": status, "priority_level": priority_level,
                "last_heartbeat": last_heartbeat.isoformat() if last_heartbeat else None,
                "incident_id": incident_id, "incident_verification": incident_verification,
                "updated_at": updated_at.isoformat() if updated_at else None
            })

        return response(200, {"total": len(nodes), "nodes": nodes})

    except psycopg2.OperationalError as e:
        return response(503, {"error": "Database connection failed", "detail": str(e)})
    except Exception as e:
        return response(500, {"error": "Internal server error", "detail": str(e)})