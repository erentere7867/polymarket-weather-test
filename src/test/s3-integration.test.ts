/**
 * S3 Integration Tests
 * Tests connectivity to NOAA S3 buckets and file operations
 * 
 * These tests are optional and will be skipped if S3 is unavailable
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { ScheduleManager } from '../weather/schedule-manager.js';
import { S3FileDetector } from '../weather/s3-file-detector.js';
import { ModelType } from '../weather/types.js';

// Mock logger to reduce noise
jest.mock('../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('S3 Integration Tests', () => {
  let s3Client: S3Client;
  let scheduleManager: ScheduleManager;
  let isS3Available = false;

  beforeAll(async () => {
    // Initialize S3 client for public buckets
    s3Client = new S3Client({
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'anonymous',
        secretAccessKey: 'anonymous',
      },
    });

    scheduleManager = new ScheduleManager();

    // Test S3 connectivity
    try {
      const command = new HeadObjectCommand({
        Bucket: 'noaa-hrrr-pds',
        Key: 'index.html',
      });
      await s3Client.send(command);
      isS3Available = true;
    } catch (error: any) {
      console.log('S3 not available, skipping integration tests');
      console.log('Error:', error.message);
      isS3Available = false;
    }
  });

  // Helper to conditionally run tests
  const s3It = (name: string, fn: () => Promise<void>) => {
    it(name, async () => {
      if (!isS3Available) {
        console.log(`Skipping: ${name}`);
        return;
      }
      await fn();
    });
  };

  describe('Bucket Connectivity', () => {
    s3It('should connect to noaa-hrrr-pds bucket', async () => {
      const command = new HeadObjectCommand({
        Bucket: 'noaa-hrrr-pds',
        Key: 'index.html',
      });
      
      const response = await s3Client.send(command);
      expect(response).toBeDefined();
    });

    s3It('should connect to noaa-rap-pds bucket', async () => {
      const command = new HeadObjectCommand({
        Bucket: 'noaa-rap-pds',
        Key: 'index.html',
      });
      
      const response = await s3Client.send(command);
      expect(response).toBeDefined();
    });

    s3It('should connect to noaa-gfs-pds bucket', async () => {
      const command = new HeadObjectCommand({
        Bucket: 'noaa-gfs-pds',
        Key: 'index.html',
      });
      
      const response = await s3Client.send(command);
      expect(response).toBeDefined();
    });
  });

  describe('File Existence Checks', () => {
    s3It('should check for recent HRRR file', async () => {
      // Get expected file for current hour
      const now = new Date();
      const cycleHour = now.getUTCHours() - 2; // Look for file from 2 hours ago
      
      if (cycleHour < 0) {
        console.log('Skipping - too early in UTC day');
        return;
      }

      const runDate = new Date(now);
      runDate.setUTCHours(cycleHour);
      
      const expectedFile = scheduleManager.getExpectedFile('HRRR', cycleHour, runDate);
      
      try {
        const command = new HeadObjectCommand({
          Bucket: expectedFile.bucket,
          Key: expectedFile.key,
        });
        
        const response = await s3Client.send(command);
        expect(response.ContentLength).toBeGreaterThan(0);
        expect(response.LastModified).toBeDefined();
      } catch (error: any) {
        // File might not exist yet, that's ok for this test
        if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
          console.log(`File not found: ${expectedFile.key}`);
        } else {
          throw error;
        }
      }
    });

    s3It('should check for recent GFS file', async () => {
      // GFS runs at 00, 06, 12, 18 UTC
      const now = new Date();
      const currentHour = now.getUTCHours();
      const gfsCycles = [0, 6, 12, 18];
      
      // Find most recent completed cycle
      let cycleHour = gfsCycles.filter(h => h <= currentHour - 6).pop();
      
      if (cycleHour === undefined) {
        // Use yesterday's 18Z run
        cycleHour = 18;
      }

      const runDate = new Date(now);
      if (cycleHour === 18 && currentHour < 6) {
        runDate.setUTCDate(runDate.getUTCDate() - 1);
      }
      
      const expectedFile = scheduleManager.getExpectedFile('GFS', cycleHour, runDate);
      
      try {
        const command = new HeadObjectCommand({
          Bucket: expectedFile.bucket,
          Key: expectedFile.key,
        });
        
        const response = await s3Client.send(command);
        expect(response.ContentLength).toBeGreaterThan(0);
      } catch (error: any) {
        if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
          console.log(`File not found: ${expectedFile.key}`);
        } else {
          throw error;
        }
      }
    });
  });

  describe('File Structure Validation', () => {
    s3It('should validate HRRR file naming pattern', async () => {
      const runDate = new Date('2026-01-15T12:00:00Z');
      const expectedFile = scheduleManager.getExpectedFile('HRRR', 12, runDate);
      
      // Validate pattern: hrrr.YYYYMMDD/conus/hrrr.tHHz.wrfsfcfFF.grib2
      expect(expectedFile.key).toMatch(/hrrr\.\d{8}\/conus\/hrrr\.t\d{2}z\.wrfsfcf\d{2}\.grib2/);
      expect(expectedFile.bucket).toBe('noaa-hrrr-pds');
    });

    s3It('should validate RAP file naming pattern', async () => {
      const runDate = new Date('2026-01-15T18:00:00Z');
      const expectedFile = scheduleManager.getExpectedFile('RAP', 18, runDate);
      
      // Validate pattern: rap.YYYYMMDD/rap.tHHz.awp130fFF.grib2
      expect(expectedFile.key).toMatch(/rap\.\d{8}\/rap\.t\d{2}z\.awp130f\d{2}\.grib2/);
      expect(expectedFile.bucket).toBe('noaa-rap-pds');
    });

    s3It('should validate GFS file naming pattern', async () => {
      const runDate = new Date('2026-01-15T06:00:00Z');
      const expectedFile = scheduleManager.getExpectedFile('GFS', 6, runDate);
      
      // Validate pattern: gfs.YYYYMMDD/HH/atmos/gfs.tHHz.pgrb2.0p25.fFFF
      expect(expectedFile.key).toMatch(/gfs\.\d{8}\/\d{2}\/atmos\/gfs\.t\d{2}z\.pgrb2\.0p25\.f\d{3}/);
      expect(expectedFile.bucket).toBe('noaa-gfs-pds');
    });

    s3It('should construct valid S3 URLs', async () => {
      const runDate = new Date('2026-01-15T12:00:00Z');
      
      for (const model of ['HRRR', 'RAP', 'GFS'] as ModelType[]) {
        const expectedFile = scheduleManager.getExpectedFile(model, 12, runDate);
        
        // URL should be valid format
        expect(expectedFile.fullUrl).toMatch(/^https:\/\/[^\/]+\.s3\.amazonaws\.com\/.+/);
        
        // URL should contain bucket name
        expect(expectedFile.fullUrl).toContain(expectedFile.bucket);
        
        // URL should contain key
        expect(expectedFile.fullUrl).toContain(expectedFile.key);
      }
    });
  });

  describe('S3FileDetector Integration', () => {
    let detector: S3FileDetector;

    beforeAll(() => {
      detector = new S3FileDetector({
        pollIntervalMs: 150,
        maxDetectionDurationMs: 5000,
        publicBuckets: true,
      });
    });

    s3It('should initialize with correct configuration', async () => {
      expect(detector).toBeDefined();
      expect(detector.getActiveDetectionCount()).toBe(0);
    });

    s3It('should handle bucket access patterns', async () => {
      // Test that we can access the bucket structure
      const buckets = [
        'noaa-hrrr-pds',
        'noaa-rap-pds',
        'noaa-gfs-pds',
      ];

      for (const bucket of buckets) {
        try {
          const command = new HeadObjectCommand({
            Bucket: bucket,
            Key: 'index.html',
          });
          
          const response = await s3Client.send(command);
          expect(response).toBeDefined();
          console.log(`✓ ${bucket} accessible`);
        } catch (error: any) {
          console.log(`Note: ${bucket} index.html not accessible: ${error.message}`);
        }
      }
    });
  });

  describe('Model Timing Validation', () => {
    s3It('should calculate correct cycle times for HRRR', async () => {
      const now = new Date();
      const schedules = [];
      
      // HRRR runs every hour
      for (let hour = 0; hour < 24; hour++) {
        const runDate = new Date(now);
        runDate.setUTCHours(hour);
        const schedule = scheduleManager.calculateDetectionWindow('HRRR', hour, runDate);
        schedules.push(schedule);
        
        // Verify detection window starts before expected publication
        expect(schedule.detectionWindowStart.getTime()).toBeLessThan(
          schedule.expectedPublishTime.getTime()
        );
      }
      
      expect(schedules).toHaveLength(24);
    });

    s3It('should calculate correct cycle times for GFS', async () => {
      const now = new Date();
      const schedules = [];
      
      // GFS runs at 00, 06, 12, 18 UTC
      for (const hour of [0, 6, 12, 18]) {
        const runDate = new Date(now);
        runDate.setUTCHours(hour);
        const schedule = scheduleManager.calculateDetectionWindow('GFS', hour, runDate);
        schedules.push(schedule);
        
        // GFS has much shorter delay than HRRR
        const delayMinutes = 
          (schedule.expectedPublishTime.getTime() - runDate.getTime()) / (1000 * 60);
        expect(delayMinutes).toBeLessThan(10); // GFS delay is 3-5 minutes
      }
      
      expect(schedules).toHaveLength(4);
    });
  });
});
