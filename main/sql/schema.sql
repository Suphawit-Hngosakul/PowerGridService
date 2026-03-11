CREATE TABLE IF NOT EXISTS power_node_master (
    node_id         VARCHAR(20) PRIMARY KEY,
    place_name      VARCHAR(255) NOT NULL,
    lat             DECIMAL(9,6) NOT NULL,
    lng             DECIMAL(9,6) NOT NULL,
    place_type      VARCHAR(50) NOT NULL CHECK (place_type IN ('HOSPITAL', 'SHELTER', 'GENERAL')),
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_grid_health_state (
    node_id               VARCHAR(20) PRIMARY KEY REFERENCES power_node_master(node_id),
    status                VARCHAR(30) NOT NULL DEFAULT 'NORMAL'
                              CHECK (status IN ('NORMAL', 'OUTAGE_DETECTED', 'DISPATCHED', 'UNDER_MAINTENANCE')),
    priority_level        INTEGER,
    last_heartbeat        TIMESTAMP,
    incident_id           VARCHAR(50) DEFAULT NULL,
    incident_verification VARCHAR(20) DEFAULT 'VERIFIED'
                              CHECK (incident_verification IN ('VERIFIED', 'UNVERIFIED', 'ORPHANED')),
    unverified_since      TIMESTAMP DEFAULT NULL,
    updated_at            TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispatch_intelligence_records (
    record_id        VARCHAR(60) PRIMARY KEY,
    node_id          VARCHAR(20) NOT NULL REFERENCES power_node_master(node_id),
    driver_id        VARCHAR(20),
    staff_id         VARCHAR(20),
    action_type      VARCHAR(20) NOT NULL CHECK (action_type IN ('DISPATCHED', 'UNDER_MAINTENANCE', 'RESOLVED')),
    dispatch_status  VARCHAR(20) NOT NULL CHECK (dispatch_status IN ('WAITING', 'ASSIGNED', 'RESOLVED')),
    action_timestamp TIMESTAMP NOT NULL,
    notes            TEXT,
    created_at       TIMESTAMP DEFAULT NOW()
);

-- ข้อมูล demo
INSERT INTO power_node_master (node_id, place_name, lat, lng, place_type) VALUES
    ('PN-HY-001', 'โรงพยาบาลหาดใหญ่',        7.0156, 100.4714, 'HOSPITAL'),
    ('PN-HY-002', 'ศูนย์พักพิงวัดโคกสมานคุณ', 7.0089, 100.4750, 'SHELTER'),
    ('PN-HY-003', 'ตลาดสดหาดใหญ่',            7.0201, 100.4689, 'GENERAL')
ON CONFLICT DO NOTHING;

INSERT INTO live_grid_health_state (node_id, status, last_heartbeat) VALUES
    ('PN-HY-001', 'NORMAL', NOW()),
    ('PN-HY-002', 'NORMAL', NOW()),
    ('PN-HY-003', 'NORMAL', NOW())
ON CONFLICT DO NOTHING;