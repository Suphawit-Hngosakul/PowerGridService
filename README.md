# PowerGrid Service

ระบบจัดการการดับไฟฟ้าสำหรับพื้นที่ประสบภัยพิบัติ รันบน AWS Lambda + API Gateway + RDS PostgreSQL

## โครงสร้างโปรเจกต์

```
PowerGridService/
├── setup.sh                  
├── main/
│   ├── infra/               
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   └── layers/
│   │       └── psycopg2.zip  
│   ├── lambda/
│   │   ├── fn1_detect_outage.py      ตรวจจับ node ดับ
│   │   ├── fn2_get_outage_nodes.py   ดึงรายการ node ที่ดับ
│   │   ├── fn3_check_incident.py     ตรวจสอบภัยพิบัติจาก Incident Service
│   │   ├── fn4_dispatch_resources.py สั่งงาน Driver + Staff (async)
│   │   └── demo_reset_node.py        reset node สำหรับ demo
│   └── sql/
│       └── schema.sql       
└── Flowchart.mmd             
```


## วิธีติดตั้ง

```bash
# 1. Clone โปรเจกต์
git clone <repo-url> 
cd ~/environment/PowerGridService

# 2. รัน setup script 
chmod +x setup.sh
./setup.sh <db_password> <stub_service_url>
```

## API Endpoints

| Method | Path | Lambda | คำอธิบาย |
|--------|------|--------|-----------| 
| `POST` | `/nodes/{node_id}/heartbeat` | fn1 | อัปเดต heartbeat / ตรวจจับ outage |
| `GET` | `/nodes` | fn2 | ดึงรายการ node (กรองตาม status, priority) |
| `POST` | `/nodes/{node_id}/check-incident` | fn3 | ตรวจสอบว่า outage เกิดจากภัยพิบัติไหม |
| `POST` | `/nodes/{node_id}/dispatch` | fn4 | สั่งงาน Driver + Staff พร้อมกัน (async) |
| `POST` | `/nodes/{node_id}/reset` | demo | reset node กลับเป็น NORMAL (สำหรับ demo) |


