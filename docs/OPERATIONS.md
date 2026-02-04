# File-Based Ingestion Operations Runbook

## Table of Contents

1. [Deployment](#deployment)
2. [Monitoring](#monitoring)
3. [Troubleshooting](#troubleshooting)
4. [Maintenance](#maintenance)
5. [Emergency Procedures](#emergency-procedures)

---

## Deployment

### Prerequisites

#### System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8 GB |
| Disk | 10 GB | 50 GB SSD |
| Network | 100 Mbps | 1 Gbps |
| OS | Ubuntu 20.04+ | Ubuntu 22.04 LTS |

#### Software Dependencies

```bash
# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install wgrib2 (required for GRIB2 parsing)
sudo apt-get install -y wgrib2

# Verify installations
node --version  # Should be v18+
npm --version
wgrib2 --version
```

#### AWS Configuration (Optional)

For public buckets, no AWS credentials are required. For private buckets:

```bash
# Install AWS CLI
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# Configure credentials
aws configure
# Enter your AWS Access Key ID and Secret Access Key
```

### Installation Steps

#### 1. Clone Repository

```bash
cd /opt
git clone <repository-url> polymarket-weather-bot
cd polymarket-weather-bot
```

#### 2. Install Dependencies

```bash
npm install
```

#### 3. Configure Environment

```bash
cp .env.example .env
nano .env
```

**Required Configuration**:

```bash
# =============================================================================
# FILE-BASED INGESTION CONFIGURATION
# =============================================================================

# Enable file-based ingestion (default: true)
ENABLE_FILE_BASED_INGESTION=true

# S3 poll interval in milliseconds (default: 150)
S3_POLL_INTERVAL_MS=150

# Detection window buffer in minutes (default: 5)
DETECTION_WINDOW_BUFFER_MINUTES=5

# API fallback max duration in minutes (default: 5)
API_FALLBACK_MAX_DURATION_MINUTES=5

# Forecast change thresholds
FORECAST_CHANGE_THRESHOLD_CELSIUS=0.5
FORECAST_CHANGE_THRESHOLD_WIND_KPH=2
FORECAST_CHANGE_THRESHOLD_PRECIP_MM=0.1
```

#### 4. Build Project

```bash
npm run build
```

#### 5. Run Tests

```bash
# Run file ingestion tests
npm run test:file-ingestion

# Run latency benchmark
npm run benchmark:latency

# Run all tests
npm test
```

#### 6. Start Services

Using PM2 (recommended for production):

```bash
# Install PM2
sudo npm install -g pm2

# Start with ecosystem config
pm2 start ecosystem.config.cjs

# Save PM2 config
pm2 save
pm2 startup
```

Or using npm:

```bash
npm start
```

### Verification Checklist

After deployment, verify the following:

```bash
# Checklist script
#!/bin/bash

echo "=== Deployment Verification ==="

# 1. Check Node.js version
echo -n "✓ Node.js version: "
node --version

# 2. Check wgrib2 installation
echo -n "✓ wgrib2 installed: "
which wgrib2 && echo "YES" || echo "NO"

# 3. Test S3 connectivity
echo -n "✓ S3 connectivity: "
curl -s -o /dev/null -w "%{http_code}" https://noaa-hrrr-pds.s3.amazonaws.com/
echo " (200 = OK)"

# 4. Check environment variables
echo "✓ Environment variables:"
grep -E "^(ENABLE_FILE_BASED_INGESTION|S3_POLL_INTERVAL)" .env

# 5. Verify build
echo -n "✓ Build exists: "
[ -d "dist" ] && echo "YES" || echo "NO"

# 6. Check PM2 status
echo "✓ PM2 status:"
pm2 status

echo "=== Verification Complete ==="
```

Expected output:
```
=== Deployment Verification ===
✓ Node.js version: v18.19.0
✓ wgrib2 installed: YES
✓ S3 connectivity: 200 (200 = OK)
✓ Environment variables:
ENABLE_FILE_BASED_INGESTION=true
S3_POLL_INTERVAL_MS=150
✓ Build exists: YES
✓ PM2 status:
┌────┬──────────────────┬────────┬─────────┬─────────┬────────┬──────────┐
│ id │ name             │ status │ cpu     │ mem     │ user   │ watching │
├────┼──────────────────┼────────┼─────────┼─────────┼────────┼──────────┤
│ 0  │ weather-bot      │ online │ 0%      │ 120mb   │ ubuntu │ disabled │
└────┴──────────────────┴────────┴─────────┴─────────┴────────┴──────────┘
=== Verification Complete ===
```

---

## Monitoring

### Key Metrics

#### Detection Metrics

| Metric | Description | Target | Alert Threshold |
|--------|-------------|--------|-----------------|
| `detection_latency_ms` | Time from window start to detection | <500ms | >1000ms |
| `detection_success_rate` | % of files detected successfully | >95% | <90% |
| `files_detected_total` | Total files detected | N/A | N/A |
| `files_missed_total` | Total files missed | 0 | >1 |

#### Download Metrics

| Metric | Description | Target | Alert Threshold |
|--------|-------------|--------|-----------------|
| `download_duration_ms` | Time to download file | <2000ms | >5000ms |
| `download_size_bytes` | Size of downloaded file | N/A | >100MB |
| `download_failures` | Failed downloads | 0 | >0 |

#### Parse Metrics

| Metric | Description | Target | Alert Threshold |
|--------|-------------|--------|-----------------|
| `parse_duration_ms` | Time to parse GRIB2 | <200ms | >500ms |
| `parse_failures` | Failed parses | 0 | >0 |
| `cities_extracted` | Cities successfully parsed | 13 | <10 |

#### End-to-End Metrics

| Metric | Description | Target | Alert Threshold |
|--------|-------------|--------|-----------------|
| `e2e_latency_ms` | Total latency (detect to signal) | <3000ms | >5000ms |
| `forecast_changes` | Changes detected per hour | N/A | N/A |
| `api_fallback_activations` | Times API fallback activated | <5/day | >10/day |

### Log Analysis

#### Log Locations

```bash
# Application logs
/var/log/weather-bot/app.log

# Error logs
/var/log/weather-bot/error.log

# PM2 logs
~/.pm2/logs/weather-bot-out.log
~/.pm2/logs/weather-bot-error.log
```

#### Key Log Patterns

```bash
# Search for detection events
grep "FILE_DETECTED" /var/log/weather-bot/app.log

# Search for errors
grep -E "ERROR|WARN" /var/log/weather-bot/error.log

# Monitor latency
grep "detectionLatencyMs" /var/log/weather-bot/app.log | tail -20

# Check API fallback activations
grep "API_FALLBACK_ACTIVATED" /var/log/weather-bot/app.log

# Real-time monitoring
tail -f /var/log/weather-bot/app.log | grep -E "FileBasedIngestion|S3FileDetector|GRIB2Parser"
```

#### Log Format

```json
{
  "timestamp": "2026-02-01T12:00:00.000Z",
  "level": "info",
  "component": "S3FileDetector",
  "message": "File detected",
  "model": "HRRR",
  "cycleHour": 12,
  "detectionLatencyMs": 450,
  "fileSize": 15728640
}
```

### Alert Conditions

#### Critical Alerts (Page Immediately)

| Condition | Query | Threshold |
|-----------|-------|-----------|
| File detection failure | `files_missed_total > 0` | >0 in 1 hour |
| High end-to-end latency | `e2e_latency_ms > 5000` | >5 seconds |
| GRIB2 parse failures | `parse_failures > 0` | >0 in 1 hour |
| S3 connectivity loss | `s3_errors > 10` | >10 in 5 minutes |

#### Warning Alerts (Notify Team)

| Condition | Query | Threshold |
|-----------|-------|-----------|
| Detection latency high | `detection_latency_ms > 1000` | >1 second |
| Download slow | `download_duration_ms > 3000` | >3 seconds |
| API fallback frequent | `api_fallback_activations > 5` | >5 in 1 day |
| Cities missing | `cities_extracted < 10` | <10 cities |

#### Alert Rules (Prometheus)

```yaml
# Critical alerts
groups:
  - name: file_ingestion_critical
    rules:
      - alert: FileDetectionFailure
        expr: increase(files_missed_total[1h]) > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "File detection failure detected"
          
      - alert: HighEndToEndLatency
        expr: e2e_latency_ms > 5000
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "End-to-end latency exceeds 5 seconds"

  - name: file_ingestion_warning
    rules:
      - alert: HighDetectionLatency
        expr: detection_latency_ms > 1000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Detection latency is high"
          
      - alert: FrequentAPIFallback
        expr: increase(api_fallback_activations[1d]) > 5
        labels:
          severity: warning
        annotations:
          summary: "API fallback activating frequently"
```

### Dashboards

#### Grafana Dashboard

```json
{
  "dashboard": {
    "title": "File-Based Ingestion",
    "panels": [
      {
        "title": "Detection Latency",
        "targets": [
          {
            "expr": "detection_latency_ms",
            "legendFormat": "{{model}} {{cycleHour}}Z"
          }
        ]
      },
      {
        "title": "End-to-End Latency",
        "targets": [
          {
            "expr": "e2e_latency_ms",
            "legendFormat": "Total Latency"
          }
        ]
      },
      {
        "title": "Files Detected",
        "targets": [
          {
            "expr": "increase(files_detected_total[1h])",
            "legendFormat": "{{model}}"
          }
        ]
      }
    ]
  }
}
```

---

## Troubleshooting

### S3 Connectivity Issues

#### Symptoms
- All detections failing
- "S3 HeadObject timeout" errors
- No FILE_DETECTED events

#### Diagnostic Steps

```bash
# 1. Test basic connectivity
ping s3.us-east-1.amazonaws.com

# 2. Test S3 bucket access
curl -I https://noaa-hrrr-pds.s3.amazonaws.com/
# Expected: HTTP/1.1 200 OK

# 3. Test specific file
curl -I https://noaa-hrrr-pds.s3.amazonaws.com/hrrr.20260201/conus/hrrr.t00z.wrfsfcf00.grib2
# Expected: HTTP/1.1 200 OK or 404 Not Found

# 4. Check DNS resolution
nslookup noaa-hrrr-pds.s3.amazonaws.com

# 5. Check AWS SDK can connect
node -e "
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const client = new S3Client({ region: 'us-east-1' });
client.send(new HeadObjectCommand({
  Bucket: 'noaa-hrrr-pds',
  Key: 'hrrr.20260201/conus/hrrr.t00z.wrfsfcf00.grib2'
})).then(() => console.log('OK')).catch(e => console.log('Error:', e.message));
"
```

#### Solutions

| Issue | Solution |
|-------|----------|
| Network timeout | Check firewall rules for port 443 |
| DNS failure | Use Google DNS (8.8.8.8) or Cloudflare (1.1.1.1) |
| SSL error | Update CA certificates: `sudo update-ca-certificates` |
| Rate limiting | Increase poll interval temporarily |

### GRIB2 Parsing Failures

#### Symptoms
- FILE_DETECTED but no FILE_CONFIRMED
- "GRIB2 parse error" in logs
- wgrib2 errors

#### Diagnostic Steps

```bash
# 1. Check wgrib2 installation
wgrib2 --version

# 2. Test with sample file
wget https://noaa-hrrr-pds.s3.amazonaws.com/hrrr.20260201/conus/hrrr.t00z.wrfsfcf00.grib2 -O test.grib2
wgrib2 test.grib2 -v

# 3. Check file integrity
ls -lh test.grib2
file test.grib2

# 4. List GRIB variables
wgrib2 test.grib2

# 5. Extract specific location
wgrib2 test.grib2 -match ":TMP:2 m above ground:" -lon -74.006 40.7128
```

#### Solutions

| Issue | Solution |
|-------|----------|
| wgrib2 not found | Install: `sudo apt-get install wgrib2` |
| Corrupt file | Check network, increase download timeout |
| Missing variables | Some cycles have incomplete data (normal) |
| Permission denied | Check temp directory permissions |

### High Latency Scenarios

#### Symptoms
- Detection latency >1 second
- End-to-end latency >5 seconds
- Slow market response

#### Diagnostic Steps

```bash
# 1. Run latency benchmark
npm run benchmark:latency

# 2. Check network latency to S3
ping -c 10 s3.us-east-1.amazonaws.com

# 3. Check system resources
htop
iostat -x 1

# 4. Check for network congestion
iftop

# 5. Profile the application
node --prof dist/index.js
```

#### Common Causes & Solutions

| Cause | Detection | Solution |
|-------|-----------|----------|
| Network latency | High ping to S3 | Move server to us-east-1 |
| High CPU | CPU usage >80% | Upgrade instance or reduce polling |
| Memory pressure | Swap usage | Increase RAM or restart service |
| Poll interval too high | S3_POLL_INTERVAL_MS >200 | Reduce to 150ms |
| Cold start | First detection slow | Pre-warm AWS SDK |

### API Fallback Activation

#### Symptoms
- "API_FALLBACK_ACTIVATED" in logs
- No FILE_CONFIRMED events
- API_DATA_RECEIVED with LOW confidence

#### Diagnostic Steps

```bash
# 1. Check if file actually exists
curl -I https://noaa-hrrr-pds.s3.amazonaws.com/hrrr.20260201/conus/hrrr.t12z.wrfsfcf00.grib2

# 2. Check NOAA status
curl https://status.noaa.gov/api/v2/status.json

# 3. Check detection window timing
grep "detectionWindow" /var/log/weather-bot/app.log

# 4. Verify model schedule
grep "expectedPublishTime" /var/log/weather-bot/app.log
```

#### Solutions

| Cause | Solution |
|-------|----------|
| File delayed | Wait (API fallback handles this) |
| Wrong expected time | Check UTC timezone, adjust buffer |
| S3 path wrong | Verify path template in code |
| NOAA outage | Monitor status.noaa.gov |

### Decision Trees

#### File Not Detected

```
File not detected?
    │
    ▼
┌─────────────────────────────┐
│ Check detection window logs │
└──────────────┬──────────────┘
               │
     ┌─────────┴─────────┐
     ▼                   ▼
 Window open?       Window closed?
     │                   │
     ▼                   ▼
 Check S3           Check model
 connectivity       schedule
     │                   │
     ▼                   ▼
 Can access         Time correct?
 noaa-hrrr-pds?          │
     │              ┌────┴────┐
     │              ▼         ▼
     │             Yes        No
     │              │         │
     │              ▼         ▼
     │         Check path   Fix UTC
     │         template     timezone
     │              │
     └──────────────┘
                    │
                    ▼
             Check NOAA
             status page
                    │
                    ▼
             File delayed?
          ┌─────────┴─────────┐
          ▼                   ▼
         Yes                  No
          │                   │
          ▼                   ▼
     Wait for file       Contact support
     (API fallback       (possible bug)
      active)
```

#### High Latency

```
High latency detected?
    │
    ▼
┌──────────────────────────────┐
│ Run: npm run benchmark:latency│
└──────────────┬───────────────┘
               │
               ▼
    ┌──────────────────────┐
    │ Which component?     │
    └──────┬───────┬───────┘
           │       │       │
           ▼       ▼       ▼
      Detection  Download  Parse
           │       │       │
           ▼       ▼       ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ Check    │ │ Check    │ │ Check    │
    │ network  │ │ file     │ │ wgrib2   │
    │ latency  │ │ size     │ │ CPU      │
    └────┬─────┘ └────┬─────┘ └────┬─────┘
         │            │            │
         ▼            ▼            ▼
    High ping?   Large file?   High CPU?
         │            │            │
    ┌────┴────┐  ┌────┴────┐  ┌────┴────┐
    ▼         ▼  ▼         ▼  ▼         ▼
   Yes        No Yes        No Yes        No
    │          │  │          │  │          │
    ▼          ▼  ▼          ▼  ▼          ▼
 Move to   Check  Wait    Check Upgrade  Check
 us-east-1  poll  for      temp   CPU    parsing
            rate  smaller  disk          settings
                  cycle
```

---

## Maintenance

### Regular Health Checks

#### Daily Checks

```bash
#!/bin/bash
# daily-health-check.sh

echo "=== Daily Health Check ==="
echo "Date: $(date)"

# 1. Check service status
echo -n "✓ Service status: "
pm2 status | grep -q "online" && echo "ONLINE" || echo "OFFLINE"

# 2. Check recent detections
echo "✓ Recent detections (last 24h):"
grep "FILE_DETECTED" /var/log/weather-bot/app.log | wc -l
echo "  files detected"

# 3. Check for errors
echo "✓ Errors in last 24h:"
grep -c "ERROR" /var/log/weather-bot/error.log || echo "0"

# 4. Check latency
echo "✓ Average latency (last 10):"
grep "detectionLatencyMs" /var/log/weather-bot/app.log | tail -10 | awk -F':' '{sum+=$2} END {print sum/NR " ms"}'

# 5. Check disk space
echo "✓ Disk usage:"
df -h / | tail -1 | awk '{print $5 " used"}'

# 6. Check memory
echo "✓ Memory usage:"
free -h | grep Mem | awk '{print $3 "/" $2}'

echo "=== Health Check Complete ==="
```

#### Weekly Checks

```bash
#!/bin/bash
# weekly-health-check.sh

echo "=== Weekly Health Check ==="

# 1. Review detection success rate
echo "Detection success rate:"
detected=$(grep -c "FILE_DETECTED" /var/log/weather-bot/app.log)
missed=$(grep -c "FILE_MISSED" /var/log/weather-bot/app.log)
total=$((detected + missed))
rate=$(echo "scale=2; $detected / $total * 100" | bc)
echo "  $detected detected, $missed missed ($rate%)"

# 2. Review API fallback usage
echo "API fallback activations:"
grep -c "API_FALLBACK_ACTIVATED" /var/log/weather-bot/app.log

# 3. Check for memory leaks
echo "Memory trend:"
for day in {1..7}; do
  date=$(date -d "$day days ago" +%Y-%m-%d)
  grep "$date" /var/log/weather-bot/app.log | grep -c "Memory usage"
done

# 4. Update packages
echo "Checking for updates..."
npm outdated

echo "=== Weekly Health Check Complete ==="
```

### Cache Management

#### Temp File Cleanup

```bash
#!/bin/bash
# cleanup-temp.sh

# Clean up old GRIB2 temp files
echo "Cleaning up temp files..."
find /tmp -name "grib_*.grib2" -mtime +1 -delete
find /tmp -name "wgrib2_*" -mtime +1 -delete

# Clean up old logs
echo "Rotating logs..."
logrotate -f /etc/logrotate.d/weather-bot

echo "Cleanup complete"
```

#### Log Rotation

```bash
# /etc/logrotate.d/weather-bot
/var/log/weather-bot/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0644 ubuntu ubuntu
    sharedscripts
    postrotate
        pm2 reload weather-bot
    endscript
}
```

### Updating City Configurations

#### Adding a New City

1. **Update city configuration** in [`src/weather/types.ts`](../src/weather/types.ts):

```typescript
export const KNOWN_CITIES: CityLocation[] = [
  // ... existing cities
  {
    name: 'New City',
    aliases: ['NC'],
    coordinates: { lat: 40.1234, lon: -74.5678 },
    timezone: 'America/New_York',
    country: 'US',
  },
];
```

2. **Update city-to-model mapping**:

```typescript
export const CITY_MODEL_CONFIGS: CityModelConfig[] = [
  // ... existing cities
  { cityName: 'New City', primaryModel: 'HRRR', fallbackModels: ['RAP', 'GFS'] },
];
```

3. **Test the configuration**:

```bash
npm run test:file-ingestion
```

4. **Deploy**:

```bash
npm run build
pm2 restart weather-bot
```

#### Updating Model Priorities

```typescript
// In src/weather/types.ts
export const CITY_MODEL_CONFIGS: CityModelConfig[] = [
  // Change from HRRR primary to RAP primary
  { cityName: 'Chicago', primaryModel: 'RAP', fallbackModels: ['HRRR', 'GFS'] },
];
```

### Backup and Recovery

#### Configuration Backup

```bash
#!/bin/bash
# backup-config.sh

BACKUP_DIR="/backup/weather-bot/$(date +%Y%m%d)"
mkdir -p $BACKUP_DIR

# Backup environment
cp .env $BACKUP_DIR/

# Backup PM2 config
cp ecosystem.config.cjs $BACKUP_DIR/

# Backup logs (last 7 days)
tar czf $BACKUP_DIR/logs.tar.gz /var/log/weather-bot/*.log.1 /var/log/weather-bot/*.log.2

# Upload to S3 (optional)
aws s3 sync $BACKUP_DIR s3://your-backup-bucket/weather-bot/$(date +%Y%m%d)/

echo "Backup complete: $BACKUP_DIR"
```

#### Recovery Procedure

```bash
#!/bin/bash
# recovery.sh

BACKUP_DATE=$1
BACKUP_DIR="/backup/weather-bot/$BACKUP_DATE"

# Stop service
pm2 stop weather-bot

# Restore configuration
cp $BACKUP_DIR/.env .
cp $BACKUP_DIR/ecosystem.config.cjs .

# Rebuild
npm run build

# Start service
pm2 start ecosystem.config.cjs

# Verify
pm2 status
tail -f /var/log/weather-bot/app.log | grep "FileBasedIngestion"
```

---

## Emergency Procedures

### System Down

#### Immediate Response (0-5 minutes)

1. **Check service status**:
   ```bash
   pm2 status
   pm2 logs weather-bot --lines 50
   ```

2. **Check system resources**:
   ```bash
   df -h
   free -h
   uptime
   ```

3. **Restart service**:
   ```bash
   pm2 restart weather-bot
   ```

#### Short-term Response (5-30 minutes)

1. **Check for errors**:
   ```bash
   grep -E "ERROR|FATAL" /var/log/weather-bot/error.log | tail -50
   ```

2. **Check S3 connectivity**:
   ```bash
   curl -I https://noaa-hrrr-pds.s3.amazonaws.com/
   ```

3. **Check NOAA status**:
   ```bash
   curl https://status.noaa.gov/api/v2/status.json
   ```

#### Long-term Response (30+ minutes)

1. **Enable debug logging**:
   ```bash
   echo "LOG_LEVEL=debug" >> .env
   pm2 restart weather-bot
   ```

2. **Contact NOAA** if issue is upstream:
   - https://www.weather.gov/contact
   - ncep.list.nomads-ftp@noaa.gov

### Data Corruption

#### Symptoms
- Incorrect forecast values
- Impossible temperatures (e.g., 500°F)
- Missing cities in output

#### Response

1. **Stop processing**:
   ```bash
   pm2 stop weather-bot
   ```

2. **Clear cache**:
   ```bash
   rm -rf /tmp/grib_*.grib2
   rm -rf /tmp/wgrib2_*
   ```

3. **Verify wgrib2**:
   ```bash
   wgrib2 --version
   ```

4. **Restart**:
   ```bash
   pm2 start weather-bot
   ```

### Security Incident

#### S3 Credentials Compromised

1. **Rotate AWS credentials**:
   ```bash
   aws iam create-access-key --user-name weather-bot
   # Update .env with new credentials
   ```

2. **Revoke old credentials**:
   ```bash
   aws iam delete-access-key --access-key-id OLD_KEY_ID --user-name weather-bot
   ```

3. **Restart service**:
   ```bash
   pm2 restart weather-bot
   ```

#### DDoS / Rate Limiting

1. **Check request rates**:
   ```bash
   grep "S3FileDetector" /var/log/weather-bot/app.log | wc -l
   ```

2. **Increase poll interval temporarily**:
   ```bash
   echo "S3_POLL_INTERVAL_MS=500" >> .env
   pm2 restart weather-bot
   ```

3. **Contact AWS if needed**:
   - https://aws.amazon.com/contact-us/

---

## Runbook Quick Reference

### Commands

```bash
# Status
pm2 status
pm2 logs weather-bot --lines 100
pm2 monit

# Start/Stop/Restart
pm2 start ecosystem.config.cjs
pm2 stop weather-bot
pm2 restart weather-bot
pm2 reload weather-bot

# Testing
npm run test:file-ingestion
npm run benchmark:latency
npm test

# Debugging
tail -f /var/log/weather-bot/app.log
grep "ERROR" /var/log/weather-bot/error.log
node --prof dist/index.js

# Maintenance
npm run build
npm audit fix
npm update
```

### Key Files

| File | Purpose |
|------|---------|
| `.env` | Environment configuration |
| `ecosystem.config.cjs` | PM2 configuration |
| `/var/log/weather-bot/app.log` | Application logs |
| `/var/log/weather-bot/error.log` | Error logs |
| `src/config.ts` | Code configuration |
| `src/weather/file-based-ingestion.ts` | Main controller |

### Emergency Contacts

| Role | Contact |
|------|---------|
| NOAA NCEP | ncep.list.nomads-ftp@noaa.gov |
| AWS Support | https://aws.amazon.com/contact-us/ |
| System Admin | [Your contact] |
| On-Call Engineer | [Your contact] |

---

## Appendix

### A. Full Environment Configuration

```bash
# =============================================================================
# POLYMARKET CONFIGURATION
# =============================================================================
POLYMARKET_PRIVATE_KEY=your_private_key_here
POLYMARKET_API_KEY=
POLYMARKET_SECRET=
POLYMARKET_PASSPHRASE=
POLYGON_RPC_URL=https://polygon-rpc.com
USDC_CONTRACT_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174

# =============================================================================
# WEATHER API CONFIGURATION
# =============================================================================
OPENWEATHER_API_KEY=
TOMORROW_API_KEY=
WEATHERAPI_KEY=
WEATHERBIT_API_KEY=
VISUALCROSSING_API_KEY=
METEOSOURCE_API_KEY=

# =============================================================================
# BOT CONFIGURATION
# =============================================================================
SIMULATION_MODE=true
MAX_POSITION_SIZE=10
MIN_EDGE_THRESHOLD=0.10
POLL_INTERVAL_MS=300000
FORECAST_POLL_INTERVAL_MS=30000

# =============================================================================
# FILE-BASED INGESTION CONFIGURATION
# =============================================================================
ENABLE_FILE_BASED_INGESTION=true
S3_POLL_INTERVAL_MS=150
DETECTION_WINDOW_BUFFER_MINUTES=5
API_FALLBACK_MAX_DURATION_MINUTES=5
FORECAST_CHANGE_THRESHOLD_CELSIUS=0.5
FORECAST_CHANGE_THRESHOLD_WIND_KPH=2
FORECAST_CHANGE_THRESHOLD_PRECIP_MM=0.1

# =============================================================================
# WEBHOOK CONFIGURATION
# =============================================================================
TOMORROW_WEBHOOK_SECRET=your_webhook_secret_here
USE_WEBHOOK_MODE=true
FETCH_MODE_TIMEOUT_MINUTES=10
NO_CHANGE_EXIT_MINUTES=5
PROVIDER_POLL_INTERVAL_MS=5000
IDLE_POLL_INTERVAL_MINUTES=5

# =============================================================================
# LOGGING
# =============================================================================
LOG_LEVEL=info

# =============================================================================
# WEB SERVER
# =============================================================================
PORT=8188
```

### B. Log Format Reference

```json
{
  "timestamp": "2026-02-01T12:00:00.000Z",
  "level": "info|warn|error|debug",
  "component": "FileBasedIngestion|ScheduleManager|S3FileDetector|GRIB2Parser|ApiFallbackPoller|ForecastChangeDetector",
  "message": "Human-readable message",
  "context": {
    "model": "HRRR|RAP|GFS",
    "cycleHour": 12,
    "cityName": "New York City",
    "latencyMs": 450,
    "fileSize": 15728640
  }
}
```

### C. Metric Names Reference

| Metric | Type | Labels |
|--------|------|--------|
| `file_ingestion_detections_total` | Counter | model, cycle_hour |
| `file_ingestion_detection_latency_ms` | Histogram | model |
| `file_ingestion_download_duration_ms` | Histogram | model |
| `file_ingestion_parse_duration_ms` | Histogram | model |
| `file_ingestion_e2e_latency_ms` | Histogram | model |
| `file_ingestion_failures_total` | Counter | model, reason |
| `file_ingestion_api_fallback_activations` | Counter | model |
