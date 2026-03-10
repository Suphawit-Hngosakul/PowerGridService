import json
import os
import urllib.request
import urllib.error
import psycopg2
from datetime import datetime, timezone

DB_HOST     = os.environ["DB_HOST"]
DB_PORT     = os.environ.get("DB_PORT", "5432")
DB_NAME     = os.environ["DB_NAME"]
DB_USER     = os.environ["DB_USER"]
DB_PASSWORD = os.environ["DB_PASSWORD"]

INCIDENT_SERVICE_URL = os.environ["INCIDENT_SERVICE_URL"]
INCIDENT_TIMEOUT_SEC = int(os.environ.get("INCIDENT_TIMEOUT_SEC", "5"))
INCIDENT_MAX_RETRIES = int(os.environ.get("INCIDENT_MAX_RETRIES", "1"))


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


def point_in_polygon(lng: float, lat: float, ring: list) -> bool:
    x, y = lng, lat
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def find_matching_incident(lng: float, lat: float, incidents: list) -> dict | None:
    for incident in incidents:
        area = incident.get("affected_area", {})
        geo_type = area.get("type")
        coords = area.get("coordinates", [])

        if geo_type == "Polygon":
            if coords and point_in_polygon(lng, lat, coords[0]):
                return incident

        elif geo_type == "MultiPolygon":
            for polygon in coords:
                if polygon and point_in_polygon(lng, lat, polygon[0]):
                    return incident

    return None


def fetch_active_incidents() -> list:
    url = f"{INCIDENT_SERVICE_URL.rstrip('/')}/incidents/active"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Content-Type", "application/json")

    attempt, last_error = 0, None
    while attempt <= INCIDENT_MAX_RETRIES:
        try:
            with urllib.request.urlopen(req, timeout=INCIDENT_TIMEOUT_SEC) as resp:
                body = json.loads(resp.read().decode())
                return body.get("incidents", [])
        except Exception as e:
            last_error = e
            attempt += 1

    raise RuntimeError(f"Incident Service unreachable after {INCIDENT_MAX_RETRIES} retries: {last_error}")


def save_incident_verified(cur, node_id: str, incident_id: str, now: datetime):
    cur.execute("""
        UPDATE live_grid_health_state
        SET incident_id           = %s,
            incident_verification = 'VERIFIED',
            unverified_since      = NULL,
            updated_at            = %s
        WHERE node_id = %s
    """, (incident_id, now, node_id))


def save_incident_unverified(cur, node_id: str, now: datetime):
    cur.execute("""
        UPDATE live_grid_health_state
        SET incident_id           = 'UNKNOWN',
            incident_verification = 'UNVERIFIED',
            unverified_since      = %s,
            updated_at            = %s
        WHERE node_id = %s
    """, (now, now, node_id))


def lambda_handler(event, context):
    node_id = (event.get("pathParameters") or {}).get("node_id")
    force   = ((event.get("queryStringParameters") or {}).get("force", "false")).lower() == "true"

    if not node_id:
        return response(400, {"error": "node_id is required"})

    now = datetime.now(timezone.utc)

    try:
        conn = get_connection()
        cur  = conn.cursor()

        cur.execute("""
            SELECT g.status, m.lat, m.lng
            FROM live_grid_health_state g
            JOIN power_node_master m ON m.node_id = g.node_id
            WHERE g.node_id = %s
        """, (node_id,))
        row = cur.fetchone()

        if not row:
            cur.close(); conn.close()
            return response(404, {"error": f"Node {node_id} not found"})

        current_status, node_lat, node_lng = row
        node_lat = float(node_lat)
        node_lng = float(node_lng)

        if current_status != "OUTAGE_DETECTED" and not force:
            cur.close(); conn.close()
            return response(409, {
                "error": "Node is not in OUTAGE_DETECTED status",
                "node_id": node_id,
                "current_status": current_status,
                "hint": "Add ?force=true to override"
            })

        try:
            incidents = fetch_active_incidents()
        except RuntimeError:
            save_incident_unverified(cur, node_id, now)
            conn.commit()
            cur.close(); conn.close()
            return response(200, {
                "node_id":               node_id,
                "incident_check":        "UNVERIFIED",
                "incident_id":           "UNKNOWN",
                "incident_verification": "UNVERIFIED",
                "message":               "Incident Service unreachable, saved as UNKNOWN pending review",
                "checked_at":            now.isoformat()
            })

        matched = find_matching_incident(node_lng, node_lat, incidents)

        if matched:
            incident_id = matched["incident_id"]
            save_incident_verified(cur, node_id, incident_id, now)
            conn.commit()
            cur.close(); conn.close()
            return response(200, {
                "node_id":               node_id,
                "incident_check":        "DISASTER_CONFIRMED",
                "incident_id":           incident_id,
                "incident_verification": "VERIFIED",
                "disaster_type":         matched.get("disaster_type"),
                "level":                 matched.get("level"),
                "node_location":         {"lat": node_lat, "lng": node_lng},
                "checked_at":            now.isoformat()
            })

        cur.close(); conn.close()
        return response(200, {
            "node_id":        node_id,
            "incident_check": "NO_DISASTER",
            "message":        "No active disaster covers this node location",
            "node_location":  {"lat": node_lat, "lng": node_lng},
            "checked_at":     now.isoformat()
        })

    except psycopg2.OperationalError as e:
        return response(503, {"error": "Database connection failed", "detail": str(e)})
    except Exception as e:
        return response(500, {"error": "Internal server error", "detail": str(e)})
