# File-Based Ingestion Test Suite

Comprehensive test suite for the NOAA model file-based ingestion system.

## Overview

This test suite validates the file-based ingestion system that monitors NOAA S3 buckets for GRIB2 weather model files. The system is designed to detect, download, and parse weather data with end-to-end latency under 5 seconds.

## Test Files

### 1. `file-based-ingestion.test.ts`
Main unit test suite covering all components:

#### ScheduleManager Tests
- **Filename Generation**: Validates HRRR, RAP, and GFS filename patterns
- **Detection Window Calculation**: Ensures windows start before expected publication
- **City-to-Model Mapping**: Verifies 13 cities are correctly assigned to primary models
- **Cycle Hour Calculations**: Tests all 24 hours for HRRR/RAP, 6-hour cycles for GFS

#### S3FileDetector Tests
- **S3 Path Construction**: Validates bucket and key patterns for each model
- **Detection Window Lifecycle**: Tests start/stop and active detection tracking
- **Poll Interval Timing**: Verifies 150ms polling configuration
- **Event Emission**: Tests FILE_DETECTED and FILE_CONFIRMED events

#### GRIB2Parser Tests
- **Grid Point Extraction**: Tests extraction for all 13 cities
- **Variable Extraction**: Validates temperature, wind, and precipitation parsing
- **Nearest-Neighbor Interpolation**: Tests coordinate matching
- **Performance**: Validates parsing completes within 200ms budget

#### Integration Tests
- **End-to-End Flow**: window start → file detection → parsing → event emission
- **API Fallback**: Tests parallel API polling during detection windows
- **Confirmation State**: Tests PENDING → UNCONFIRMED → CONFIRMED transitions
- **Forecast Change Detection**: Tests change detection and event emission

### 2. `latency-benchmark.ts`
Performance benchmark suite:

#### Benchmark Scenarios
- Simulates file appearance at expected time
- Measures detection latency (target: <500ms)
- Measures download latency (target: <2000ms)
- Measures parse latency (target: <200ms)
- Measures total end-to-end latency (target: <3000ms)

#### Statistics
- Runs 100 iterations
- Calculates mean, median, p95, p99, min, max
- Reports standard deviation
- Validates against latency budgets

### 3. `s3-integration.test.ts`
Integration tests with actual NOAA S3 buckets:

#### Tests
- **Bucket Connectivity**: Verifies access to noaa-hrrr-pds, noaa-rap-pds, noaa-gfs-pds
- **File Existence**: Tests HeadObject on recent model files
- **File Structure**: Validates naming patterns match expected templates
- **Model Timing**: Verifies cycle time calculations

**Note**: These tests are skipped if S3 is unavailable.

## Running Tests

### Install Dependencies
```bash
npm install
```

### Run All Tests
```bash
npm test
```

### Run Specific Test Suites
```bash
# File-based ingestion tests only
npm run test:file-ingestion

# Latency benchmark
npm run test:latency

# S3 integration tests
npm run test:s3-integration
```

### Run with Coverage
```bash
npm test -- --coverage
```

## Latency Requirements

### Budget Breakdown
| Component | Budget | Description |
|-----------|--------|-------------|
| S3 HeadObject | 500ms | Polling at 150ms intervals |
| File Download | 2000ms | Typical GRIB2 file (~10-20MB) |
| GRIB2 Parsing | 200ms | Extract 13 cities, 3 variables |
| Event Emission | 50ms | EventBus dispatch |
| **Total** | **3000ms** | Conservative estimate |
| **Requirement** | **5000ms** | Maximum allowed |
| **Headroom** | **2000ms** | Safety margin |

### Success Criteria
- Mean total latency < 3 seconds
- P95 total latency < 5 seconds
- All component budgets met

## Test Configuration

### Jest Configuration (`jest.config.ts`)
- **Preset**: ts-jest with ESM support
- **Timeout**: 30 seconds for integration tests
- **Coverage**: 80% threshold for branches, functions, lines, statements

### Environment Variables
Tests use the following defaults:
- AWS Region: `us-east-1`
- Poll Interval: `150ms`
- Max Detection Duration: `45 minutes`
- Public Buckets: `true` (no credentials required)

## Architecture Coverage

### Components Tested
1. **ScheduleManager** - Filename generation and window management
2. **S3FileDetector** - S3 polling and file detection
3. **GRIB2Parser** - GRIB2 file parsing
4. **FileBasedIngestion** - Main controller coordination
5. **ApiFallbackPoller** - Parallel API polling
6. **ConfirmationManager** - Data stream coordination
7. **ForecastChangeDetector** - Change detection and events

### Event Flow Validated
```
DETECTION_WINDOW_START
    ↓
FILE_DETECTED (S3 HeadObject success)
    ↓
FILE_CONFIRMED (download + parse complete)
    ↓
FORECAST_CHANGE (if significant changes detected)
```

## Troubleshooting

### S3 Tests Failing
- Check internet connectivity
- Verify NOAA S3 buckets are accessible
- Tests will skip if S3 is unavailable

### Latency Tests Failing
- Check local system performance
- Verify no resource contention
- Consider running on dedicated hardware

### Coverage Below Threshold
- Add tests for uncovered branches
- Mock additional edge cases
- Increase test iterations for latency tests

## CI/CD Integration

### GitHub Actions Example
```yaml
- name: Run Tests
  run: |
    npm ci
    npm test

- name: Run Latency Benchmark
  run: npm run test:latency

- name: Upload Coverage
  uses: codecov/codecov-action@v3
```

## Contributing

When adding new features:
1. Add unit tests for new components
2. Update integration tests if event flow changes
3. Verify latency budget is maintained
4. Update this README with new test coverage
