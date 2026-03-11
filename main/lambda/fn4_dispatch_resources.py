import json
import os
import urllib.request
import urllib.error
import psycopg2
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

DB_HOST     = os.environ["DB_HOST"]
DB_PORT     = os.environ.get("DB_PORT", "5432")
DB_NAME     = os.environ["DB_NAME"]
DB_USER     = os.environ["DB_USER"]
DB_PASSWORD = os.environ["DB_PASSWORD"]

DRIVER_SERVICE_URL = os.environ["DRIVER_SERVICE_URL"]
STAFF_SERVICE_URL  = os.environ["STAFF_SERVICE_URL"]
SERVICE_TIMEOUT    = int(os.environ.get("SERVICE_TIMEOUT_SEC", "5"))


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
        user=DB_USER, password=DB_PASSWORD, connect_timeout=5
    )


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str, ensure_ascii=False)
    }


# ── External Service Calls (async via ThreadPoolExecutor) ────────────────────

def call_driver_service(node_id: str) -> dict:
    """POST /drivers/dispatch — ขอ driver มารับงาน"""
    url = f"{DRIVER_SERVICE_URL.rstrip('/')}/drivers/dispatch"
    payload = json.dumps({"node_id": node_id}).encode()
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")

    with urllib.request.urlopen(req, timeout=SERVICE_TIMEOUT) as resp:
        return json.loads(resp.read().decode())


def call_staff_service(node_id: str) -> dict:
    """POST /staff/dispatch — ขอช่างเทคนิคมาซ่อม"""
    url = f"{STAFF_SERVICE_URL.rstrip('/')}/staff/dispatch"
    payload = json.dumps({"node_id": node_id}).encode()
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")

    with urllib.request.urlopen(req, timeout=SERVICE_TIMEOUT) as resp:
        return json.loads(resp.read().decode())


# ── Main Handler ─────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    node_id = (event.get("pathParameters") or {}).get("node_id")
    if not node_id:
        return response(400, {"error": "node_id is required"})

    now = datetime.now(timezone.utc)

    try:
        conn = get_connection()
        cur  = conn.cursor()

        # ── ตรวจสอบสถานะ node ─────────────────────────────────────────────
        cur.execute("""
            SELECT g.status, g.incident_id
            FROM live_grid_health_state g
            WHERE g.node_id = %s
        """, (node_id,))
        row = cur.fetchone()

        if not row:
            cur.close(); conn.close()
            return response(404, {"error": f"Node {node_id} not found"})

        current_status, incident_id = row

        if current_status != "OUTAGE_DETECTED":
            cur.close(); conn.close()
            return response(409, {
                "error": "Node is not in OUTAGE_DETECTED status",
                "node_id": node_id,
                "current_status": current_status,
                "hint": "Node must be OUTAGE_DETECTED before dispatching"
            })

        # ── เรียก Driver + Staff พร้อมกัน (Async) ─────────────────────────
        driver_result = None
        staff_result  = None
        errors = []

        with ThreadPoolExecutor(max_workers=2) as executor:
            future_driver = executor.submit(call_driver_service, node_id)
            future_staff  = executor.submit(call_staff_service, node_id)

            for future in as_completed([future_driver, future_staff]):
                try:
                    result = future.result()
                    if future == future_driver:
                        driver_result = result
                    else:
                        staff_result = result
                except Exception as e:
                    errors.append(str(e))

        if errors:
            cur.close(); conn.close()
            return response(502, {
                "error": "Failed to contact external services",
                "details": errors,
                "node_id": node_id
            })

        # ── อัปเดตสถานะ → DISPATCHED ──────────────────────────────────────
        driver_id = driver_result.get("driver_id", "UNKNOWN")
        staff_id  = staff_result.get("staff_id", "UNKNOWN")
        record_id = f"DSP-{node_id}-{now.strftime('%Y%m%dT%H%M%SZ')}"

        cur.execute("""
            UPDATE live_grid_health_state
            SET status = 'DISPATCHED', updated_at = %s
            WHERE node_id = %s
        """, (now, node_id))

        cur.execute("""
            INSERT INTO dispatch_intelligence_records
                (record_id, node_id, driver_id, staff_id, action_type,
                 dispatch_status, action_timestamp, notes)
            VALUES (%s, %s, %s, %s, 'DISPATCHED', 'ASSIGNED', %s, %s)
        """, (
            record_id, node_id, driver_id, staff_id, now,
            f"Driver: {driver_result.get('name','')}, Staff: {staff_result.get('name','')}"
        ))

        conn.commit()
        cur.close(); conn.close()

        return response(200, {
            "node_id":       node_id,
            "status":        "DISPATCHED",
            "record_id":     record_id,
            "driver": {
                "driver_id":   driver_id,
                "name":        driver_result.get("name"),
                "status":      driver_result.get("status"),
                "eta_minutes": driver_result.get("eta_minutes")
            },
            "staff": {
                "staff_id":    staff_id,
                "name":        staff_result.get("name"),
                "status":      staff_result.get("status"),
                "eta_minutes": staff_result.get("eta_minutes")
            },
            "incident_id":   incident_id,
            "dispatched_at": now.isoformat()
        })

    except psycopg2.OperationalError as e:
        return response(503, {"error": "Database connection failed", "detail": str(e)})
    except Exception as e:
        return response(500, {"error": "Internal server error", "detail": str(e)})
