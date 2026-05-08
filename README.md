# PowerGrid Service — Deploy บน AWS Cloud9

```bash
cd  ~/environment
git  clone  https://github.com/Suphawit-Hngosakul/PowerGridService.git
cd  PowerGridService
```

```bash
cp  infra/terraform.tfvars.example  infra/terraform.tfvars
```

```bash
aws  ec2  describe-subnets  \
--filters "Name=default-for-az,Values=true" \
--query  'Subnets[].SubnetId'  --output  text 

aws  ec2  describe-security-groups  \
--filters "Name=group-name,Values=default" \
--query  'SecurityGroups[].GroupId'  --output  text
```

---

## Deploy 

```bash
chmod  +x  scripts/*.sh
npm  install
./scripts/deploy.sh
```
---
## Re-deploy

แก้ Lambda code อย่างเดียว:

```bash
npm  run  build && (cd  infra && tofu  apply  -auto-approve)
```

แก้แค่ web:

```bash
./scripts/deploy-web.sh
```