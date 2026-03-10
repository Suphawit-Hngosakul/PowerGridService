# PowerGrid Service

ระบบจัดการการดับไฟฟ้าสำหรับพื้นที่ประสบภัยพิบัติ รันบน AWS Lambda + API Gateway + RDS PostgreSQL

## โครงสร้างโปรเจกต์

```
PowerGridService/
├── setup.sh                  ← สคริปต์ตั้งค่าทั้งหมดในคำสั่งเดียว
├── main/
│   ├── infra/                ← Terraform (OpenTofu)
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   └── layers/
│   │       └── psycopg2.zip  ← Lambda Layer (ต้องเตรียมไว้)
│   ├── lambda/
│   │   ├── fn1_detect_outage.py      ← ตรวจจับ node ดับ
│   │   ├── fn2_get_outage_nodes.py   ← ดึงรายการ node ที่ดับ
│   │   └── fn3_check_incident.py     ← ตรวจสอบภัยพิบัติจาก Incident Service
│   └── sql/
│       └── schema.sql        ← DDL + ข้อมูล demo
└── Flowchart.mmd             ← แผนภาพการทำงาน
```

## ข้อกำหนดเบื้องต้น

- [AWS Cloud9](https://aws.amazon.com/cloud9/) พร้อม IAM Role ที่มีสิทธิ์สร้าง Lambda, API Gateway, RDS
- [OpenTofu](https://opentofu.org/) (`tofu`) ติดตั้งแล้ว
- `psycopg2` Lambda Layer zip วางไว้ที่ `main/infra/layers/psycopg2.zip`

## วิธีติดตั้ง (Cloud9)

```bash
# 1. Clone โปรเจกต์
git clone <repo-url> ~/environment/PowerGridService
cd ~/environment/PowerGridService

# 2. รัน setup script ในคำสั่งเดียว
chmod +x setup.sh
./setup.sh <db_password> <incident_service_url>
```

**ตัวอย่าง:**
```bash
./setup.sh Postgres123 https://xxxx.execute-api.us-east-1.amazonaws.com/prod
```

> `incident_service_url` คือ base URL ของ Incident Service ภายนอก  
> ถ้ายังไม่มีให้ใส่ placeholder ก่อนได้: `https://placeholder.example.com`

สคริปต์จะดำเนินการ **4 ขั้นตอน** โดยอัตโนมัติ:
1. `tofu init` + `tofu apply` — สร้าง RDS, Lambda, API Gateway
2. ติดตั้ง PostgreSQL client (`psql`) ถ้ายังไม่มี
3. `psql` รัน `schema.sql` ใส่ตาราง + ข้อมูล demo
4. แสดง endpoint ที่พร้อมใช้งาน

## API Endpoints

| Method | Path | Lambda | คำอธิบาย |
|--------|------|--------|-----------|
| `POST` | `/nodes/{node_id}/heartbeat` | fn1 | อัปเดต heartbeat / ตรวจจับ outage |
| `GET` | `/nodes` | fn2 | ดึงรายการ node (กรองตาม status, priority) |
| `POST` | `/nodes/{node_id}/check-incident` | fn3 | ตรวจสอบว่า outage เกิดจากภัยพิบัติไหม |

## ถอนการติดตั้ง

```bash
cd main/infra
tofu destroy -var="db_password=<password>" -var="incident_service_url=<url>"
```
